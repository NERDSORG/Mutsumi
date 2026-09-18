import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type McpServerStatus = "connecting" | "connected" | "error";

/** A discovered tool together with its model-exposure validation state. */
export type McpDiscoveredTool = Tool & {
	schemaValid: boolean;
	error?: string;
};

export interface McpStdioServerConfig {
	type: "stdio";
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string | number>;
	timeout?: number;
}

export interface McpHttpServerConfig {
	type: "http";
	url: string;
	headers?: Record<string, string>;
	timeout?: number;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
export type McpServersConfig = Record<string, McpServerConfig>;

export interface McpToolSelection {
	serverId: string;
	toolNames: string[];
}

export interface McpServerRecord {
	serverId: string;
	config: McpServerConfig;
	tools: McpDiscoveredTool[];
	status: McpServerStatus;
	error?: string;
}

export interface McpToolCaller {
	callTool(serverId: string, toolName: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
