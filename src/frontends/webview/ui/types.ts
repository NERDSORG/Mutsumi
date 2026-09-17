/**
 * @fileoverview Shared UI-facing types and label keys for the chat webview.
 * The webview bundle mirrors the backend event payloads it consumes (it only
 * imports pure types from shared/backend modules, never values).
 * @module frontends/webview/ui/types
 */

import type { AgentMetadata } from '../../../types';
import type {
    ApprovalRequestInfo,
    ContextPanelData,
    SessionSnapshot,
    Turn,
} from '../../../backend/events';
import type { RenderData } from '../../../shared/renderTypes';
import type { sendFtB } from './bridge';

export type { ApprovalRequestInfo, ContextPanelData, RenderData, SessionSnapshot, Turn };

/** Everything a component needs to act on the session. */
export interface UiContext {
    sendFtB: typeof sendFtB;
    /** Fill the input box with text (withdraw action). */
    fillInput: (text: string) => void;
    label: (key: string) => string;
}

/** Aggregate mutable UI state for one panel. */
export interface ChatState {
    metadata: AgentMetadata | null;
    status: 'idle' | 'running';
    queuedCount: number;
    autoApproveEnabled: boolean;
    contextPanel: ContextPanelData | null;
    availableModels: Record<string, string[]>;
    approvals: ApprovalRequestInfo[];
    /** Locally tracked sends that have not been committed yet (queue bar). */
    pendingSends: { text: string; mode: 'queue' | 'steer' }[];
    /** The session file was deleted; the panel shows a notice. */
    deleted: boolean;
}

/** Look up a label with a fallback to the key itself. */
export function makeLabeler(labels: Record<string, string>): (key: string) => string {
    return (key: string) => labels[key] ?? key;
}
