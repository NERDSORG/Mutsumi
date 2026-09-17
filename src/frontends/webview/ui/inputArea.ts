/**
 * @fileoverview Input area: queue bar, toolbar, rename row, attachment
 * preview, and the input box (transparent textarea over a syntax-highlighted
 * pre — markdown is highlighted, never rendered).
 * @module frontends/webview/ui/inputArea
 */

import { rpc } from './bridge';
import { highlightMarkdownSource } from './render/renderCore';
import { buildToolbar } from './toolbar';
import { AnchoredPopup, renderPickerGroups } from './popup';
import type { PickerGroup } from './popup';
import type { ChatState, UiContext } from './types';

type SendMode = 'queue' | 'steer';

/** Picker popup for the send-mode button: pick a mode and close. */
class ModePickerPopup extends AnchoredPopup {
    private groups: PickerGroup[] = [];
    private readonly collapsedGroups = new Set<string>();

    constructor(
        anchorButton: HTMLElement,
        private readonly onPick: (id: string) => void,
    ) {
        super(anchorButton, { align: 'right' });
        this.rootEl.classList.add('mutsumi-picker-popover');
    }

    setGroups(groups: PickerGroup[]): void {
        this.groups = groups;
        this.refreshIfOpen();
    }

    protected render(): void {
        this.rootEl.innerHTML = '';
        renderPickerGroups(this.rootEl, this.groups, this.collapsedGroups,
            (id) => {
                this.onPick(id);
                this.close();
            },
            () => this.render(),
        );
    }
}

export interface InputAreaCallbacks {
    onSend(text: string, mode: SendMode): void;
    onInterrupt(): void;
}

const IMG_LINK_REGEX = /!\[[^\]]*\]\((file:\/\/[^)\s]+)\)/g;

export class InputArea {
    private readonly textarea: HTMLTextAreaElement;
    private readonly highlightPre: HTMLElement;
    private readonly queueBar: HTMLElement;
    private readonly attachBar: HTMLElement;
    private readonly sendButton: HTMLButtonElement;
    private readonly interruptButton: HTMLButtonElement;
    private readonly modeButton: HTMLButtonElement;
    private readonly modePicker: ModePickerPopup;
    private sendMode: SendMode = 'steer';
    private readonly renameInput: HTMLInputElement;

