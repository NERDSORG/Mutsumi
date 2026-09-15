import * as vscode from 'vscode';
import { IAgentAdapter, IAgentSession, CreateSessionOptions, AgentSessionConfig } from './interfaces';
import { AgentMessage, AgentMetadata, ContextItem } from '../types';
import { GhostBlock } from '../contextManagement/interfaces';
import { decodeGhostBlock, isEmptyGhostBlock } from '../contextManagement/ghostBlocks';
import { debugLogger } from '../debugLogger';
import { readReasoningEffortFromFile, writeReasoningEffortToFile } from './headlessAdapter';

export class NotebookAdapter implements IAgentAdapter {
    constructor(
        private readonly controller?: vscode.NotebookController
    ) {}

    async createSession(options: CreateSessionOptions): Promise<IAgentSession> {
        if (!options.resourceUri) {
            throw new Error('Resource URI is required for NotebookAdapter');
        }

        // Find the notebook document
        // We look for a notebook that either matches the URI directly or contains a cell with that URI
        const notebook = vscode.workspace.notebookDocuments.find(nb => 
            nb.uri.toString() === options.resourceUri?.toString() || 
            nb.getCells().some(c => c.document.uri.toString() === options.resourceUri?.toString())
        );

        if (!notebook) {
            throw new Error('Notebook document not found');
        }

        // Find the cell
        const cell = notebook.getCells().find(c => c.document.uri.toString() === options.resourceUri?.toString());
        if (!cell) {
             throw new Error('Notebook cell not found');
        }

        if (!this.controller) {
            throw new Error('Notebook controller is required to create a session');
        }

        // Create execution
        const execution = this.controller.createNotebookCellExecution(cell);
        
        return new NotebookAgentSession(execution, notebook, options.config);
    }

    /** Read from open notebook metadata, falling back to the backing file. */
    async getReasoningEffort(fileUri: vscode.Uri): Promise<string | undefined> {
        const notebook = vscode.workspace.notebookDocuments.find(
            document => document.uri.toString() === fileUri.toString()
        );
        if (notebook) {
            return (notebook.metadata as AgentMetadata)?.reasoning_effort;
        }
        return readReasoningEffortFromFile(fileUri);
    }

    /** Update open notebook metadata, falling back to the backing file. */
    async setReasoningEffort(fileUri: vscode.Uri, effort: string | undefined): Promise<void> {
        const notebook = vscode.workspace.notebookDocuments.find(
            document => document.uri.toString() === fileUri.toString()
        );
        if (!notebook) {
            await writeReasoningEffortToFile(fileUri, effort);
            return;
        }

        const metadata: AgentMetadata = { ...(notebook.metadata as AgentMetadata) };
        if (effort === undefined || effort === 'default') {
            delete metadata.reasoning_effort;
        } else {
            metadata.reasoning_effort = effort;
        }

        const edit = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [
            vscode.NotebookEdit.updateNotebookMetadata(JSON.parse(JSON.stringify(metadata)))
        ]);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            throw new Error('Failed to apply notebook metadata edit');
        }
    }
}

export class NotebookAgentSession implements IAgentSession {
    public readonly id: string;
    public readonly token: vscode.CancellationToken;
    public readonly supportsUI = true;
    private rawHistoryLength: number = 0;  // Length of raw (unexpanded) history from getHistory
    private fullHistory: AgentMessage[] | undefined;  // Full expanded history set by setHistory
    private config?: AgentSessionConfig;
    private pendingGhostBlock?: GhostBlock | null;
    private pendingContextItems?: ContextItem[];

    // We keep track of the accumulated output string if needed,
    // but VSCode execution handles the actual display state.

    constructor(
        public readonly execution: vscode.NotebookCellExecution,
        private readonly notebook: vscode.NotebookDocument,
        config?: AgentSessionConfig
    ) {
        this.id = execution.cell.document.uri.toString();
        this.token = execution.token;

        // Deep clone config to avoid read-only issues with VSCode's frozen metadata
        if (config) {
            this.config = JSON.parse(JSON.stringify(config)) as AgentSessionConfig;
        }

        // Start timing
        this.execution.start(Date.now());
    }

