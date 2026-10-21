/**
 * @fileoverview Chat application orchestrator for the Mutsumi WebView: holds
 * the panel's mutable state, applies BtF facts to it and renders the message
 * flow (one row per inbound message: its card, then the agent's live output),
 * approval cards, the context panel and the input area. Every state change
 * arrives as a BtF fact.
 *
 * @module frontend/frontends/webview/ui/app
 */

import { rpc, sendFtB } from './bridge';
import { codicon, extractLeadingIcon } from './codicon';
import { TurnRenderer, buildDetailsCard, renderMarkdown } from './render/renderCore';
import { buildMenuBar } from './menus';
import { InputArea } from './inputArea';
import { ContextPanel } from './contextPanel';
import { SettingsPanel } from './settingsPanel';
import type { StateDrivenPopup } from './popup';
import type { AgentMessageType } from '../../../../types';
import type {
    ApprovalRequestInfo,
    ChatState,
    RenderData,
    SessionSnapshot,
    UiContext,
} from './types';
import { makeLabeler } from './types';

interface TurnView {
    rowEl: HTMLElement;
    /** Card area: the row's single inbound message card, when it has one. */
    cardsHost: HTMLElement;
    /** TurnRenderer host for the agent's output stream. */
    agentHost: HTMLElement;
    renderer: TurnRenderer;
    lastRenderData: RenderData;
    /** Flat-history index of the row's first message; -1 when unknown. */
    messageIndex: number;
}

const EMPTY_RENDER_DATA: RenderData = { committed: [], active: null };

/** Render a unified diff (`details` on edit/write approvals) as prefix-classified lines. */
function buildDiffBlock(patch: string): HTMLElement {
    const container = document.createElement('div');
    container.className = 'mutsumi-approval-details mutsumi-diff';
    const lines = patch.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop(); // trailing-newline artifact of the patch format
    }
    for (const line of lines) {
        const lineEl = document.createElement('div');
        if (line.startsWith('=') || line.startsWith('+++') || line.startsWith('---') || line.startsWith('\\')) {
            lineEl.className = 'mutsumi-diff-meta';
        } else if (line.startsWith('@@')) {
            lineEl.className = 'mutsumi-diff-hunk';
        } else if (line.startsWith('+')) {
            lineEl.className = 'mutsumi-diff-add';
        } else if (line.startsWith('-')) {
            lineEl.className = 'mutsumi-diff-del';
        }
        lineEl.textContent = line;
        container.appendChild(lineEl);
    }
    return container;
}

/**
 * Source prefix of an agent-to-agent message: `[Agent Message — from 'name'
 * (uuid)]`. Names may span newlines, so the name capture is non-greedy with
 * the uuid terminator anchoring the match — a greedy dotAll would swallow a
 * quoted `'(uuid)]'` fragment inside the body.
 */
const AGENT_MESSAGE_SOURCE = /^\[Agent Message — from '([\s\S]*?)' \(([0-9a-fA-F-]{36})\)\]\r?\n\r?\n?/;

/**
 * Build the card for one agent-to-agent message. The prefix is display-only:
 * the stored body is untouched, and an unparseable body simply keeps the
 * static title with its full text.
 */
