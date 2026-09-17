/**
 * @fileoverview Snapshot builder: persisted session state → `session.state`
 * payload (hydration).
 *
 * `buildInteractionRenderBlocks` turns a group of assistant/tool messages
 * into committed RenderBlocks (it needs ToolManager/MCP registry knowledge,
 * which only exists in the host). Frontends render the snapshot as-is and
 * then follow incremental `session.output` events.
 *
 * @module backend/snapshot
 */

import * as vscode from 'vscode';
import { extractText } from '@moonshot-ai/kosong';
import type { ContentPart, ThinkPart } from '@moonshot-ai/kosong';
import type { AgentMessage, AgentMetadata } from '../types';
import type { RenderBlock } from '../shared/renderTypes';
import { ToolManager } from '../tools.d/toolManager';
import { collectRulesRecursively } from '../contextManagement/prompts';
import { SkillManager } from '../contextManagement/skillManager';
import { McpRegistry } from '../mcp/registry';
import { getModelsConfig } from '../utils';
import { isAutoApproveEnabled } from './approvalManager';
import type { ApprovalRequestManager } from './approvalManager';
import type { DispatchSessionManager } from './dispatchManager';
import type { BackendSession } from './backendSession';
import type { ContextPanelData, SessionSnapshot, Turn } from './events';

/**
 * Build committed RenderBlocks from an interaction message group
 * (assistant/tool messages following one user message, or an orphan group).
 */
export function buildInteractionRenderBlocks(group: AgentMessage[], isSubAgent: boolean): RenderBlock[] {
    const blocks: RenderBlock[] = [];
    const toolCallMap = new Map<string, { name: string; args: any }>();

    for (const m of group) {
        if (m.role === 'assistant') {
            for (const tc of m.toolCalls) {
                let parsedArgs: any = {};
                if (tc.arguments) {
                    try { parsedArgs = JSON.parse(tc.arguments); } catch { parsedArgs = {}; }
                }
                if (tc.id) {
                    toolCallMap.set(tc.id, { name: tc.name, args: parsedArgs });
                }
            }
            // Reasoning precedes content (think parts, hidden included:
            // re-open replay is an audit scenario).
            const reasoningStr = m.content
                .filter((part): part is ThinkPart => part.type === 'think')
                .map(part => part.think)
                .join('');
            if (reasoningStr) {
                blocks.push({ type: 'reasoning', markdown: reasoningStr, collapsed: true });
            }
            const contentStr = serializeContentToString(m.content);
            if (contentStr) {
                blocks.push({ type: 'content', markdown: contentStr });
            }
        } else if (m.role === 'tool') {
            const contentStr = extractText(m);
            const mapped = m.toolCallId ? toolCallMap.get(m.toolCallId) : undefined;
            const toolName = mapped?.name ?? m.name ?? 'unknown';
            const args = mapped?.args ?? {};
            const prettyPrintSummary = mapped
                ? ToolManager.getInstance().getPrettyPrint(toolName, args, isSubAgent)
                : `Tool Call: ${toolName}`;
            const renderingConfig = ToolManager.getInstance().getToolRenderingConfig(toolName, isSubAgent);

            blocks.push({
                type: 'toolCall',
                name: toolName,
                args,
                summary: prettyPrintSummary,
                result: contentStr,
                isStreaming: false,
                renderingConfig,
            });
        }
    }
    return blocks;
}

/**
 * Serialize message content parts to a display string.
 * text → raw text; image_url → markdown image; think/audio/video never render here.
 */
function serializeContentToString(content: ContentPart[] | undefined): string {
    if (!content) {
        return '';
    }
    return content.map(part => {
        if (part.type === 'text') {
            return part.text;
        } else if (part.type === 'image_url') {
            return `![image](${part.imageUrl.url})`;
        }
        return '';
    }).join('');
}

/**
 * Format an array of AgentMessage into a readable string representation.
 * Used by the context.debug plumbing.
 */
export function formatMessagesToString(
    messages: AgentMessage[],
    options?: {
        includeHeader?: boolean;
        maxContentLength?: number;
    }
): string {
    const { includeHeader = true, maxContentLength = Infinity } = options || {};

    let content = '';
    if (includeHeader) {
        content += `Total Messages: ${messages.length}\n\n`;
    }

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        content += `--- Message ${i + 1} [${msg.role.toUpperCase()}] ---\n\n`;

        // Content is always ContentPart[]; think parts are not displayed here
        for (const part of msg.content) {
            if (part.type === 'text') {
                const displayText = maxContentLength < part.text.length
                    ? part.text.substring(0, maxContentLength) + '\n...(truncated)'
                    : part.text;
                content += displayText;
            } else if (part.type === 'image_url') {
                content += '[Image: ' + (part.imageUrl?.url?.substring(0, 50) || 'unknown') + '...]';
            }
            content += '\n';
        }
        content += '\n\n';
    }

    return content;
}

