/**
 * @fileoverview Chat application orchestrator for the Mutsumi WebView.
 *
 * Holds the panel's mutable state, applies BtF facts to it, and renders the
 * message flow (right-aligned user bubbles + full-width agent turns with live
 * incremental rendering), approval/dispatch cards, the context panel and the
 * input area. Frontends never listen to FtB; every state change arrives as a
 * BtF fact.
 *
 * @module frontends/webview/ui/app
 */

import { rpc, sendFtB } from './bridge';
import { TurnRenderer, renderMarkdown } from './render/renderCore';
import { buildMenuBar } from './menus';
import type { MenuTurnContext } from './menus';
import { InputArea } from './inputArea';
import { ContextPanel } from './contextPanel';
import { SettingsPanel } from './settingsPanel';
import type { StateDrivenPopup } from './popup';
import type {
    ApprovalRequestInfo,
    ChatState,
    DispatchCardData,
    RenderData,
    SessionSnapshot,
    UiContext,
} from './types';
import { makeLabeler } from './types';

interface TurnView {
    userText: string | null;
    messageIndex: number;
    rowEl: HTMLElement;
    agentHost: HTMLElement;
    renderer: TurnRenderer;
    lastRenderData: RenderData;
}

const EMPTY_RENDER_DATA: RenderData = { committed: [], active: null };

export class App {
    private readonly ctx: UiContext;
    private readonly state: ChatState;
    private readonly flowEl: HTMLElement;
    private readonly approvalsEl: HTMLElement;
    private readonly debugOverlayEl: HTMLElement;
    private readonly inputArea: InputArea;
    /** Toolbar-anchored popups, keyed by toolbar item id. */
    private readonly popups = new Map<string, StateDrivenPopup>();

    private turns: TurnView[] = [];
    private liveTurn: TurnView | null = null;

    constructor(root: HTMLElement, sessionId: string, labels: Record<string, string>) {
        const label = makeLabeler(labels);
        this.ctx = {
            label,
            sendFtB: (name, payload) => sendFtB(name, { ...payload, sessionId }),
            fillInput: (text) => this.inputArea.setText(text),
        };
        this.state = {
            metadata: null,
            status: 'idle',
            queuedCount: 0,
            autoApproveEnabled: false,
            contextPanel: null,
            availableModels: {},
            approvals: [],
            dispatches: [],
            pendingSends: [],
            deleted: false,
        };

        // --- Layout ---
        const mainEl = document.createElement('div');
        mainEl.className = 'mutsumi-main';
        this.flowEl = document.createElement('div');
        this.flowEl.className = 'mutsumi-flow';
        // Scrolling up (any amount) unlocks output-following immediately;
        // scrolling back to the bottom re-locks it. Programmatic jumps only
        // ever increase scrollTop, so an upward move is always user-initiated.
        this.flowEl.addEventListener('scroll', () => {
            const st = this.flowEl.scrollTop;
            if (st < this.lastScrollTop) {
                this.followOutput = false;
            } else if (this.isAtBottom()) {
                this.followOutput = true;
            }
            this.lastScrollTop = st;
        });
        mainEl.appendChild(this.flowEl);
        root.appendChild(mainEl);

        this.approvalsEl = document.createElement('div');
        this.approvalsEl.className = 'mutsumi-approvals';
        root.appendChild(this.approvalsEl);

        const inputContainer = document.createElement('div');
        inputContainer.className = 'mutsumi-input-container';
        root.appendChild(inputContainer);
        this.inputArea = new InputArea(inputContainer, this.ctx, {
            onSend: (text, mode) => this.handleSend(text, mode),
            onInterrupt: () => this.ctx.sendFtB('run.interrupt', {}),
        });

        // Toolbar-anchored popups (each wraps its registry button as anchor)
        const popupAnchor = (id: string): HTMLElement => {
            const button = inputContainer.querySelector<HTMLElement>(`[data-toolbar-id="${id}"]`);
            if (!button) {
                throw new Error(`toolbar button '${id}' not found`);
            }
            return button;
        };
        this.popups.set('contextPanel', new ContextPanel(popupAnchor('contextPanel'), this.ctx));
        this.popups.set('sessionSettings', new SettingsPanel(popupAnchor('sessionSettings'), this.ctx));

        this.debugOverlayEl = document.createElement('div');
        this.debugOverlayEl.className = 'mutsumi-debug-overlay';
        root.appendChild(this.debugOverlayEl);

        this.renderChrome();
    }

