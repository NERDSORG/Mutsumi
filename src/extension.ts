/**
 * @fileoverview Main extension entry point for Mutsumi VSCode extension.
 * @module extension
 *
 * Assembly point: initializes logging, the tool registry, the agent-type
 * configuration system, MCP, skills and RAG, then the AgentBackend (the sole
 * state authority), the frontend adapters, the sidebar, and the notification
 * micro-frontend.
 */

import * as vscode from "vscode";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { AgentSidebarProvider } from "./sidebar/agentSidebar";
import { activateEditSupport } from "./tools.d/edit_file";

import { CodebaseService } from "./codebase/service";
import { RagService } from "./codebase/rag/service";
import { SkillManager } from "./contextManagement/skillManager";
import { t } from "./i18n";
import { ToolRegistry } from "./tools.d/toolManager";
import { debugLogger } from "./debugLogger";
import { toolsLogger } from "./tools.d/toolsLogger";
import { clearToolCache } from "./tools.d/cache";
import { notifyApprovalNeeded } from "./notifications";

// Agent Type System imports
import { loadMutsumiConfig } from "./config/loader";
import { ToolSetRegistry } from "./registry/toolSetRegistry";
import { AgentTypeRegistry } from "./registry/agentTypeRegistry";
import { getEntryAgentTypes } from "./config/resolver";
import { McpRegistry } from "./mcp/registry";

// Backend + frontend framework
import { AgentBackend } from "./backend/agentBackend";
import { AdapterRegistry } from "./frontend/registry";
import { LiteAdapter } from "./frontends/lite/liteAdapter";
import { WebViewAdapter } from "./frontends/webview/webviewAdapter";
import { registerTestRagSearchCommand } from "./commands/testRagSearch";
import { initializeRules } from "./contextManagement/prompts";

/**
 * Initializes the Agent Type System by loading the Mutsumi configuration and
 * populating both the ToolSetRegistry and AgentTypeRegistry.
 */
function initializeAgentTypeSystem(): ReturnType<typeof loadMutsumiConfig> {
	const mutsumiConfig = loadMutsumiConfig();
	debugLogger.log("[Extension] Mutsumi config loaded successfully");

	ToolSetRegistry.getInstance().initialize(mutsumiConfig.toolSets);
	debugLogger.log("[Extension] ToolSetRegistry initialized");

	AgentTypeRegistry.getInstance().initialize(
		mutsumiConfig.agentTypes,
		Object.keys(mutsumiConfig.toolSets),
	);
	debugLogger.log("[Extension] AgentTypeRegistry initialized");
	return mutsumiConfig;
}

/**
 * Activates the Mutsumi extension.
 */
export async function activate(
	context: vscode.ExtensionContext,
): Promise<void> {
	try {
		await activateImpl(context);
	} catch (err: any) {
		debugLogger.fatal(`activate() failed: ${err?.stack || err}`);
		throw err;
	}
}