    async getInput(): Promise<string> {
        return this.execution.cell.document.getText();
    }

    async getHistory(): Promise<AgentMessage[]> {
        debugLogger.log('[NotebookAdapter.getHistory] ==== START ====');
        // Build raw history from notebook cells
        // Returns original stored messages WITHOUT expanding interactions
        // This preserves metadata and maintains 1:1 correspondence with ghostBlocks
        const history: AgentMessage[] = [];
        const currentIndex = this.execution.cell.index;
        debugLogger.log(`[NotebookAdapter.getHistory] Current cell index: ${currentIndex}, iterating ${currentIndex} previous cells`);

        for (let i = 0; i < currentIndex; i++) {
            const cell = this.notebook.cellAt(i);
            const role = cell.metadata?.role || 'user';
            const content = cell.document.getText();
            debugLogger.log(`[NotebookAdapter.getHistory] Cell ${i}: kind=${cell.kind}, role=${role}, content length=${content.length}, metadata keys=${Object.keys(cell.metadata ?? {}).join(',')}`);

            if (content.trim()) {
                if (role === 'user') {
                    // User message - store with cell metadata if any
                    history.push({
                        role: 'user',
                        content: [{ type: 'text', text: content }],
                        toolCalls: [],
                        metadata: cell.metadata
                    });
                    debugLogger.log(`[NotebookAdapter.getHistory]   - Added user message, has interaction=${!!cell.metadata?.mutsumi_interaction}`);
                } else if (role === 'assistant') {
                    // Assistant message - preserve the full interaction in metadata
                    // Do NOT expand here - buildInteractionHistory will handle expansion
                    history.push({
                        role: 'assistant',
                        content: [{ type: 'text', text: content }],
                        toolCalls: [],
                        metadata: cell.metadata
                    });
                    debugLogger.log(`[NotebookAdapter.getHistory]   - Added assistant message, has interaction=${!!cell.metadata?.mutsumi_interaction}`);
                }
            } else {
                debugLogger.log(`[NotebookAdapter.getHistory]   - Skipped empty content cell`);
            }
        }

        // Populate config from metadata if missing
        if (!this.config) {
            this.config = {};
        }
        const metadata = this.notebook.metadata as AgentMetadata;
        if (!this.config.allowedUris && metadata?.allowed_uris) {
            this.config.allowedUris = metadata.allowed_uris;
        }
        if (this.config.isSubAgent === undefined && metadata?.parent_agent_id) {
            this.config.isSubAgent = true;
        }
        if (!this.config.metadata && metadata) {
            this.config.metadata = JSON.parse(JSON.stringify(metadata)) as AgentMetadata;
        }

        // Record raw history length to calculate diff for save()
        // This is the count of raw (unexpanded) messages BEFORE AgentRunner adds new messages
        this.rawHistoryLength = history.length;
        debugLogger.log(`[NotebookAdapter.getHistory] ==== END, returning ${history.length} messages, rawHistoryLength=${this.rawHistoryLength} ====`);

        return history;
    }

    async appendOutput(content: string, options?: { isMarkdown?: boolean; mimeType?: string }): Promise<void> {
        // When mimeType is 'application/vnd.mutsumi.agent-chat', content is a RenderData JSON string
        // consumed by the custom notebook renderer.
        const mimeType = options?.mimeType;
        let outputItem: vscode.NotebookCellOutputItem;
        if (mimeType === 'application/vnd.mutsumi.agent-chat') {
            outputItem = vscode.NotebookCellOutputItem.json(JSON.parse(content), mimeType);
        } else {
            outputItem = vscode.NotebookCellOutputItem.text(content, options?.isMarkdown ? 'text/markdown' : 'text/plain');
        }
        await this.execution.appendOutput(
            new vscode.NotebookCellOutput([outputItem])
        );
    }