/** Build the context-panel data bundled into the snapshot. */
async function buildContextPanelData(metadata: AgentMetadata): Promise<ContextPanelData> {
    // Rules: all workspace rules with their active flag (undefined activeRules = all active)
    let rules: ContextPanelData['rules'] = [];
    const wsUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (wsUri) {
        try {
            const rulesDir = vscode.Uri.joinPath(wsUri, '.mutsumi', 'rules');
            const allRules = (await collectRulesRecursively(rulesDir, rulesDir)).map(r => r.name).sort();
            const activeRules = metadata.activeRules;
            rules = allRules.map(name => ({
                name,
                active: activeRules === undefined || activeRules === null || activeRules.includes(name),
            }));
        } catch {
            rules = [];
        }
    }

    // Skills: all known skills with their active flag (undefined activeSkills = none active)
    const activeSkills = new Set(metadata.activeSkills ?? []);
    const skills = SkillManager.getInstance().skillsList.map(s => ({
        name: s.name,
        description: s.description,
        active: activeSkills.has(s.name),
    }));

    // MCP servers: registry records ∪ persisted selection
    const records = McpRegistry.getInstance().getRecords();
    const selectionByServer = new Map(
        (metadata.enabledMcpTools ?? []).map(s => [s.serverId, new Set(s.toolNames)] as const),
    );
    const serverIds = new Set([...records.map(r => r.serverId), ...selectionByServer.keys()]);
    const mcpServers: ContextPanelData['mcpServers'] = [...serverIds].sort().map(serverId => {
        const record = records.find(r => r.serverId === serverId);
        const selected = selectionByServer.get(serverId) ?? new Set<string>();
        const toolNames = new Set([...(record?.tools ?? []).map(t => t.name), ...selected]);
        return {
            serverId,
            status: record?.status ?? 'notConfigured',
            error: record?.error,
            tools: [...toolNames].sort().map(name => {
                const tool = record?.tools.find(t => t.name === name);
                return {
                    name,
                    schemaValid: tool ? tool.schemaValid !== false : false,
                    enabled: selected.has(name),
                };
            }),
        };
    });

    return { rules, skills, mcpServers, contextItems: metadata.contextItems ?? [] };
}

/**
 * Build the full `session.state` snapshot for a session: turn replay
 * (committed-only RenderData), live current-turn IR, status, pending
 * approvals and context panel data — enough to hydrate an empty frontend in
 * one message.
 */
export async function buildSessionSnapshot(
    session: BackendSession,
    approvals: ApprovalRequestManager,
    dispatches: DispatchSessionManager,
): Promise<SessionSnapshot> {
    const metadata = session.metadata;
    const isSubAgent = !!metadata.parent_agent_id;

    const turns: Turn[] = [];
    const history = session.history;
    let i = 0;
    while (i < history.length) {
        const msg = history[i];
        if (msg.role === 'user') {
            const messageIndex = i;
            const group: AgentMessage[] = [];
            let j = i + 1;
            while (j < history.length && history[j].role !== 'user') {
                group.push(history[j]);
                j++;
            }
            turns.push({
                userText: extractText(msg),
                messageIndex,
                renderData: { committed: buildInteractionRenderBlocks(group, isSubAgent), active: null },
            });
            i = j;
        } else {
            // Orphan assistant/tool group (no preceding user message)
            const messageIndex = i;
            const group: AgentMessage[] = [];
            while (i < history.length && history[i].role !== 'user') {
                group.push(history[i]);
                i++;
            }
            turns.push({
                userText: null,
                messageIndex,
                renderData: { committed: buildInteractionRenderBlocks(group, isSubAgent), active: null },
            });
        }
    }

    return {
        sessionId: session.sessionId,
        metadata: JSON.parse(JSON.stringify(metadata)) as AgentMetadata,
        turns,
        currentTurn: session.status === 'running' ? session.currentTurnRenderData : null,
        status: session.status,
        reason: session.lastStopReason,
        queuedCount: session.queuedCount,
        pendingApprovals: approvals.getPendingRequests(session.sessionId),
        pendingDispatches: dispatches.getPendingDispatches().filter(d => d.parentId === session.sessionId),
        availableModels: getModelsConfig(),
        autoApproveEnabled: isAutoApproveEnabled(),
        contextPanel: await buildContextPanelData(metadata),
    };
}
