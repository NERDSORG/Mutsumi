/**
 * @fileoverview Internal event protocol between frontends and the agent
 * backend.
 *
 * FtB (frontend → backend) events are intents (commands); only the backend
 * subscribes to them. BtF (backend → frontend) events are facts (state
 * transitions); every frontend subscribes. Any FtB intent that changes
 * backend state is answered by a corresponding BtF fact.
 *
 * The two `as const` name arrays double as the runtime registry; the payload
 * maps are checked against them via `satisfies`. This module is imported by
 * the webview bundle for its types: it must stay free of vscode / Node value
 * imports.
 *
 * @module backend/events
 */

import type { AgentMessageType, AgentMetadata, ContextItem, McpToolSelection } from '../types';
import type { RenderData } from '../shared/renderTypes';

// ============================================================================
// Shared payload shapes
// ============================================================================

/** Serializable view of a pending (or resolved) approval request. */
export interface ApprovalRequestInfo {
    id: string;
    sessionId: string;
    toolName: string;
    /**
     * The tool's own prettyPrint for the requesting call; may carry a leading
     * `$(icon)` token (extracted by the webview, stripped elsewhere).
     */
    actionDescription: string;
    targetUri: string;
    details?: string;
    customAction?: { label: string; localOnly?: boolean };
    autoApproved: boolean;
    /** Epoch milliseconds (serialized; Date does not survive postMessage). */
    timestamp: number;
}

/**
 * One conversation turn for snapshot replay: the inbound message that opened
 * the turn row, plus the assistant/tool output following it as committed-only
 * RenderData.
 */
export interface Turn {
    /**
     * The `role: 'user'` message that opened this row; null only for an orphan
     * assistant/tool group at the head of the history.
     */
    inbound: { messageType: AgentMessageType; text: string; historyIndex: number } | null;
    /**
     * Index of the turn's opening message (or of the first message of an
     * orphan group) in the flat history; consumed by `history.truncate`.
     */
    messageIndex: number;
    renderData: RenderData;
}

/** Context-panel data bundled into the session snapshot. */
export interface ContextPanelData {
    rules: { name: string; active: boolean }[];
    skills: { name: string; description?: string; active: boolean }[];
    mcpServers: {
        serverId: string;
        status: string;
        error?: string;
        tools: { name: string; schemaValid: boolean; enabled: boolean }[];
    }[];
    contextItems: ContextItem[];
}

/** Full session state snapshot (`session.state` payload, hydration). */
export interface SessionSnapshot {
    sessionId: string;
    metadata: AgentMetadata;
    turns: Turn[];
    /** Live render IR of the in-flight turn; null when idle. */
    currentTurn: RenderData | null;
    status: 'idle' | 'running';
    reason?: 'completed' | 'interrupted' | 'error';
    queuedCount: number;
    pendingApprovals: ApprovalRequestInfo[];
    /** provider name → model identifiers */
    availableModels: Record<string, string[]>;
    autoApproveEnabled: boolean;
    contextPanel: ContextPanelData;
}

// ============================================================================
// FtB: Frontend → Backend (intents; subscribed by the backend only)
// ============================================================================

export interface FtBEventMap {
    /** Sole entry point for creating a session (command / dispatch tool / future ACP). */
    'session.create': {
        requestId: string;
        agentType: string;
        name?: string;
        prompt?: string;
        allowedUris?: string[];
        model?: string;
        provider?: string;
        rules?: string[];
        skills?: string[];
        mcpServers?: string[];
    };
    /** A frontend starts displaying the session; backend answers with a `session.state` snapshot. */
    'session.open': { sessionId: string };
    /** A frontend stops displaying the session (panel closed); the session keeps running. */
    'session.close': { sessionId: string };
    /** The session becomes the "current" one (drives context panels etc.). */
    'session.focus': { sessionId: string };
    'session.delete': { sessionId: string };
    'session.rename': { sessionId: string; name: string };
    'session.setModel': { sessionId: string; model: string; provider: string };
    /** `effort` undefined or 'default' removes the metadata override. */
    'session.setReasoningEffort': { sessionId: string; effort?: string };
    'userMessage.send': { sessionId: string; text: string; mode?: 'queue' | 'steer' };
    /** Hard-stop the current run; also clears the session's queue. */
    'run.interrupt': { sessionId: string };
    /** Cascade-delete the message at fromIndex and everything after it. */
    'history.truncate': { sessionId: string; fromIndex: number };
    'context.debug': { sessionId: string };
    'context.toggleRule': { sessionId: string; rule: string; active: boolean };
    'context.toggleSkill': { sessionId: string; skill: string; active: boolean };
    'context.setMcpTools': { sessionId: string; selection: McpToolSelection[] };
    /** Stop tracking a referenced file (drops its version tracking; history is never touched). */
    'context.removeFile': { sessionId: string; key: string };
    /** Remove a macro (template preprocessing no longer resolves it). */
    'context.removeMacro': { sessionId: string; key: string };
    'approval.respond': {
        sessionId: string;
        requestId: string;
        outcome: 'approve' | 'reject' | 'custom';
        reason?: string;
        origin?: string;
    };
    /** Global event (no sessionId): toggles the VSCode auto-approve setting. */
    'settings.setAutoApprove': { enabled: boolean };
}

