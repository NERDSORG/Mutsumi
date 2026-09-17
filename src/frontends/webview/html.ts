/**
 * @fileoverview HTML generation for the Mutsumi chat custom editor.
 * Injects the CSP, the webview bundle reference and the initial data
 * (sessionId + host-translated static labels).
 * @module frontends/webview/html
 */

import * as vscode from 'vscode';
import { t } from '../../i18n';

/** Build the static label map (host-side t() translations) for the webview. */
export function buildWebviewLabels(): Record<string, string> {
    return {
        'chat.send': t('chat.send'),
        'chat.interrupt': t('chat.interrupt'),
        'chat.inputPlaceholder': t('chat.inputPlaceholder'),
        'chat.mode.queue': t('chat.mode.queue'),
        'chat.mode.steer': t('chat.mode.steer'),
        'chat.copy': t('chat.copy'),
        'chat.retry': t('chat.retry'),
        'chat.withdraw': t('chat.withdraw'),
        'chat.continue': t('chat.continue'),
        'chat.rename': t('chat.rename'),
        'chat.renamePlaceholder': t('chat.renamePlaceholder'),
        'chat.selectModel': t('chat.selectModel'),
        'chat.reasoningEffort': t('chat.reasoningEffort'),
        'chat.sessionSettings': t('chat.sessionSettings'),
        'chat.insertImage': t('chat.insertImage'),
        'chat.pruneGhostBlocks': t('chat.pruneGhostBlocks'),
        'chat.debugContext': t('chat.debugContext'),
        'chat.autoApprove': t('chat.autoApprove'),
        'chat.contextPanel': t('chat.contextPanel'),
        'chat.approve': t('chat.approve'),
        'chat.reject': t('chat.reject'),
        'chat.rejectWithReason': t('chat.rejectWithReason'),
        'chat.rejectReasonPlaceholder': t('chat.rejectReasonPlaceholder'),
        'chat.sessionDeleted': t('chat.sessionDeleted'),
        'chat.debugResultTitle': t('chat.debugResultTitle'),
        'chat.close': t('chat.close'),
        'chat.queuedCount': t('chat.queuedCount'),
        'chat.context.rules': t('chat.context.rules'),
        'chat.context.skills': t('chat.context.skills'),
        'chat.context.mcps': t('chat.context.mcps'),
        'chat.context.files': t('chat.context.files'),
        'chat.context.macros': t('chat.context.macros'),
        'chat.effort.default': t('chat.effort.default'),
    };
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
