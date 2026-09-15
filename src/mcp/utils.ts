import * as crypto from "crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig, McpServersConfig, McpToolSelection } from "./interfaces";

export function validateMcpServersConfig(value: unknown): asserts value is McpServersConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("mcpServers must be an object keyed by server ID");
	}
	for (const [serverId, config] of Object.entries(value)) {
		if (!serverId.trim()) throw new Error("MCP server ID must not be empty");
		validateMcpServerConfig(serverId, config);
	}
}

function validateMcpServerConfig(serverId: string, value: unknown): asserts value is McpServerConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`MCP server "${serverId}" must be an object`);
	const config = value as Record<string, unknown>;
	if (config.type === "stdio") {
		if (typeof config.command !== "string" || !config.command.trim()) throw new Error(`MCP stdio server "${serverId}" requires a non-empty command`);
		if (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every(arg => typeof arg === "string"))) throw new Error(`MCP stdio server "${serverId}" args must be a string array`);
		if (config.cwd !== undefined && typeof config.cwd !== "string") throw new Error(`MCP stdio server "${serverId}" cwd must be a string`);
		validateRecord(serverId, "env", config.env, value => typeof value === "string" || typeof value === "number");
	} else if (config.type === "http") {
		if (typeof config.url !== "string" || !isHttpUrl(config.url)) throw new Error(`MCP HTTP server "${serverId}" requires an absolute HTTP(S) URL`);
		validateRecord(serverId, "headers", config.headers, value => typeof value === "string");
	} else {
		throw new Error(`MCP server "${serverId}" has unsupported type`);
	}
	if (config.timeout !== undefined && (typeof config.timeout !== "number" || !Number.isFinite(config.timeout) || config.timeout <= 0)) throw new Error(`MCP server "${serverId}" timeout must be a positive number`);
}

function validateRecord(serverId: string, name: string, value: unknown, validValue: (entry: unknown) => boolean): void {
	if (value === undefined) return;
	if (!value || typeof value !== "object" || Array.isArray(value) || !Object.values(value).every(validValue)) throw new Error(`MCP server "${serverId}" ${name} must be an object with valid values`);
}

function isHttpUrl(value: string): boolean {
	try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; }
}

export function normalizeMcpToolSelections(value: unknown): McpToolSelection[] {
	if (!Array.isArray(value)) return [];
	const selections = new Map<string, string[]>();
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const { serverId, toolNames } = item as Partial<McpToolSelection>;
		if (typeof serverId !== "string" || !serverId || !Array.isArray(toolNames)) continue;
		const names = toolNames.filter((name): name is string => typeof name === "string" && !!name);
		if (!names.length) continue;
		const existing = selections.get(serverId) ?? [];
		selections.set(serverId, [...new Set([...existing, ...names])]);
	}
	return [...selections].map(([serverId, toolNames]) => ({ serverId, toolNames }));
}

/** Validates the JSON Schema subset required for model-facing tool parameters (object-typed JSON Schema, accepted by every provider wire). */
export function getMcpToolSchemaError(tool: Tool): string | undefined {
	const schema = tool.inputSchema;
	if (!schema || typeof schema !== "object" || Array.isArray(schema) || schema.type !== "object") {
		return "MCP tool inputSchema must be an object schema.";
	}
	return undefined;
}

/**
 * Produces a stable OpenAI-compatible model-facing name for a logical MCP tool.
 * The hash preserves distinction after lossy character encoding and truncation.
 */
export function getMcpToolExposedName(serverId: string, toolName: string): string {
	const encode = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "tool";
	const hash = crypto.createHash("sha256").update(`${serverId}\u0000${toolName}`).digest("hex").slice(0, 10);
	const prefix = `mcp__${encode(serverId)}__${encode(toolName)}`;
	return `${prefix.slice(0, 53)}__${hash}`;
}

/** Creates deterministic text output from the MCP result protocol. */
export function projectMcpToolResult(value: unknown): string {
	if (!value || typeof value !== "object") return value === undefined ? "MCP tool returned no result." : String(value);
	const result = value as {
		content?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
		isError?: boolean;
		structuredContent?: unknown;
	};
	const parts: string[] = [];
	for (const item of result.content ?? []) {
		if (item.type === "text" && typeof item.text === "string") {
			parts.push(item.text);
		} else {
			const type = typeof item.type === "string" ? item.type : "unknown";
			const metadata = summarizeMcpContentMetadata(item);
			parts.push(`[Unsupported MCP content: ${type}${metadata}]`);
		}
	}
	if (result.structuredContent !== undefined) parts.push(stableJson(result.structuredContent));
	const output = parts.join("\n") || "MCP tool returned no result.";
	return result.isError ? `MCP tool error: ${output}` : output;
}

function summarizeMcpContentMetadata(item: Record<string, unknown>): string {
	const keys = Object.keys(item).filter(key => key !== "type");
	const hasBinary = keys.some(key => key === "data" || key === "base64");
	const safeKeys = keys.filter(key => key !== "data" && key !== "base64");
	const summary = safeKeys.length ? ` keys=[${safeKeys.sort().join(", ")}]` : "";
	const binaryNotice = hasBinary ? " (binary data omitted)" : "";
	return `${summary}${binaryNotice}`;
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, nested) => {
		if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
		return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
	});
}
