/**
 * @fileoverview BackendSession — the single session implementation.
 *
 * Owns the session's full truth — metadata, flat message history,
 * per-session run queue, current render IR and abort handle — and is the
 * single write point for both history (`appendMessage`) and persistence
 * (`persist`, via SessionStore's per-file write queue). Frontends observe it
 * exclusively through BtF events.
 *
 * `fileUri === null` marks an ephemeral session (title generation, Lite
 * one-shot runs): it emits events like any other session but never touches
 * the disk or the registry.
 *
 * @module backend/backendSession
 */

import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { createToolMessage } from '@moonshot-ai/kosong';
import type { AgentMessage, AgentMetadata } from '../types';
import type { McpToolSelection } from '../mcp/interfaces';
import type { RenderData } from '../shared/renderTypes';
import { RenderDataBuilder } from '../agent/renderDataBuilder';
import { createEmptyToolSet, createToolSetForAgent, ToolSet } from '../tools.d/toolManager';
import type { AgentRunOptions } from '../agent/interfaces';
import { normalizeReasoningEffort } from '../agent/types';
import {
    assembleSystemPrompt,
    assembleUserMessage,
    assembleWireHistory,
} from '../contextManagement/history';
import { decodeGhostBlock, isEmptyGhostBlock, removeGhostFiles } from '../contextManagement/ghostBlocks';
import { collectRulesRecursively } from '../contextManagement/prompts';
import { getDefaultModelSelection, getModelCredentials, resolveModelSelection } from '../utils';
import { debugLogger } from '../debugLogger';
import type { EventBus } from './eventBus';
import type { SessionStore } from './sessionStore';
import type { ApprovalRequestManager } from './approvalManager';
import type { AgentRegistry } from './agentRegistry';
import type {
    ApprovalRequestInit,
    ApprovalResolution,
    BackendSessionDeps,
    BackendSessionOptions,
    DispatchRequestItem,
    QueuedUserMessage,
    SessionStatus,
    SessionStopReason,
} from './interfaces';
import { buildSessionSnapshot, formatMessagesToString } from './snapshot';

/**
 * The single session implementation. See module docstring.
 */
export class BackendSession {
    readonly sessionId: string;
    /** Null for ephemeral sessions (never persisted). */
    fileUri: vscode.Uri | null;
    /** In-memory truth; persisted through the store. */
    metadata: AgentMetadata;
    /** Flat message history — the .mtm `context` array (no system messages). */
    history: AgentMessage[];
    /** Live render IR of the in-flight turn (drives `session.output`). */
    currentTurnRenderData: RenderData | null = null;
    /** Builder for the current turn's render IR; recreated per turn. */
    renderDataBuilder: RenderDataBuilder | null = null;
    status: SessionStatus = 'idle';
    lastStopReason: SessionStopReason | undefined;
    currentAbort: AbortController | undefined;

    /**
     * Termination signaling hook of the in-flight tool batch. Set by
     * ToolExecutor while executing tools; invoked when an approval rejection
     * without reason must terminate the session.
     */
    terminationHook: ((isTaskComplete: boolean) => void) | null = null;

    private queue: QueuedUserMessage[] = [];
    private drainPromise: Promise<void> | null = null;
    private readonly maxLoops: number;
    private readonly emptyToolSet: boolean;

    constructor(
        private readonly deps: BackendSessionDeps,
        metadata: AgentMetadata,
        history: AgentMessage[],
        fileUri: vscode.Uri | null,
        options?: BackendSessionOptions,
    ) {
        this.sessionId = metadata.uuid;
        this.metadata = metadata;
        this.history = history;
        this.fileUri = fileUri;
        this.maxLoops = options?.maxLoops ?? 30;
        this.emptyToolSet = options?.emptyToolSet ?? false;
    }

