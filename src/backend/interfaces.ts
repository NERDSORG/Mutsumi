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

/**
 * One inbound stimulus for a session: `text` is the source markdown (raw input
 * for `user`/`agent`, injection markdown for `injection`). `kind` decides the
 * committed message's `messageType` tag and its UI card type only.
 */
export type InboundItem = { kind: 'user' | 'injection' | 'agent'; text: string };

/** An inbound item waiting in the session's run queue. */
export interface QueuedInbound {
    item: InboundItem;
    /**
     * When the item drains. `queue`: batched into a turn after the run ends.
     * `steer`: at the next round boundary, else with that same batch.
     */
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
    /** Initial prompt; enqueued by the caller. */
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
    /** Filled by `BackendSession` from `context.toolSession.toolName`. */
    toolName: string;
    /**
     * Request label shared by all approval frontends; filled by
     * `BackendSession` from `context.callDescription` (may carry `$(icon)`).
     */
    actionDescription: string;
    targetUri: string;
    details?: string;
    /**
     * Optional local action on the approval card (e.g. "view/edit diff");
     * `localOnly` actions are not advertised to remote (ACP) clients. The
     * handler runs in the extension host and does not settle the request.
     */
    customAction?: { label: string; localOnly?: boolean; handler: () => Promise<void> };
    /** Aborts the pending request (resolves as cancelled) when fired. */
    abortSignal?: AbortSignal;
    /**
     * Runs on approval; the returned value becomes the resolution payload.
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
    /** Becomes the child session's title and locks title generation */
    name?: string;
}