    // ------------------------------------------------------------------
    // BtF event application
    // ------------------------------------------------------------------

    applyBtfEvent(name: string, payload: any): void {
        switch (name) {
            case 'session.state':
                this.hydrate(payload as SessionSnapshot);
                break;
            case 'session.output':
                this.applyOutput(payload.renderData as RenderData);
                break;
            case 'session.userMessageCommitted':
                this.applyUserMessageCommitted(payload.text, payload.historyIndex);
                break;
            case 'session.status':
                this.state.status = payload.status;
                this.state.queuedCount = payload.queuedCount;
                this.refreshChrome();
                break;
            case 'session.metadata':
                this.state.metadata = payload.metadata;
                this.refreshContextActiveFlags();
                this.refreshChrome();
                break;
            case 'session.deleted':
                this.state.deleted = true;
                this.renderDeletedNotice();
                break;
            case 'session.error':
                this.showErrorBanner(payload.message);
                break;
            case 'approval.requested':
                // Requests carry a unique id: a repeated broadcast of the same
                // request must not render a duplicate card.
                if (!this.state.approvals.some(r => r.id === payload.request.id)) {
                    this.state.approvals.push(payload.request);
                    this.renderApprovals();
                    this.scrollToBottom();
                }
                break;
            case 'approval.resolved':
                if (payload.outcome !== 'custom') {
                    this.state.approvals = this.state.approvals.filter(r => r.id !== payload.requestId);
                    this.renderApprovals();
                }
                break;
            case 'dispatch.requested':
                if (!this.state.dispatches.some(d => d.requestId === payload.requestId)) {
                    this.state.dispatches.push({ requestId: payload.requestId, children: payload.children });
                    this.renderApprovals();
                    this.scrollToBottom();
                }
                break;
            case 'dispatch.resolved':
                this.state.dispatches = this.state.dispatches.filter(d => d.requestId !== payload.requestId);
                this.renderApprovals();
                break;
            case 'context.debugResult':
                this.showDebugOverlay(payload.formatted);
                break;
            case 'settings.autoApprove':
                this.state.autoApproveEnabled = payload.enabled;
                this.refreshChrome();
                break;
            // sessions.changed, session.created, session.userMessageCommitted
            // for other sessions: panel-level filtering already applied by the host.
        }
    }

    // ------------------------------------------------------------------
    // Hydration (snapshot)
    // ------------------------------------------------------------------

    private hydrate(snapshot: SessionSnapshot): void {
        this.state.metadata = snapshot.metadata;
        this.state.status = snapshot.status;
        this.state.queuedCount = snapshot.queuedCount;
        this.state.autoApproveEnabled = snapshot.autoApproveEnabled;
        this.state.contextPanel = snapshot.contextPanel;
        this.state.availableModels = snapshot.availableModels;
        this.state.approvals = [...snapshot.pendingApprovals];
        this.state.dispatches = snapshot.pendingDispatches.map(d => ({
            requestId: d.requestId,
            children: d.children,
        }));
        this.state.pendingSends = [];
        this.state.deleted = false;

        this.flowEl.innerHTML = '';
        this.turns = [];
        this.liveTurn = null;

        const running = snapshot.status === 'running';
        const lastIndex = snapshot.turns.length - 1;
        snapshot.turns.forEach((turn, index) => {
            const isLive = running && index === lastIndex;
            const view = this.appendTurnRow(turn.userText, turn.messageIndex);
            if (isLive) {
                this.liveTurn = view;
                view.renderer.update(snapshot.currentTurn ?? turn.renderData);
                view.lastRenderData = snapshot.currentTurn ?? turn.renderData;
            } else {
                view.renderer.update(turn.renderData);
                view.lastRenderData = turn.renderData;
            }
        });

        this.renderApprovals();
        this.refreshChrome();
        this.scrollToBottom();
    }

    // ------------------------------------------------------------------
    // Streaming
    // ------------------------------------------------------------------

    private applyOutput(renderData: RenderData): void {
        if (!this.liveTurn) {
            // Defensive: output without a preceding userMessageCommitted
            // (e.g. a run that started before this panel opened).
            this.liveTurn = this.appendTurnRow(null, -1);
        }
        this.liveTurn.renderer.update(renderData);
        this.liveTurn.lastRenderData = renderData;
        this.scrollToBottom();
    }

