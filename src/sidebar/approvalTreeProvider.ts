import * as vscode from 'vscode';
import { ApprovalTreeItem, DispatchTreeItem } from './approvalTreeItem';
import type { AgentBackend } from '../backend/agentBackend';

/**
 * Union type for tree items in the approval sidebar
 */
export type ApprovalSidebarItem = ApprovalTreeItem | DispatchTreeItem;

/**
 * @description Approval request tree data provider: the always-on fallback
 * frontend for approvals. Shows tool approval requests (from the backend
 * ApprovalRequestManager) and pending dispatch approvals (from the backend
 * DispatchSessionManager).
 * @class ApprovalTreeDataProvider
 * @implements {vscode.TreeDataProvider<ApprovalSidebarItem>}
 */
export class ApprovalTreeDataProvider implements vscode.TreeDataProvider<ApprovalSidebarItem> {
    /** @description Tree data change event emitter for triggering view refresh */
    private _onDidChangeTreeData = new vscode.EventEmitter<ApprovalSidebarItem | undefined | null>();

    /** @description Tree data change event that VSCode subscribes to for view updates */
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly backend: AgentBackend) {
        this.backend.approvals.onDidChangeRequests(() => this.refresh());
        this.backend.dispatches.onDidChange(() => this.refresh());
    }

    getTreeItem(element: ApprovalSidebarItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ApprovalSidebarItem): Thenable<ApprovalSidebarItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        const items: ApprovalSidebarItem[] = [];

        // Pending dispatch approvals first
        for (const dispatch of this.backend.dispatches.getPendingDispatches()) {
            items.push(new DispatchTreeItem(dispatch));
        }

        // Approval records (already sorted: pending first, newer first)
        for (const record of this.backend.approvals.getAllRequests()) {
            items.push(new ApprovalTreeItem(record));
        }

        return Promise.resolve(items);
    }

    /**
     * @description Refreshes the approval request tree view
     */
    public refresh(): void {
        this._onDidChangeTreeData.fire(null);
    }
}