    /** Create an ephemeral session (no file, no registry entry). */
    static createEphemeral(
        deps: BackendSessionDeps,
        options?: BackendSessionOptions & { metadata?: Partial<AgentMetadata> },
    ): BackendSession {
        const metadata: AgentMetadata = {
            uuid: uuidv4(),
            name: 'ephemeral',
            created_at: new Date().toISOString(),
            parent_agent_id: null,
            allowed_uris: ['/'],
            ...options?.metadata,
        };
        return new BackendSession(deps, metadata, [], null, options);
    }

    /** ToolExecutor keys ToolSession by this id. */
    get id(): string {
        return this.sessionId;
    }

    get queuedCount(): number {
        return this.queue.length;
    }

    get isSubAgent(): boolean {
        return !!this.metadata.parent_agent_id;
    }

    // ------------------------------------------------------------------
    // Output / error broadcast
    // ------------------------------------------------------------------

    /** Publish the current turn's render IR (object pass-through; no JSON boundary). */
    publishRenderData(renderData: RenderData): void {
        this.currentTurnRenderData = renderData;
        this.deps.bus.emitBtF('session.output', { sessionId: this.sessionId, renderData });
    }

    /** Broadcast a session-scoped error (the notification micro-frontend picks it up). */
    reportError(message: string, recoverable: boolean): void {
        debugLogger.log(`[BackendSession] ${this.sessionId} error (recoverable=${recoverable}): ${message}`);
        this.deps.bus.emitBtF('session.error', { sessionId: this.sessionId, message, recoverable });
    }

    /** Broadcast the current metadata (title/model/effort/rules/skills/MCP changes). */
    broadcastMetadata(): void {
        this.deps.bus.emitBtF('session.metadata', {
            sessionId: this.sessionId,
            metadata: JSON.parse(JSON.stringify(this.metadata)) as AgentMetadata,
        });
    }

    // ------------------------------------------------------------------
    // History write path
    // ------------------------------------------------------------------

    /**
     * The single history write point. Every produced message is appended the
     * moment it exists and triggers a queued persist.
     */
    appendMessage(msg: AgentMessage): void {
        this.history.push(msg);
        void this.persist();
    }

    /** Persist through the store's per-file write queue. No-op for ephemeral sessions. */
    persist(): Promise<void> {
        if (!this.fileUri) {
            return Promise.resolve();
        }
        return this.deps.store.write(this.fileUri, this.metadata, this.history).catch(err => {
            debugLogger.log(`[BackendSession] persist failed for ${this.sessionId}: ${err}`);
        });
    }

    /**
     * Assemble, append, broadcast and persist a user message. Returns the
     * persisted message (callers projecting onto the wire use
     * `projectUserMessageToWire`).
     */
    async commitUserMessage(text: string): Promise<AgentMessage> {
        const msg = await assembleUserMessage(this, text);
        this.appendMessage(msg);
        this.deps.bus.emitBtF('session.userMessageCommitted', {
            sessionId: this.sessionId,
            text,
            historyIndex: this.history.length - 1,
        });
        await this.persist();
        // Assembly updated metadata.contextItems (file versions/macros).
        this.broadcastMetadata();
        return msg;
    }

    // ------------------------------------------------------------------
    // Queue / run semantics
    // ------------------------------------------------------------------

    /** Enqueue a user message; starts the drain loop when idle. */
    enqueueUserMessage(text: string, mode: 'queue' | 'steer' = 'queue'): void {
        this.queue.push({ text, mode });
        this.emitStatus();
        if (!this.drainPromise) {
            this.drainPromise = this.drainLoop().finally(() => {
                this.drainPromise = null;
            });
        }
    }

    /**
     * Extract all pending steer messages (queue messages stay queued).
     * Only called by the runner at round boundaries.
     */
    drainSteering(): string[] {
        if (this.queue.length === 0) {
            return [];
        }
        const steered: string[] = [];
        const remaining: QueuedUserMessage[] = [];
        for (const msg of this.queue) {
            if (msg.mode === 'steer') {
                steered.push(msg.text);
            } else {
                remaining.push(msg);
            }
        }
        if (steered.length > 0) {
            this.queue = remaining;
            this.emitStatus();
        }
        return steered;
    }

