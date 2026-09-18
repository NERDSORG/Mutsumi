import { EventEmitter } from "events";
import * as vscode from "vscode";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpDiscoveredTool, McpServerConfig, McpServerRecord, McpServersConfig, McpToolCaller, McpToolSelection } from "./interfaces";
import { getMcpToolSchemaError } from "./utils";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Extension-wide MCP client lifecycle and discovered-tool registry. */
export class McpRegistry implements McpToolCaller, Disposable {
	private static instance: McpRegistry | undefined;
	private readonly records = new Map<string, McpServerRecord>();
	private readonly clients = new Map<string, { client: Client; transport: Transport }>();
	private readonly emitter = new EventEmitter();
	private reloadQueue: Promise<void> = Promise.resolve();
	private latestConfig?: McpServersConfig;

	static getInstance(): McpRegistry {
		return this.instance ??= new McpRegistry();
	}

	get onDidChange(): (listener: () => void) => Disposable {
		return listener => {
			this.emitter.on("change", listener);
			return { dispose: () => { this.emitter.off("change", listener); } };
		};
	}

	/** Immutable current records for status consumers such as the ContextTree. */
	getRecords(): readonly McpServerRecord[] {
		return [...this.records.values()].map(record => ({ ...record, tools: [...record.tools] }));
	}

	/** @deprecated Use getRecords. */
	getServers(): readonly McpServerRecord[] { return this.getRecords(); }

	getServer(serverId: string): McpServerRecord | undefined {
		const record = this.records.get(serverId);
		return record && { ...record, tools: [...record.tools] };
	}

	resolveDefaultSelection(serverIds: readonly string[]): McpToolSelection[] {
		return serverIds.flatMap(serverId => {
			const record = this.records.get(serverId);
			const toolNames = record?.status === "connected"
				? record.tools.filter(tool => tool.schemaValid).map(tool => tool.name)
				: [];
			return toolNames.length ? [{ serverId, toolNames }] : [];
		});
	}

	getTool(serverId: string, toolName: string): Tool | undefined {
		const record = this.records.get(serverId);
		const tool = record?.status === "connected"
			? record.tools.find(candidate => candidate.name === toolName && candidate.schemaValid)
			: undefined;
		return tool;
	}

	reload(config?: McpServersConfig): Promise<void> {
		if (config) {
			this.latestConfig = config;
		}
		const nextConfig = config ?? this.latestConfig ?? Object.fromEntries(
			[...this.records.values()].map(record => [record.serverId, record.config]),
		);
		this.reloadQueue = this.reloadQueue.then(() => this.performReload(nextConfig), () => this.performReload(nextConfig));
		return this.reloadQueue;
	}

	private async performReload(config: McpServersConfig): Promise<void> {
		await this.disposeClients();
		this.records.clear();
		for (const [serverId, serverConfig] of Object.entries(config)) {
			this.records.set(serverId, { serverId, config: serverConfig, tools: [], status: "connecting" });
		}
		this.fireChange();
		await Promise.all(Object.entries(config).map(([serverId, serverConfig]) => this.connect(serverId, serverConfig)));
	}

	private async connect(serverId: string, config: McpServerConfig): Promise<void> {
		let transport: Transport | undefined;
		let client: Client | undefined;
		try {
			client = new Client({ name: "mutsumi", version: "0.0.8" });
			transport = this.createTransport(config);
			const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
			await this.withTimeout(client.connect(transport), timeout, `connecting to MCP server "${serverId}"`);
			const listed = await this.withTimeout(client.listTools(), timeout, `discovering tools from MCP server "${serverId}"`);
			const record = this.records.get(serverId);
			if (!record) { await client.close().catch(() => undefined); return; }
			record.tools = listed.tools.map(tool => this.decorateTool(tool));
			record.status = "connected";
			record.error = undefined;
			client.onclose = () => this.markUnavailable(serverId, `MCP server "${serverId}" closed its connection`);
			client.onerror = error => this.markUnavailable(serverId, error.message);
			this.clients.set(serverId, { client, transport });
		} catch (error) {
			const record = this.records.get(serverId);
			if (record) {
				record.status = "error";
				record.error = error instanceof Error ? error.message : String(error);
			}
			await client?.close().catch(() => undefined);
		}
		this.fireChange();
	}

	async callTool(serverId: string, toolName: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const record = this.records.get(serverId);
		const connection = this.clients.get(serverId);
		if (!record || record.status !== "connected" || !connection) throw new Error(`MCP server "${serverId}" is unavailable`);
		if (!record.tools.some(tool => tool.name === toolName)) throw new Error(`MCP tool "${toolName}" is unavailable on server "${serverId}"`);
		try {
			return await connection.client.callTool({ name: toolName, arguments: arguments_ }, undefined, { signal });
		} catch (error) {
			if (!signal?.aborted) this.markUnavailable(serverId, error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	private markUnavailable(serverId: string, error: string): void {
		const record = this.records.get(serverId);
		if (!record || record.status === "error") return;
		record.status = "error";
		record.error = error;
		const connection = this.clients.get(serverId);
		this.clients.delete(serverId);
		if (connection) {
			connection.client.onclose = undefined;
			connection.client.onerror = undefined;
			void connection.client.close().catch(() => undefined);
		}
		this.fireChange();
	}

	private decorateTool(tool: Tool): McpDiscoveredTool {
		const error = getMcpToolSchemaError(tool);
		return { ...tool, schemaValid: !error, error };
	}

	private createTransport(config: McpServerConfig): Transport {
		if (config.type === "stdio") {
			const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri;
			const cwd = config.cwd ?? (workspaceCwd?.scheme === "file" ? workspaceCwd.fsPath : undefined);
			const env = config.env ? Object.fromEntries([
				...Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
				...Object.entries(config.env).map(([key, value]) => [key, String(value)]),
			]) : undefined;
			return new StdioClientTransport({ command: config.command, args: config.args, cwd, env });
		}
		return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
	}

	private async disposeClients(): Promise<void> {
		const clients = [...this.clients.values()];
		this.clients.clear();
		for (const { client } of clients) {
			client.onclose = undefined;
			client.onerror = undefined;
		}
		await Promise.allSettled(clients.map(({ client }) => client.close()));
	}

	private async withTimeout<T>(promise: Promise<T>, timeout: number, action: string): Promise<T> {
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out while ${action}`)), timeout); })]);
		} finally { if (timer) clearTimeout(timer); }
	}

	private fireChange(): void { this.emitter.emit("change"); }
	async dispose(): Promise<void> { await this.disposeClients(); this.records.clear(); this.fireChange(); }
}

interface Disposable { dispose(): void | Promise<void>; }