    constructor(
        container: HTMLElement,
        private readonly ctx: UiContext,
        private readonly callbacks: InputAreaCallbacks,
    ) {
        const root = document.createElement('div');
        root.className = 'mutsumi-input-root';

        // Queue bar
        this.queueBar = document.createElement('div');
        this.queueBar.className = 'mutsumi-queue-bar';
        root.appendChild(this.queueBar);

        // Toolbar row (registry buttons; popup anchors live here)
        const toolbarRow = document.createElement('div');
        toolbarRow.className = 'mutsumi-toolbar-row';
        toolbarRow.appendChild(buildToolbar(ctx));
        root.appendChild(toolbarRow);

        // Rename row (toggled by the toolbar button)
        const renameRow = document.createElement('div');
        renameRow.className = 'mutsumi-rename-row';
        renameRow.id = 'mutsumi-rename-row';
        this.renameInput = document.createElement('input');
        this.renameInput.type = 'text';
        this.renameInput.placeholder = ctx.label('chat.renamePlaceholder');
        this.renameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.commitRename();
            } else if (e.key === 'Escape') {
                renameRow.classList.remove('is-open');
            }
        });
        const renameConfirm = document.createElement('button');
        renameConfirm.type = 'button';
        renameConfirm.textContent = ctx.label('chat.rename');
        renameConfirm.addEventListener('click', () => this.commitRename());
        renameRow.appendChild(this.renameInput);
        renameRow.appendChild(renameConfirm);
        root.appendChild(renameRow);

        // Attachment preview bar
        this.attachBar = document.createElement('div');
        this.attachBar.className = 'mutsumi-attach-bar';
        root.appendChild(this.attachBar);

        // Input box: highlight pre under a transparent textarea
        const inputWrap = document.createElement('div');
        inputWrap.className = 'mutsumi-input-wrap';
        this.highlightPre = document.createElement('pre');
        this.highlightPre.className = 'mutsumi-input-highlight';
        this.highlightPre.setAttribute('aria-hidden', 'true');
        this.textarea = document.createElement('textarea');
        this.textarea.className = 'mutsumi-input-textarea';
        this.textarea.placeholder = ctx.label('chat.inputPlaceholder');
        this.textarea.rows = 3;
        this.textarea.addEventListener('input', () => this.syncHighlight());
        this.textarea.addEventListener('scroll', () => {
            this.highlightPre.scrollTop = this.textarea.scrollTop;
            this.highlightPre.scrollLeft = this.textarea.scrollLeft;
        });
        this.textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                this.send();
            }
        });
        this.textarea.addEventListener('paste', (e) => void this.handlePaste(e));
        this.textarea.addEventListener('drop', (e) => void this.handleDrop(e));
        this.textarea.addEventListener('dragover', (e) => e.preventDefault());
        inputWrap.appendChild(this.highlightPre);
        inputWrap.appendChild(this.textarea);
        root.appendChild(inputWrap);

        // Action row: send-mode picker button + interrupt + send
        const actionRow = document.createElement('div');
        actionRow.className = 'mutsumi-action-row';
        this.modeButton = document.createElement('button');
        this.modeButton.type = 'button';
        this.modeButton.className = 'mutsumi-mode-button';
        const modeChevron = document.createElement('span');
        modeChevron.className = 'codicon codicon-chevron-up';
        this.modeButton.appendChild(modeChevron);
        actionRow.appendChild(this.modeButton);
        this.modePicker = new ModePickerPopup(this.modeButton, (id) => {
            this.sendMode = id as SendMode;
            this.refreshModeButton();
        });

        this.interruptButton = document.createElement('button');
        this.interruptButton.type = 'button';
        this.interruptButton.className = 'mutsumi-interrupt-button';
        this.interruptButton.textContent = ctx.label('chat.interrupt');
        this.interruptButton.addEventListener('click', () => this.callbacks.onInterrupt());
        actionRow.appendChild(this.interruptButton);

        this.sendButton = document.createElement('button');
        this.sendButton.type = 'button';
        this.sendButton.className = 'mutsumi-send-button';
        this.sendButton.textContent = ctx.label('chat.send');
        this.sendButton.addEventListener('click', () => this.send());
        actionRow.appendChild(this.sendButton);
        root.appendChild(actionRow);

        container.appendChild(root);
        this.refreshModeButton();
        this.syncHighlight();
    }

    /** Refresh status-dependent widgets from state. */
    update(state: ChatState): void {
        this.interruptButton.style.display = state.status === 'running' ? '' : 'none';
        document.body.dataset.autoApprove = String(state.autoApproveEnabled);

        // Queue bar
        this.queueBar.innerHTML = '';
        for (const pending of state.pendingSends) {
            const chip = document.createElement('div');
            chip.className = 'mutsumi-queue-chip';
            chip.textContent = `${pending.mode === 'steer' ? '⚡' : '…'} ${pending.text.slice(0, 80)}`;
            this.queueBar.appendChild(chip);
        }
        if (state.pendingSends.length === 0 && state.queuedCount > 0) {
            const chip = document.createElement('div');
            chip.className = 'mutsumi-queue-chip';
            chip.textContent = this.ctx.label('chat.queuedCount').replace('{0}', String(state.queuedCount));
            this.queueBar.appendChild(chip);
        }
        this.queueBar.style.display = this.queueBar.children.length > 0 ? '' : 'none';

        if (state.metadata?.name && this.renameInput.value !== state.metadata.name) {
            this.renameInput.value = state.metadata.name;
        }

        void this.refreshAttachments();
    }

    /** Insert text at the cursor (or set when empty), keeping the input usable. */
    fillInput(text: string): void {
        if (!this.textarea.value) {
            this.textarea.value = text;
        } else {
            const start = this.textarea.selectionStart ?? this.textarea.value.length;
            const before = this.textarea.value.substring(0, start);
            const after = this.textarea.value.substring(this.textarea.selectionEnd ?? start);
            this.textarea.value = before + text + after;
            this.textarea.selectionStart = this.textarea.selectionEnd = start + text.length;
        }
        this.textarea.focus();
        this.syncHighlight();
    }

    /** Replace the whole input text (withdraw action). */
    setText(text: string): void {
        this.textarea.value = text;
        this.textarea.focus();
        this.syncHighlight();
    }

    private send(): void {
        const text = this.textarea.value.trim();
        if (!text) {
            return;
        }
        this.textarea.value = '';
        this.syncHighlight();
        this.callbacks.onSend(text, this.sendMode);
    }

    /** Reflect the current send mode on the button and the picker selection. */
    private refreshModeButton(): void {
        const label = this.ctx.label(this.sendMode === 'steer' ? 'chat.mode.steer' : 'chat.mode.queue');
        const labelEl = this.modeButton.querySelector('.mutsumi-mode-button-label');
        if (labelEl) {
            labelEl.textContent = label;
        } else {
            const span = document.createElement('span');
            span.className = 'mutsumi-mode-button-label';
            span.textContent = label;
            this.modeButton.prepend(span);
        }
        this.modePicker.setGroups([{
            id: 'mode',
            entries: (['steer', 'queue'] as const).map(mode => ({
                id: mode,
                label: this.ctx.label(mode === 'steer' ? 'chat.mode.steer' : 'chat.mode.queue'),
                selected: mode === this.sendMode,
            })),
        }]);
    }

    private commitRename(): void {
        const name = this.renameInput.value.trim();
        if (name) {
            this.ctx.sendFtB('session.rename', { name });
        }
        document.getElementById('mutsumi-rename-row')?.classList.remove('is-open');
    }

    private syncHighlight(): void {
        this.highlightPre.innerHTML = highlightMarkdownSource(this.textarea.value) + '\n';
        void this.refreshAttachments();
    }

    /** Rebuild the attachment preview bar from file:// image links in the input. */
    private async refreshAttachments(): Promise<void> {
        const text = this.textarea.value;
        const uris = [...text.matchAll(IMG_LINK_REGEX)].map(m => m[1]);
        const signature = uris.join('|');
        if (this.attachBar.dataset.signature === signature) {
            return;
        }
        this.attachBar.dataset.signature = signature;
        this.attachBar.innerHTML = '';
        if (uris.length === 0) {
            this.attachBar.style.display = 'none';
            return;
        }
        this.attachBar.style.display = '';
        for (const uri of uris) {
            const thumb = document.createElement('img');
            thumb.className = 'mutsumi-attach-thumb';
            thumb.alt = uri;
            const resolved = await rpc<{ webviewUri: string } | null>('resolveImage', { uri });
            if (resolved?.webviewUri && this.attachBar.dataset.signature === signature) {
                thumb.src = resolved.webviewUri;
            }
            this.attachBar.appendChild(thumb);
        }
    }

    private async handlePaste(event: ClipboardEvent): Promise<void> {
        const files = [...(event.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'));
        if (files.length === 0) {
            return;
        }
        event.preventDefault();
        for (const file of files) {
            await this.uploadImageFile(file);
        }
    }

    private async handleDrop(event: DragEvent): Promise<void> {
        const files = [...(event.dataTransfer?.files ?? [])].filter(f => f.type.startsWith('image/'));
        if (files.length === 0) {
            return;
        }
        event.preventDefault();
        for (const file of files) {
            await this.uploadImageFile(file);
        }
    }

    private async uploadImageFile(file: File): Promise<void> {
        const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
        const dataBase64 = dataUrl.split(',')[1] ?? '';
        const ext = (file.name.split('.').pop() || file.type.split('/')[1] || 'png').toLowerCase();
        const result = await rpc<{ fileUri: string }>('uploadImage', { dataBase64, ext });
        if (result?.fileUri) {
            this.fillInput(`![image](${result.fileUri})`);
        }
    }
}
