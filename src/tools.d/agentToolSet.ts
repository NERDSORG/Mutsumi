/**
 * @fileoverview Agent-scoped tool set construction.
 *
 * Builds the immutable ToolSet for a single agent run from its agentType
 * configuration (AgentTypeRegistry/ToolSetRegistry) plus the persisted MCP
 * tool selection snapshot. Lives in its own module so toolSet/toolRegistry
 * do not depend on the agentTypes registries (toolSetRegistry already
 * imports ToolRegistry from toolRegistry).
 *
 * @module tools.d/agentToolSet
 */

import { AgentTypeRegistry } from "../agentTypes/registry/agentTypeRegistry";
import { ToolSetRegistry } from "../agentTypes/registry/toolSetRegistry";
import { ToolRegistry } from "./toolRegistry";
import { ToolSet } from "./toolSet";
import { McpRegistry } from "./mcp/registry";
import { McpToolAdapter } from "./mcp/tool";
import type { McpToolSelection } from "./mcp/interfaces";
import { normalizeMcpToolSelections } from "./mcp/utils";

/**
 * Creates a tool set for an agent based on its agentType configuration.
 * Resolves toolSets from AgentTypeRegistry and adds task_finish for non-root agents.
 *
 * @returns {ToolSet} Configured tool set
 * @throws {Error} If agentType is invalid
 */
export interface CreateToolSetForAgentOptions {
	agentType: string;
	agentId?: string;
	parentAgentId?: string | null;
	enabledMcpTools?: McpToolSelection[];
}

/**
 * Builds the immutable tool set for a single agent run. MCP selections are a
 * persisted session snapshot; only tools that remain available in the registry
 * are added to this run.
 */
export function createToolSetForAgent(
	options: CreateToolSetForAgentOptions,
): ToolSet {
	const { agentType, agentId, parentAgentId, enabledMcpTools = [] } = options;
	const agentTypeConfig =
		AgentTypeRegistry.getInstance().getAgentType(agentType);
	if (!agentTypeConfig) {
		throw new Error(
			`Unknown agent type '${agentType}' for agent ${agentId || "unknown"}. ` +
				`Available types: ${AgentTypeRegistry.getInstance().getAllTypes().join(", ")}`,
		);
	}

	// Get combined tools from all specified tool sets
	const tools = ToolSetRegistry.getInstance().getCombinedToolSet(
		agentTypeConfig.toolSets,
	);

	// Create ToolSet with specific tools
	const toolSet = new ToolSet({
		includeCommon: false,
		includeTaskFinish: false,
		additionalTools: tools,
	});

	const mcpRegistry = McpRegistry.getInstance();
	for (const selection of normalizeMcpToolSelections(enabledMcpTools)) {
		for (const toolName of selection.toolNames) {
			const tool = mcpRegistry.getTool(selection.serverId, toolName);
			if (tool) {
				toolSet.addTool(new McpToolAdapter(selection.serverId, tool, mcpRegistry));
			}
		}
	}

	// task_finish remains available only to sub-agents.
	if (parentAgentId) {
		const taskFinishTool = ToolRegistry.getTaskFinishTool();
		toolSet.addTool(taskFinishTool);
	}

	return toolSet;
}

/**
 * Creates an empty tool set for special purposes (e.g., title generation).
 * @returns {ToolSet} Empty tool set
 */
export function createEmptyToolSet(): ToolSet {
	return new ToolSet({
		includeCommon: false,
		includeTaskFinish: false,
	});
}
