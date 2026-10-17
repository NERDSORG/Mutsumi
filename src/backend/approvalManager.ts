/**
 * @fileoverview Backend approval request manager.
 *
 * The manager is the single authority for tool approvals. A request either
 * auto-approves (global setting / pre-execution plane) or is broadcast as
 * `approval.requested` and suspended until some frontend answers with
 * `approval.respond`; the first respond wins and an `approval.resolved` fact
 * is broadcast so every other frontend immediately drops the card.
 *
 * Rejection reasons arrive with the respond payload.
 *
 * Any change to the request list (a request is suspended, settled, an
 * auto-approved trace is recorded, or an expired trace is removed) is
 * broadcast as the bare `approval.changed` notification; the in-process
 * sidebar approval tree subscribes to it and reads the records back via
 * `getAllRequests()` (the same pattern as `sessions.changed` for the agent
 * tree).
 *
 * @module backend/approvalManager
 */

import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import type { EventBus } from './eventBus';
import type { ApprovalRequestInfo } from './events';
import type {
    ApprovalRequestInit,
    ApprovalRequestRecord,
    ApprovalResolution,
} from './interfaces';
import { isInPreExecution } from '../tools.d/preExecution';

const AUTO_APPROVE_CONFIG_KEY = 'mutsumi.autoApproveEnabled';

/** Check if auto-approve mode is enabled globally. */
export function isAutoApproveEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(AUTO_APPROVE_CONFIG_KEY, false);
}

/** Set auto-approve mode globally. */
export async function setAutoApproveEnabled(enabled: boolean): Promise<void> {
    await vscode.workspace.getConfiguration().update(AUTO_APPROVE_CONFIG_KEY, enabled, true);
}

interface PendingEntry {
    info: ApprovalRequestInfo;
    status: 'pending' | 'approved' | 'rejected';
    resolve: (resolution: ApprovalResolution) => void;
    reject: (error: unknown) => void;
    customActionHandler?: () => Promise<void>;
    onApprove?: () => Promise<unknown>;
}

/**
 * Approval request authority. See module docstring.
 */
export class ApprovalRequestManager {
    private readonly requests = new Map<string, PendingEntry>();

    constructor(private readonly bus: EventBus) {}

    /**
     * Request approval for a tool action. Auto-approves (with a recorded
     * trace, `id: null`) when the global switch is on or the call happens on
     * the pre-execution plane. Returns the request id (needed by edit
     * transactions to cancel a pending request) plus the resolution promise.
     */
    request(init: ApprovalRequestInit): { id: string | null; promise: Promise<ApprovalResolution> } {
        const preExecution = isInPreExecution();
        const autoApprove = isAutoApproveEnabled() || preExecution;

        if (autoApprove) {
            const promise = (async (): Promise<ApprovalResolution> => {
                try {
                    const payload = await init.onApprove?.();
                    return { kind: 'approved', payload };
                } finally {
                    // Pre-execution calls are explicitly authored by the user
                    // (`@[tool{...}]`), so they leave no approval trace; the
                    // global auto-approve switch keeps its trace for auditing.
                    if (!preExecution) {
                        this.recordTrace(init, true);
                    }
                }
            })();
            return { id: null, promise };
        }

        if (init.abortSignal?.aborted) {
            return { id: null, promise: Promise.resolve({ kind: 'cancelled' }) };
        }

        let resolveFn!: (resolution: ApprovalResolution) => void;
        let rejectFn!: (error: unknown) => void;
        const promise = new Promise<ApprovalResolution>((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
        });

        const id = uuidv4();
        const info: ApprovalRequestInfo = {
            id,
            sessionId: init.sessionId,
            toolName: init.toolName,
            actionDescription: init.actionDescription,
            targetUri: init.targetUri,
            details: init.details,
            customAction: init.customAction
                ? { label: init.customAction.label, localOnly: init.customAction.localOnly }
                : undefined,
            autoApproved: false,
            timestamp: Date.now(),
        };
        const entry: PendingEntry = {
            info,
            status: 'pending',
            resolve: resolveFn,
            reject: rejectFn,
            customActionHandler: init.customAction?.handler,
            onApprove: init.onApprove,
        };
        this.requests.set(id, entry);
        this.bus.emitBtF('approval.changed', {});
        this.bus.emitBtF('approval.requested', { sessionId: init.sessionId, request: { ...info } });

        if (init.abortSignal) {
            const onAbort = () => {
                this.cancel(id);
            };
            if (init.abortSignal.aborted) {
                onAbort();
            } else {
                init.abortSignal.addEventListener('abort', onAbort, { once: true });
            }
        }

        return { id, promise };
    }

