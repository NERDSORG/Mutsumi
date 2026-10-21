/**
 * @fileoverview IPC envelope contract between the WebView host (extension
 * process) and the webview bundle (browser). Pure types — importable from
 * both sides. Session traffic rides the global event bus; only transport-
 * specific needs (image upload/resolution, readiness) use the local RPC
 * envelope, which never enters the bus.
 * @module frontend/frontends/webview/interfaces
 */

/** WebView → Host messages. */
export type WebviewToHostMessage =
    | { kind: 'ready' }
    | { kind: 'ftb'; name: string; payload: Record<string, unknown> }
    | { kind: 'rpc'; id: number; method: string; args?: unknown };

/** Host → WebView messages. */
export type HostToWebviewMessage =
    | { kind: 'btf'; name: string; payload: unknown }
    | { kind: 'rpc-result'; id: number; result?: unknown; error?: string };

// ============================================================================
// `@` completion payloads (adapter-local RPC)
// ============================================================================

/** One tool row in the `@` completion menu / params form. */
export interface CompletionToolInfo {
    /** Name inserted into the text (built-in name or the `mcp__…__hash` exposed name). */
    name: string;
    /** Display label: the bare name for built-ins, `serverId/originalName` for MCP tools. */
    displayName: string;
    description?: string;
    /** JSON schema of the parameters object (kosong wire shape). */
    parameters?: {
        properties?: Record<string, any>;
        required?: string[];
    };
    /** Owning MCP server id (MCP tools only). */
    serverId?: string;
}

/** `listWorkspaceFiles` RPC result: the full unfiltered workspace file + root directory list. */
export interface WorkspaceFileList {
    files: string[];
    dirs: string[];
}

// ============================================================================
// Static label keys (host translates; the webview only looks up)
// ============================================================================

/**
 * Every static-label key the webview bundle may request. The host builds the
 * translated map from this list (`buildWebviewLabels` in html.ts); webview
 * components narrow their lookups to {@link WebviewLabelKey} so key typos
 * fail at compile time. Keep in sync with the l10n bundle.
 */
export const WEBVIEW_LABEL_KEYS = [
    'chat.send',
    'chat.interrupt',
    'chat.inputPlaceholder',
    'chat.mode.queue',
    'chat.mode.steer',
    'chat.copy',
    'chat.retry',
    'chat.withdraw',
    'chat.continue',
    'chat.rename',
    'chat.renamePlaceholder',
    'chat.selectModel',
    'chat.reasoningEffort',
    'chat.sessionSettings',
    'chat.insertImage',
    'chat.contextInjection',
    'chat.agentMessage',
    'chat.agentMessageFrom',
    'chat.debugContext',
    'chat.autoApprove',
    'chat.contextPanel',
    'chat.approve',
    'chat.reject',
    'chat.rejectSubmit',
    'chat.rejectReasonPlaceholder',
    'chat.reasoningSummary',
    'chat.copyCode',
    'chat.copied',
    'chat.toolArgs',
    'chat.toolArgsStreaming',
    'chat.toolResult',
    'chat.sessionDeleted',
    'chat.debugResultTitle',
    'chat.close',
    'chat.queuedCount',
    'chat.context.rules',
    'chat.context.skills',
    'chat.context.mcps',
    'chat.context.files',
    'chat.context.macros',
    'chat.effort.default',
    'chat.completion.files',
    'chat.completion.directories',
    'chat.completion.tools',
    'chat.completion.mcp',
    'chat.completion.noMatches',
    'chat.completion.toolFormHint',
] as const;

/** Union of valid static-label keys (see {@link WEBVIEW_LABEL_KEYS}). */
export type WebviewLabelKey = typeof WEBVIEW_LABEL_KEYS[number];
