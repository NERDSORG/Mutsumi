/**
 * @fileoverview Tool composition and execution for a single agent or plane.
 *
 * A ToolSet is an immutable combination of tools (built-in common tools,
 * task_finish, plus any additional tools) bound to one agent instance or one
 * execution plane (e.g. the human pre-execution plane). It owns tool lookup,
 * execution, and the display metadata queries (prettyPrint / rendering
 * config) for the tools it contains.
 *
 * @module tools.d/toolSet
 */

import type { ITool, ToolContext } from "./interface";
import type { Tool } from "@moonshot-ai/kosong";
import { ToolRegistry } from "./toolRegistry";
import { taskFinishTool } from "./tools/agent_control";

/**
 * Tool set configuration for different agent types.
 * @interface ToolSetConfig
 */
export interface ToolSetConfig {
	/** Include common tools (file operations, search, etc.) */
	includeCommon?: boolean;
	/** Include task_finish tool */
	includeTaskFinish?: boolean;
	/** Additional specific tools to include */
	additionalTools?: ITool[];
	/** Specific tools to exclude from common set */
	excludeTools?: string[];
}

/**
 * A specific combination of tools for an agent instance.
 * @class ToolSet
 * @description Encapsulates a specific set of tools, allowing different agents
 * to have different tool availability without affecting global state.
 */
export class ToolSet {
	private tools = new Map<string, ITool>();

	/**
	 * Creates a new ToolSet with the specified configuration.
	 * @constructor
	 * @param {ToolSetConfig} config - Tool set configuration
	 */
	constructor(config: ToolSetConfig = {}) {
		const {
			includeCommon = true,
			includeTaskFinish = false,
			additionalTools = [],
			excludeTools = [],
		} = config;

		// Add common tools
		if (includeCommon) {
			for (const tool of ToolRegistry.getCommonTools()) {
				if (!excludeTools.includes(tool.name)) {
					this.addTool(tool);
				}
			}
		}

		// Add task_finish if requested
		if (includeTaskFinish) {
			this.addTool(taskFinishTool);
		}

		// Add additional tools
		for (const tool of additionalTools) {
			this.addTool(tool);
		}
	}

	/**
	 * Gets all tool definitions in the provider-agnostic kosong wire schema.
	 * @returns {Tool[]} Array of tool definitions
	 */
	getDefinitions(): Tool[] {
		return Array.from(this.tools.values()).map((t) => t.definition);
	}

	/**
	 * Executes a tool with the given arguments.
	 * @param {string} name - Tool name
	 * @param {any} args - Tool arguments
	 * @param {ToolContext} context - Execution context
	 * @returns {Promise<string>} Tool execution result
	 * @throws {Error} If tool not found or execution fails
	 */
	async execute(
		name: string,
		args: any,
		context: ToolContext,
	): Promise<string> {
		const tool = this.tools.get(name);
		if (!tool) {
			return `Error: Tool '${name}' is not available in this agent's tool set.`;
		}
		return await tool.execute(args, context);
	}

	/**
	 * Gets the pretty print string for a tool call.
	 * @param {string} name - Tool name
	 * @param {any} args - Tool arguments
	 * @returns {string} Human-readable description
	 */
	getPrettyPrint(name: string, args: any): string {
		const tool = this.tools.get(name);
		if (!tool) {
			return `$(tools) Tool Call: ${name}`;
		}
		return tool.prettyPrint(args);
	}

	/**
	 * Gets whether a tool should have its results cached.
	 * @param {string} name - Tool name
	 * @returns {boolean} True if the tool should be cached
	 */
	getShouldCache(name: string): boolean {
		const tool = this.tools.get(name);
		if (!tool) {
			return false;
		}
		return tool.shouldCache ?? false;
	}

	/**
	 * Gets the rendering configuration for a tool.
	 * @param {string} name - Tool name
	 * @returns {Object | undefined} Rendering configuration
	 */
	getRenderingConfig(
		name: string,
	):
		| {
				argsToCodeBlock?: string[];
				codeBlockFilePaths?: (string | undefined)[];
		  }
		| undefined {
		const tool = this.tools.get(name);
		if (!tool) return undefined;
		return {
			argsToCodeBlock: tool.argsToCodeBlock,
			codeBlockFilePaths: tool.codeBlockFilePaths,
		};
	}

	/**
	 * Checks if a tool is available in this tool set.
	 * @param {string} name - Tool name
	 * @returns {boolean} True if tool is available
	 */
	hasTool(name: string): boolean {
		return this.tools.has(name);
	}

	/**
	 * Gets all available tool names.
	 * @returns {string[]} Array of tool names
	 */
	getToolNames(): string[] {
		return Array.from(this.tools.keys());
	}

	/**
	 * Adds a tool to this tool set dynamically.
	 * Used for special cases like injecting task_finish for sub-agents.
	 * @param {ITool} tool - The tool to add
	 */
	addTool(tool: ITool): void {
		if (this.tools.has(tool.name)) {
			throw new Error(`Duplicate tool name '${tool.name}' in tool set.`);
		}
		this.tools.set(tool.name, tool);
	}
}
