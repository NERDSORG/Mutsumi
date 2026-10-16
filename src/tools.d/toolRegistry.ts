/**
 * @fileoverview Built-in tool registry.
 *
 * ToolRegistry is the single declaration source for all built-in tools:
 * the common-tool singleton list is defined here and nowhere else. ToolSet
 * consumes this registry to compose per-agent tool combinations, and the
 * agentTypes toolSetRegistry validates tool names against it.
 *
 * @module tools.d/toolRegistry
 */

import type { ITool } from "./interface";
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
