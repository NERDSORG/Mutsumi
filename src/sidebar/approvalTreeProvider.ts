import * as vscode from 'vscode';
import { ApprovalTreeItem } from './approvalTreeItem';
import type { AgentBackend } from '../backend/agentBackend';

/**
 * Union type for tree items in the approval sidebar
 */
export type ApprovalSidebarItem = ApprovalTreeItem;

/**
 * @description Approval request tree data provider: the always-on fallback
 * frontend for approvals. Shows tool approval requests (from the backend
 * ApprovalRequestManager).
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
    }

    getTreeItem(element: ApprovalSidebarItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ApprovalSidebarItem): Thenable<ApprovalSidebarItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        // Approval records (already sorted: pending first, newer first)
        const items: ApprovalSidebarItem[] = this.backend.approvals.getAllRequests()
            .map(record => new ApprovalTreeItem(record));

        return Promise.resolve(items);
    }

    /**
     * @description Refreshes the approval request tree view
     */
    public refresh(): void {
        this._onDidChangeTreeData.fire(null);
    }
}
