/**
 * @fileoverview Popup primitives for the chat webview.
 *
 * `PopupBase` owns the shared lifecycle (root element, open/close, outside-
 * mousedown / Escape dismiss); `AnchoredPopup` adds button anchoring for the
 * toolbar popups; the completion menu and tool params form extend
 * `PopupBase` directly, anchored to the composer card. `renderPickerGroups`
 * is the shared group/row renderer for picker-style popups.
 *
 * @module frontend/frontends/webview/ui/popup
 */

import { codicon } from './codicon';
import type { ChatState } from './types';

/** A popup whose content derives from chat state. */
export interface StateDrivenPopup {
    update(state: ChatState): void;
}

/**
 * Shared popup base: owns the root element and the open/close lifecycle.
 * Subclasses attach {@link PopupBase.rootEl} where they want it and
 * implement {@link PopupBase.render}.
 */
export abstract class PopupBase {
    protected readonly rootEl: HTMLElement;
    private opened = false;

    private readonly dismissListener = (event: MouseEvent) => {
        if (!this.isInside(event.target as Node)) {
            this.close();
        }
    };
    private readonly escapeListener = (event: KeyboardEvent) => {
        // Esc during an IME composition cancels the composition, not the popup.
        if (event.key === 'Escape' && !event.isComposing) {
            this.close();
        }
    };

    constructor() {
        this.rootEl = document.createElement('div');
        this.rootEl.className = 'mutsumi-popup';
        this.rootEl.style.display = 'none';
    }

    /**
     * Containment test for the outside-mousedown dismiss. Defaults to the
     * popup body itself; anchored popups widen it to their anchor.
     */
    protected isInside(target: Node): boolean {
        return this.rootEl.contains(target);
    }

    open(): void {
        if (this.opened) {
            return;
        }
        this.opened = true;
        this.rootEl.style.display = '';
        this.render();
        document.addEventListener('mousedown', this.dismissListener, true);
        document.addEventListener('keydown', this.escapeListener, true);
    }

    close(): void {
        if (!this.opened) {
            return;
        }
        this.opened = false;
        this.rootEl.style.display = 'none';
        document.removeEventListener('mousedown', this.dismissListener, true);
        document.removeEventListener('keydown', this.escapeListener, true);
    }

    toggle(): void {
        if (this.opened) {
            this.close();
        } else {
            this.open();
        }
    }

    isOpen(): boolean {
        return this.opened;
    }

    /** Re-render the popup body if it is currently open. */
    protected refreshIfOpen(): void {
        if (this.opened) {
            this.render();
        }
    }

    /** Render the popup body into {@link PopupBase.rootEl}. */
    protected abstract render(): void;
}

/**
 * A responsive popup anchored above a button. Subclasses implement
 * {@link AnchoredPopup.render} to fill the popup body.
 */
export abstract class AnchoredPopup extends PopupBase {
    private readonly anchor: HTMLElement;

    constructor(anchorButton: HTMLElement, options?: { align?: 'left' | 'right' }) {
        super();
        // Wrap the anchor button in a positioned span; the popup is a sibling
        // of the button (never a child, so popup clicks cannot bubble into the
        // button's own toggle handler).
        this.anchor = document.createElement('span');
        this.anchor.className = 'mutsumi-popover-anchor';
        anchorButton.replaceWith(this.anchor);
        this.anchor.appendChild(anchorButton);
        // Clicking the anchor button toggles the popup.
        anchorButton.addEventListener('click', () => this.toggle());

        if (options?.align === 'right') {
            this.rootEl.style.left = 'auto';
            this.rootEl.style.right = '0';
        }
        this.anchor.appendChild(this.rootEl);
    }

    /** The anchor (button + popup together) counts as "inside" for dismiss. */
    protected override isInside(target: Node): boolean {
        return this.anchor.contains(target);
    }
}

// ============================================================================
// Shared picker group/row rendering
// ============================================================================

/** One selectable row in a picker. */
export interface PickerEntry {
    id: string;
    label: string;
    description?: string;
    selected?: boolean;
}

/** A collapsible group of picker rows; a falsy label renders no header. */
export interface PickerGroup {
    id: string;
    label?: string;
    icon?: string;
    entries: PickerEntry[];
    collapsedByDefault?: boolean;
}

/**
 * Render picker groups into a host element. Row clicks invoke `onPick` with
 * the entry id (the owning popup decides whether to close). Group collapse
 * state lives in the caller-provided set so it survives re-renders.
 */
export function renderPickerGroups(
    host: HTMLElement,
    groups: PickerGroup[],
    collapsedGroups: Set<string>,
    onPick: (id: string) => void,
    rerender: () => void,
): void {
    for (const group of groups) {
        if (group.collapsedByDefault && !collapsedGroups.has(`init:${group.id}`)) {
            collapsedGroups.add(group.id);
            collapsedGroups.add(`init:${group.id}`);
        }

        if (group.label) {
            const header = document.createElement('div');
            header.className = 'mutsumi-picker-group-header';
            const chevron = codicon(collapsedGroups.has(group.id) ? 'chevron-right' : 'chevron-down');
            header.appendChild(chevron);
            if (group.icon) {
                header.appendChild(codicon(group.icon, 'mutsumi-picker-group-icon'));
            }
            const label = document.createElement('span');
            label.textContent = group.label;
            header.appendChild(label);
            header.addEventListener('click', () => {
                if (collapsedGroups.has(group.id)) {
                    collapsedGroups.delete(group.id);
                } else {
                    collapsedGroups.add(group.id);
                }
                rerender();
            });
            host.appendChild(header);
        }

        if (collapsedGroups.has(group.id)) {
            continue;
        }
        for (const entry of group.entries) {
            const row = document.createElement('div');
            row.className = 'mutsumi-picker-row';
            if (entry.description) {
                row.title = entry.description;
            }
            const check = entry.selected ? codicon('check') : document.createElement('span');
            check.classList.add('mutsumi-picker-check');
            row.appendChild(check);
            const label = document.createElement('span');
            label.className = 'mutsumi-picker-label';
            label.textContent = entry.label;
            row.appendChild(label);
            row.addEventListener('click', () => onPick(entry.id));
            host.appendChild(row);
        }
    }
}
