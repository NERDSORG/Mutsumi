/**
 * @fileoverview `@` completion menu for the chat composer.
 *
 * Lifecycle (state machine):
 * - Opens when an `input` event leaves the caret right after an `@`: typing
 *   `@`, backspacing down to an existing `@`, or pasting text ending in `@`.
 *   Caret moves never open it.
 * - On open, the full workspace file list and the tool list are fetched once
 *   via RPC (the host serves them from a 60s cache); every keystroke then
 *   re-filters them locally with `fuzzyFilter` — zero RPC while typing.
 * - While open, the searched string is `value.slice(tokenStart + 1, caret)`,
 *   recomputed on `input` / `selectionchange`; a query change resets the
 *   highlight to the top.
 * - ↑/↓ move the highlight (wrapping); Enter/Tab accept the highlighted row
 *   (with zero candidates they swallow the key and close); Esc closes; any
 *   pointer-down outside the menu closes it (PopupBase dismiss).
 * - Accepting a file/directory inserts `@[path]`; accepting a tool hands off
 *   to the params form (or inserts `@[name{}]` when it takes no arguments).
 *
 * Anchored to the composer card via `PopupBase`; opens above it through the
 * shared `.mutsumi-popup` geometry.
 *
 * @module frontend/frontends/webview/ui/completionMenu
 */

import { rpc } from './bridge';
import { codicon } from './codicon';
import { PopupBase } from './popup';
import { fuzzyFilter } from '../../../../shared/fuzzyMatch';
import type { CompletionToolInfo, WebviewLabelKey, WorkspaceFileList } from '../interfaces';

/** One selectable row. */
type Entry =
    | { kind: 'file'; path: string }
    | { kind: 'dir'; path: string }
    | { kind: 'tool'; tool: CompletionToolInfo };

export interface CompletionMenuCallbacks {
    /** Replace `[start, end)` in the textarea with `text`, focus, highlight. */
    applyInsertion(text: string, start: number, end: number): void;
    /** Hand a tool pick off to the params form (the menu is already closed). */
    openToolForm(tool: CompletionToolInfo, range: { start: number; end: number }): void;
    label(key: WebviewLabelKey): string;
}

/** Best-ranked rows shown per category. */
const DISPLAY_LIMIT = 50;

export class CompletionMenu extends PopupBase {
    private tokenStart = -1;
    private lastQuery = '';
    private entries: Entry[] = [];
    private activeIndex = 0;
    /** Full lists for the lifetime of one open session; refetched on next open. */
    private files: string[] = [];
    private dirs: string[] = [];
    private tools: CompletionToolInfo[] = [];

    constructor(
        composerEl: HTMLElement,
        private readonly textarea: HTMLTextAreaElement,
        private readonly callbacks: CompletionMenuCallbacks,
    ) {
        super();
        this.rootEl.classList.add('mutsumi-completion-popover');
        composerEl.appendChild(this.rootEl);
        // Caret moves (mouse, ←/→, Home/End…) re-derive the query of an open
        // menu; they never open it.
        document.addEventListener('selectionchange', () => {
            if (this.isOpen() && document.activeElement === this.textarea) {
                this.recompute();
            }
        });
    }

    /**
     * InputArea hook: every textarea `input` event flows through here.
     * (Re)opens the menu when the mutation leaves the caret right after an
     * `@`; otherwise re-derives the query of an open menu.
     */
    onInput(): void {
        const caret = this.textarea.selectionStart;
        const collapsed = caret === this.textarea.selectionEnd;
        const before = this.textarea.value.slice(0, caret);
        if (collapsed && before.endsWith('@')) {
            // Caret now sits right after an `@` (typed, backspaced down to,
            // or pasted): (re)open; close() first resets state.
            this.close();
            this.tokenStart = before.length - 1;
            this.lastQuery = '';
            this.activeIndex = 0;
            this.open();
            void this.fetchLists();
            return;
        }
        if (this.isOpen()) {
            this.recompute();
        }
    }

