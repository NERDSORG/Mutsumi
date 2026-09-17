/**
 * @fileoverview Dispatch session manager — sub-agent orchestration.
 *
 * Flow:
 *
 * 1. The parent's dispatch_subagents tool calls `requestDispatch`.
 * 2. Each sub-agent is created through AgentRegistry.createAgent (file
 *    persisted immediately) and the children manifest is broadcast as
 *    `dispatch.requested`; the parent stays suspended.
 * 3. Some frontend answers with `dispatch.respond`: approve → every child
 *    session gets its prompt enqueued and runs in the background right away;
 *    reject → the child files are deleted and the dispatch resolves with a
 *    rejection report.
 * 4. Each child's task_finish lands in `reportTaskFinished`; once every
 *    child has reported (or was deleted), the aggregated report resolves the
 *    parent tool call.
 *
 * Child sessions are first-class sessions: their created/status/output events
 * broadcast like any other session.
 *
 * @module backend/dispatchManager
 */

import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import type { EventBus } from './eventBus';
import type { AgentRegistry } from './agentRegistry';
import type { BackendSession } from './backendSession';
import type {
    DispatchChildInfo,
    DispatchRequestItem,
    DispatchSession,
    PendingDispatchInfo,
} from './interfaces';

/**
 * Manages dispatch sessions for sub-agents. See module docstring.
 */
export class DispatchSessionManager {
    /** Active dispatch sessions keyed by parent session id. */
    private readonly activeDispatches = new Map<string, DispatchSession>();

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    /** Fires when the pending dispatch list changes (sidebar subscription). */
    readonly onDidChange = this._onDidChange.event;

    constructor(
        private readonly bus: EventBus,
        private readonly registry: AgentRegistry,
    ) {}

    /**
     * Create child sessions, broadcast the dispatch approval request and
     * suspend until all children finish (or are deleted). Resolves with the
     * aggregated report.
     */
    async requestDispatch(
        parent: BackendSession,
        contextBroadcast: string,
        subAgents: DispatchRequestItem[],
        signal?: AbortSignal,
    ): Promise<string> {
        if (signal?.aborted) {
            throw new Error('Operation aborted');
        }
        const parentId = parent.sessionId;

        return new Promise<string>((resolve, reject) => {
            void (async () => {
                const requestId = uuidv4();
                const childUuids = new Set<string>();
                const childSessions: BackendSession[] = [];
                const children: DispatchChildInfo[] = [];

                try {
                    for (const sub of subAgents) {
                        const agentType = sub.agent_type || 'implementer';
                        // Sub-agents use their own agentType defaults (rules/skills/MCP snapshot).
                        const combinedPrompt = contextBroadcast
                            ? `## Context Summary\n\n${contextBroadcast}\n\n---\n\n${sub.prompt}`
                            : sub.prompt;
                        const childSession = await this.registry.createAgent({
                            agentType,
                            prompt: combinedPrompt,
                            allowedUris: sub.allowed_uris,
                            modelSelection: sub.modelSelection,
                            parentId,
                        });
                        childUuids.add(childSession.sessionId);
                        childSessions.push(childSession);
                        children.push({
                            sessionId: childSession.sessionId,
                            prompt: combinedPrompt,
                            agentType,
                            allowedUris: sub.allowed_uris,
                        });
                    }
                } catch (e) {
                    reject(e);
                    return;
                }

                const session: DispatchSession = {
                    parentId,
                    requestId,
                    resolve,
                    reject,
                    childUuids,
                    childSessions,
                    children,
                    results: new Map(),
                    deletedChildren: new Set(),
                    responded: false,
                };
                this.activeDispatches.set(parentId, session);
                this._onDidChange.fire();
                this.bus.emitBtF('dispatch.requested', { sessionId: parentId, requestId, children });

                if (signal) {
                    signal.addEventListener('abort', () => {
                        this.cancelSession(parentId, 'User aborted execution');
                    });
                }
            })();
        });
    }