async function activateImpl(
	context: vscode.ExtensionContext,
): Promise<void> {
	// Initialize Debug Logger first so other modules can use it
	debugLogger.initialize(context);
	debugLogger.log(`[Extension] activate() begin (log file: ${debugLogger.logFilePath})`);

	// Surface fatal extension-host errors into the persistent log before death.
	process.on("uncaughtException", (err) => {
		debugLogger.fatal(`uncaughtException: ${err?.stack || err}`);
	});
	process.on("unhandledRejection", (reason: any) => {
		debugLogger.fatal(`unhandledRejection: ${reason?.stack || reason}`);
	});

	// Initialize Tools Logger for streaming tool output
	toolsLogger.initialize(context);

	// Initialize ToolRegistry (required for the ToolSet architecture)
	ToolRegistry.initialize();

	// Validate configuration before changing either runtime registry, then connect MCP
	// servers before agent creation can consume their discovery snapshots.
	const mcpRegistry = McpRegistry.getInstance();
	const initialMutsumiConfig = initializeAgentTypeSystem();
	await mcpRegistry.reload(initialMutsumiConfig.mcpServers);
	debugLogger.log("[Extension] MCP registry reloaded");
	context.subscriptions.push({ dispose: () => mcpRegistry.dispose() });

	// ------------------------------------------------------------------
	// Agent backend (sole state authority) + frontend adapters
	// ------------------------------------------------------------------
	const backend = new AgentBackend();
	await backend.initialize();
	debugLogger.log("[Extension] AgentBackend initialized");

	const sidebarProvider = new AgentSidebarProvider(backend);
	sidebarProvider.registerTreeView(context);
	debugLogger.log("[Extension] Sidebar registered");
	context.subscriptions.push({ dispose: () => sidebarProvider.dispose() });

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
			const mcpChanged = e.affectsConfiguration("mutsumi.mcpServers");
			if (!mcpChanged && !e.affectsConfiguration("mutsumi.agentConfig")) {
				return;
			}
			try {
				const config = loadMutsumiConfig();
				// Validation completed for the whole candidate before either runtime registry changes.
				ToolSetRegistry.getInstance().initialize(config.toolSets);
				AgentTypeRegistry.getInstance().initialize(
					config.agentTypes,
					Object.keys(config.toolSets),
				);
				if (mcpChanged) {
					await mcpRegistry.reload(config.mcpServers);
				}
				await sidebarProvider.update();
				debugLogger.log("[Extension] Mutsumi configuration reloaded");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				debugLogger.log(`[Extension] Failed to reload Mutsumi configuration: ${message}`);
				vscode.window.showErrorMessage(t("config.reloadFailed", message));
			}
		}),
	);

	// Initialize SkillManager
	const skillManager = SkillManager.getInstance();
	await skillManager.initialize(context);
	debugLogger.log("[Extension] SkillManager initialized");

	// Initialize Codebase Service
	CodebaseService.getInstance().initialize(context).catch(console.error);

	// Initialize RAG Service
	const ragService = await RagService.getInstance(context);
	debugLogger.log("[Extension] RagService initialized");
	context.subscriptions.push(ragService);

	// 只在 RAG 启用时执行索引更新和注册文件监听器
	if (ragService.isEmbeddingEnabled()) {
		for (const wf of vscode.workspace.workspaceFolders ?? []) {
			ragService.updateWorkspace(wf.uri).catch((err) => {
				debugLogger.log(`[RAG] Failed to update workspace on startup: ${err}`);
			});
		}

		const pendingUpdates = new Map<string, NodeJS.Timeout>();
		context.subscriptions.push(
			vscode.workspace.onDidSaveTextDocument((doc) => {
				const uri = doc.uri;
				if (uri.fsPath.includes(".mutsumi")) {
					return;
				}
				const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
				if (!wsFolder) {
					return;
				}

				const wsKey = wsFolder.uri.toString();
				const existing = pendingUpdates.get(wsKey);
				if (existing) {
					clearTimeout(existing);
				}
				const timer = setTimeout(() => {
					pendingUpdates.delete(wsKey);
					ragService.updateWorkspace(wsFolder.uri).catch((err) => {
						debugLogger.log(`[RAG] Failed to update workspace on save: ${err}`);
					});
				}, 500);
				pendingUpdates.set(wsKey, timer);
			}),
		);
	}

	// ------------------------------------------------------------------
	// Frontend adapters
	// ------------------------------------------------------------------
	const adapterRegistry = new AdapterRegistry();
	adapterRegistry.register(new LiteAdapter());
	adapterRegistry.register(new WebViewAdapter());
	await adapterRegistry.activateAll({
		bus: backend.bus,
		backend,
		extensionContext: context,
	});
	context.subscriptions.push({ dispose: () => adapterRegistry.disposeAll() });

	// ------------------------------------------------------------------
	// Notification micro-frontend (the only vscode.window consumer of
	// backend events)
	// ------------------------------------------------------------------
	context.subscriptions.push(
		backend.bus.onBtF("session.error", (payload) => {
			const copyDetailsBtn = t("controller.copyDetails");
			vscode.window
				.showErrorMessage(payload.message, copyDetailsBtn)
				.then((selection) => {
					if (selection === copyDetailsBtn) {
						vscode.env.clipboard.writeText(payload.message);
					}
				});
		}),
		backend.bus.onBtF("approval.requested", (payload) => {
			notifyApprovalNeeded(
				t("approval.requestNotification", payload.request.actionDescription),
			);
		}),
	);

	// ------------------------------------------------------------------
	// .mtm file deletion watcher
	// ------------------------------------------------------------------
	const watcher = vscode.workspace.createFileSystemWatcher("**/*.mtm");
	context.subscriptions.push(watcher);
	context.subscriptions.push(
		watcher.onDidDelete(async (uri) => {
			await backend.notifyFileDeleted(uri);
		}),
	);

	// Register commands
	registerCommands(context, backend);

	activateEditSupport(context);
	debugLogger.log("[Extension] activate() done");
}

