/**
 * @fileoverview Context assembly for agent sessions: system prompt assembly,
 * user-input assembly (template rendering + context-item differential +
 * injection markdown, returned as pure data) and wire projection of the
 * persisted flat history.
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
    injectionMarkdownFromItems,
} from './contextInjection';
import {
    parseUserMessageWithImages,
    extractMacroDefinitions,
    computeHash
} from './utils';
import type { BackendSession } from '../backend/backendSession';
import type { InboundExecution } from '../backend/interfaces';

/** Minimal session surface needed by wire projection (implemented by BackendSession). */
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

/** Assemble the system prompt: role macro, template-expanded rules and skills markdown. */
export async function assembleSystemPrompt(
    metadata: AgentMetadata,
    session: BackendSession,
    execution: InboundExecution
): Promise<string> {
    const wsUri = requireWorkspaceUri();
    const allowedUris = metadata.allowed_uris || ['/'];
    const isSubAgent = !!metadata.parent_agent_id;

    const rulesItems = await getRulesContext(
        wsUri,
        allowedUris,
        metadata.activeRules,
        persistedMacros(metadata),
        session,
        execution
    );
    let systemPromptContent = await getSystemPrompt(wsUri, allowedUris, rulesItems, isSubAgent);

    const skillsMarkdown = SkillManager.getInstance().generateSkillsMarkdown(metadata.activeSkills);
    if (skillsMarkdown && skillsMarkdown.trim()) {
        systemPromptContent += '\n\n# Installed Skills\n' + skillsMarkdown;
    }

    return systemPromptContent;
}

/**
 * Assemble user input into pure data: rendered text plus injection markdown (null when empty),
 * running the template engine in APPEND mode under `execution` and diffing `metadata.contextItems`.
 */
export async function assembleUserInput(
    session: BackendSession,
    text: string,
    execution?: InboundExecution
): Promise<{ text: string; injectionMarkdown: string | null }> {
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

    // Full-content file versions carried by previous injection messages.
    const availableContentVersions = collectAvailableFileVersions(session.history);

    // Render the input (APPEND: collected items feed the injection)
    const { renderedText: processedPrompt, collectedItems: currentContext } = await TemplateEngine.render(
        text,
        macros,
        wsUri,
        allowedUris,
        'APPEND',
        [],
        execution,
        session
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

    const injectionMarkdown = injectionMarkdownFromItems(finalItemsToDisplay);
    return { text: processedPrompt, injectionMarkdown: injectionMarkdown || null };
}

/**
 * Project one persisted message into wire form: user-role messages (text,
 * agent and injection alike) resolve image links to multimodal parts; other
 * roles pass through with pipeline metadata stripped.
 */
export async function projectMessageToWire(msg: AgentMessage): Promise<AgentMessage> {
    if (msg.role === 'user') {
        const content = await parseUserMessageWithImages(extractText(msg));
        return { role: 'user', content, toolCalls: [] };
    }
    const { metadata: _pipelineMetadata, ...rest } = msg;
    return rest as AgentMessage;
}

/**
 * Project the flat history into wire messages; system messages are dropped.
 */
export async function assembleWireHistory(session: HistoryAssemblySession): Promise<AgentMessage[]> {
    const wire: AgentMessage[] = [];
    for (const msg of session.history) {
        if (msg.role === 'system') {
            continue;
        }
        wire.push(await projectMessageToWire(msg));
    }
    return wire;
}
