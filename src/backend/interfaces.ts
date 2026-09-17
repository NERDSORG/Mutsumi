/**
 * @fileoverview Pure interface contracts for the backend module: the
 * contracts of the registry / session / approval / dispatch classes. The
 * event protocol (payload maps and name registries) lives in events.ts.
 *
 * @module backend/interfaces
 */

import type { ModelSelection } from '../types';
import type { BackendSession } from './backendSession';
import type { EventBus } from './eventBus';
import type { SessionStore } from './sessionStore';
import type { ApprovalRequestManager } from './approvalManager';
import type { AgentRegistry } from './agentRegistry';
import type { ApprovalRequestInfo } from './events';

// ============================================================================
// Session contracts
// ============================================================================

export type SessionStatus = 'idle' | 'running';
export type SessionStopReason = 'completed' | 'interrupted' | 'error';

/** A user message waiting in the session's run queue. */
export interface QueuedUserMessage {
    text: string;
    mode: 'queue' | 'steer';
}

/** Services a session needs from the backend container. */
export interface BackendSessionDeps {
    bus: EventBus;
    store: SessionStore;
    approvals: ApprovalRequestManager;
    registry: AgentRegistry;
    /** Materialize (or fetch) a registered session by uuid. */
    materializeSession: (uuid: string) => Promise<BackendSession>;
    /** Fetch an already-materialized session by uuid (undefined if cold). */
    getMaterializedSession: (uuid: string) => BackendSession | undefined;
    /** Triggered after the run answering the session's first user message. */
    onFirstTurnCompleted?: (session: BackendSession) => void;
}

/** Options controlling a session's run behavior. */
export interface BackendSessionOptions {
    maxLoops?: number;
    /** Ephemeral/lite sessions run without tools. */
    emptyToolSet?: boolean;
}

// ============================================================================
// Registry contracts
// ============================================================================

/** Options for the sole agent-creation entry point. */
export interface CreateAgentOptions {
    agentType: string;
    name?: string;
    /** Initial prompt; kept on the registry entry, enqueued by the caller. */
    prompt?: string;
    /** Pre-generated uuid override (dispatch pre-generates to embed identity blocks). */
    uuid?: string;
    allowedUris?: string[];
    modelSelection?: ModelSelection;
    rules?: string[];
    skills?: string[];
    /** Override the agent type's defaultMcpServers for this session. */
    mcpServers?: string[];
    parentId?: string | null;
    /** Echoed back on the `session.created` broadcast for request correlation. */
    requestId?: string;
}

// ============================================================================
// Approval contracts
// ============================================================================

/** Init parameters for {@link ApprovalRequestManager.request}. */
export interface ApprovalRequestInit {
    sessionId: string;
    toolName: string;
    actionDescription: string;
    targetUri: string;
    details?: string;
    /**
     * Optional local action offered on the approval card (e.g. "view/edit
     * diff"). `localOnly` actions are not advertised to remote (ACP) clients.
     * The handler runs in the extension host and does NOT settle the request.
     */
    customAction?: { label: string; localOnly?: boolean; handler: () => Promise<void> };
    /** Aborts the pending request (resolves as cancelled) when fired. */
    abortSignal?: AbortSignal;
    /**
     * Runs on approval before the request resolves; the returned value becomes
     * the resolution payload (used by the edit transaction to surface the
     * "accepted with manual edits" diff).
     */
    onApprove?: () => Promise<unknown>;
}

/** How a suspended approval request concluded. */
export type ApprovalResolution =
    | { kind: 'approved'; payload?: unknown }
    | { kind: 'rejected'; reason?: string }
    | { kind: 'cancelled' };

/** Sidebar-facing record (includes resolved history entries). */
export interface ApprovalRequestRecord {
    info: ApprovalRequestInfo;
    status: 'pending' | 'approved' | 'rejected';
}

// ============================================================================
// Dispatch contracts
// ============================================================================

/** One sub-agent requested by the dispatch_subagents tool. */
export interface DispatchRequestItem {
    prompt: string;
    allowed_uris: string[];
    agent_type?: string;
    modelSelection?: ModelSelection;
}
