import * as vscode from 'vscode';
import { t } from '../i18n';
import type { ApprovalRequestRecord, PendingDispatchInfo } from '../backend/interfaces';
import type { EventBus } from '../backend/eventBus';

/**
 * @description Approval request tree node item for displaying tool call approval requests in the sidebar
 * @class ApprovalTreeItem
 * @extends {vscode.TreeItem}
 */
export class ApprovalTreeItem extends vscode.TreeItem {
    /**
     * @description Creates a new approval request tree node item
     * @param {ApprovalRequestRecord} record - Approval request record from the backend
     */
    constructor(
        public readonly record: ApprovalRequestRecord
    ) {
        super(record.info.actionDescription, vscode.TreeItemCollapsibleState.None);

        this.description = new Date(record.info.timestamp).toLocaleTimeString();
        this.tooltip = this.buildTooltip();
        this.iconPath = this.getIcon();

        if (record.status === 'pending') {
            this.contextValue = record.info.customAction ? 'pendingApprovalWithCustom' : 'pendingApproval';
        } else {
            this.contextValue = 'resolvedApproval';
        }
    }

    private buildTooltip(): vscode.MarkdownString {
        const info = this.record.info;
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${info.actionDescription}**\n\n`);
        md.appendMarkdown(t('approval.target', info.targetUri) + `\n\n`);

        if (info.customAction) {
             md.appendMarkdown(t('approval.customActionAvailable', info.customAction.label) + `\n\n`);
        }

        if (info.details) {
            md.appendMarkdown(t('approval.details', info.details));
        }
        md.appendMarkdown(t('approval.time', new Date(info.timestamp).toLocaleString()) + `\n\n`);
        md.appendMarkdown(t('approval.status', this.getStatusText()));
        return md;
    }

    private getStatusText(): string {
        switch (this.record.status) {
            case 'pending': return t('approval.pending');
            case 'approved': return t('approval.approved');
            case 'rejected': return t('approval.rejected');
        }
    }

    private getIcon(): vscode.ThemeIcon {
        switch (this.record.status) {
            case 'pending': return new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.yellow'));
            case 'approved': return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
            case 'rejected': return new vscode.ThemeIcon('x', new vscode.ThemeColor('charts.red'));
        }
    }
}

/**
 * @description Dispatch approval tree node: a parent agent asks to start sub-agents.
 */
export class DispatchTreeItem extends vscode.TreeItem {
    constructor(
        public readonly dispatch: PendingDispatchInfo
    ) {
        super(
            t('approval.dispatch.action', dispatch.children.length),
            vscode.TreeItemCollapsibleState.None
        );

        this.description = new Date().toLocaleTimeString();
        this.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.yellow'));
        this.contextValue = 'pendingDispatch';

        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${t('approval.dispatch.action', dispatch.children.length)}**\n\n`);
        for (const child of dispatch.children) {
            md.appendMarkdown(`- \`${child.agentType}\`: ${child.prompt.slice(0, 200)}\n`);
        }
        this.tooltip = md;
    }
}

/**
 * @description Registers approval-related commands. Buttons emit FtB events;
 * the backend settles the request and broadcasts the fact.
 * @param {vscode.ExtensionContext} context - Extension context for registering disposables
 * @param {EventBus} bus - The backend event bus
 */
export function registerApprovalCommands(context: vscode.ExtensionContext, bus: EventBus): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('mutsumi.approveRequest', (item: ApprovalTreeItem | DispatchTreeItem) => {
            if (item instanceof DispatchTreeItem) {
                bus.emitFtB('dispatch.respond', {
                    sessionId: item.dispatch.parentId,
                    requestId: item.dispatch.requestId,
                    outcome: 'approve',
                    origin: 'sidebar',
                });
                return;
            }
            if (item?.record?.info.id) {
                bus.emitFtB('approval.respond', {
                    sessionId: item.record.info.sessionId,
                    requestId: item.record.info.id,
                    outcome: 'approve',
                    origin: 'sidebar',
                });
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('mutsumi.rejectRequest', async (item: ApprovalTreeItem | DispatchTreeItem) => {
            if (item instanceof DispatchTreeItem) {
                bus.emitFtB('dispatch.respond', {
                    sessionId: item.dispatch.parentId,
                    requestId: item.dispatch.requestId,
                    outcome: 'reject',
                    origin: 'sidebar',
                });
                return;
            }
            if (!item?.record?.info.id) {
                return;
            }
            // Rejection reason is collected here (frontend) and carried by the
            // FtB payload; empty or cancelled input rejects without a reason,
            // which terminates the session (backend semantics).
            const reason = await vscode.window.showInputBox({
                prompt: t('permission.rejectPrompt', item.record.info.toolName),
                placeHolder: t('permission.rejectPlaceHolder'),
            });
            bus.emitFtB('approval.respond', {
                sessionId: item.record.info.sessionId,
                requestId: item.record.info.id,
                outcome: 'reject',
                reason: reason ?? undefined,
                origin: 'sidebar',
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('mutsumi.customRequestAction', (item: ApprovalTreeItem) => {
            if (item?.record?.info.id) {
                bus.emitFtB('approval.respond', {
                    sessionId: item.record.info.sessionId,
                    requestId: item.record.info.id,
                    outcome: 'custom',
                    origin: 'sidebar',
                });
            }
        })
    );
}
