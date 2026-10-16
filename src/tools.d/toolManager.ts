/**
 * @fileoverview Tool manager for agent tools.
 * @module toolManager
 */

import type { ITool, ToolContext } from "./interface";
import { readFileTool } from "./tools/read";
import { globTool } from "./tools/glob";
import { grepTool } from "./tools/grep";
import { shellTool } from "./tools/shell_exec";
import { editFileSearchReplaceTool } from "./tools/edit";
import { createOrReplaceTool } from "./tools/write";
import { searchFileNameIncludesTool } from "./tools/find_filename";
import {
	getEnvVarTool,
	systemInfoTool,
} from "./tools/system_info";
import { mkdirTool } from "./tools/fs_write_ops";
import {
	dispatchSubagentsTool,
	taskFinishTool,
	getAgentTypesTool,
	communicateTool,
} from "./tools/agent_control";
import { projectOutlineTool } from "./tools/project_outline";
import { getWarningErrorTool } from "./tools/diagnostics";
import { inspectShellTaskTool } from "./tools/inspect_shell_task";
import { killShellTaskTool } from "./tools/kill_shell_task";
import type { Tool } from "@moonshot-ai/kosong";
import { getCachedResult, setCachedResult } from "./cache";
import { McpRegistry } from "./mcp/registry";
import { McpToolAdapter } from "./mcp/tool";

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

/**
 * Global tool registry for managing all available tools.
 * @class ToolRegistry
 * @description Maintains the global registry of all tools. Used by ToolSet
 * to build specific tool combinations for agents.
 */
export class ToolRegistry {
	private static commonTools: ITool[] = [];
	private static initialized = false;

	/**
	 * Initializes the global tool registry.
	 * @description Should be called once during extension activation.
	 */
	static initialize(): void {
		if (ToolRegistry.initialized) return;

		// Register all common tools
		ToolRegistry.commonTools = [
			readFileTool,
			globTool,
			grepTool,
			shellTool,
			createOrReplaceTool,
			editFileSearchReplaceTool,
			searchFileNameIncludesTool,
			getEnvVarTool,
			systemInfoTool,
			mkdirTool,
			projectOutlineTool,
			getWarningErrorTool,
			inspectShellTaskTool,
			killShellTaskTool,
			dispatchSubagentsTool,
			getAgentTypesTool,
			communicateTool,
		];

		ToolRegistry.initialized = true;
	}

	/**
	 * Gets all common tools.
	 * @returns {ITool[]} Array of common tools
	 */
	static getCommonTools(): ITool[] {
		if (!ToolRegistry.initialized) {
			ToolRegistry.initialize();
		}
		return [...ToolRegistry.commonTools];
	}

	/**
	 * Gets the task_finish tool.
	 * @returns {ITool} The task_finish tool
	 */
	static getTaskFinishTool(): ITool {
		return taskFinishTool;
	}
}

/**
 * Global ToolManager for user/ContextManagement control plane operations.
 * Provides global tool access, completion, pre-execution, and rendering support.
 *
 * The pre-execution (user tool plane) tool set is cached and consists of the
 * built-in common tools plus every connected, schema-valid MCP tool exposed
 * under the same `mcp__<server>__<tool>__<hash>` names as the Agent runtime.
 * The cache is invalidated whenever the MCP registry state changes (reload,
 * disconnect, discovered tool list updates) and rebuilt lazily.
 */
export class ToolManager {
	/** Singleton instance */
	private static instance: ToolManager;

	/** Cached pre-execution tool sets, keyed by task_finish inclusion. */
	private readonly userToolSets: {
		plain?: ToolSet;
		withTaskFinish?: ToolSet;
	} = {};

	/**
	 * Gets the singleton instance of ToolManager.
	 * @static
	 * @returns {ToolManager} The singleton instance
	 */
	public static getInstance(): ToolManager {
		if (!ToolManager.instance) {
			ToolManager.instance = new ToolManager();
		}
		return ToolManager.instance;
	}

	/**
	 * Creates a new ToolManager instance.
	 * @constructor
	 */
	constructor() {
		if (!ToolManager.instance) {
			ToolManager.instance = this;
			McpRegistry.getInstance().onDidChange(() =>
				this.invalidateUserToolSets(),
			);
		}
	}

	/**
	 * Invalidates the cached pre-execution tool sets so they are rebuilt from
	 * the current MCP registry state on next use.
	 */
	public invalidateUserToolSets(): void {
		this.userToolSets.plain = undefined;
		this.userToolSets.withTaskFinish = undefined;
	}

	/**
	 * Gets the cached pre-execution tool set, building it on first use or
	 * after invalidation.
	 * @param {boolean} isSubAgent - True for non-root/child sessions (includes task_finish)
	 * @returns {ToolSet} The pre-execution tool set
	 */
	private getUserToolSet(isSubAgent: boolean): ToolSet {
		const key = isSubAgent ? "withTaskFinish" : "plain";
		let toolSet = this.userToolSets[key];
		if (!toolSet) {
			toolSet = createUserToolSet(isSubAgent);
			this.userToolSets[key] = toolSet;
		}
		return toolSet;
	}

	/**
	 * Gets tool definitions in the provider-agnostic kosong wire schema.
	 * @param {boolean} isSubAgent - True for non-root/child sessions (includes task_finish)
	 * @returns {Tool[]} Array of tool definitions
	 */
	public getToolsDefinitions(
		isSubAgent: boolean,
	): Tool[] {
		return this.getUserToolSet(isSubAgent).getDefinitions();
	}

	/**
	 * Executes a tool with the given arguments and context.
	 * @param {string} name - Tool name
	 * @param {any} args - Tool arguments
	 * @param {ToolContext} context - Execution context
	 * @param {boolean} isSubAgent - True for non-root/child sessions (includes task_finish)
	 * @returns {Promise<string>} Tool execution result
	 */
	public async executeTool(
		name: string,
		args: any,
		context: ToolContext,
		isSubAgent: boolean,
	): Promise<string> {
		const toolSet = this.getUserToolSet(isSubAgent);

		const shouldCache = toolSet.getShouldCache(name);

		if (shouldCache) {
			const cached = getCachedResult(name, args);
			if (cached !== undefined) {
				return cached;
			}
		}

		const result = await toolSet.execute(name, args, context);

		if (shouldCache) {
			setCachedResult(name, args, result);
		}

		return result;
	}

	/**
	 * Gets the pretty print string for a tool call.
	 * @param {string} name - Tool name
	 * @param {any} args - Tool arguments
	 * @param {boolean} isSubAgent - True for non-root/child sessions
	 * @returns {string} Human-readable description
	 */
	public getPrettyPrint(name: string, args: any, isSubAgent: boolean): string {
		return this.getUserToolSet(isSubAgent).getPrettyPrint(name, args);
	}

	/**
	 * Gets the rendering configuration for a tool.
	 * @param {string} name - Tool name
	 * @param {boolean} isSubAgent - True for non-root/child sessions
	 * @returns {Object | undefined} Rendering configuration
	 */
	public getToolRenderingConfig(
		name: string,
		isSubAgent: boolean,
	):
		| {
				argsToCodeBlock?: string[];
				codeBlockFilePaths?: (string | undefined)[];
		  }
		| undefined {
		return this.getUserToolSet(isSubAgent).getRenderingConfig(name);
	}
}

/**
 * Builds the pre-execution (user tool plane) tool set: built-in common tools
 * plus all currently connected, schema-valid MCP tools under the same exposed
 * names as the Agent runtime. Tool calls on this plane are user-authored and
 * execute without approval.
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