function buildAgentCard(label: UiContext['label'], text: string): HTMLElement {
    const source = AGENT_MESSAGE_SOURCE.exec(text);
    // Replacer function, not a string: a name may contain dollar-sign patterns
    // that a string replacement would expand.
    const summaryText = source
        ? label('chat.agentMessageFrom').replace('{name}', () => source[1].replace(/\s+/g, ' ').trim())
        : label('chat.agentMessage');
    return buildDetailsCard({
        icon: 'mail',
        summaryText,
        markdown: source ? text.slice(source[0].length) : text,
        defaultOpen: true,
        contentClassName: 'mutsumi-agent-message-content',
    });
}

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
            fillInput: (text) => this.inputArea.fillInput(text),
            setText: (text) => this.inputArea.setText(text),
            toggleRenameRow: () => this.inputArea.toggleRenameRow(),
        };
        this.state = {
            metadata: null,
            status: 'idle',
            queuedCount: 0,
            autoApproveEnabled: false,
            contextPanel: null,
            availableModels: {},
            approvals: [],
            pendingSends: [],
            deleted: false,
        };

        // --- Layout ---
        const mainEl = document.createElement('div');
        mainEl.className = 'mutsumi-main';
        this.flowEl = document.createElement('div');
        this.flowEl.className = 'mutsumi-flow';
        // Any upward scroll unlocks output-following; reaching the bottom
        // re-locks it (programmatic jumps only ever move down).
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
            case 'session.inboundCommitted':
                this.applyInboundCommitted(payload);
                break;
            case 'session.turnStarted':
                this.applyTurnStarted(payload.historyIndex);
                break;
            case 'session.historyTruncated':
                this.applyHistoryTruncated(payload.fromIndex);
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
                // Deduplicate by request id.
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
            case 'context.debugResult':
                this.showDebugOverlay(payload.formatted);
                break;
            case 'settings.autoApprove':
                this.state.autoApproveEnabled = payload.enabled;
                this.refreshChrome();
                break;
            // sessions.changed and other sessions' facts: filtered by the host.
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
        this.state.pendingSends = [];
        this.state.deleted = false;

        this.flowEl.innerHTML = '';
        this.turns = [];
        this.liveTurn = null;

        const running = snapshot.status === 'running';
        const lastIndex = snapshot.turns.length - 1;
        snapshot.turns.forEach((turn, index) => {
            const isLive = running && index === lastIndex;
            const view = this.appendTurnRow(turn.messageIndex);
            if (turn.inbound) {
                view.cardsHost.appendChild(
                    this.buildInboundCard(
                        turn.inbound.messageType,
                        turn.inbound.text,
                        turn.inbound.historyIndex,
                    ),
                );
            }
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
            // Output without a preceding turnStarted (run started before this
            // panel opened).
            this.liveTurn = this.appendTurnRow(-1);
            this.refreshGeneratingFlag();
        }
        this.liveTurn.renderer.update(renderData);
        this.liveTurn.lastRenderData = renderData;
        this.scrollToBottom();
    }

    /** Mount one committed inbound message as a card on the live row. */
    private applyInboundCommitted(payload: {
        messageType: AgentMessageType;
        text: string;
        historyIndex: number;
    }): void {
        let view = this.liveTurn;
        if (!view) {
            // Card without a preceding turnStarted (run started before this
            // panel opened).
            view = this.appendTurnRow(payload.historyIndex);
            this.liveTurn = view;
            this.refreshGeneratingFlag();
        }
        view.cardsHost.appendChild(
            this.buildInboundCard(payload.messageType, payload.text, payload.historyIndex),
        );

        if (payload.messageType === 'user') {
            // Remove the matching locally tracked send (first match).
            const idx = this.state.pendingSends.findIndex(s => s.text === payload.text);
            if (idx !== -1) {
                this.state.pendingSends.splice(idx, 1);
            }
            this.refreshChrome();
        }
        this.scrollToBottom();
    }

    /** A visual turn starts: seal the live turn and open an empty row for it. */
    private applyTurnStarted(historyIndex: number): void {
        if (this.liveTurn) {
            this.turns.push(this.liveTurn);
            this.liveTurn = null;
        }
        const view = this.appendTurnRow(historyIndex);
        this.liveTurn = view;
        view.renderer.update(EMPTY_RENDER_DATA);
        view.lastRenderData = EMPTY_RENDER_DATA;
        this.refreshChrome();
        this.scrollToBottom();
    }

    /**
     * Targeted purge after a truncation: drop every turn row at or after
     * `fromIndex` (DOM rows, sealed-turn registry, live row). Rows without a
     * real index (`-1`) never match.
     */
    private applyHistoryTruncated(fromIndex: number): void {
        for (const rowEl of this.flowEl.querySelectorAll<HTMLElement>('.mutsumi-turn-row')) {
            if (Number(rowEl.dataset.messageIndex) >= fromIndex) {
                rowEl.remove();
            }
        }
        this.turns = this.turns.filter(view => view.messageIndex < fromIndex);
        if (this.liveTurn && this.liveTurn.messageIndex >= fromIndex) {
            this.liveTurn = null;
        }
        this.refreshChrome();
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

    /**
     * Build one inbound message card: a right-aligned user bubble (with its
     * own menu, anchored to its history index) or a details card for
     * injections and agent messages.
     */
    private buildInboundCard(
        messageType: AgentMessageType,
        text: string,
        historyIndex: number,
    ): HTMLElement {
        if (messageType === 'user') {
            return this.buildUserCard(text, historyIndex);
        }
        if (messageType === 'injection') {
            return buildDetailsCard({
                icon: 'references',
                summaryText: this.ctx.label('chat.contextInjection'),
                markdown: text,
                contentClassName: 'mutsumi-injection-content',
            });
        }
        return buildAgentCard(this.ctx.label, text);
    }

    /** Build the user card (bubble + user menu bar) of one user message. */
    private buildUserCard(text: string, historyIndex: number): HTMLElement {
        const bubbleWrap = document.createElement('div');
        bubbleWrap.className = 'mutsumi-user-wrap';
        const bubble = document.createElement('div');
        bubble.className = 'mutsumi-user-bubble';
        bubble.innerHTML = renderMarkdown(text);
        this.resolveImages(bubble);
        bubbleWrap.appendChild(bubble);
        bubbleWrap.appendChild(buildMenuBar('user', this.ctx, {
            userText: text,
            messageIndex: historyIndex,
        }));
        return bubbleWrap;
    }

    private appendTurnRow(messageIndex: number): TurnView {
        const rowEl = document.createElement('div');
        rowEl.className = 'mutsumi-turn-row';
        rowEl.dataset.messageIndex = String(messageIndex);

        const cardsHost = document.createElement('div');
        cardsHost.className = 'mutsumi-turn-cards';
        rowEl.appendChild(cardsHost);

        const agentHost = document.createElement('div');
        agentHost.className = 'mutsumi-agent-turn';
        rowEl.appendChild(agentHost);
        const agentMenuHost = document.createElement('div');
        rowEl.appendChild(agentMenuHost);

        this.flowEl.appendChild(rowEl);

        const view: TurnView = {
            rowEl,
            cardsHost,
            agentHost,
            renderer: new TurnRenderer(agentHost),
            lastRenderData: EMPTY_RENDER_DATA,
            messageIndex,
        };

        // The agent menu reads the turn markdown lazily from the latest render data.
        agentMenuHost.appendChild(buildMenuBar('agent', this.ctx, {
            messageIndex,
            get agentMarkdown() { return turnMarkdown(view); },
        }));

        return view;
    }

    // ------------------------------------------------------------------
    // Approvals
    // ------------------------------------------------------------------

    private renderApprovals(): void {
        this.approvalsEl.innerHTML = '';
        for (const request of this.state.approvals) {
            this.approvalsEl.appendChild(this.buildApprovalCard(request));
        }
    }

    private buildApprovalCard(request: ApprovalRequestInfo): HTMLElement {
        const card = document.createElement('div');
        card.className = 'mutsumi-approval-card';

        const title = document.createElement('div');
        title.className = 'mutsumi-approval-title';
        // `actionDescription` is the tool's prettyPrint: a leading `$(icon)`
        // token becomes the card icon; the rest stays a verbatim text node.
        const leading = extractLeadingIcon(request.actionDescription);
        title.appendChild(codicon(leading?.name ?? 'question', 'mutsumi-label-icon mutsumi-approval-icon'));
        title.appendChild(document.createTextNode(leading ? leading.rest : request.actionDescription));
        card.appendChild(title);

        const target = document.createElement('div');
        target.className = 'mutsumi-approval-target';
        target.textContent = request.targetUri;
        card.appendChild(target);

        if (request.details) {
            if (request.toolName === 'edit' || request.toolName === 'write') {
                // edit/write carry a unified diff in `details`.
                card.appendChild(buildDiffBlock(request.details));
            } else {
                const details = document.createElement('pre');
                details.className = 'mutsumi-approval-details';
                details.textContent = request.details;
                card.appendChild(details);
            }
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
            });
        });
        buttons.appendChild(approveBtn);

        const rejectBtn = document.createElement('button');
        rejectBtn.type = 'button';
        rejectBtn.className = 'mutsumi-reject-button';
        rejectBtn.textContent = this.ctx.label('chat.reject');
        buttons.appendChild(rejectBtn);
        card.appendChild(buttons);

        // Rejection reason row (revealed by the reject button). An empty reason
        // rejects bare (backend terminates the run); a non-empty one continues
        // the run with the feedback delivered to the model.
        const reasonRow = document.createElement('div');
        reasonRow.className = 'mutsumi-reject-reason-row';
        reasonRow.style.display = 'none';
        const reasonInput = document.createElement('input');
        reasonInput.type = 'text';
        reasonInput.placeholder = this.ctx.label('chat.rejectReasonPlaceholder');
        const submitBtn = document.createElement('button');
        submitBtn.type = 'button';
        submitBtn.textContent = this.ctx.label('chat.rejectSubmit');
        const respondReject = () => {
            this.ctx.sendFtB('approval.respond', {
                requestId: request.id,
                outcome: 'reject',
                reason: reasonInput.value.trim() || undefined,
            });
        };
        submitBtn.addEventListener('click', respondReject);
        reasonInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                respondReject();
            } else if (e.key === 'Escape') {
                reasonRow.style.display = 'none';
            }
        });
        reasonRow.appendChild(reasonInput);
        reasonRow.appendChild(submitBtn);
        card.appendChild(reasonRow);

        rejectBtn.addEventListener('click', () => {
            reasonRow.style.display = reasonRow.style.display === 'none' ? '' : 'none';
            if (reasonRow.style.display !== 'none') {
                reasonInput.focus();
            }
        });

        return card;
    }

    // ------------------------------------------------------------------
    // Chrome (panels / banners / overlays)
    // ------------------------------------------------------------------

    private renderChrome(): void {
        this.refreshChrome();
    }

    private refreshChrome(): void {
        // Body-level fact for the auto-approve toolbar highlight.
        document.body.dataset.autoApprove = String(this.state.autoApproveEnabled);

        // Toolbar-anchored popups (re-render only while open)
        for (const popup of this.popups.values()) {
            popup.update(this.state);
        }

        // Input area widgets
        this.inputArea.update(this.state);

        this.refreshGeneratingFlag();
    }

    /**
     * Reflect "the live turn is generating" as a `data-generating` attribute on
     * its row; CSS gates the indicator's visibility on it.
     */
    private refreshGeneratingFlag(): void {
        this.flowEl.querySelector('.mutsumi-turn-row[data-generating]')
            ?.removeAttribute('data-generating');
        if (this.state.status === 'running' && this.liveTurn) {
            this.liveTurn.rowEl.setAttribute('data-generating', 'true');
        }
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
        // The message is arbitrary text: keep it in its own node, never scanned
        // for icon tokens.
        const textEl = document.createElement('span');
        textEl.appendChild(codicon('error', 'mutsumi-label-icon mutsumi-error-icon'));
        textEl.appendChild(document.createTextNode(message));
        banner.appendChild(textEl);
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'mutsumi-banner-dismiss';
        dismiss.appendChild(codicon('close'));
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
     * Whether the flow follows new output: true while the user's scroll
     * position is at the bottom, false after any upward scroll.
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
            // Re-check inside the frame: the user may have scrolled up meanwhile.
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