    private async drainLoop(): Promise<void> {
        while (this.queue.length > 0) {
            const msg = this.queue.shift()!;
            this.emitStatus();
            await this.executeTurn(msg.text);
        }
    }

    private async executeTurn(text: string): Promise<void> {
        this.setRunning(true);
        const abortController = new AbortController();
        this.currentAbort = abortController;
        let reason: SessionStopReason = 'completed';
        let firstTurn = false;
        try {
            await this.commitUserMessage(text);
            firstTurn = this.history.filter(m => m.role === 'user').length === 1;
            this.renderDataBuilder = new RenderDataBuilder();
            this.currentTurnRenderData = null;

            const systemPrompt = await assembleSystemPrompt(this.metadata);
            const wireHistory = await assembleWireHistory(this);
            const toolSet = this.buildToolSet();
            const options = this.resolveRunOptions();

            // Dynamic import: agentRunner imports this module's type; keeping
            // the value edge lazy avoids a module cycle.
            const { AgentRunner } = await import('../agent/agentRunner');
            const runner = new AgentRunner(options, toolSet, this);
            await runner.run(abortController, { systemPrompt, wireHistory });
            if (abortController.signal.aborted) {
                reason = 'interrupted';
            }
        } catch (err: any) {
            if (abortController.signal.aborted) {
                reason = 'interrupted';
            } else {
                reason = 'error';
                this.reportError(err?.message || String(err), false);
            }
        } finally {
            this.currentAbort = undefined;
            if (reason === 'interrupted') {
                this.repairDanglingToolCalls();
            }
            this.setRunning(false, reason);
            await this.persist();
            if (reason !== 'error' && firstTurn && this.fileUri) {
                this.deps.onFirstTurnCompleted?.(this);
            }
        }
    }

    /**
     * Hard-stop the current run, clear the queue, repair and persist.
     * Interrupt cascades to every materialized descendant session (an
     * interrupt is an emergency brake for the whole agent tree).
     */
    async interrupt(): Promise<void> {
        await this.interruptTree(new Set());
    }

    private async interruptTree(visited: Set<string>): Promise<void> {
        if (visited.has(this.sessionId)) {
            return;
        }
        visited.add(this.sessionId);

        this.queue = [];
        this.deps.approvals.cancelSessionRequests(this.sessionId);

        // Cascade to materialized descendants (cold descendants have no run
        // to stop; recursion covers deeper levels).
        const entry = this.deps.registry.get(this.sessionId);
        const childInterrupts: Promise<void>[] = [];
        for (const childId of entry?.childIds ?? []) {
            const child = this.deps.getMaterializedSession(childId);
            if (child) {
                childInterrupts.push(child.interruptTree(visited));
            }
        }

        if (this.currentAbort) {
            this.currentAbort.abort();
            // Wait for the in-flight turn to settle (its finally-block repairs
            // the tail, persists and broadcasts the idle/interrupted status).
            await Promise.all([this.drainPromise, ...childInterrupts]);
            return;
        }
        await Promise.all(childInterrupts);
        this.emitStatus('interrupted');
    }

    /**
     * Cascade-delete the history from `fromIndex` onwards: interrupt first
     * when running, then truncate, repair the tail, clear the queue and
     * persist. Callers broadcast a fresh `session.state` snapshot afterwards.
     */
    async truncateFrom(fromIndex: number): Promise<void> {
        if (this.currentAbort || this.drainPromise) {
            await this.interrupt();
        }
        this.queue = [];
        this.history = this.history.slice(0, Math.max(0, fromIndex));
        this.repairDanglingToolCalls();
        this.currentTurnRenderData = null;
        await this.persist();
    }

    /** Repair dangling tool calls found after loading (crash residue). */
    async repairLoadedHistory(): Promise<void> {
        const before = this.history.length;
        this.repairDanglingToolCalls();
        if (this.history.length !== before) {
            await this.persist();
        }
    }

