import * as vscode from 'vscode';
import { AgentTreeItem, AgentNodeData } from './agentTreeItem';
import type { AgentBackend } from '../backend/agentBackend';
import { AgentRegistry } from '../backend/agentRegistry';

/**
 * @description Agent tree data provider, implements VSCode TreeDataProvider interface
 * Reads from the backend AgentRegistry and refreshes on `sessions.changed`.
 * @class AgentTreeDataProvider
 * @implements {vscode.TreeDataProvider<AgentTreeItem>}
 */
export class AgentTreeDataProvider implements vscode.TreeDataProvider<AgentTreeItem> {
    /** @description Tree data change event emitter, used to trigger view refresh */
    private _onDidChangeTreeData = new vscode.EventEmitter<AgentTreeItem | undefined | null>();

    /** @description Tree data change event, VSCode subscribes to this event to update the view */
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    /** @description Root node list, caches all currently displayed Agent tree nodes */
    private rootItems: AgentTreeItem[] = [];

    constructor(private readonly backend: AgentBackend) {
        this.backend.bus.onBtF('sessions.changed', () => {
            void this.refresh();
        });
    }

    getTreeItem(element: AgentTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: AgentTreeItem): Thenable<AgentTreeItem[]> {
        if (!element) {
            return Promise.resolve(this.rootItems);
        }
        return Promise.resolve(element.children);
    }

    /**
     * @description Refreshes the Agent tree view from the backend registry
     */
    public async refresh(): Promise<void> {
        this.rootItems = [];
        const allAgents = this.backend.registry.getTreeNodes();

        const nodeMap = new Map<string, AgentTreeItem>();

        // Create all Agent tree node items
        allAgents.forEach(info => {
            const data: AgentNodeData = {
                uuid: info.uuid,
                name: info.name,
                status: AgentRegistry.computeStatus(info),
                parentId: info.parentId,
                fileUri: info.fileUri
            };
            nodeMap.set(info.uuid, new AgentTreeItem(data, vscode.TreeItemCollapsibleState.Collapsed));
        });

        // Build Agent hierarchical relationships using childIds
        allAgents.forEach(info => {
            const item = nodeMap.get(info.uuid)!;

            // Root node: no parent or parent not in display list
            const isRoot = !info.parentId || !nodeMap.has(info.parentId);
            if (isRoot) {
                this.rootItems.push(item);
            }

            if (info.childIds) {
                for (const childId of info.childIds) {
                    const childItem = nodeMap.get(childId);
                    if (childItem) {
                        item.children.push(childItem);
                    }
                }
            }

            item.collapsibleState = item.children.length > 0
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.None;
        });

        this._onDidChangeTreeData.fire(null);
    }
}