// ============================================================================
// BtF: Backend → Frontend (facts; subscribed by every frontend)
// ============================================================================

export interface BtFEventMap {
    'session.created': { sessionId: string; requestId?: string; fileUri: string; metadata: AgentMetadata };
    'session.deleted': { sessionId: string };
    /** Full snapshot; hydration when a frontend starts displaying the session (`session.open`). */
    'session.state': SessionSnapshot;
    'session.output': { sessionId: string; renderData: RenderData };
    'session.status': {
        sessionId: string;
        status: 'idle' | 'running';
        reason?: 'completed' | 'interrupted' | 'error';
        queuedCount: number;
    };
    'session.metadata': { sessionId: string; metadata: AgentMetadata };
    /**
     * A committed inbound message, mounted as a card in the current turn row.
     * `historyIndex` is its flat index; `text` is the raw input for `user`,
     * the assembled text for `agent` and the terminal markdown for
     * `injection`.
     */
    'session.inboundCommitted': {
        sessionId: string;
        messageType: AgentMessageType;
        text: string;
        historyIndex: number;
    };
    /**
     * A new row opens: every committed `role: 'user'` message starts one,
     * ahead of its own `session.inboundCommitted`; carries no visible content.
     * `historyIndex` is the row-opening message's flat index (aligns the row
     * menu's truncate).
     */
    'session.turnStarted': { sessionId: string; historyIndex: number };
    /**
     * The session history was cut at `fromIndex` (every message at or after it
     * no longer exists); frontends drop the turn rows with index ≥ `fromIndex`.
     */
    'session.historyTruncated': { sessionId: string; fromIndex: number };
    'session.error': { sessionId: string; message: string; recoverable: boolean };
    'approval.requested': { sessionId: string; request: ApprovalRequestInfo };
    'approval.resolved': {
        sessionId: string;
        requestId: string;
        outcome: 'approve' | 'reject' | 'custom';
        reason?: string;
        origin?: string;
    };
    'context.debugResult': { sessionId: string; formatted: string };
    /** Global event: the session tree/list changed; sidebars refresh. */
    'sessions.changed': Record<string, never>;
    /**
     * Global event: the approval request list changed (a request suspended,
     * settled, or a trace recorded/expired); the approval sidebar refreshes.
     */
    'approval.changed': Record<string, never>;
    /** Global event: auto-approve switch replay. */
    'settings.autoApprove': { enabled: boolean };
}

// ============================================================================
// Name registries (arrays drive bulk subscribe/register)
// ============================================================================

export const FTB_EVENT_NAMES = [
    'session.create',
    'session.open',
    'session.close',
    'session.focus',
    'session.delete',
    'session.rename',
    'session.setModel',
    'session.setReasoningEffort',
    'userMessage.send',
    'run.interrupt',
    'history.truncate',
    'context.debug',
    'context.toggleRule',
    'context.toggleSkill',
    'context.setMcpTools',
    'context.removeFile',
    'context.removeMacro',
    'approval.respond',
    'settings.setAutoApprove',
] as const satisfies readonly (keyof FtBEventMap)[];

export const BTF_EVENT_NAMES = [
    'session.created',
    'session.deleted',
    'session.state',
    'session.output',
    'session.status',
    'session.metadata',
    'session.inboundCommitted',
    'session.turnStarted',
    'session.historyTruncated',
    'session.error',
    'approval.requested',
    'approval.resolved',
    'approval.changed',
    'context.debugResult',
    'sessions.changed',
    'settings.autoApprove',
] as const satisfies readonly (keyof BtFEventMap)[];