    /**
     * Settle a pending dispatch approval. Approve starts every child in the
     * background; reject deletes the child files and resolves the dispatch
     * with a rejection report.
     */
    async respond(
        sessionId: string,
        requestId: string,
        outcome: 'approve' | 'reject',
        origin?: string,
    ): Promise<void> {
        const session = this.activeDispatches.get(sessionId);
        if (!session || session.requestId !== requestId || session.responded) {
            return;
        }
        session.responded = true;
        this.bus.emitBtF('dispatch.resolved', { sessionId, requestId, outcome, origin });

        if (outcome === 'approve') {
            // Start every child in the background; the parent's tool call
            // resolves when all children report via task_finish (or are deleted).
            for (let i = 0; i < session.childSessions.length; i++) {
                session.childSessions[i].enqueueUserMessage(session.children[i].prompt, 'queue');
            }
            if (session.childSessions.length === 0) {
                this.activeDispatches.delete(sessionId);
                session.resolve('No sub-agents were created.');
            }
        } else {
            this.activeDispatches.delete(sessionId);
            for (const childId of session.childUuids) {
                try {
                    await this.registry.deleteAgent(childId);
                } catch (e) {
                    console.error('[DispatchSessionManager] Failed to delete rejected child:', e);
                }
            }
            session.resolve(
                `Dispatch rejected by user. ${session.childUuids.size} sub-agent(s) were not started; their session files were deleted.`,
            );
        }
        this._onDidChange.fire();
    }

    /**
     * A child agent called task_finish: record the result and complete the
     * dispatch session once every child has reported or was deleted.
     */
    reportTaskFinished(childUuid: string, summary: string): void {
        const agent = this.registry.get(childUuid);
        if (!agent) {
            return;
        }
        this.registry.emitChanged();
        if (!agent.parentId) {
            return;
        }
        const session = this.activeDispatches.get(agent.parentId);
        if (!session || !session.childUuids.has(childUuid)) {
            return;
        }
        session.results.set(childUuid, summary);
        this.checkSessionCompletion(agent.parentId);
    }

    /** A child agent file was deleted (counts towards dispatch completion). */
    handleChildDeleted(parentId: string, childUuid: string): void {
        const session = this.activeDispatches.get(parentId);
        if (!session || !session.childUuids.has(childUuid)) {
            return;
        }
        session.deletedChildren.add(childUuid);
        this.checkSessionCompletion(parentId);
    }

    /** Cancel a dispatch session (parent run aborted), rejecting its promise. */
    cancelSession(parentId: string, reason: string): void {
        const session = this.activeDispatches.get(parentId);
        if (!session) {
            return;
        }
        this.activeDispatches.delete(parentId);
        if (!session.responded) {
            // Clear the pending approval card on all frontends.
            this.bus.emitBtF('dispatch.resolved', {
                sessionId: parentId,
                requestId: session.requestId,
                outcome: 'reject',
            });
        }
        this._onDidChange.fire();
        session.reject(new Error(reason));
    }

    /** Pending (unresponded) dispatch approvals, for the sidebar tree. */
    getPendingDispatches(): PendingDispatchInfo[] {
        return [...this.activeDispatches.values()]
            .filter(s => !s.responded)
            .map(s => ({ requestId: s.requestId, parentId: s.parentId, children: s.children }));
    }

    private checkSessionCompletion(parentId: string): void {
        const session = this.activeDispatches.get(parentId);
        if (!session) {
            return;
        }
        for (const childId of session.childUuids) {
            if (!session.results.has(childId) && !session.deletedChildren.has(childId)) {
                return;
            }
        }
        this.activeDispatches.delete(parentId);
        this._onDidChange.fire();
        session.resolve(this.generateReport(session));
    }

    private generateReport(session: DispatchSession): string {
        const successSummaries = [...session.results.entries()].map(([uuid, text]) => {
            const name = this.registry.get(uuid)?.name || uuid.slice(0, 6);
            return `### Sub-agent '${name}' Finished:\n${text}`;
        });
        const deletedSummaries = [...session.deletedChildren].map(
            uuid => `### Sub-agent ${uuid.slice(0, 6)} was deleted (Cancelled).`,
        );
        const finalReport = [...successSummaries, ...deletedSummaries].join('\n\n----------------\n\n');
        if (!finalReport.trim()) {
            return 'All sub-agents were deleted or produced no output.';
        }
        return finalReport;
    }
}
