/**
 * @fileoverview Context assembly for agent sessions.
 *
 * Three functions over the session's persisted state:
 *
 * - {@link assembleSystemPrompt}: metadata + workspace → system prompt
 * - {@link assembleUserMessage}: raw input text → persistable user message
 *   (template rendering, context-item differential, ghost block attachment)
 * - {@link assembleWireHistory}: persisted history → wire-protocol messages
 *   (ghost markdown projection, image part resolution)
 *
 * The persisted form is canonical; the wire form is a projection rebuilt on
 * every run. The history is a flat message array.
 *
 * @module contextManagement/history
 */

import * as vscode from 'vscode';
import { extractText } from '@moonshot-ai/kosong';
import { AgentMessage, AgentMetadata, ContextItem } from '../types';
import { getSystemPrompt, getRulesContext } from './prompts';
import { TemplateEngine } from './templateEngine';
import { SkillManager } from './skillManager';
import {
    collectAvailableFileVersions,
    decodeGhostBlock,
    ghostBlockFromContextItems,
    ghostBlockToMarkdown,
    isEmptyGhostBlock
} from './ghostBlocks';
import {
    parseUserMessageWithImages,
    extractMacroDefinitions,
    computeHash
} from './utils';

/**
 * Minimal session surface needed by history assembly.
 * Implemented by BackendSession; declared here so contextManagement does not
 * depend on the backend module graph.
 */
export interface HistoryAssemblySession {
    readonly metadata: AgentMetadata;
    readonly history: AgentMessage[];
}

function requireWorkspaceUri(): vscode.Uri {
    const wsUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!wsUri) {
        throw new Error('No workspace available for resolving context references');
    }
    return wsUri;
}

/** Extract macro definitions persisted in metadata context items. */
function persistedMacros(metadata: AgentMetadata): Record<string, string> {
    const macros: Record<string, string> = {};
    for (const item of metadata.contextItems ?? []) {
        if (item.type === 'macro') {
            macros[item.key] = item.content;
        }
    }
    return macros;
}

/**
 * Assemble the system prompt from session metadata and workspace state.
 * Pure function of metadata + workspace: role macro, rules (recursively
 * collected, template-expanded) and skills markdown.
 */
export async function assembleSystemPrompt(metadata: AgentMetadata): Promise<string> {
    const wsUri = requireWorkspaceUri();
    const allowedUris = metadata.allowed_uris || ['/'];
    const isSubAgent = !!metadata.parent_agent_id;

    const rulesItems = await getRulesContext(wsUri, allowedUris, metadata.activeRules, persistedMacros(metadata));
    let systemPromptContent = await getSystemPrompt(wsUri, allowedUris, rulesItems, isSubAgent);

    const skillsMarkdown = SkillManager.getInstance().generateSkillsMarkdown(metadata.activeSkills);
    if (skillsMarkdown && skillsMarkdown.trim()) {
        systemPromptContent += '\n\n# Installed Skills\n' + skillsMarkdown;
    }

    return systemPromptContent;
}

/**
 * Assemble a persistable user message from raw input text.
 *
 * Runs the template engine in APPEND mode (collecting ghost items), performs
 * the hash/version differential against `metadata.contextItems`, updates the
 * persisted context items in place, and attaches the resulting ghost block to
 * the returned message's `metadata.last_ghost_block`.
 *
 * The returned message content is the template-rendered text WITHOUT the
 * ghost markdown (that is projected at wire-assembly time); image references
 * stay as markdown links (resolved to image parts at wire-assembly time).
 */
