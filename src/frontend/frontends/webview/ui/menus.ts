/**
 * @fileoverview Message menu registry. Adding a menu item = adding one entry
 * here. Menus render under each message row; user bubbles and agent turns get
 * different item sets.
 * @module frontend/frontends/webview/ui/menus
 */

import { codicon } from './codicon';
import type { WebviewLabelKey } from '../interfaces';
import type { UiContext } from './types';

/** A message row as seen by menu actions. */
export interface MenuTurnContext {
    /** Flat-history index of the message the menu acts on (truncate anchor). */
    messageIndex: number;
    /** Raw user text; set on user cards. */
    userText?: string;
    /** Markdown of the agent turn's content blocks; set on agent rows. */
    agentMarkdown?: string;
}

export interface MessageMenuItem {
    id: string;
    when: 'user' | 'agent';
    labelKey: WebviewLabelKey;
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
            ctx.setText(turn.userText ?? '');
        },
    },
    {
        id: 'copy',
        when: 'agent',
        labelKey: 'chat.copy',
        icon: 'copy',
        run: (_ctx, turn) => {
            void navigator.clipboard.writeText(turn.agentMarkdown ?? '');
        },
    },
    {
        id: 'continue',
        when: 'agent',
        labelKey: 'chat.continue',
        icon: 'play',
        run: (ctx) => {
            ctx.sendFtB('userMessage.send', { text: ctx.label('chat.continue') });
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
        button.appendChild(codicon(item.icon));
        button.addEventListener('click', () => item.run(ctx, turn));
        bar.appendChild(button);
    }
    return bar;
}
