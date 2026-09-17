import * as vscode from "vscode";
import { AgentTreeDataProvider } from "./agentTreeProvider";
import { ApprovalTreeDataProvider } from "./approvalTreeProvider";
import { registerApprovalCommands } from "./approvalTreeItem";
import { registerAgentCommands } from "./agentTreeItem";
import { ShellTaskTreeDataProvider } from "./shellTaskTreeProvider";
import { registerShellTaskCommands } from "./shellTaskTreeItem";
import type { AgentBackend } from "../backend/agentBackend";

/**
 * @description Main controller for the Agent sidebar
 * Manages the Agent tree, the approval tree (tool approvals + dispatch
 * approvals) and the shell task tree, all fed by backend events.
 * @class AgentSidebarProvider
 */
export class AgentSidebarProvider {
	/** @description View type identifier for the Agent sidebar */
	public static readonly viewType = "mutsumi.agentSidebar";

	private readonly _agentTreeDataProvider: AgentTreeDataProvider;
	private readonly _approvalTreeDataProvider: ApprovalTreeDataProvider;
	private readonly _shellTaskTreeDataProvider: ShellTaskTreeDataProvider;

	private _agentTreeView?: vscode.TreeView<any>;
	private _approvalTreeView?: vscode.TreeView<any>;
	private _shellTaskTreeView?: vscode.TreeView<any>;

	constructor(private readonly backend: AgentBackend) {
		this._agentTreeDataProvider = new AgentTreeDataProvider(backend);
		this._approvalTreeDataProvider = new ApprovalTreeDataProvider(backend);
		this._shellTaskTreeDataProvider = new ShellTaskTreeDataProvider();
	}

	/**
	 * @description Registers tree views and related commands
	 */
	public registerTreeView(context: vscode.ExtensionContext): void {
		this._agentTreeView = vscode.window.createTreeView("mutsumi.agentSidebar", {
			treeDataProvider: this._agentTreeDataProvider,
			showCollapseAll: true,
		});
		context.subscriptions.push(this._agentTreeView);

		this._approvalTreeView = vscode.window.createTreeView(
			"mutsumi.approvalSidebar",
			{
				treeDataProvider: this._approvalTreeDataProvider,
				showCollapseAll: false,
			},
		);
		context.subscriptions.push(this._approvalTreeView);

		this._shellTaskTreeView = vscode.window.createTreeView(
			"mutsumi.shellTaskSidebar",
			{
				treeDataProvider: this._shellTaskTreeDataProvider,
				showCollapseAll: false,
			},
		);
		context.subscriptions.push(this._shellTaskTreeView);
		context.subscriptions.push(this._shellTaskTreeDataProvider);

		registerAgentCommands(context);
		registerApprovalCommands(context, this.backend.bus);
		registerShellTaskCommands(context);

		// Initial population
		void this._agentTreeDataProvider.refresh();
	}

	/**
	 * @description Refreshes the Agent and shell task trees
	 */
	public async update(): Promise<void> {
		await this._agentTreeDataProvider.refresh();
		this._shellTaskTreeDataProvider.refresh();
	}

	/**
	 * @description Disposes the sidebar provider and all its resources
	 */
	public dispose(): void {
		this._agentTreeView?.dispose();
		this._approvalTreeView?.dispose();
		this._shellTaskTreeView?.dispose();
	}
}