    /**
     * InputArea keydown mediation point. Returns true when the key was
     * consumed by the menu (the caller must not process it further).
     */
    handleKeydown(e: KeyboardEvent): boolean {
        if (!this.isOpen() || e.isComposing) {
            return false;
        }
        switch (e.key) {
            case 'ArrowUp':
                e.preventDefault();
                this.moveActive(-1);
                return true;
            case 'ArrowDown':
                e.preventDefault();
                this.moveActive(1);
                return true;
            case 'Enter':
            case 'Tab': {
                e.preventDefault();
                const entry = this.entries[this.activeIndex];
                if (!entry) {
                    // Zero candidates: swallow the key and close.
                    this.close();
                    return true;
                }
                this.accept(entry);
                return true;
            }
        }
        return false;
    }

    override close(): void {
        this.files = [];
        this.dirs = [];
        this.tools = [];
        this.tokenStart = -1;
        this.entries = [];
        super.close();
    }

    /** Searched string = text from `@` to the caret. */
    private recompute(): void {
        const caret = this.textarea.selectionStart;
        if (caret !== this.textarea.selectionEnd || caret <= this.tokenStart) {
            this.close();
            return;
        }
        const query = this.textarea.value.slice(this.tokenStart + 1, caret);
        // Whitespace, `@`, or brackets end the token.
        if (/[\s@[\]]/.test(query)) {
            this.close();
            return;
        }
        if (query !== this.lastQuery) {
            this.lastQuery = query;
            this.activeIndex = 0;
            this.applyFilter();
        }
    }

    /**
     * One-shot fetch on open: the full workspace file list (served from the
     * host's cache) plus the tool list. Dropped when the menu has since
     * closed.
     */
    private async fetchLists(): Promise<void> {
        try {
            const [list, tools] = await Promise.all([
                rpc<WorkspaceFileList>('listWorkspaceFiles'),
                rpc<CompletionToolInfo[]>('listCompletionTools'),
            ]);
            if (!this.isOpen()) {
                return;
            }
            this.files = list.files;
            this.dirs = list.dirs;
            this.tools = tools;
            this.applyFilter();
        } catch {
            if (this.isOpen()) {
                this.entries = [];
                this.render();
            }
        }
    }

    /**
     * Local fuzzy re-filter of the session lists against the current query;
     * synchronous, so it runs on every keystroke with no RPC. Applies the
     * per-category display cap after ranking.
     */
    private applyFilter(): void {
        const query = this.lastQuery;
        const files = fuzzyFilter(query, this.files, p => p).slice(0, DISPLAY_LIMIT);
        const dirs = fuzzyFilter(query, this.dirs, d => d).slice(0, DISPLAY_LIMIT);
        const matchedTools = fuzzyFilter(query, this.tools, t => t.displayName);
        // Group order: files, directories, built-in tools, then MCP tools
        // per server.
        const builtins = matchedTools.filter(t => !t.serverId);
        const byServer = new Map<string, CompletionToolInfo[]>();
        for (const tool of matchedTools) {
            if (!tool.serverId) {
                continue;
            }
            const bucket = byServer.get(tool.serverId) ?? [];
            bucket.push(tool);
            byServer.set(tool.serverId, bucket);
        }
        this.entries = [
            ...files.map(path => ({ kind: 'file', path }) as Entry),
            ...dirs.map(path => ({ kind: 'dir', path }) as Entry),
            ...builtins.map(tool => ({ kind: 'tool', tool }) as Entry),
            ...[...byServer.values()].flat().map(tool => ({ kind: 'tool', tool }) as Entry),
        ];
        this.render();
    }

    private moveActive(delta: number): void {
        if (this.entries.length === 0) {
            return;
        }
        this.activeIndex = (this.activeIndex + delta + this.entries.length) % this.entries.length;
        this.updateActiveRow();
    }