    async replaceOutput(content: string, options?: { isMarkdown?: boolean; mimeType?: string }): Promise<void> {
        // Primary output path: content is a RenderData JSON string for the custom renderer,
        // or plain text/markdown for fallback scenarios.
        const mimeType = options?.mimeType;
        let outputItem: vscode.NotebookCellOutputItem;
        if (mimeType === 'application/vnd.mutsumi.agent-chat') {
            outputItem = vscode.NotebookCellOutputItem.json(JSON.parse(content), mimeType);
        } else {
            outputItem = vscode.NotebookCellOutputItem.text(content, options?.isMarkdown ? 'text/markdown' : 'text/plain');
        }
        await this.execution.replaceOutput([
            new vscode.NotebookCellOutput([outputItem])
        ]);
    }

    setHistory(messages: AgentMessage[]): void {
        // Store the full expanded history (after buildInteractionHistory and AgentRunner processing)
        this.fullHistory = messages;
    }

    async save(): Promise<void> {
        // Persist metadata changes and interaction history to the notebook via WorkspaceEdit
        // This updates VSCode's buffer (dirty state), which will be saved to disk
        // by user action or auto-save

        const edits: vscode.NotebookEdit[] = [];
        const cellIndex = this.execution.cell.index;

        // 1. Metadata Update (including context items and macros)
        const currentMetadata = this.notebook.metadata as AgentMetadata;
        const newMetadata: AgentMetadata = { ...currentMetadata };

        if (this.config?.metadata) {
            Object.assign(newMetadata, this.config.metadata);
        }

        // Apply pending context items if any
        if (this.pendingContextItems) {
            newMetadata.contextItems = this.pendingContextItems;
        }

        // Deep clone to avoid read-only issues
        edits.push(vscode.NotebookEdit.updateNotebookMetadata(JSON.parse(JSON.stringify(newMetadata))));

        // 2. Cell Metadata Update
        const newCellMetadata: any = { ...this.execution.cell.metadata };

        // Apply pending ghost block if any
        if (this.pendingGhostBlock !== undefined) {
            if (this.pendingGhostBlock === null) {
                delete newCellMetadata.last_ghost_block;
            } else {
                newCellMetadata.last_ghost_block = this.pendingGhostBlock;
            }
        }

        // Calculate the new interaction for this cell
        if (this.fullHistory && this.fullHistory.length > 0) {

            const newMessages: AgentMessage[] = [];
            for (let i = this.fullHistory.length - 1; i >= 0; i--) {
                const msg = this.fullHistory[i];
                if (msg.role === 'user') {
                    break;
                }
                newMessages.unshift(msg);
            }

            if (newMessages.length > 0) {
                newCellMetadata.mutsumi_interaction = newMessages;
            }
        }

        edits.push(vscode.NotebookEdit.updateCellMetadata(cellIndex, newCellMetadata));

        if (edits.length > 0) {
            const edit = new vscode.WorkspaceEdit();
            edit.set(this.notebook.uri, edits);
            await vscode.workspace.applyEdit(edit);
        }

        // Clear pending state
        this.pendingGhostBlock = undefined;
        this.pendingContextItems = undefined;
    }

    async getConfig(): Promise<AgentSessionConfig> {
        if (!this.config) {
             const meta = this.notebook.metadata as AgentMetadata;
             // Deep clone metadata to avoid referencing VSCode's frozen object
             const metaCopy = meta ? JSON.parse(JSON.stringify(meta)) as AgentMetadata : undefined;
             this.config = {
                 model: meta?.model,
                 allowedUris: meta?.allowed_uris,
                 isSubAgent: !!meta?.parent_agent_id,
                 metadata: metaCopy
             };
        }
        // Always return a deep clone to prevent external modifications affecting internal state
        return JSON.parse(JSON.stringify(this.config)) as AgentSessionConfig;
    }

    setConfig(config: Partial<AgentSessionConfig>): void {
        if (!this.config) {
            this.config = {};
        }
        // Merge the new config, deep cloning metadata to avoid read-only issues
        this.config = {
            ...this.config,
            ...config,
            metadata: config.metadata 
                ? JSON.parse(JSON.stringify(config.metadata)) as AgentMetadata 
                : this.config.metadata
        };
    }

