/**
 * @fileoverview Panel controller — one per chat editor panel. The single IPC
 * gateway between the webview script and the extension process:
 *
 * - WebView → host: `ftb` envelopes are re-emitted onto the bus with the
 *   controller-injected sessionId and `origin: 'webview'`; `rpc` envelopes
 *   are answered adapter-locally (image upload/pick/resolution) and never
 *   enter the bus.
 * - Host → WebView: BtF facts, filtered by this panel's sessionId (plus the
 *   global `settings.autoApprove`), are posted into the webview.
 *
 * The panel is a pure observation window: closing it never stops the session;
 * reopening re-hydrates from the `session.state` snapshot.
 *
 * @module frontends/webview/panelController
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { Disposable } from 'vscode';
import type { AdapterContext } from '../../frontend/interfaces';
import type { FtBEventMap } from '../../backend/events';
import type { WebviewToHostMessage } from './interfaces';
import { buildChatHtml } from './html';
import { debugLogger } from '../../debugLogger';

/** Per-panel bridge between a chat webview and the backend event bus. */
export class PanelController {
    private sessionId: string | undefined;
    private btfSubscription: Disposable | undefined;
    private disposed = false;
    private ready = false;

    constructor(
        private readonly ctx: AdapterContext,
        private readonly fileUri: vscode.Uri,
        private readonly panel: vscode.WebviewPanel,
        private readonly onDispose: () => void,
    ) {}

    async initialize(): Promise<void> {
        const backend = this.ctx.backend;

        // Resolve the session id from the file, registering unknown files
        // (e.g. created externally) and sanitizing copied files (uuid clash).
        const { metadata } = await backend.store.read(this.fileUri);
        if (!metadata.uuid) {
            throw new Error('Invalid .mtm file: missing metadata.uuid');
        }
        const existing = backend.registry.get(metadata.uuid);
        if (!existing || existing.fileUri !== this.fileUri.toString()) {
            const uuid = await backend.registry.registerWithConflictCheck({
                uuid: metadata.uuid,
                parentId: metadata.parent_agent_id || null,
                name: metadata.name || 'Unknown Agent',
                fileUri: this.fileUri.toString(),
                openClientCount: 0,
                isRunning: false,
                isTaskFinished: !!metadata.is_task_finished,
                childIds: new Set(metadata.sub_agents_list || []),
            });
            backend.registry.emitChanged();
            this.sessionId = uuid;
        } else {
            this.sessionId = metadata.uuid;
        }

        this.panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.ctx.extensionContext.extensionUri, 'dist'),
                vscode.Uri.file(path.join(os.tmpdir(), 'mutsumi_images')),
            ],
        };
        this.panel.webview.html = buildChatHtml(
            this.panel.webview,
            this.ctx.extensionContext.extensionUri,
            this.sessionId,
        );

        this.panel.webview.onDidReceiveMessage(
            (message: WebviewToHostMessage) => void this.handleMessage(message),
            undefined,
            this.ctx.extensionContext.subscriptions,
        );

        this.panel.onDidDispose(() => this.dispose());
        this.panel.onDidChangeViewState(() => {
            if (this.panel.active && this.sessionId) {
                this.ctx.bus.emitFtB('session.focus', { sessionId: this.sessionId });
            }
        });

        // BtF bridge: subscribe to all facts, forward the ones for this session.
        this.btfSubscription = this.ctx.bus.subscribeAllBtF((name, payload) => {
            if (this.disposed || !this.ready) {
                return;
            }
            if (!this.shouldForward(name, payload)) {
                return;
            }
            void this.panel.webview.postMessage({ kind: 'btf', name, payload });
        });
    }

    private shouldForward(name: string, payload: unknown): boolean {
        // Global events (no sessionId) that panels care about.
        if (name === 'settings.autoApprove') {
            return true;
        }
        return (payload as { sessionId?: string })?.sessionId === this.sessionId;
    }

    private async handleMessage(message: WebviewToHostMessage): Promise<void> {
        if (message.kind === 'ready') {
            this.ready = true;
            if (this.sessionId) {
                this.ctx.bus.emitFtB('session.open', { sessionId: this.sessionId });
            }
            return;
        }
        if (message.kind === 'ftb') {
            if (!this.sessionId) {
                return;
            }
            // The controller injects sessionId and origin; the script never
            // self-reports them.
            this.ctx.bus.emitFtB(message.name as keyof FtBEventMap, {
                ...message.payload,
                sessionId: this.sessionId,
                origin: 'webview',
            } as FtBEventMap[keyof FtBEventMap]);
            return;
        }
        if (message.kind === 'rpc') {
            try {
                const result = await this.handleRpc(message.method, message.args);
                await this.panel.webview.postMessage({ kind: 'rpc-result', id: message.id, result });
            } catch (e: any) {
                debugLogger.log(`[PanelController] RPC ${message.method} failed: ${e?.message || e}`);
                await this.panel.webview.postMessage({
                    kind: 'rpc-result',
                    id: message.id,
                    error: e?.message || String(e),
                });
            }
        }
    }

    /** Adapter-local RPC: pure transport needs, never session state. */
    private async handleRpc(method: string, args: any): Promise<unknown> {
        switch (method) {
            case 'uploadImage': {
                const dataBase64 = String(args?.dataBase64 ?? '');
                const ext = String(args?.ext ?? 'png').replace(/[^a-z0-9]/gi, '') || 'png';
                const fileUri = await this.writeTempImage(Buffer.from(dataBase64, 'base64'), ext);
                return { fileUri: fileUri.toString() };
            }
            case 'pickImage': {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
                });
                if (!picked || picked.length === 0) {
                    return null;
                }
                const source = picked[0];
                const ext = (path.extname(source.fsPath).slice(1) || 'png').toLowerCase();
                const data = await vscode.workspace.fs.readFile(source);
                const fileUri = await this.writeTempImage(Buffer.from(data), ext);
                return { fileUri: fileUri.toString() };
            }
            case 'resolveImage': {
                const uri = vscode.Uri.parse(String(args?.uri ?? ''));
                if (uri.scheme !== 'file') {
                    return null;
                }
                return { webviewUri: this.panel.webview.asWebviewUri(uri).toString() };
            }
            default:
                throw new Error(`Unknown RPC method: ${method}`);
        }
    }

    /** Persist image bytes to the shared temp directory (mutsumi_images). */
    private async writeTempImage(data: Buffer, ext: string): Promise<vscode.Uri> {
        const tempDir = path.join(os.tmpdir(), 'mutsumi_images');
        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(tempDir));
        } catch {
            // Directory may already exist
        }
        const fileName = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        const fileUri = vscode.Uri.file(path.join(tempDir, fileName));
        await vscode.workspace.fs.writeFile(fileUri, data);
        return fileUri;
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.btfSubscription?.dispose();
        if (this.sessionId) {
            this.ctx.bus.emitFtB('session.close', { sessionId: this.sessionId });
        }
        this.onDispose();
    }
}
