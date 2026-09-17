/**
 * @fileoverview WebView-side bridge: the single acquireVsCodeApi handle, FtB
 * posting and adapter-local RPC. The bus is not visible to the webview; the
 * panel controller translates between these envelopes and bus events.
 * @module frontends/webview/ui/bridge
 */

import type { HostToWebviewMessage, WebviewToHostMessage } from '../interfaces';

interface VsCodeApi {
    postMessage(message: WebviewToHostMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// acquireVsCodeApi may only be called once per webview — cache the handle.
const vscode = acquireVsCodeApi();

let rpcCounter = 0;
const pendingRpc = new Map<number, { resolve: (value: any) => void; reject: (reason: any) => void }>();

/** Post an FtB intent towards the backend (routed through the panel controller). */
export function sendFtB(name: string, payload: Record<string, unknown>): void {
    vscode.postMessage({ kind: 'ftb', name, payload });
}

/** Adapter-local RPC (image upload/resolution, picking). Never enters the bus. */
export function rpc<TResult = unknown>(method: string, args?: unknown): Promise<TResult> {
    const id = ++rpcCounter;
    return new Promise<TResult>((resolve, reject) => {
        pendingRpc.set(id, { resolve, reject });
        vscode.postMessage({ kind: 'rpc', id, method, args });
    });
}

/** Signal that the webview script is loaded and ready to receive state. */
export function signalReady(): void {
    vscode.postMessage({ kind: 'ready' });
}

/** Install the host→webview message listener. */
export function onHostMessage(handler: (message: HostToWebviewMessage) => void): void {
    window.addEventListener('message', (event) => {
        const message = event.data as HostToWebviewMessage;
        if (message?.kind === 'rpc-result') {
            const pending = pendingRpc.get(message.id);
            if (pending) {
                pendingRpc.delete(message.id);
                if (message.error) {
                    pending.reject(new Error(message.error));
                } else {
                    pending.resolve(message.result);
                }
            }
            return;
        }
        handler(message);
    });
}

/** Initial data injected into the HTML by the host. */
export function getInitialData(): { sessionId: string; labels: Record<string, string> } {
    const el = document.getElementById('mutsumi-initial-data');
    if (el?.textContent) {
        try {
            return JSON.parse(el.textContent);
        } catch {
            // fall through
        }
    }
    return { sessionId: '', labels: {} };
}
