/**
 * @fileoverview HTML generation for the Mutsumi chat custom editor.
 * Injects the CSP, the webview bundle reference and the initial data
 * (sessionId + host-translated static labels).
 * @module frontend/frontends/webview/html
 */

import * as vscode from 'vscode';
import { t } from '../../../i18n';
import { WEBVIEW_LABEL_KEYS, type WebviewLabelKey } from './interfaces';

/**
 * Build the static label map (host-side t() translations) for the webview.
 * Iterates {@link WEBVIEW_LABEL_KEYS} so the map always covers exactly the
 * keys webview components may request; warns when a key is missing from the
 * l10n bundle (t() falls back to the key itself).
 */
export function buildWebviewLabels(): Record<WebviewLabelKey, string> {
    const labels = {} as Record<WebviewLabelKey, string>;
    for (const key of WEBVIEW_LABEL_KEYS) {
        const value = t(key);
        if (value === key) {
            console.warn(`[mutsumi] webview label missing from l10n bundle: ${key}`);
        }
        labels[key] = value;
    }
    return labels;
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/** Build the chat editor HTML document. */
export function buildChatHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    sessionId: string,
): string {
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'),
    );
    const codiconCssUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'dist', 'codicon.css'),
    );
    const nonce = getNonce();
    const initialData = JSON.stringify({
        sessionId,
        labels: buildWebviewLabels(),
    }).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: https:; font-src ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${codiconCssUri}">
    <title>Mutsumi</title>
</head>
<body>
    <script nonce="${nonce}" id="mutsumi-initial-data" type="application/json">${initialData}</script>
    <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
