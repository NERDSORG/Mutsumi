/**
 * @fileoverview Pure interface contracts for the frontend adapter framework.
 *
 * Adapters are singleton hosts (CustomEditorProvider registration, ports and
 * process resources are physically singletons); per-panel/per-session
 * controllers live inside the host and do not enter the registry. All
 * session traffic goes through the single global EventBus, routed by the
 * `sessionId` in each payload — there are no per-session channels.
 *
 * @module frontend/interfaces
 */

import type * as vscode from 'vscode';
import type { EventBus } from '../backend/eventBus';
import type { AgentBackend } from '../backend/agentBackend';

/** Services handed to adapters at activation. */
export interface AdapterContext {
    bus: EventBus;
    backend: AgentBackend;
    extensionContext: vscode.ExtensionContext;
}

/**
 * A frontend adapter (webview | lite | future acp).
 */
export interface IFrontendAdapter {
    readonly id: string;
    readonly capabilities: { interactive: boolean };
    activate(ctx: AdapterContext): void | Promise<void>;
    dispose(): void;
}
