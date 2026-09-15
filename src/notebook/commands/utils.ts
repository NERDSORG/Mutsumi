/**
 * @fileoverview Utility functions for notebook commands.
 * @module notebook/commands/utils
 */

import * as vscode from 'vscode';
import { IAgentSession } from '../../adapters/interfaces';
import { AgentMessage, AgentMetadata } from '../../types';
import { LiteAdapter, LiteAgentSessionConfig } from '../../adapters/liteAdapter';
import { GhostBlock, GhostFileEntry } from '../../contextManagement/interfaces';
import { decodeGhostBlock, removeGhostFiles } from '../../contextManagement/ghostBlocks';

/**
 * Builds NotebookEdits that strip ghost file entries from every cell's last_ghost_block.
 * Only cells whose ghost block actually changes produce an edit. Metadata is
 * edited in place (no cell insertion/deletion), preserving ghost-block index
 * alignment; blocks that become empty are normalized by deleting the key,
 * matching persistGhostBlock's behavior.
 * Shared by the sidebar file actions and the notebook toolbar prune command.
 * @param {vscode.NotebookDocument} notebook - The notebook whose cells are scanned
 * @param {(file: GhostFileEntry) => boolean} remove - Predicate selecting file entries to remove
 * @returns {vscode.NotebookEdit[]} Cell metadata edits for affected cells
 */
export function buildGhostStripEdits(
    notebook: vscode.NotebookDocument,
    remove: (file: GhostFileEntry) => boolean
): vscode.NotebookEdit[] {
    const edits: vscode.NotebookEdit[] = [];
    for (let i = 0; i < notebook.cellCount; i++) {
        const cell = notebook.cellAt(i);
        const raw = cell.metadata?.last_ghost_block;
        if (raw === undefined || raw === null) {
            continue;
        }
        const block = decodeGhostBlock(raw);
        if (!block || !block.files.some(remove)) {
            continue;
        }
        const stripped = removeGhostFiles(block, remove);
        const newMetadata = { ...(cell.metadata ?? {}) };
        if (stripped === null) {
            delete newMetadata.last_ghost_block;
        } else {
            newMetadata.last_ghost_block = stripped;
        }
        edits.push(vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata));
    }
    return edits;
}

/**
 * Format an array of AgentMessage into a readable string representation.
 * Used for debugging and displaying conversation context.
 * @param messages - Array of agent messages to format
 * @param options - Formatting options
 * @returns Formatted string
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

/**
 * Create a LiteAgentSession from notebook data.
 * This allows using buildInteractionHistory without a full execution context.
 * Used for debug and compression operations.
 */
export async function createDebugSessionFromNotebook(
    notebook: vscode.NotebookDocument,
    cellIndex: number
): Promise<IAgentSession> {
    const metadata = notebook.metadata as AgentMetadata;
    const cell = notebook.cellAt(cellIndex);

    // Build raw history from cells before current
    const history: AgentMessage[] = [];
    for (let i = 0; i < cellIndex; i++) {
        const c = notebook.cellAt(i);
        const role = c.metadata?.role || 'user';
        const content = c.document.getText();

        if (content.trim()) {
            if (role === 'user') {
                history.push({
                    role: 'user',
                    content: [{ type: 'text', text: content }],
                    toolCalls: []
                });
                // Expand mutsumi_interaction from user cell (contains assistant/tool messages)
                const interaction = c.metadata?.mutsumi_interaction as AgentMessage[] | undefined;
                if (interaction && Array.isArray(interaction)) {
                    history.push(...interaction);
                }
            } else if (role === 'assistant') {
                // Assistant cell content is directly in the cell value
                history.push({
                    role: 'assistant',
                    content: [{ type: 'text', text: content }],
                    toolCalls: []
                });
            }
        }
    }

    // Collect ghost blocks from previous cells
    const ghostBlocks: (GhostBlock | null)[] = [];
    for (let i = 0; i < cellIndex; i++) {
        ghostBlocks.push(decodeGhostBlock(notebook.cellAt(i).metadata?.last_ghost_block));
    }

    const adapter = new LiteAdapter();
    const liteConfig: LiteAgentSessionConfig = {
        model: metadata?.model,
        allowedUris: metadata?.allowed_uris,
        isSubAgent: !!metadata?.parent_agent_id,
        metadata: metadata ? JSON.parse(JSON.stringify(metadata)) as AgentMetadata : undefined,
        input: cell.document.getText(),
        history
    };
    const session = await adapter.createSession({
        sessionId: metadata?.uuid || notebook.uri.toString(),
        config: liteConfig
    });

    // Pre-populate ghost blocks, preserving user-cell alignment with null placeholders
    for (const gb of ghostBlocks) {
        await session.persistGhostBlock!(gb ?? { files: [], tools: [] });
    }

    return session;
}
