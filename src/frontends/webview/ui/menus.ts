/**
 * @fileoverview Message menu registry. Adding a menu item = adding one entry
 * here. Menus render under each message row; user bubbles and agent turns get
 * different item sets.
 * @module frontends/webview/ui/menus
 */

import type { UiContext } from './types';

/** A turn as seen by menu actions. */
export interface MenuTurnContext {
    /** Raw user text (null for orphan agent turns). */
    userText: string | null;
    /** Flat-history index of the user message (or orphan group start). */
    messageIndex: number;
    /** Markdown of the agent turn's committed content blocks. */
    agentMarkdown: string;
}

export interface MessageMenuItem {
    id: string;
    when: 'user' | 'agent';
    labelKey: string;
    /** Codicon name (without the `codicon-` prefix); label shows as tooltip. */
    icon: string;
    run(ctx: UiContext, turn: MenuTurnContext): void;
}

/**
 * The message menu registry: copy/retry/withdraw on user bubbles,
 * copy/continue on agent turns.
 */
export const MESSAGE_MENUS: MessageMenuItem[] = [
    {
        id: 'copy',
        when: 'user',
        labelKey: 'chat.copy',
        icon: 'copy',
        run: (_ctx, turn) => {
            void navigator.clipboard.writeText(turn.userText ?? '');
        },
    },
    {
        id: 'retry',
        when: 'user',
        labelKey: 'chat.retry',
        icon: 'debug-restart',
        run: (ctx, turn) => {
            // Cascade-delete this message and everything after it, then resend.
            ctx.sendFtB('history.truncate', { fromIndex: turn.messageIndex });
            ctx.sendFtB('userMessage.send', { text: turn.userText ?? '' });
        },
    },
    {
        id: 'withdraw',
        when: 'user',
        labelKey: 'chat.withdraw',
        icon: 'reply',
        run: (ctx, turn) => {
            ctx.sendFtB('history.truncate', { fromIndex: turn.messageIndex });
            ctx.fillInput(turn.userText ?? '');
        },
    },
    {
        id: 'copy',
        when: 'agent',
        labelKey: 'chat.copy',
        icon: 'copy',
        run: (_ctx, turn) => {
            void navigator.clipboard.writeText(turn.agentMarkdown);
        },
    },
    {
        id: 'continue',
        when: 'agent',
        labelKey: 'chat.continue',
        icon: 'play',
        run: (ctx) => {
            ctx.sendFtB('userMessage.send', { text: '继续' });
        },
    },
];

/** Build the menu bar element for one message row. */
export function buildMenuBar(
    when: 'user' | 'agent',
    ctx: UiContext,
    turn: MenuTurnContext,
): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'mutsumi-menu-bar';
    for (const item of MESSAGE_MENUS.filter(i => i.when === when)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mutsumi-menu-item';
        const label = ctx.label(item.labelKey);
        button.title = label;
        button.setAttribute('aria-label', label);
        const icon = document.createElement('span');
        icon.className = `codicon codicon-${item.icon}`;
        button.appendChild(icon);
        button.addEventListener('click', () => item.run(ctx, turn));
        bar.appendChild(button);
    }
    return bar;
}
