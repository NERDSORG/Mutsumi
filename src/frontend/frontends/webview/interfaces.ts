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

/** `searchCompletions` RPC result: fuzzy-ranked files + root directory rows. */
export interface CompletionSearchResult {
    files: string[];
    dirs: string[];
}