    /** Swap the highlight class without a full re-render; keep the row visible. */
    private updateActiveRow(): void {
        const rows = this.rootEl.querySelectorAll<HTMLElement>('.mutsumi-completion-row');
        rows.forEach((row, index) => row.classList.toggle('is-active', index === this.activeIndex));
        rows[this.activeIndex]?.scrollIntoView({ block: 'nearest' });
    }

    private accept(entry: Entry): void {
        const range = { start: this.tokenStart, end: this.textarea.selectionStart };
        this.close();
        if (entry.kind === 'tool') {
            const hasParams = Object.keys(entry.tool.parameters?.properties ?? {}).length > 0;
            if (hasParams) {
                this.callbacks.openToolForm(entry.tool, range);
            } else {
                this.callbacks.applyInsertion(`@[${entry.tool.name}{}]`, range.start, range.end);
            }
        } else {
            this.callbacks.applyInsertion(`@[${entry.path}]`, range.start, range.end);
        }
    }

    protected render(): void {
        this.rootEl.innerHTML = '';
        if (this.entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'mutsumi-completion-empty';
            empty.textContent = this.callbacks.label('chat.completion.noMatches');
            this.rootEl.appendChild(empty);
            return;
        }

        let lastGroup: string | null = null;
        this.entries.forEach((entry, index) => {
            const group = this.groupOf(entry);
            if (group.id !== lastGroup) {
                lastGroup = group.id;
                const header = document.createElement('div');
                header.className = 'mutsumi-completion-group';
                header.textContent = group.label;
                this.rootEl.appendChild(header);
            }
            const row = document.createElement('div');
            row.className = 'mutsumi-picker-row mutsumi-completion-row';
            if (index === this.activeIndex) {
                row.classList.add('is-active');
            }
            row.appendChild(codicon(group.icon, 'mutsumi-completion-icon'));
            const displayText = entry.kind === 'tool' ? entry.tool.displayName : entry.path;
            row.appendChild(this.buildPathLabel(displayText));
            if (entry.kind === 'tool' && entry.tool.description) {
                row.title = entry.tool.description;
            }
            // Keep the textarea focused while clicking; accept on click.
            row.addEventListener('mousedown', e => e.preventDefault());
            row.addEventListener('mouseenter', () => {
                if (this.activeIndex !== index) {
                    this.activeIndex = index;
                    this.updateActiveRow();
                }
            });
            row.addEventListener('click', () => this.accept(entry));
            this.rootEl.appendChild(row);
        });
    }

    /**
     * Two adjacent spans: the path head elides (with an ellipsis), the tail
     * (last separator + file/tool name) never truncates; when everything
     * fits, the two spans read as one string.
     */
    private buildPathLabel(text: string): HTMLElement {
        const group = document.createElement('span');
        group.className = 'mutsumi-completion-path';
        const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
        if (cut <= 0) {
            const whole = document.createElement('span');
            whole.className = 'mutsumi-completion-base';
            whole.textContent = text;
            group.appendChild(whole);
            return group;
        }
        const head = document.createElement('span');
        head.className = 'mutsumi-completion-dir';
        head.textContent = text.slice(0, cut);
        const tail = document.createElement('span');
        tail.className = 'mutsumi-completion-base';
        tail.textContent = text.slice(cut);
        group.appendChild(head);
        group.appendChild(tail);
        return group;
    }

    private groupOf(entry: Entry): { id: string; label: string; icon: string } {
        switch (entry.kind) {
            case 'file':
                return { id: 'files', label: this.callbacks.label('chat.completion.files'), icon: 'file' };
            case 'dir':
                return { id: 'dirs', label: this.callbacks.label('chat.completion.directories'), icon: 'folder' };
            case 'tool':
                if (entry.tool.serverId) {
                    return {
                        id: `mcp:${entry.tool.serverId}`,
                        label: this.callbacks.label('chat.completion.mcp').replace('{0}', entry.tool.serverId),
                        icon: 'server-environment',
                    };
                }
                return { id: 'tools', label: this.callbacks.label('chat.completion.tools'), icon: 'tools' };
        }
    }
}
