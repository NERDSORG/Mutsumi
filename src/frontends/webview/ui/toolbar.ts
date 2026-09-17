/**
 * @fileoverview Toolbar registry. Adding a toolbar button = adding one entry
 * here. Model/reasoning-effort selects and the send-mode control are
 * dedicated widgets rendered next to the registry buttons.
 * @module frontends/webview/ui/toolbar
 */

import { rpc } from './bridge';
import type { UiContext } from './types';

export interface ToolbarItem {
    id: string;
    labelKey: string;
    /** Codicon name (without the `codicon-` prefix). */
    icon: string;
    /**
     * When set, the button anchors the popup of the same id (the popup wires
     * its own toggle click); `run` is not used.
     */
    popupId?: string;
    run?(ctx: UiContext): void;
}

/**
 * The toolbar registry: insert image, rename session, prune stale
 * references, debug context, auto-approve switch, context panel toggle.
 */
export const TOOLBAR_ITEMS: ToolbarItem[] = [
    {
        id: 'insertImage',
        labelKey: 'chat.insertImage',
        icon: 'file-media',
        run: async (ctx) => {
            const result = await rpc<{ fileUri: string } | null>('pickImage');
            if (result?.fileUri) {
                ctx.fillInput(`![image](${result.fileUri})`);
            }
        },
    },
    {
        id: 'rename',
        labelKey: 'chat.rename',
        icon: 'pencil',
        run: (ctx) => {
            const row = document.getElementById('mutsumi-rename-row');
            if (row) {
                row.classList.toggle('is-open');
                const input = row.querySelector('input');
                if (row.classList.contains('is-open') && input instanceof HTMLInputElement) {
                    input.focus();
                    input.select();
                }
            }
        },
    },
    {
        id: 'pruneGhostBlocks',
        labelKey: 'chat.pruneGhostBlocks',
        icon: 'clear-all',
        run: (ctx) => {
            ctx.sendFtB('history.pruneGhostBlocks', {});
        },
    },
    {
        id: 'debugContext',
        labelKey: 'chat.debugContext',
        icon: 'debug-console',
        run: (ctx) => {
            ctx.sendFtB('context.debug', {});
        },
    },
    {
        id: 'autoApprove',
        labelKey: 'chat.autoApprove',
        icon: 'run-all',
        run: (ctx) => {
            const current = document.body.dataset.autoApprove === 'true';
            ctx.sendFtB('settings.setAutoApprove', { enabled: !current });
        },
    },
    {
        id: 'contextPanel',
        labelKey: 'chat.contextPanel',
        icon: 'list-tree',
        popupId: 'contextPanel',
    },
    {
        id: 'sessionSettings',
        labelKey: 'chat.sessionSettings',
        icon: 'hubot',
        popupId: 'sessionSettings',
    },
];

/** Build the toolbar button row (registry-driven, codicon icon buttons). */
export function buildToolbar(ctx: UiContext): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'mutsumi-toolbar-buttons';
    for (const item of TOOLBAR_ITEMS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mutsumi-toolbar-item';
        button.dataset.toolbarId = item.id;
        const label = ctx.label(item.labelKey);
        button.title = label;
        button.setAttribute('aria-label', label);
        const icon = document.createElement('span');
        icon.className = `codicon codicon-${item.icon}`;
        button.appendChild(icon);
        // Popup-anchoring buttons are wired by the popup itself.
        if (!item.popupId && item.run) {
            button.addEventListener('click', () => item.run!(ctx));
        }
        bar.appendChild(button);
    }
    return bar;
}