    async updateTitle(title: string): Promise<void> {
        const { debugLogger } = require('../debugLogger');
        debugLogger.log(`[NotebookAdapter] updateTitle called: "${title}"`);

        try {
            const edit = new vscode.WorkspaceEdit();
            // Use deep clone to avoid readonly issues with VSCode's frozen metadata
            const newMetadata = JSON.parse(JSON.stringify({ ...this.notebook.metadata, name: title }));
            const nbEdit = vscode.NotebookEdit.updateNotebookMetadata(newMetadata);
            edit.set(this.notebook.uri, [nbEdit]);
            await vscode.workspace.applyEdit(edit);
            debugLogger.log(`[NotebookAdapter] Notebook metadata updated with title: "${title}"`);
        } catch (err) {
            debugLogger.log(`[NotebookAdapter] ERROR updating notebook metadata: ${err}`);
        }

        try {
            // Also update in-memory config
            if (!this.config) {
                this.config = {};
            }
            if (!this.config.metadata) {
                this.config.metadata = {} as AgentMetadata;
            }
            this.config.metadata.name = title;
            debugLogger.log(`[NotebookAdapter] In-memory config updated`);
        } catch (err) {
            debugLogger.log(`[NotebookAdapter] ERROR updating in-memory config: ${err}`);
        }

        try {
            // Sync with orchestrator
            const notebookUuid = this.notebook.metadata?.uuid;
            const configUuid = this.config?.metadata?.uuid;
            const uuid = notebookUuid || configUuid;
            debugLogger.log(`[NotebookAdapter] UUID sources - notebook.metadata.uuid: ${notebookUuid}, config.metadata.uuid: ${configUuid}`);
            debugLogger.log(`[NotebookAdapter] Attempting registry sync with uuid: ${uuid}`);
            if (uuid) {
                const { AgentOrchestrator } = require('../agent/agentOrchestrator');
                const { AgentRegistry } = require('../agent/registry');
                const orchestrator = AgentOrchestrator.getInstance();
                const registry = AgentRegistry.getInstance();
                const agent = registry.getAgent(uuid);
                debugLogger.log(`[NotebookAdapter] Registry lookup for uuid ${uuid}: ${agent ? `found "${agent.name}"` : 'NOT FOUND'}`);
                orchestrator.updateAgentName(uuid, title);
                orchestrator.refreshUI();
                debugLogger.log(`[NotebookAdapter] Registry sync completed`);
            } else {
                debugLogger.log(`[NotebookAdapter] No uuid available for registry sync`);
            }
        } catch (err) {
            debugLogger.log(`[NotebookAdapter] ERROR during registry sync: ${err}`);
        }
    }

    /**
     * Completes the execution session.
     * Not part of IAgentSession but used by the Adapter/Controller.
     */
    end(success: boolean): void {
        this.execution.end(success, Date.now());
    }

    /**
     * Get ghost blocks from previous cells for content version tracking.
     * Iterates through all cells before the current one and decodes persisted
     * metadata; invalid values become null placeholders to preserve alignment.
     */
    async getPreviousGhostBlocks(): Promise<(GhostBlock | null)[]> {
        const ghostBlocks: (GhostBlock | null)[] = [];
        const currentIndex = this.execution.cell.index;

        for (let i = 0; i < currentIndex; i++) {
            const cell = this.notebook.cellAt(i);
            ghostBlocks.push(decodeGhostBlock(cell.metadata?.last_ghost_block));
        }

        return ghostBlocks;
    }

    /**
     * Persist ghost block for the current cell.
     * Stores in cell metadata via pending state (applied on save). An empty
     * block is normalized to a pending clear so rerunning without context does
     * not leave a stale ghost object behind.
     */
    async persistGhostBlock(ghostBlock: GhostBlock): Promise<void> {
        this.pendingGhostBlock = isEmptyGhostBlock(ghostBlock) ? null : ghostBlock;
    }

    /**
     * Update context items in session metadata.
     * Stores in pending state (applied on save).
     */
    async updateContextItems(items: ContextItem[]): Promise<void> {
        this.pendingContextItems = items;
    }
}
