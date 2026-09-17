/**
 * @fileoverview Settings popup: one-stop view and editing of the session's
 * model and reasoning effort, opened from a toolbar registry button.
 * @module frontends/webview/ui/settingsPanel
 */

import { AnchoredPopup, renderPickerGroups } from './popup';
import type { PickerGroup } from './popup';
import type { ChatState, UiContext } from './types';

/** Reasoning effort setting values (display order; 'default' clears the override). */
const EFFORT_VALUES = ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Model + reasoning-effort panel: provider-grouped model list and flat effort
 * list with the current selection checked. The panel stays open after a pick
 * so the moved check mark is visible; state converges via the backend's
 * `session.metadata` broadcast.
 */
export class SettingsPanel extends AnchoredPopup {
    private state: ChatState | null = null;
    private readonly collapsedGroups = new Set<string>();

    constructor(
        anchorButton: HTMLElement,
        private readonly ctx: UiContext,
    ) {
        super(anchorButton);
        this.rootEl.classList.add('mutsumi-settings-popover');
    }

    /** Feed the latest state; re-renders only while open. */
    update(state: ChatState): void {
        this.state = state;
        this.refreshIfOpen();
    }

    protected render(): void {
        this.rootEl.innerHTML = '';
        const state = this.state;
        const metadata = state?.metadata;
        if (!state || !metadata) {
            return;
        }

        // --- Model section ---
        this.rootEl.appendChild(this.sectionHeader('hubot', this.ctx.label('chat.selectModel')));
        const currentPair = metadata.model && metadata.provider
            ? `${metadata.provider}::${metadata.model}`
            : '';
        const modelGroups: PickerGroup[] = Object.entries(state.availableModels).map(([provider, models]) => ({
            id: provider,
            label: provider,
            icon: 'server-environment',
            entries: models.map(model => ({
                id: `${provider}::${model}`,
                label: model,
                selected: `${provider}::${model}` === currentPair,
            })),
        }));
        renderPickerGroups(this.rootEl, modelGroups, this.collapsedGroups, (id) => {
            const [provider, model] = id.split('::');
            if (provider && model) {
                this.ctx.sendFtB('session.setModel', { model, provider });
            }
        }, () => this.render());

        // --- Reasoning effort section ---
        this.rootEl.appendChild(this.sectionHeader('sparkle', this.ctx.label('chat.reasoningEffort')));
        const currentEffort = metadata.reasoning_effort ?? 'default';
        const effortGroups: PickerGroup[] = [{
            id: 'effort',
            entries: EFFORT_VALUES.map(value => ({
                id: value,
                label: value === 'default' ? this.ctx.label('chat.effort.default') : value,
                selected: value === currentEffort,
            })),
        }];
        renderPickerGroups(this.rootEl, effortGroups, this.collapsedGroups, (id) => {
            this.ctx.sendFtB('session.setReasoningEffort', {
                effort: id === 'default' ? undefined : id,
            });
        }, () => this.render());
    }

    private sectionHeader(icon: string, label: string): HTMLElement {
        const header = document.createElement('div');
        header.className = 'mutsumi-settings-section-header';
        const iconEl = document.createElement('span');
        iconEl.className = `codicon codicon-${icon}`;
        header.appendChild(iconEl);
        const labelEl = document.createElement('span');
        labelEl.textContent = label;
        header.appendChild(labelEl);
        return header;
    }
}
