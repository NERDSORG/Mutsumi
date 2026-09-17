import type { Tool as KosongTool } from "@moonshot-ai/kosong";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ITool, ToolContext } from "../tools.d/interface";
import type { McpToolCaller } from "./interfaces";
import { getMcpToolExposedName, getMcpToolSchemaError, projectMcpToolResult } from "./utils";

/** Lightweight ITool projection of a discovered MCP tool. */
export class McpToolAdapter implements ITool {
	readonly name: string;
	readonly shouldCache = false;
	readonly definition: KosongTool;

	readonly serverId: string;
	readonly originalToolName: string;
	private readonly tool: Tool;
	private readonly caller: McpToolCaller;

	constructor(serverId: string, tool: Tool, caller: McpToolCaller);
	constructor(serverId: string, originalToolName: string, tool: Tool, caller: McpToolCaller);
	constructor(serverId: string, nameOrTool: string | Tool, toolOrCaller: Tool | McpToolCaller, caller?: McpToolCaller) {
		this.serverId = serverId;
		this.originalToolName = typeof nameOrTool === "string" ? nameOrTool : nameOrTool.name;
		this.tool = typeof nameOrTool === "string" ? toolOrCaller as Tool : nameOrTool;
		this.caller = (caller ?? toolOrCaller) as McpToolCaller;
		const schemaError = getMcpToolSchemaError(this.tool);
		if (schemaError) throw new Error(`MCP tool ${serverId}/${this.originalToolName} cannot be exposed: ${schemaError}`);
		this.name = getMcpToolExposedName(serverId, this.originalToolName);
		this.definition = {
			name: this.name,
			description: this.tool.description || `${serverId}: ${this.originalToolName}`,
			parameters: this.tool.inputSchema as Record<string, unknown>,
		};
	}

	async execute(args: Record<string, unknown>, context: ToolContext): Promise<string> {
		if (this.tool.annotations?.readOnlyHint !== true) {
			const approval = await context.session.requestApproval(
				`Call MCP tool ${this.originalToolName}`,
				`mcp://${this.serverId}/${this.originalToolName}`,
				this.name,
				`${this.tool.description ?? ""}\n\nServer: ${this.serverId}\nTool: ${this.originalToolName}\nArguments: ${safeJson(args)}`,
			);
			if (approval) return approval;
		}
		const result = await this.caller.callTool(
			this.serverId,
			this.originalToolName,
			args,
			context.abortSignal ?? context.toolSession.abortSignal,
		);
		return projectMcpToolResult(result);
	}

	prettyPrint(args: unknown): string {
		return `MCP ${this.serverId}/${this.originalToolName}: ${safeJson(args)}`;
	}
}

function safeJson(value: unknown): string {
	try { return JSON.stringify(value); } catch { return "[unserializable arguments]"; }
}
