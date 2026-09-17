/**
 * @fileoverview WebView bundle entry point. Installs styles, the copy-code
 * handler and the BtF message listener, then signals readiness so the host
 * starts streaming state.
 * @module frontends/webview/ui/main
 */

import { App } from './app';
import { APP_CSS } from './appCss';
import { RENDERER_CSS } from './render/css';
import { installCopyCodeHandler } from './render/renderCore';
import { getInitialData, onHostMessage, signalReady } from './bridge';

function installStyles(): void {
    const style = document.createElement('style');
    style.textContent = RENDERER_CSS + '\n' + APP_CSS;
    document.head.appendChild(style);
}

function main(): void {
    installStyles();
    installCopyCodeHandler();

    const { sessionId, labels } = getInitialData();

    const root = document.createElement('div');
    root.id = 'mutsumi-root';
    document.body.appendChild(root);

    const app = new App(root, sessionId, labels);

    onHostMessage((message) => {
        if (message.kind === 'btf') {
            app.applyBtfEvent(message.name, message.payload);
        }
    });

    signalReady();
}

main();
