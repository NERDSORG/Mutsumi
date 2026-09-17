/**
 * @fileoverview Anchored popup primitives for the chat webview.
 *
 * `AnchoredPopup` is the shared base for every responsive popup that opens
 * directly above a toolbar button: it wraps the anchor button in a positioned
 * span, opens above it, and closes on toggle / Escape / outside click.
 * `renderPickerGroups` is the shared group/row renderer used by picker-style
 * popups (collapsible groups, codicon check on the selected row).
 *
 * @module frontends/webview/ui/popup
 */

import type { ChatState } from './types';

/** A popup whose content derives from chat state. */
export interface StateDrivenPopup {
    update(state: ChatState): void;
}

/**
 * A responsive popup anchored above a button. Subclasses implement
 * {@link AnchoredPopup.render} to fill the popup body.
 */
export abstract class AnchoredPopup {
    private readonly anchor: HTMLElement;
    protected readonly rootEl: HTMLElement;
    private open = false;

    private readonly dismissListener = (event: MouseEvent) => {
        if (!this.anchor.contains(event.target as Node)) {
            this.close();
        }
    };
    private readonly escapeListener = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            this.close();
        }
    };

    constructor(anchorButton: HTMLElement, options?: { align?: 'left' | 'right' }) {
        // Wrap the anchor button in a positioned span; the popup is a sibling
        // of the button (never a child, so popup clicks cannot bubble into the
        // button's own toggle handler).
        this.anchor = document.createElement('span');
        this.anchor.className = 'mutsumi-popover-anchor';
        anchorButton.replaceWith(this.anchor);
        this.anchor.appendChild(anchorButton);
        // Clicking the anchor button toggles the popup.
        anchorButton.addEventListener('click', () => this.toggle());

        this.rootEl = document.createElement('div');
        this.rootEl.className = 'mutsumi-popup';
        this.rootEl.style.display = 'none';
        if (options?.align === 'right') {
            this.rootEl.style.left = 'auto';
            this.rootEl.style.right = '0';
        }
        this.anchor.appendChild(this.rootEl);
    }

    toggle(): void {
        if (this.open) {
            this.close();
        } else {
            this.open = true;
            this.rootEl.style.display = '';
            this.render();
            document.addEventListener('mousedown', this.dismissListener, true);
            document.addEventListener('keydown', this.escapeListener, true);
        }
    }

    close(): void {
        if (!this.open) {
            return;
        }
        this.open = false;
        this.rootEl.style.display = 'none';
        document.removeEventListener('mousedown', this.dismissListener, true);
        document.removeEventListener('keydown', this.escapeListener, true);
    }

    isOpen(): boolean {
        return this.open;
    }

    /** Re-render the popup body if it is currently open. */
    protected refreshIfOpen(): void {
        if (this.open) {
            this.render();
        }
    }

    /** Render the popup body into {@link AnchoredPopup.rootEl}. */
    protected abstract render(): void;
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
            const chevron = document.createElement('span');
            chevron.className = `codicon ${collapsedGroups.has(group.id) ? 'codicon-chevron-right' : 'codicon-chevron-down'}`;
            header.appendChild(chevron);
            if (group.icon) {
                const iconEl = document.createElement('span');
                iconEl.className = `codicon codicon-${group.icon} mutsumi-picker-group-icon`;
                header.appendChild(iconEl);
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
            const check = document.createElement('span');
            check.className = 'mutsumi-picker-check';
            if (entry.selected) {
                check.classList.add('codicon', 'codicon-check');
            }
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
