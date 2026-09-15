import * as vscode from 'vscode';
import { extractText } from '@moonshot-ai/kosong';
import { AgentMessage, AgentMetadata, ContextItem } from '../types';
import { IAgentSession } from '../adapters/interfaces';
import { getSystemPrompt, getRulesContext } from './prompts';
import { TemplateEngine } from './templateEngine';
import { SkillManager } from './skillManager';
import {
    collectAvailableFileVersions,
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
 * @description Build Agent's conversation history context.
 * Ghost blocks are consumed and persisted as structured GhostBlock objects;
 * markdown is projected only when assembling provider-facing message content.
 * @param session - The agent session providing history and persistence
 * @param currentPrompt - Optional current user prompt (if not provided, uses session.getInput())
 * @returns Object containing messages array, allowed URIs, and sub-agent status
 */
export async function buildInteractionHistory(
    session: IAgentSession,
    currentPrompt?: string
): Promise<{ messages: AgentMessage[], allowedUris: string[], isSubAgent: boolean }> {
    // Get current prompt from session if not provided
    if (!currentPrompt) {
        currentPrompt = await session.getInput();
    }
    const messages: AgentMessage[] = [];

    // Get config and metadata from session
    const config = await session.getConfig();
    const metadata = config.metadata || {} as AgentMetadata;
    const allowedUris = config.allowedUris || metadata.allowed_uris || ['/'];
    const isSubAgent = config.isSubAgent || !!metadata.parent_agent_id;

    // Get workspace URI
    const wsUri = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri :
        (config.resourceUri ? vscode.Uri.parse(config.resourceUri) : undefined);

    if (!wsUri) {
        throw new Error('No workspace available for resolving context references');
    }

    // Extract and merge macros
    const persistedMacroItems = (metadata.contextItems || []).filter(item => item.type === 'macro');
    const persistedMacros: Record<string, string> = {};
    for (const item of persistedMacroItems) {
        persistedMacros[item.key] = item.content;
    }
    const localMacros = extractMacroDefinitions(currentPrompt);
    const macros = { ...persistedMacros, ...localMacros };
    const macroContextItems: ContextItem[] = Object.entries(macros).map(([key, content]) => ({
        type: 'macro' as const,
        key,
        content,
    }));

    // 1. Static System Prompt (Now includes Rules)
    const activeRules = metadata.activeRules;
    const rulesItems = await getRulesContext(wsUri, allowedUris, activeRules, macros);
    let systemPromptContent = await getSystemPrompt(wsUri, allowedUris, rulesItems, isSubAgent);

    // Append skills information if available
    const activeSkills = metadata.activeSkills;
    const skillsMarkdown = SkillManager.getInstance().generateSkillsMarkdown(activeSkills);
    if (skillsMarkdown && skillsMarkdown.trim()) {
        systemPromptContent += '\n\n# Installed Skills\n' + skillsMarkdown;
    }

    messages.push({
        role: 'system',
        content: [{ type: 'text', text: systemPromptContent }],
        toolCalls: []
    });

    // Get previous ghost blocks for version tracking
    const previousGhostBlocks = session.getPreviousGhostBlocks
        ? await session.getPreviousGhostBlocks()
        : [];
    const availableContentVersions = collectAvailableFileVersions(previousGhostBlocks);

    // 2. Prepare Context Map & Differential Update
    const persistedItems: ContextItem[] = metadata.contextItems || [];
    const persistedMap = new Map<string, ContextItem>();
    for (const item of persistedItems) {
        if (item.type === 'file') {
            persistedMap.set(item.key, item);
        }
    }

    // 2a. Parse Current Prompt using TemplateEngine (APPEND mode)
    const { renderedText: processedPrompt, collectedItems: currentContext } = await TemplateEngine.render(
        currentPrompt,
        macros,
        wsUri,
        allowedUris,
        'APPEND'
    );

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
                // Check if this file was in persistedItems under a different object reference but same key?
                // persistedMap handles keys. If not in map, it's new.
                version = 1;
            }

            // Update item metadata
            item.lastHash = currentHash;
            item.version = version;

            const hasPreviousContent = !isModified && availableContentVersions.has(`${item.key}::${version}`);

            if (isModified || !hasPreviousContent) {
                // Full content
                finalItemsToDisplay.push(item);
            } else {
                // Reference only
                const refItem = { ...item };
                refItem.metadata = { ...refItem.metadata, isReference: true };
                finalItemsToDisplay.push(refItem);
            }

            // Update global metadata tracking
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

    // 3. Build Message History from session
    const history = await session.getHistory();

    // Track ghost block index separately (only for user messages)
    let ghostBlockIndex = 0;

    // Process raw history - expand interactions and attach ghost blocks
    // NOTE: mutsumi_interaction ONLY exists on user messages, containing the
    // assistant and tool messages that followed that user prompt
    for (const msg of history) {
        if (msg.role === 'user') {
            // Persisted user content is a single text part holding the raw
            // markdown; images are re-parsed at assembly time (never persisted).
            const multiModalContent = await parseUserMessageWithImages(extractText(msg));
            // Append the persisted ghost block if it exists
            const savedGhostBlock = previousGhostBlocks[ghostBlockIndex] ?? null;
            ghostBlockIndex++;
            const savedGhostMarkdown = savedGhostBlock && !isEmptyGhostBlock(savedGhostBlock)
                ? ghostBlockToMarkdown(savedGhostBlock)
                : '';

            if (savedGhostMarkdown) {
                multiModalContent.push({ type: 'text', text: savedGhostMarkdown });
            }
            messages.push({ role: 'user', content: multiModalContent, toolCalls: [] });

            // Expand mutsumi_interaction from user message metadata
            // This contains the assistant response and any tool calls/results
            const interaction = msg.metadata?.mutsumi_interaction as AgentMessage[] | undefined;
            if (interaction && Array.isArray(interaction)) {
                messages.push(...interaction);
            }
        } else if (msg.role === 'assistant') {
            // Assistant messages in history are standalone (orphan messages without a preceding user)
            // or legacy format. Add them directly.
            messages.push(msg);
        } else if (msg.role === 'system') {
            // Skip, we already added system prompt
            continue;
        } else {
            // tool, etc. - add directly
            messages.push(msg);
        }
    }

    // 4. Assemble Final User Message
    const currentGhostBlock = ghostBlockFromContextItems(finalItemsToDisplay);
    const currentGhostMarkdown = isEmptyGhostBlock(currentGhostBlock)
        ? ''
        : ghostBlockToMarkdown(currentGhostBlock);

    // 5. Persist context items and ghost block via session
    if (session.updateContextItems) {
        await session.updateContextItems(newContextItemsForMetadata);
    }

    if (session.persistGhostBlock) {
        await session.persistGhostBlock(currentGhostBlock);
    }

    // 6. Push final message
    const currentMultiModalContent = await parseUserMessageWithImages(processedPrompt);
    if (currentGhostMarkdown) {
        currentMultiModalContent.push({ type: 'text', text: currentGhostMarkdown });
    }
    messages.push({ role: 'user', content: currentMultiModalContent, toolCalls: [] });

    return { messages, allowedUris, isSubAgent };
}
