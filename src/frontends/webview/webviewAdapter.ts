/**
 * @fileoverview WebView adapter — the singleton host for the Mutsumi chat
 * custom editor. Registers the CustomReadonlyEditorProvider and spawns a
 * lightweight PanelController per panel (controllers are not registered in
 * the adapter framework; the host owns them).
 * @module frontends/webview/webviewAdapter
 */

import * as vscode from 'vscode';
import type { AdapterContext, IFrontendAdapter } from '../../frontend/interfaces';
import { PanelController } from './panelController';
import { debugLogger } from '../../debugLogger';

export class WebViewAdapter implements IFrontendAdapter {
    readonly id = 'webview';
    readonly capabilities = { interactive: true };

    private ctx: AdapterContext | undefined;
    private registration: vscode.Disposable | undefined;
    private readonly controllers = new Set<PanelController>();

    activate(ctx: AdapterContext): void {
        this.ctx = ctx;
        const provider = new MutsumiChatEditorProvider(ctx, this.controllers);
        this.registration = vscode.window.registerCustomEditorProvider(
            'mutsumi.chat',
            provider,
            {
                // A session may be shown in several panels (split); state lives
                // in the backend, panels are pure observation windows.
                supportsMultipleEditorsPerDocument: true,
                webviewOptions: { retainContextWhenHidden: true },
            },
        );
    }

    dispose(): void {
        this.registration?.dispose();
        for (const controller of [...this.controllers]) {
            controller.dispose();
        }
        this.controllers.clear();
        this.ctx = undefined;
    }
}

class MutsumiChatEditorProvider implements vscode.CustomReadonlyEditorProvider {
    constructor(
        private readonly ctx: AdapterContext,
        private readonly controllers: Set<PanelController>,
    ) {}

    /** The provider supplies no document model; there is no dirty-buffer state. */
    async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => {} };
    }

    async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        const controller = new PanelController(this.ctx, document.uri, webviewPanel, () => {
            this.controllers.delete(controller);
        });
        this.controllers.add(controller);
        try {
            await controller.initialize();
        } catch (e: any) {
            debugLogger.log(`[WebViewAdapter] Failed to initialize panel for ${document.uri}: ${e?.message || e}`);
            vscode.window.showErrorMessage(`Mutsumi: ${e?.message || String(e)}`);
            controller.dispose();
            webviewPanel.dispose();
        }
    }
}