    private applyUserMessageCommitted(text: string, historyIndex: number): void {
        // Seal the previous live turn (its DOM persists as a committed turn).
        if (this.liveTurn) {
            this.turns.push(this.liveTurn);
            this.liveTurn = null;
        }
        const view = this.appendTurnRow(text, historyIndex);
        this.liveTurn = view;
        view.renderer.update(EMPTY_RENDER_DATA);
        view.lastRenderData = EMPTY_RENDER_DATA;

        // Remove the matching locally tracked send (first match).
        const idx = this.state.pendingSends.findIndex(s => s.text === text);
        if (idx !== -1) {
            this.state.pendingSends.splice(idx, 1);
        }
        this.refreshChrome();
        this.scrollToBottom();
    }

    private handleSend(text: string, mode: 'queue' | 'steer'): void {
        this.state.pendingSends.push({ text, mode });
        this.ctx.sendFtB('userMessage.send', { text, mode });
        this.refreshChrome();
        this.forceScrollToBottom();
    }

    // ------------------------------------------------------------------
    // Turn rows
    // ------------------------------------------------------------------

    private appendTurnRow(userText: string | null, messageIndex: number): TurnView {
        const rowEl = document.createElement('div');
        rowEl.className = 'mutsumi-turn-row';

        const menuCtx: MenuTurnContext = {
            userText,
            messageIndex,
            agentMarkdown: '',
        };

        if (userText !== null) {
            const bubbleWrap = document.createElement('div');
            bubbleWrap.className = 'mutsumi-user-wrap';
            const bubble = document.createElement('div');
            bubble.className = 'mutsumi-user-bubble';
            bubble.innerHTML = renderMarkdown(userText);
            this.resolveImages(bubble);
            bubbleWrap.appendChild(bubble);
            bubbleWrap.appendChild(buildMenuBar('user', this.ctx, menuCtx));
            rowEl.appendChild(bubbleWrap);
        }

        const agentHost = document.createElement('div');
        agentHost.className = 'mutsumi-agent-turn';
        rowEl.appendChild(agentHost);
        const agentMenuHost = document.createElement('div');
        agentMenuHost.className = 'mutsumi-agent-menu-host';
        rowEl.appendChild(agentMenuHost);

        this.flowEl.appendChild(rowEl);

        const view: TurnView = {
            userText,
            messageIndex,
            rowEl,
            agentHost,
            renderer: new TurnRenderer(agentHost),
            lastRenderData: EMPTY_RENDER_DATA,
        };

        // Agent menu needs the turn's markdown; rebuild lazily on hover/click
        // from the latest render data.
        const agentMenuBar = buildMenuBar('agent', this.ctx, {
            get userText() { return menuCtx.userText; },
            get messageIndex() { return menuCtx.messageIndex; },
            get agentMarkdown() { return turnMarkdown(view); },
        });
        agentMenuHost.appendChild(agentMenuBar);

        return view;
    }

    // ------------------------------------------------------------------
    // Approvals
    // ------------------------------------------------------------------

    private renderApprovals(): void {
        this.approvalsEl.innerHTML = '';
        for (const dispatch of this.state.dispatches) {
            this.approvalsEl.appendChild(this.buildDispatchCard(dispatch));
        }
        for (const request of this.state.approvals) {
            this.approvalsEl.appendChild(this.buildApprovalCard(request));
        }
    }

