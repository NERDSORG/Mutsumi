/**
 * @fileoverview BackendSession — the single session implementation. Owns the
 * session's full truth (metadata, flat message history, inbound queue,
 * current render IR, abort handle) and is the single write point for history
 * (`commitMessage`) and persistence (`persist`). Frontends observe it through
 * BtF events only. `fileUri === null` marks an ephemeral session: it emits
 * events but never touches the disk or the registry.
 *
 * @module backend/backendSession
 */

import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { createToolMessage, extractText } from '@moonshot-ai/kosong';
import type { AgentMessage, AgentMetadata } from '../types';
import type { McpToolSelection } from '../tools.d/mcp/interfaces';
import type { RenderData } from '../shared/renderTypes';
import { RenderDataBuilder } from '../agent/renderDataBuilder';
import { ToolSet } from '../tools.d/toolSet';
import { createEmptyToolSet, createToolSetForAgent } from '../tools.d/agentToolSet';
import { getUserToolSet } from '../tools.d/userToolSet';
import type { ToolContext } from '../tools.d/interface';
import type { AgentRunOptions } from '../agent/interfaces';
import { normalizeReasoningEffort } from '../agent/types';
import {
    assembleSystemPrompt,
    assembleUserInput,
    assembleWireHistory,
} from '../contextManagement/history';
import {
    createInjectionMessage,
    getMessageType,
} from '../contextManagement/messageTypes';
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
    InboundExecution,
    InboundItem,
    QueuedInbound,
    SessionStatus,
    SessionStopReason,
} from './interfaces';
import { buildSessionSnapshot, formatMessagesToString } from './snapshot';

/** Execution policy snapshot of an agent-authored item; undefined when the author has no agent type. */
function agentExecution(author: BackendSession | undefined): InboundExecution | undefined {
    const agentType = author?.metadata.agentType;
    if (!author || !agentType) {
        return undefined;
    }
    return {
        toolSet: createToolSetForAgent({
            agentType,
            agentId: author.sessionId,
            parentAgentId: author.metadata.parent_agent_id,
            enabledMcpTools: author.metadata.enabledMcpTools,
        }),
        skipApproval: false,
    };
}

