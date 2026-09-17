/**
 * @fileoverview Internal event protocol between frontends and the agent
 * backend.
 *
 * FtB (frontend → backend) events are intents (commands); only the backend
 * subscribes to them. BtF (backend → frontend) events are facts (state
 * transitions); every frontend subscribes. Any FtB intent that changes
 * backend state must be answered by a corresponding BtF fact broadcast.
 *
 * Event names are collected into two `as const` arrays that double as the
 * runtime registry; the payload maps are cross-checked against them via
 * `satisfies` so a missing entry is a compile error.
 *
 * This module is imported by the webview bundle for its types: it must stay
 * free of vscode / Node value imports.
 *
 * @module backend/events
 */

import type { AgentMetadata, ContextItem, McpToolSelection } from '../types';
import type { RenderData } from '../shared/renderTypes';
import type { PendingDispatchInfo } from './interfaces';

// ============================================================================
// Shared payload shapes
// ============================================================================

/** Serializable view of a pending (or resolved) approval request. */
export interface ApprovalRequestInfo {
    id: string;
    sessionId: string;
    toolName: string;
    actionDescription: string;
    targetUri: string;
    details?: string;
    customAction?: { label: string; localOnly?: boolean };
    autoApproved: boolean;
    /** Epoch milliseconds (serialized; Date does not survive postMessage). */
    timestamp: number;
}

/**
 * One conversation turn for snapshot replay: a user message plus the
 * assistant/tool message group that followed it, rendered as committed-only
 * RenderData. Orphan assistant/tool groups (no preceding user message) also
 * form a turn with `userText: null`.
 */
export interface Turn {
    /** Raw text of the user message; null for orphan turns. */
    userText: string | null;
    /**
     * Index of the user message (or of the first message of an orphan group)
     * in the flat history; consumed by `history.truncate`.
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
    /** Dispatch approvals awaiting a response (this session as parent). */
    pendingDispatches: PendingDispatchInfo[];
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
    'history.pruneGhostBlocks': { sessionId: string };
    'context.debug': { sessionId: string };
    'context.toggleRule': { sessionId: string; rule: string; active: boolean };
    'context.toggleSkill': { sessionId: string; skill: string; active: boolean };
    'context.setMcpTools': { sessionId: string; selection: McpToolSelection[] };
    /** Stop tracking a referenced file (drops version tracking + ghost entries). */
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
    'dispatch.respond': {
        sessionId: string;
        requestId: string;
        outcome: 'approve' | 'reject';
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
    /** Full snapshot; also broadcast after history-changing operations (truncate/prune). */
    'session.state': SessionSnapshot;
    'session.output': { sessionId: string; renderData: RenderData };
    'session.status': {
        sessionId: string;
        status: 'idle' | 'running';
        reason?: 'completed' | 'interrupted' | 'error';
        queuedCount: number;
    };
    'session.metadata': { sessionId: string; metadata: AgentMetadata };
    /** A queued/steered user message has been committed into the history. */
    'session.userMessageCommitted': { sessionId: string; text: string; historyIndex: number };
    'session.error': { sessionId: string; message: string; recoverable: boolean };
    'approval.requested': { sessionId: string; request: ApprovalRequestInfo };
    'approval.resolved': {
        sessionId: string;
        requestId: string;
        outcome: 'approve' | 'reject' | 'custom';
        reason?: string;
        origin?: string;
    };
    'dispatch.requested': {
        /** Parent session id. */
        sessionId: string;
        requestId: string;
        children: { sessionId: string; prompt: string; agentType: string; allowedUris: string[] }[];
    };
    'dispatch.resolved': {
        sessionId: string;
        requestId: string;
        outcome: 'approve' | 'reject';
        origin?: string;
    };
    'context.debugResult': { sessionId: string; formatted: string };
    /** Global event: the session tree/list changed; sidebars refresh. */
    'sessions.changed': Record<string, never>;
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
    'history.pruneGhostBlocks',
    'context.debug',
    'context.toggleRule',
    'context.toggleSkill',
    'context.setMcpTools',
    'context.removeFile',
    'context.removeMacro',
    'approval.respond',
    'dispatch.respond',
    'settings.setAutoApprove',
] as const satisfies readonly (keyof FtBEventMap)[];

export const BTF_EVENT_NAMES = [
    'session.created',
    'session.deleted',
    'session.state',
    'session.output',
    'session.status',
    'session.metadata',
    'session.userMessageCommitted',
    'session.error',
    'approval.requested',
    'approval.resolved',
    'dispatch.requested',
    'dispatch.resolved',
    'context.debugResult',
    'sessions.changed',
    'settings.autoApprove',
] as const satisfies readonly (keyof BtFEventMap)[];