    private buildApprovalCard(request: ApprovalRequestInfo): HTMLElement {
        const card = document.createElement('div');
        card.className = 'mutsumi-approval-card';

        const title = document.createElement('div');
        title.className = 'mutsumi-approval-title';
        title.textContent = `⚠️ ${request.actionDescription}`;
        card.appendChild(title);

        const target = document.createElement('div');
        target.className = 'mutsumi-approval-target';
        target.textContent = request.targetUri;
        card.appendChild(target);

        if (request.details) {
            const details = document.createElement('pre');
            details.className = 'mutsumi-approval-details';
            details.textContent = request.details;
            card.appendChild(details);
        }

        const buttons = document.createElement('div');
        buttons.className = 'mutsumi-approval-buttons';

        if (request.customAction) {
            const customBtn = document.createElement('button');
            customBtn.type = 'button';
            customBtn.textContent = request.customAction.label;
            customBtn.addEventListener('click', () => {
                this.ctx.sendFtB('approval.respond', {
                    requestId: request.id,
                    outcome: 'custom',
                    origin: 'webview',
                });
            });
            buttons.appendChild(customBtn);
        }

        const approveBtn = document.createElement('button');
        approveBtn.type = 'button';
        approveBtn.className = 'mutsumi-approve-button';
        approveBtn.textContent = this.ctx.label('chat.approve');
        approveBtn.addEventListener('click', () => {
            this.ctx.sendFtB('approval.respond', {
                requestId: request.id,
                outcome: 'approve',
                origin: 'webview',
            });
        });
        buttons.appendChild(approveBtn);

        const rejectBtn = document.createElement('button');
        rejectBtn.type = 'button';
        rejectBtn.className = 'mutsumi-reject-button';
        rejectBtn.textContent = this.ctx.label('chat.reject');
        buttons.appendChild(rejectBtn);
        card.appendChild(buttons);

        // Rejection reason row (revealed by the reject button)
        const reasonRow = document.createElement('div');
        reasonRow.className = 'mutsumi-reject-reason-row';
        reasonRow.style.display = 'none';
        const reasonInput = document.createElement('input');
        reasonInput.type = 'text';
        reasonInput.placeholder = this.ctx.label('chat.rejectReasonPlaceholder');
        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.textContent = this.ctx.label('chat.rejectWithReason');
        const respondReject = (reason?: string) => {
            this.ctx.sendFtB('approval.respond', {
                requestId: request.id,
                outcome: 'reject',
                reason,
                origin: 'webview',
            });
        };
        confirmBtn.addEventListener('click', () => respondReject(reasonInput.value.trim() || undefined));
        reasonInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                respondReject(reasonInput.value.trim() || undefined);
            }
        });
        const noReasonBtn = document.createElement('button');
        noReasonBtn.type = 'button';
        noReasonBtn.textContent = this.ctx.label('chat.reject');
        noReasonBtn.addEventListener('click', () => respondReject(undefined));
        reasonRow.appendChild(reasonInput);
        reasonRow.appendChild(confirmBtn);
        reasonRow.appendChild(noReasonBtn);
        card.appendChild(reasonRow);

        rejectBtn.addEventListener('click', () => {
            reasonRow.style.display = reasonRow.style.display === 'none' ? '' : 'none';
            if (reasonRow.style.display !== 'none') {
                reasonInput.focus();
            }
        });

        return card;
    }

    private buildDispatchCard(dispatch: DispatchCardData): HTMLElement {
        const card = document.createElement('div');
        card.className = 'mutsumi-approval-card mutsumi-dispatch-card';

        const title = document.createElement('div');
        title.className = 'mutsumi-approval-title';
        title.textContent = `🍴 ${this.ctx.label('chat.dispatchTitle').replace('{0}', String(dispatch.children.length))}`;
        card.appendChild(title);

        const list = document.createElement('ul');
        list.className = 'mutsumi-dispatch-list';
        for (const child of dispatch.children) {
            const item = document.createElement('li');
            item.textContent = `[${child.agentType}] ${child.prompt.slice(0, 200)}`;
            list.appendChild(item);
        }
        card.appendChild(list);

        const buttons = document.createElement('div');
        buttons.className = 'mutsumi-approval-buttons';
        const approveBtn = document.createElement('button');
        approveBtn.type = 'button';
        approveBtn.className = 'mutsumi-approve-button';
        approveBtn.textContent = this.ctx.label('chat.approve');
        approveBtn.addEventListener('click', () => {
            this.ctx.sendFtB('dispatch.respond', {
                requestId: dispatch.requestId,
                outcome: 'approve',
                origin: 'webview',
            });
        });
        const rejectBtn = document.createElement('button');
        rejectBtn.type = 'button';
        rejectBtn.className = 'mutsumi-reject-button';
        rejectBtn.textContent = this.ctx.label('chat.reject');
        rejectBtn.addEventListener('click', () => {
            this.ctx.sendFtB('dispatch.respond', {
                requestId: dispatch.requestId,
                outcome: 'reject',
                origin: 'webview',
            });
        });
        buttons.appendChild(approveBtn);
        buttons.appendChild(rejectBtn);
        card.appendChild(buttons);

        return card;
    }

    // ------------------------------------------------------------------
    // Chrome (panels / banners / overlays)
    // ------------------------------------------------------------------

    private renderChrome(): void {
        this.refreshChrome();
    }

    private refreshChrome(): void {
        // Toolbar-anchored popups (re-render only while open)
        for (const popup of this.popups.values()) {
            popup.update(this.state);
        }

        // Input area widgets
        this.inputArea.update(this.state);
    }

    /** Re-derive context panel data from the latest metadata. */
    private refreshContextActiveFlags(): void {
        const panel = this.state.contextPanel;
        const metadata = this.state.metadata;
        if (!panel || !metadata) {
            return;
        }
        const activeRules = metadata.activeRules;
        for (const rule of panel.rules) {
            rule.active = activeRules === undefined || activeRules === null || activeRules.includes(rule.name);
        }
        const activeSkills = new Set(metadata.activeSkills ?? []);
        for (const skill of panel.skills) {
            skill.active = activeSkills.has(skill.name);
        }
        const selectionByServer = new Map(
            (metadata.enabledMcpTools ?? []).map(s => [s.serverId, new Set(s.toolNames)] as const),
        );
        for (const server of panel.mcpServers) {
            const selected = selectionByServer.get(server.serverId) ?? new Set<string>();
            for (const tool of server.tools) {
                tool.enabled = selected.has(tool.name);
            }
        }
        // Referenced files / macros live in metadata.contextItems.
        panel.contextItems = metadata.contextItems ?? [];
    }

    private showErrorBanner(message: string): void {
        const banner = document.createElement('div');
        banner.className = 'mutsumi-error-banner';
        banner.textContent = `⚠️ ${message}`;
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'mutsumi-banner-dismiss';
        dismiss.textContent = '✕';
        dismiss.addEventListener('click', () => banner.remove());
        banner.appendChild(dismiss);
        this.flowEl.appendChild(banner);
        this.scrollToBottom();
    }

    private showDebugOverlay(formatted: string): void {
        this.debugOverlayEl.innerHTML = '';
        this.debugOverlayEl.classList.add('is-open');
        const panel = document.createElement('div');
        panel.className = 'mutsumi-debug-panel';
        const header = document.createElement('div');
        header.className = 'mutsumi-debug-header';
        header.textContent = this.ctx.label('chat.debugResultTitle');
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = this.ctx.label('chat.close');
        closeBtn.addEventListener('click', () => this.debugOverlayEl.classList.remove('is-open'));
        header.appendChild(closeBtn);
        panel.appendChild(header);
        const pre = document.createElement('pre');
        pre.className = 'mutsumi-debug-content';
        pre.textContent = formatted;
        panel.appendChild(pre);
        this.debugOverlayEl.appendChild(panel);
    }

    private renderDeletedNotice(): void {
        this.flowEl.innerHTML = '';
        this.turns = [];
        this.liveTurn = null;
        const notice = document.createElement('div');
        notice.className = 'mutsumi-deleted-notice';
        notice.textContent = this.ctx.label('chat.sessionDeleted');
        this.flowEl.appendChild(notice);
    }

    // ------------------------------------------------------------------
    // Utilities
    // ------------------------------------------------------------------

    /** Lazily resolve file:// image sources through the host RPC. */
    private resolveImages(root: HTMLElement): void {
        root.querySelectorAll('img').forEach((img) => {
            const src = img.getAttribute('src') ?? '';
            if (!src.startsWith('file:')) {
                return;
            }
            void rpc<{ webviewUri: string } | null>('resolveImage', { uri: src }).then((resolved) => {
                if (resolved?.webviewUri) {
                    img.src = resolved.webviewUri;
                }
            });
        });
    }

    /**
     * Whether the flow follows new output. True while the user's scroll
     * position is at the bottom; any upward scroll unlocks (the user is
     * reading history and must not be dragged down), scrolling back to the
     * bottom re-locks.
     */
    private followOutput = true;
    private lastScrollTop = 0;

    private isAtBottom(): boolean {
        const el = this.flowEl;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    }

    private scrollToBottom(): void {
        if (!this.followOutput) {
            return;
        }
        requestAnimationFrame(() => {
            // Re-check inside the frame: an upward user scroll may have
            // unlocked after this jump was scheduled.
            if (!this.followOutput) {
                return;
            }
            this.flowEl.scrollTop = this.flowEl.scrollHeight;
        });
    }

    /** Sending a message is a deliberate input-area action: lock and jump. */
    private forceScrollToBottom(): void {
        this.followOutput = true;
        requestAnimationFrame(() => {
            this.flowEl.scrollTop = this.flowEl.scrollHeight;
        });
    }
}

/** Serialize a turn's content blocks (committed + active tail) to markdown. */
function turnMarkdown(view: TurnView): string {
    const parts = view.lastRenderData.committed
        .filter(b => b.type === 'content' || b.type === 'reasoning')
        .map(b => b.markdown);
    const active = view.lastRenderData.active;
    if (active) {
        if (active.reasoning) {
            parts.push(active.reasoning);
        }
        if (active.content) {
            parts.push(active.content);
        }
    }
    return parts.join('\n\n');
}
