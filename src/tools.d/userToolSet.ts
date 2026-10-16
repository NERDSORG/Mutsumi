/**
 * @fileoverview Pre-execution (user tool plane) tool set provider.
 *
 * Builds and caches the tool set used for human-authored tool calls
 * (`@[tool{...}]` in messages, rules, skills or macros): the built-in common
 * tools plus every connected, schema-valid MCP tool exposed under the same
 * `mcp__<server>__<tool>__<hash>` names as the Agent runtime. Tool calls on
 * this plane are user-authored and execute without approval.
 *
 * The cache is invalidated whenever the MCP registry state changes (reload,
 * disconnect, discovered tool list updates) and rebuilt lazily. The
 * invalidation listener is registered exactly once, on first use.
 *
 * @module tools.d/userToolSet
 */

import { ToolSet } from "./toolSet";
import { McpRegistry } from "./mcp/registry";
import { McpToolAdapter } from "./mcp/tool";

/** Cached pre-execution tool sets, keyed by task_finish inclusion. */
const userToolSets: {
	plain?: ToolSet;
	withTaskFinish?: ToolSet;
} = {};

/** Whether the MCP invalidation listener has been registered. */
let mcpInvalidationListenerRegistered = false;

/**
 * Registers the MCP registry change listener that invalidates the cached
 * tool sets. Idempotent: the listener is attached exactly once.
 */
function ensureMcpInvalidationListener(): void {
	if (mcpInvalidationListenerRegistered) return;
	mcpInvalidationListenerRegistered = true;
	McpRegistry.getInstance().onDidChange(() => {
		userToolSets.plain = undefined;
		userToolSets.withTaskFinish = undefined;
	});
}

/**
 * Gets the cached pre-execution tool set, building it on first use or after
 * invalidation.
 * @param {boolean} isSubAgent - True for non-root/child sessions (includes task_finish)
 * @returns {ToolSet} The pre-execution tool set
 */
export function getUserToolSet(isSubAgent: boolean): ToolSet {
	ensureMcpInvalidationListener();
	const key = isSubAgent ? "withTaskFinish" : "plain";
	let toolSet = userToolSets[key];
	if (!toolSet) {
		toolSet = createUserToolSet(isSubAgent);
		userToolSets[key] = toolSet;
	}
	return toolSet;
}

/**
 * Builds the pre-execution (user tool plane) tool set: built-in common tools
 * plus all currently connected, schema-valid MCP tools under the same exposed
 * names as the Agent runtime.
 * @param {boolean} isSubAgent - True to include the task_finish tool
 * @returns {ToolSet} The pre-execution tool set
 */
function createUserToolSet(isSubAgent: boolean): ToolSet {
	const toolSet = new ToolSet({
		includeCommon: true,
		includeTaskFinish: isSubAgent,
	});
	const mcpRegistry = McpRegistry.getInstance();
	for (const record of mcpRegistry.getRecords()) {
		if (record.status !== "connected") {
			continue;
		}
		for (const tool of record.tools) {
			if (!tool.schemaValid) {
				continue;
			}
			const adapter = new McpToolAdapter(record.serverId, tool, mcpRegistry);
			if (!toolSet.hasTool(adapter.name)) {
				toolSet.addTool(adapter);
			}
		}
	}
	return toolSet;
}