export async function assembleUserMessage(
    session: HistoryAssemblySession,
    text: string
): Promise<AgentMessage> {
    const metadata = session.metadata;
    const allowedUris = metadata.allowed_uris || ['/'];
    const wsUri = requireWorkspaceUri();

    // Merge persisted macros with locally defined ones (local wins)
    const localMacros = extractMacroDefinitions(text);
    const macros = { ...persistedMacros(metadata), ...localMacros };
    const macroContextItems: ContextItem[] = Object.entries(macros).map(([key, content]) => ({
        type: 'macro' as const,
        key,
        content,
    }));

    // Ghost blocks of previous user messages, aligned by position; invalid or
    // absent persisted values decode to null placeholders.
    const previousGhostBlocks = session.history
        .filter(m => m.role === 'user')
        .map(m => decodeGhostBlock(m.metadata?.last_ghost_block));
    const availableContentVersions = collectAvailableFileVersions(previousGhostBlocks);

    // Render the input (APPEND: collected items feed the ghost block)
    const { renderedText: processedPrompt, collectedItems: currentContext } = await TemplateEngine.render(
        text,
        macros,
        wsUri,
        allowedUris,
        'APPEND'
    );

    // Differential update against persisted context items
    const persistedItems: ContextItem[] = metadata.contextItems || [];
    const persistedMap = new Map<string, ContextItem>();
    for (const item of persistedItems) {
        if (item.type === 'file') {
            persistedMap.set(item.key, item);
        }
    }

    const finalItemsToDisplay: ContextItem[] = [];
    const newContextItemsForMetadata: ContextItem[] = persistedItems.filter(item => item.type === 'file');

    for (const item of currentContext) {
        if (item.type === 'file') {
            const currentHash = computeHash(item.content);
            const prevItem = persistedMap.get(item.key);

            let version = 1;
            let isModified = true;

            if (prevItem) {
                if (prevItem.lastHash === currentHash) {
                    isModified = false;
                    version = prevItem.version || 1;
                } else {
                    version = (prevItem.version || 0) + 1;
                }
            } else {
                version = 1;
            }

            item.lastHash = currentHash;
            item.version = version;

            const hasPreviousContent = !isModified && availableContentVersions.has(`${item.key}::${version}`);

            if (isModified || !hasPreviousContent) {
                finalItemsToDisplay.push(item);
            } else {
                const refItem = { ...item };
                refItem.metadata = { ...refItem.metadata, isReference: true };
                finalItemsToDisplay.push(refItem);
            }

            const index = newContextItemsForMetadata.findIndex(i => i.key === item.key && i.type === 'file');
            if (index !== -1) {
                newContextItemsForMetadata[index] = item;
            } else {
                newContextItemsForMetadata.push(item);
            }
        } else {
            // Tools are always displayed
            finalItemsToDisplay.push(item);
        }
    }

    newContextItemsForMetadata.push(...macroContextItems);
    metadata.contextItems = newContextItemsForMetadata;

    const currentGhostBlock = ghostBlockFromContextItems(finalItemsToDisplay);

    const message: AgentMessage = {
        role: 'user',
        content: [{ type: 'text', text: processedPrompt }],
        toolCalls: []
    };
    if (!isEmptyGhostBlock(currentGhostBlock)) {
        message.metadata = { last_ghost_block: currentGhostBlock };
    }
    return message;
}

/**
 * Project a persisted user message into wire form: image links resolved to
 * image parts, persisted ghost block projected to markdown and appended.
 */
export async function projectUserMessageToWire(msg: AgentMessage): Promise<AgentMessage> {
    const content = await parseUserMessageWithImages(extractText(msg));
    const ghost = decodeGhostBlock(msg.metadata?.last_ghost_block);
    const ghostMarkdown = ghost && !isEmptyGhostBlock(ghost) ? ghostBlockToMarkdown(ghost) : '';
    if (ghostMarkdown) {
        content.push({ type: 'text', text: ghostMarkdown });
    }
    return { role: 'user', content, toolCalls: [] };
}

/**
 * Project the session's persisted flat history into wire-protocol messages:
 * user messages get their ghost markdown + image parts; assistant/tool
 * messages pass through (pipeline metadata stripped); system messages are
 * dropped (the system prompt is assembled separately).
 */
export async function assembleWireHistory(session: HistoryAssemblySession): Promise<AgentMessage[]> {
    const wire: AgentMessage[] = [];
    for (const msg of session.history) {
        if (msg.role === 'user') {
            wire.push(await projectUserMessageToWire(msg));
        } else if (msg.role === 'system') {
            continue;
        } else {
            const { metadata: _pipelineMetadata, ...rest } = msg;
            wire.push(rest as AgentMessage);
        }
    }
    return wire;
}