    /**
     * Scan the history tail: any assistant toolCall without a following tool
     * message gets a synthetic `[Interrupted]` placeholder so the wire
     * protocol history stays legal after interrupts/truncations.
     */
    private repairDanglingToolCalls(): void {
        const repaired: AgentMessage[] = [];
        let changed = false;
        for (let i = 0; i < this.history.length; i++) {
            const msg = this.history[i];
            repaired.push(msg);
            if (msg.role !== 'assistant' || msg.toolCalls.length === 0) {
                continue;
            }
            const answered = new Set<string>();
            let j = i + 1;
            while (j < this.history.length && this.history[j].role === 'tool') {
                const toolMsg = this.history[j];
                if (toolMsg.toolCallId) {
                    answered.add(toolMsg.toolCallId);
                }
                repaired.push(toolMsg);
                j++;
            }
            for (const tc of msg.toolCalls) {
                if (tc.id && !answered.has(tc.id)) {
                    repaired.push({
                        ...createToolMessage(
                            tc.id,
                            `[Interrupted] The ${tc.name} tool execution was interrupted before producing a result.`,
                        ),
                        name: tc.name,
                    });
                    changed = true;
                }
            }
            i = j - 1;
        }
        if (changed) {
            this.history = repaired;
        }
    }

    // ------------------------------------------------------------------
    // Metadata operations (FtB handlers delegate here)
    // ------------------------------------------------------------------

    /** Rename: metadata + file rename (sanitized, deduplicated) + broadcasts. */
    async rename(name: string): Promise<void> {
        const trimmed = name.trim();
        if (!trimmed) {
            return;
        }
        this.metadata.name = trimmed;
        if (this.fileUri) {
            const newUri = await this.deps.registry.renameAgentFile(this.sessionId, trimmed);
            if (newUri) {
                this.fileUri = newUri;
            }
        }
        await this.persist();
        this.broadcastMetadata();
        this.deps.registry.emitChanged();
    }

    /** Change the model pair through the single validation gate. */
    async setModel(model: string, provider: string): Promise<void> {
        const resolved = resolveModelSelection({ model, provider });
        this.metadata.model = resolved.model;
        this.metadata.provider = resolved.provider;
        await this.persist();
        this.broadcastMetadata();
    }

    /** Set or clear (undefined/'default') the reasoning effort override. */
    async setReasoningEffort(effort?: string): Promise<void> {
        if (effort === undefined || effort === 'default') {
            delete this.metadata.reasoning_effort;
        } else {
            this.metadata.reasoning_effort = effort;
        }
        await this.persist();
        this.broadcastMetadata();
    }