/** Execution policy of a user- or rules-authored item: the user plane, without approval. */
function userPlaneExecution(): InboundExecution {
    return { toolSet: getUserToolSet(false), skipApproval: true };
}

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
     * Termination signaling hook of the in-flight tool batch, set by
     * ToolExecutor while executing tools.
     */
    terminationHook: ((isTaskComplete: boolean) => void) | null = null;

    private queue: QueuedInbound[] = [];
    private drainPromise: Promise<void> | null = null;
    /**
     * Epoch of the drain loop. `truncateFrom` bumps it so the in-flight loop
     * exits instead of consuming the queue.
     */
    private drainEpoch = 0;
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
        this.maxLoops = options?.maxLoops ?? 200;
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
     * The single history write point: appends the message and queues a
     * persist.
     * @returns The index of the appended message in the flat history
     */
    commitMessage(msg: AgentMessage): number {
        this.history.push(msg);
        void this.persist();
        return this.history.length - 1;
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
     * Commit one inbound item: assemble it, then commit a `role: 'user'` message tagged with
     * the item's kind (`user` untagged) followed by the derived injection message, if any.
     * @returns The committed messages in commit order
     */
    private async commitInbound(item: InboundItem): Promise<AgentMessage[]> {
        const { text, injectionMarkdown } = await assembleUserInput(this, item.text, item.execution);
        const message: AgentMessage = {
            role: 'user',
            content: [{ type: 'text', text }],
            toolCalls: [],
        };
        if (item.kind !== 'user') {
            message.metadata = { messageType: item.kind };
        }
        this.commitMessage(message);
        await this.persist();
        this.broadcastMetadata();
        if (injectionMarkdown === null) {
            return [message];
        }
        const injectionMessage = createInjectionMessage(injectionMarkdown);
        this.commitMessage(injectionMessage);
        return [message, injectionMessage];
    }

    // ------------------------------------------------------------------
    // Queue / run semantics
    // ------------------------------------------------------------------

    /** Enqueue a user message; its `@[tool{...}]` runs on the user plane without approval. */
    enqueueUserMessage(text: string, mode: 'queue' | 'steer' = 'queue'): void {
        this.enqueue({ kind: 'user', text, execution: userPlaneExecution() }, mode);
    }

    /** Enqueue a context-injection message (final markdown); its `@[tool{...}]` stays literal. */
    enqueueInjection(text: string, mode: 'queue' | 'steer' = 'queue'): void {
        this.enqueue({ kind: 'injection', text }, mode);
    }

    /** Enqueue an agent-to-agent message; the author's tool-set snapshot governs its `@[tool{...}]`. */
    enqueueAgentMessage(
        text: string,
        mode: 'queue' | 'steer' = 'queue',
        author?: BackendSession,
    ): void {
        this.enqueue({ kind: 'agent', text, execution: agentExecution(author) }, mode);
    }

    private enqueue(item: InboundItem, mode: 'queue' | 'steer'): void {
        this.queue.push({ item, mode });
        this.emitStatus();
        if (!this.drainPromise) {
            this.startDrain();
        }
    }

    /**
     * Drain due inbound items, yielding in commit order (the caller finishes each item before the
     * next pull) and emitting `turnStarted` + `inboundCommitted` per committed message.
     */
    async *drainInbound(due: (queued: QueuedInbound) => boolean): AsyncGenerator<AgentMessage> {
        for (;;) {
            const index = this.queue.findIndex(due);
            if (index === -1) {
                return;
            }
            const queued = this.queue.splice(index, 1)[0];
            this.emitStatus();
            // This item's commits are contiguous; the first lands at `base`.
            const base = this.history.length;
            const committed = await this.commitInbound(queued.item);
            for (let offset = 0; offset < committed.length; offset++) {
                const msg = committed[offset];
                const historyIndex = base + offset;
                const messageType = getMessageType(msg);
                this.deps.bus.emitBtF('session.turnStarted', {
                    sessionId: this.sessionId,
                    historyIndex,
                });
                // Raw user input is the card text; every other message projects its content.
                const text = messageType === 'user' ? queued.item.text : extractText(msg);
                this.deps.bus.emitBtF('session.inboundCommitted', {
                    sessionId: this.sessionId,
                    messageType,
                    text,
                    historyIndex,
                });
                yield msg;
            }
        }
    }

    /**
     * Apply one committed inbound message to the current turn's render IR and
     * publish it: every message opens its own row, so the builder seals the
     * previous row and starts a fresh one.
     */
    applyCommittedToTurn(): void {
        const builder = this.renderDataBuilder ?? (this.renderDataBuilder = new RenderDataBuilder());
        builder.commitTurnBoundary();
        this.publishRenderData(builder.getRenderData());
    }

    /**
     * Run turns serially while the epoch is current and the queue is
     * non-empty; each iteration batch-consumes every currently due item into
     * one turn. `truncateFrom` supersedes the epoch, so the retiring loop
     * exits without consuming the queue.
     */
    private async drainLoop(): Promise<void> {
        const epoch = this.drainEpoch;
        while (epoch === this.drainEpoch && this.queue.length > 0) {
            await this.executeTurn();
        }
    }

    /** Start the drain loop; the handle clears itself when the loop settles. */
    private startDrain(): void {
        this.drainPromise = this.drainLoop().finally(() => {
            this.drainPromise = null;
        });
    }

    private async executeTurn(): Promise<void> {
        this.setRunning(true);
        const abortController = new AbortController();
        this.currentAbort = abortController;
        let reason: SessionStopReason = 'completed';
        let firstTurn = false;
        try {
            const preDrainHadUserMessage = this.history.some(
                m => m.role === 'user' && getMessageType(m) === 'user',
            );
            this.renderDataBuilder = new RenderDataBuilder();
            this.currentTurnRenderData = null;
            let batchContainedUserMessage = false;
            // Batch-drain every due item into this turn; each message is
            // applied to the render IR as it commits.
            for await (const msg of this.drainInbound(() => true)) {
                this.applyCommittedToTurn();
                if (msg.role === 'user' && getMessageType(msg) === 'user') {
                    batchContainedUserMessage = true;
                }
            }
            firstTurn = !preDrainHadUserMessage && batchContainedUserMessage;

            const systemPrompt = await assembleSystemPrompt(this.metadata, this, userPlaneExecution());
            const wireHistory = await assembleWireHistory(this);
            const toolSet = this.buildToolSet();
            const options = this.resolveRunOptions();

            // Dynamic import: agentRunner only imports this module's type, so
            // the value edge stays lazy (no module cycle).
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
     * Cascades to every materialized descendant session.
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

        // Cascade to materialized descendants (cold ones have no run to stop).
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
            // Wait for the in-flight turn to settle in its finally block.
            await Promise.all([this.drainPromise, ...childInterrupts]);
            return;
        }
        await Promise.all(childInterrupts);
        this.emitStatus('interrupted');
    }

    /**
     * Cascade-delete the history from `fromIndex` onwards: bump the drain
     * epoch and drop the queued items (the in-flight loop retires at its next
     * iteration boundary), interrupt when running, slice, repair the tail,
     * emit `session.historyTruncated` synchronously (before the persist await)
     * and restart the drain for items queued meanwhile. Frontends drop rows
     * ≥ `fromIndex`.
     */
    async truncateFrom(fromIndex: number): Promise<void> {
        this.drainEpoch++;
        this.queue = [];
        if (this.currentAbort || this.drainPromise) {
            await this.interrupt();
        }
        const cut = Math.max(0, fromIndex);
        this.history = this.history.slice(0, cut);
        this.repairDanglingToolCalls();
        this.currentTurnRenderData = null;
        this.deps.bus.emitBtF('session.historyTruncated', {
            sessionId: this.sessionId,
            fromIndex: cut,
        });
        if (this.queue.length > 0 && !this.drainPromise) {
            this.startDrain();
        }
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
     * Repair the history tail: every assistant toolCall without a matching
     * tool message gets a synthetic `[Interrupted]` placeholder, keeping the
     * wire history legal after interrupts/truncations.
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
        this.metadata.title_locked = true;
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
     * Stop tracking a referenced file: drop its version/hash entry from
     * `metadata.contextItems`. History is never touched.
     */
    async removeContextFile(key: string): Promise<void> {
        const items = this.metadata.contextItems ?? [];
        this.metadata.contextItems = items.filter(i => !(i.type === 'file' && i.key === key));
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
     * as a steered agent message. Callable repeatedly.
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
     * Deliver a steered agent message to another session: injected at the next
     * round boundary while the target runs, otherwise wakes it with a new turn.
     * Returns the status string for the calling tool.
     */
    async deliverAgentMessage(targetUuid: string, text: string): Promise<string> {
        const targetEntry = this.deps.registry.get(targetUuid);
        if (!targetEntry) {
            return `Error: target session '${targetUuid}' not found (deleted?).`;
        }
        const target = await this.deps.materializeSession(targetUuid);
        const wasRunning = target.status === 'running';
        target.enqueueAgentMessage(text, 'steer', this);
        return wasRunning
            ? `Message delivered to agent '${targetEntry.name}'; it will see it at the next round boundary.`
            : `Message delivered to agent '${targetEntry.name}'; it will wake up and process it.`;
    }

    // ------------------------------------------------------------------
    // Context operations
    // ------------------------------------------------------------------

    /** Assemble the complete LLM context (system + wire history) for debugging. */
    async debugContext(): Promise<string> {
        const systemPrompt = await assembleSystemPrompt(this.metadata, this, userPlaneExecution());
        const wire = await assembleWireHistory(this);
        const messages: AgentMessage[] = [
            { role: 'system', content: [{ type: 'text', text: systemPrompt }], toolCalls: [] },
            ...wire,
        ];
        return formatMessagesToString(messages, { includeHeader: true });
    }

    /** Broadcast a fresh `session.state` snapshot (hydration on open). */
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
     * The label is the tool's prettyPrint (`context.callDescription`).
     */
    async requestApproval(
        context: ToolContext,
        targetUri: string,
        details?: string,
    ): Promise<string | null> {
        const { promise } = this.requestApprovalWithAction(context, {
            targetUri,
            details,
        });
        const resolution = await promise;
        return this.formatApprovalResolution(context.toolSession.toolName, resolution);
    }

    /**
     * Full approval path (edit transactions): custom actions plus an
     * `onApprove` callback whose return value becomes the resolution payload.
     * Returns the request id (null when auto-approved) so callers can cancel it.
     */
    requestApprovalWithAction(
        context: ToolContext,
        init: Omit<ApprovalRequestInit, 'sessionId' | 'abortSignal' | 'actionDescription' | 'toolName' | 'skipApproval'> & { abortSignal?: AbortSignal },
    ): { requestId: string | null; promise: Promise<ApprovalResolution> } {
        const { id, promise } = this.deps.approvals.request({
            ...init,
            toolName: context.toolSession.toolName,
            actionDescription: context.callDescription,
            sessionId: this.sessionId,
            abortSignal: init.abortSignal ?? this.currentAbort?.signal,
            skipApproval: context.skipApproval,
        });
        return { requestId: id, promise };
    }

    /** Cancel a pending approval request (edit transaction override path). */
    cancelApproval(requestId: string): void {
        this.deps.approvals.cancel(requestId);
    }

    /**
     * Map an approval resolution to the tool-facing result string. An empty
     * rejection reason terminates the session.
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
     * dispatch_subagents entry point: creates and starts every child in the
     * background, then resolves with the children manifest. Children report
     * back through `task_finish` as steered agent messages.
     */
    async requestDispatch(
        contextBroadcast: string,
        subAgents: DispatchRequestItem[],
    ): Promise<string> {
        // Pre-generate uuids so each child's prompt carries the identity block.
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
                parentId: this.sessionId,
                uuid,
                name: sub.name?.trim() || undefined,
            });
            children.push({ session: child, prompt: fullPrompt });
        }

        for (const child of children) {
            child.session.enqueueAgentMessage(child.prompt, 'queue', this);
        }

        const manifest = children
            .map(c => `- '${c.session.metadata.name}' (${c.session.sessionId})`)
            .join('\n');
        return [
            `Created and started ${children.length} sub-agent(s):`,
            manifest,
            '',
            'They are now running in the background. Each one reports back when it finishes; completion reports arrive as agent messages. Continue your own work or end your turn to wait for them.',
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