    /**
     * Settle (or, for `custom`, act on) a pending request. The first respond
     * wins; every frontend is notified through `approval.resolved`.
     */
    async respond(
        sessionId: string,
        requestId: string,
        outcome: 'approve' | 'reject' | 'custom',
        reason?: string,
        origin?: string,
    ): Promise<void> {
        const entry = this.requests.get(requestId);
        if (!entry || entry.status !== 'pending') {
            return;
        }

        if (outcome === 'custom') {
            if (entry.customActionHandler) {
                try {
                    await entry.customActionHandler();
                } catch (e) {
                    console.error('[ApprovalRequestManager] custom action failed:', e);
                }
            }
            return; // custom actions never settle the request
        }

        entry.status = outcome === 'approve' ? 'approved' : 'rejected';

        if (outcome === 'approve') {
            try {
                const payload = await entry.onApprove?.();
                entry.resolve({ kind: 'approved', payload });
            } catch (error) {
                entry.reject(error);
            }
        } else {
            entry.resolve({ kind: 'rejected', reason });
        }

        this.bus.emitBtF('approval.resolved', { sessionId, requestId, outcome, reason, origin });
        this.bus.emitBtF('approval.changed', {});
        // Keep the resolved record briefly so the sidebar can show the outcome.
        setTimeout(() => {
            if (this.requests.get(requestId) === entry) {
                this.requests.delete(requestId);
                this.bus.emitBtF('approval.changed', {});
            }
        }, 1000);
    }

    /** Cancel a pending request without an approve/reject outcome (abort path). */
    cancel(requestId: string): void {
        const entry = this.requests.get(requestId);
        if (!entry || entry.status !== 'pending') {
            return;
        }
        entry.status = 'rejected';
        entry.resolve({ kind: 'cancelled' });
        this.bus.emitBtF('approval.resolved', {
            sessionId: entry.info.sessionId,
            requestId,
            outcome: 'reject',
        });
        this.requests.delete(requestId);
        this.bus.emitBtF('approval.changed', {});
    }

    /** Cancel every pending request belonging to a session (run interrupted). */
    cancelSessionRequests(sessionId: string): void {
        for (const [id, entry] of [...this.requests]) {
            if (entry.info.sessionId === sessionId && entry.status === 'pending') {
                this.cancel(id);
            }
        }
    }

    getPendingRequests(sessionId?: string): ApprovalRequestInfo[] {
        return [...this.requests.values()]
            .filter(r => r.status === 'pending' && (!sessionId || r.info.sessionId === sessionId))
            .map(r => r.info);
    }

    /** Sidebar view: all requests (pending first, newer first). */
    getAllRequests(): ApprovalRequestRecord[] {
        return [...this.requests.values()]
            .map(({ info, status }) => ({ info: { ...info }, status }))
            .sort((a, b) => {
                if (a.status === 'pending' && b.status !== 'pending') return -1;
                if (a.status !== 'pending' && b.status === 'pending') return 1;
                return b.info.timestamp - a.info.timestamp;
            });
    }

    /** Record an auto-approved request so the sidebar keeps a history trace. */
    private recordTrace(init: ApprovalRequestInit, autoApproved: boolean): void {
        const id = uuidv4();
        this.requests.set(id, {
            info: {
                id,
                sessionId: init.sessionId,
                toolName: init.toolName,
                actionDescription: init.actionDescription,
                targetUri: init.targetUri,
                details: init.details,
                autoApproved,
                timestamp: Date.now(),
            },
            status: 'approved',
            resolve: () => {},
            reject: () => {},
        });
        this.bus.emitBtF('approval.changed', {});
        setTimeout(() => {
            this.requests.delete(id);
            this.bus.emitBtF('approval.changed', {});
        }, 1000);
    }
}