/**
 * Registers all extension commands.
 */
function registerCommands(context: vscode.ExtensionContext, backend: AgentBackend): void {
	// New Agent command: native QuickPick (no UI surface exists yet at creation
	// time), then session.create + session.created correlation, then open.
	context.subscriptions.push(
		vscode.commands.registerCommand("mutsumi.newAgent", async () => {
			const wsFolders = vscode.workspace.workspaceFolders;
			if (!wsFolders) {
				vscode.window.showErrorMessage(t("newAgent.noWorkspace"));
				return;
			}

			const entryTypes = getEntryAgentTypes();
			if (entryTypes.length === 0) {
				vscode.window.showErrorMessage(t("newAgent.noEntryTypes"));
				return;
			}

			const typeItems = entryTypes.map(({ name, config }) => {
				const modelDisplay = config.defaultModel
					? `${config.defaultModel.model} (${config.defaultModel.provider})`
					: "default";
				return {
					label: name,
					description: `${config.toolSets.join("+")}`,
					detail: t(
						"newAgent.detail",
						modelDisplay,
						config.defaultRules.length,
						config.defaultSkills.length,
					),
					typeName: name,
				};
			});

			const selectedType = await vscode.window.showQuickPick(typeItems, {
				placeHolder: t("newAgent.quickPickPlaceHolder"),
				title: t("newAgent.quickPickTitle"),
			});
			if (!selectedType) {
				return;
			}

			try {
				await initializeRules(context.extensionUri, wsFolders[0].uri);

				// In-process caller: await the backend method directly.
				const session = await backend.createSession({
					requestId: uuidv4(),
					agentType: selectedType.typeName,
				});

				if (session.fileUri) {
					await vscode.commands.executeCommand(
						"vscode.openWith",
						session.fileUri,
						"mutsumi.chat",
						{ preview: false },
					);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(message);
			}
		}),
	);

	// Copy reference command
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"mutsumi.copyReference",
			async (uri?: vscode.Uri) => {
				let targetUri = uri;
				let selection: vscode.Selection | undefined;
				const editor = vscode.window.activeTextEditor;

				if (!targetUri) {
					if (editor) {
						targetUri = editor.document.uri;
						selection = editor.selection;
					} else {
						vscode.window.showErrorMessage(t("copyReference.noFile"));
						return;
					}
				} else {
					if (
						editor &&
						editor.document.uri.toString() === targetUri.toString()
					) {
						selection = editor.selection;
					}
				}

				if (!targetUri) {
					return;
				}

				const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
				if (!workspaceFolder) {
					vscode.window.showErrorMessage(t("copyReference.notInWorkspace"));
					return;
				}

				const workspaceFolders = vscode.workspace.workspaceFolders;
				const isMultiRoot = workspaceFolders && workspaceFolders.length > 1;

				const relativePath = path
					.relative(workspaceFolder.uri.fsPath, targetUri.fsPath)
					.replace(/\\/g, "/");

				let refPath: string;
				if (isMultiRoot) {
					refPath = `${workspaceFolder.name}/${relativePath}`;
				} else {
					refPath = relativePath;
				}

				try {
					const stat = await vscode.workspace.fs.stat(targetUri);
					if (stat.type === vscode.FileType.Directory) {
						refPath += "/";
					}
				} catch {
					// Ignore errors (e.g., file doesn't exist)
				}

				let refString = "";

				if (selection && !selection.isEmpty && !selection.isSingleLine) {
					const start = selection.start.line + 1;
					const end = selection.end.line + 1;
					refString = `@[${refPath}:${start}:${end}]`;
				} else if (selection) {
					const line = selection.active.line + 1;
					refString = `@[${refPath}:${line}]`;
				} else {
					refString = `@[${refPath}]`;
				}

				await vscode.env.clipboard.writeText(refString);
				vscode.window.setStatusBarMessage(
					t("copyReference.statusBar", refString),
					3000,
				);
			},
		),
	);

	// Clear tool cache command
	context.subscriptions.push(
		vscode.commands.registerCommand("mutsumi.clearToolCache", () => {
			clearToolCache();
			vscode.window.showInformationMessage(t("clearToolCache.done"));
		}),
	);

	// RAG search test command
	registerTestRagSearchCommand(context);
}

/**
 * Deactivates the extension.
 */
export function deactivate(): void {}
