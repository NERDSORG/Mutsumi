/**
 * @fileoverview IPC envelope contract between the WebView host (extension
 * process) and the webview bundle (browser). Pure types — importable from
 * both sides. Session traffic rides the global event bus; only transport-
 * specific needs (image upload/resolution, readiness) use the local RPC
 * envelope, which never enters the bus.
 * @module frontends/webview/interfaces
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