    /** Toggle a rule; `activeRules === undefined` means "all active". */
    async toggleRule(rule: string, active: boolean): Promise<void> {
        const wsUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!wsUri) {
            return;
        }
        const rulesDir = vscode.Uri.joinPath(wsUri, '.mutsumi', 'rules');
        const allRules = (await collectRulesRecursively(rulesDir, rulesDir)).map(r => r.name);
        const effective = new Set(this.metadata.activeRules ?? allRules);
        if (active) {
            effective.add(rule);
        } else {
            effective.delete(rule);
        }
        this.metadata.activeRules = [...effective];
        await this.persist();
        this.broadcastMetadata();
    }

    /** Toggle a skill; `activeSkills === undefined` means "none active". */
    async toggleSkill(skill: string, active: boolean): Promise<void> {
        const effective = new Set(this.metadata.activeSkills ?? []);
        if (active) {
            effective.add(skill);
        } else {
            effective.delete(skill);
        }
        this.metadata.activeSkills = [...effective];
        await this.persist();
        this.broadcastMetadata();
    }

    /** Replace the MCP tool selection snapshot. */
    async setMcpTools(selection: McpToolSelection[]): Promise<void> {
        this.metadata.enabledMcpTools = selection;
        await this.persist();
        this.broadcastMetadata();
    }

    /**
     * Stop tracking a referenced file: drop its version/hash tracking from
     * metadata.contextItems (a future re-reference re-injects it fully) and
     * strip its ghost entries from every user message so it no longer appears
     * anywhere in the assembled context.
     */
    async removeContextFile(key: string): Promise<void> {
        const items = this.metadata.contextItems ?? [];
        this.metadata.contextItems = items.filter(i => !(i.type === 'file' && i.key === key));
        for (const msg of this.history) {
            if (msg.role !== 'user' || msg.metadata?.last_ghost_block === undefined) {
                continue;
            }
            const block = decodeGhostBlock(msg.metadata.last_ghost_block);
            if (!block || !block.files.some(f => f.key === key)) {
                continue;
            }
            const stripped = removeGhostFiles(block, f => f.key === key);
            const newMetadata = { ...msg.metadata };
            if (stripped === null || isEmptyGhostBlock(stripped)) {
                delete newMetadata.last_ghost_block;
            } else {
                newMetadata.last_ghost_block = stripped;
            }
            msg.metadata = newMetadata;
        }
        await this.persist();
        this.broadcastMetadata();
    }

    /** Remove a macro; template preprocessing no longer resolves it. */
    async removeMacro(key: string): Promise<void> {
        const items = this.metadata.contextItems ?? [];
        this.metadata.contextItems = items.filter(i => !(i.type === 'macro' && i.key === key));
        await this.persist();
        this.broadcastMetadata();
    }

    /** Mark the session finished (metadata + registry + broadcast). */
    async markTaskFinished(): Promise<void> {
        this.metadata.is_task_finished = true;
        const entry = this.deps.registry.get(this.sessionId);
        if (entry) {
            entry.isTaskFinished = true;
        }
        await this.persist();
        this.broadcastMetadata();
        this.deps.registry.emitChanged();
    }

    /**
     * task_finish entry point: mark finished and report to the parent session
     * (a steered agent message). May be called multiple times — the user can
     * talk to a finished sub-agent and have it report again.
     */
    async reportTaskFinished(summary: string): Promise<void> {
        await this.markTaskFinished();
        const parentId = this.metadata.parent_agent_id;
        if (!parentId) {
            return;
        }
        const text = `[Agent Message — from '${this.metadata.name}' (${this.sessionId})]\n\nTask finished. Final report:\n\n${summary}`;
        await this.deliverAgentMessage(parentId, text);
    }

    /**
     * Deliver an agent message to another session. The message lands as a
     * steered user message: injected at the next round boundary while the
     * target is running, or wakes the target (a new turn) when it is stopped
     * — regardless of how it stopped. Returns a status string for the
     * calling tool.
     */
    async deliverAgentMessage(targetUuid: string, text: string): Promise<string> {
        const targetEntry = this.deps.registry.get(targetUuid);
        if (!targetEntry) {
            return `Error: target session '${targetUuid}' not found (deleted?).`;
        }
        const target = await this.deps.materializeSession(targetUuid);
        const wasRunning = target.status === 'running';
        target.enqueueUserMessage(text, 'steer');
        return wasRunning
            ? `Message delivered to agent '${targetEntry.name}'; it will see it at the next round boundary.`
            : `Message delivered to agent '${targetEntry.name}'; it will wake up and process it.`;
    }

    // ------------------------------------------------------------------
    // Context operations
    // ------------------------------------------------------------------

    /**
     * Prune ghost-block file entries whose version is older than the latest
     * known version of that key (max of tracked metadata versions and versions
     * present in ghost blocks). Returns whether anything changed.
     */
    async pruneGhostBlocks(): Promise<boolean> {
        const latestVersions = new Map<string, number>();
        for (const item of this.metadata.contextItems ?? []) {
            if (item.type === 'file') {
                latestVersions.set(item.key, item.version || 1);
            }
        }
        for (const msg of this.history) {
            if (msg.role !== 'user') {
                continue;
            }
            const block = decodeGhostBlock(msg.metadata?.last_ghost_block);
            if (!block) {
                continue;
            }
            for (const file of block.files) {
                latestVersions.set(file.key, Math.max(latestVersions.get(file.key) ?? 0, file.version));
            }
        }

        let changed = false;
        for (const msg of this.history) {
            if (msg.role !== 'user' || msg.metadata?.last_ghost_block === undefined) {
                continue;
            }
            const block = decodeGhostBlock(msg.metadata.last_ghost_block);
            const isStale = (file: { key: string; version: number }) =>
                file.version < (latestVersions.get(file.key) ?? file.version);
            if (!block || !block.files.some(isStale)) {
                continue;
            }
            const stripped = removeGhostFiles(block, isStale);
            const newMetadata = { ...msg.metadata };
            if (stripped === null || isEmptyGhostBlock(stripped)) {
                delete newMetadata.last_ghost_block;
            } else {
                newMetadata.last_ghost_block = stripped;
            }
            msg.metadata = newMetadata;
            changed = true;
        }

        if (changed) {
            await this.persist();
        }
        return changed;
    }

    /** Assemble the complete LLM context (system + wire history) for debugging. */
    async debugContext(): Promise<string> {
        const systemPrompt = await assembleSystemPrompt(this.metadata);
        const wire = await assembleWireHistory(this);
        const messages: AgentMessage[] = [
            { role: 'system', content: [{ type: 'text', text: systemPrompt }], toolCalls: [] },
            ...wire,
        ];
        return formatMessagesToString(messages, { includeHeader: true });
    }

    /** Broadcast a fresh `session.state` snapshot (after truncate/prune, or on open). */
    async broadcastSnapshot(): Promise<void> {
        const snapshot = await buildSessionSnapshot(this, this.deps.approvals);
        this.deps.bus.emitBtF('session.state', snapshot);
    }

    // ------------------------------------------------------------------
    // Approval / dispatch delegation (tools go through here)
    // ------------------------------------------------------------------

    /**
     * Simple-tool approval path: resolves to null when approved, otherwise to
     * the `[Rejected]`/`[Cancelled]` message the tool returns to the model.
     */
    async requestApproval(
        actionDescription: string,
        targetUri: string,
        toolName: string,
        details?: string,
    ): Promise<string | null> {
        const { promise } = this.requestApprovalWithAction({
            actionDescription,
            targetUri,
            toolName,
            details,
        });
        const resolution = await promise;
        return this.formatApprovalResolution(toolName, resolution);
    }

    /**
     * Full approval path (edit transactions): supports custom actions and an
     * onApprove callback whose return value becomes the resolution payload.
     * Returns the request id (null for auto-approved) so callers can cancel a
     * pending request.
     */
    requestApprovalWithAction(
        init: Omit<ApprovalRequestInit, 'sessionId' | 'abortSignal'> & { abortSignal?: AbortSignal },
    ): { requestId: string | null; promise: Promise<ApprovalResolution> } {
        const { id, promise } = this.deps.approvals.request({
            ...init,
            sessionId: this.sessionId,
            abortSignal: init.abortSignal ?? this.currentAbort?.signal,
        });
        return { requestId: id, promise };
    }

    /** Cancel a pending approval request (edit transaction override path). */
    cancelApproval(requestId: string): void {
        this.deps.approvals.cancel(requestId);
    }

    /**
     * Map an approval resolution to the tool-facing result string. Empty
     * rejection reasons terminate the session.
     */
    formatApprovalResolution(toolName: string, resolution: ApprovalResolution): string | null {
        switch (resolution.kind) {
            case 'approved':
                return null;
            case 'cancelled':
                return `[Cancelled] The ${toolName} operation was cancelled while waiting for approval.`;
            case 'rejected': {
                const reason = resolution.reason?.trim();
                if (!reason) {
                    this.terminationHook?.(false);
                    return `[Rejected] The ${toolName} operation was rejected by user.`;
                }
                return `[Rejected with Reason] The ${toolName} operation was rejected by user. Reason: ${reason}`;
            }
        }
    }

    /**
     * dispatch_subagents entry point (parent side; called after approval).
     * Creates and immediately starts every child in the background, then
     * resolves right away with the children manifest — children report back
     * via task_finish, which lands as steered agent messages.
     */
    async requestDispatch(
        contextBroadcast: string,
        subAgents: DispatchRequestItem[],
    ): Promise<string> {
        // Pre-generate uuids so every child's prompt carries the full identity
        // block (own id, parent id, sibling ids).
        const planned = subAgents.map(sub => ({
            sub,
            uuid: uuidv4(),
            agentType: sub.agent_type || 'implementer',
        }));

        const siblingList = planned.map(p => `${p.uuid} (${p.agentType})`).join(', ');
        const children: { session: BackendSession; prompt: string }[] = [];
        for (const { sub, uuid, agentType } of planned) {
            const taskPrompt = contextBroadcast
                ? `## Context Summary\n\n${contextBroadcast}\n\n---\n\n${sub.prompt}`
                : sub.prompt;
            const identityBlock = [
                '## Agent Identity',
                `- Your session id: ${uuid}`,
                `- Your parent agent session id: ${this.sessionId}`,
                `- Sibling agents from this dispatch: ${siblingList}`,
                'Use the `communicate` tool to message any of them by session id. Use `task_finish` to report completion to your parent.',
            ].join('\n');
            const fullPrompt = `${taskPrompt}\n\n${identityBlock}`;
            const child = await this.deps.registry.createAgent({
                agentType,
                prompt: fullPrompt,
                allowedUris: sub.allowed_uris,
                modelSelection: sub.modelSelection,
                parentId: this.sessionId,
                uuid,
            });
            children.push({ session: child, prompt: fullPrompt });
        }

        for (const child of children) {
            child.session.enqueueUserMessage(child.prompt, 'queue');
        }

        const manifest = children
            .map(c => `- '${c.session.metadata.name}' (${c.session.sessionId})`)
            .join('\n');
        return [
            `Created and started ${children.length} sub-agent(s):`,
            manifest,
            '',
            'They are now running in the background. Each one reports back when it finishes; completion reports arrive as user messages. Continue your own work or end your turn to wait for them.',
        ].join('\n');
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private buildToolSet(): ToolSet {
        if (this.emptyToolSet) {
            return createEmptyToolSet();
        }
        if (!this.metadata.agentType) {
            throw new Error('Agent has no agentType. All agents must have a valid agentType defined in their metadata.');
        }
        return createToolSetForAgent({
            agentType: this.metadata.agentType,
            agentId: this.sessionId,
            parentAgentId: this.metadata.parent_agent_id,
            enabledMcpTools: this.metadata.enabledMcpTools,
        });
    }

    private resolveRunOptions(): AgentRunOptions {
        const metadataModel = this.metadata.model;
        const metadataProvider = this.metadata.provider;

        let model: string;
        let provider: string;
        if (metadataModel && metadataProvider) {
            const resolved = resolveModelSelection({ model: metadataModel, provider: metadataProvider });
            model = resolved.model;
            provider = resolved.provider;
        } else if (!metadataModel) {
            const resolved = getDefaultModelSelection();
            model = resolved.model;
            provider = resolved.provider;
        } else {
            throw new Error(
                'Agent metadata is missing the required provider field. ' +
                'Update the agent file by re-selecting the model.',
            );
        }

        const credentials = getModelCredentials(model, provider);
        return {
            model,
            apiKey: credentials.apiKey,
            baseUrl: credentials.baseUrl,
            providerType: credentials.providerType,
            maxLoops: this.maxLoops,
            reasoningEffort: normalizeReasoningEffort(this.metadata.reasoning_effort),
        };
    }

    private setRunning(running: boolean, reason?: SessionStopReason): void {
        this.status = running ? 'running' : 'idle';
        if (!running) {
            this.lastStopReason = reason;
        }
        const entry = this.deps.registry.get(this.sessionId);
        if (entry) {
            entry.isRunning = running;
        }
        this.emitStatus(reason);
        this.deps.registry.emitChanged();
    }

    private emitStatus(reason?: SessionStopReason): void {
        this.deps.bus.emitBtF('session.status', {
            sessionId: this.sessionId,
            status: this.status,
            reason,
            queuedCount: this.queue.length,
        });
    }
}
