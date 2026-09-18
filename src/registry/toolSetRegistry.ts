/**
 * @fileoverview ToolSet Registry for managing named tool set configurations.
 * @module registry/toolSetRegistry
 */

import type { ITool } from "../tools.d/interface";
import { ToolRegistry } from "../tools.d/toolManager";
import { type ToolSetsConfig } from "../config/interfaces";

/**
 * ToolSetRegistry manages named collections of tools.
 *
 * This registry is responsible for:
 * - Storing tool set configurations (name -> tool name array)
 * - Resolving tool names to actual ITool instances
 * - Validating that all referenced tools exist in ToolRegistry
 *
 * It is a singleton that should be initialized during extension activation
 * with configuration loaded from the `mutsumi.agentConfig` VSCode Setting.
 *
 * Unlike a one-shot init, `initialize()` may be called again (e.g. when the
 * `mutsumi.agentConfig` setting changes) to reload the configuration in place.
 * The `ready` flag only guards against reads before the first successful init.
 *
 * @example
 * ```typescript
 * const registry = ToolSetRegistry.getInstance();
 * registry.initialize(config.toolSets);
 * const tools = registry.getToolSet('read');
 * ```
 */
export class ToolSetRegistry {
	private static instance: ToolSetRegistry | null = null;
	private toolSets: Map<string, string[]> = new Map();
	private ready = false;

	/**
	 * Gets the singleton instance of ToolSetRegistry.
	 * @returns {ToolSetRegistry} The singleton instance
	 */
	static getInstance(): ToolSetRegistry {
		if (!ToolSetRegistry.instance) {
			ToolSetRegistry.instance = new ToolSetRegistry();
		}
		return ToolSetRegistry.instance;
	}

	/**
	 * Private constructor to enforce singleton pattern.
	 */
	private constructor() {}

	/**
	 * Loads (or reloads) the registry with tool set configurations.
	 *
	 * May be called multiple times: each call fully replaces the previous
	 * configuration. This is used during activation and again whenever the
	 * `mutsumi.agentConfig` setting changes.
	 *
	 * @param {ToolSetsConfig} config - Tool set configuration mapping names to tool name arrays
	 * @throws {Error} If a tool set references a non-existent tool
	 */
	initialize(config: ToolSetsConfig): void {
		// Clear existing tool sets so a reload fully replaces prior state
		this.toolSets.clear();

		// Process each tool set
		for (const [name, toolNames] of Object.entries(config)) {
			this.validateToolNames(toolNames, name);
			this.toolSets.set(name, [...toolNames]);
		}

		// Mark the registry as ready for queries
		this.ready = true;
	}

	/**
	 * Validates that all tool names in a list exist in the ToolRegistry.
	 *
	 * @private
	 * @param {string[]} toolNames - Array of tool names to validate
	 * @param {string} toolSetName - Name of the tool set (for error messages)
	 * @throws {Error} If any tool name is not registered
	 */
	private validateToolNames(toolNames: string[], toolSetName: string): void {
		const commonTools = ToolRegistry.getCommonTools();
		const taskFinishTool = ToolRegistry.getTaskFinishTool();

		// Build set of all available tool names
		const availableTools = new Set<string>(commonTools.map((t) => t.name));
		availableTools.add(taskFinishTool.name);

		// Validate each tool name
		for (const toolName of toolNames) {
			if (!availableTools.has(toolName)) {
				throw new Error(
					`Tool set '${toolSetName}' references unknown tool: '${toolName}'`,
				);
			}
		}
	}

	/**
	 * Gets a tool set by name, returning the array of ITool instances.
	 *
	 * @param {string} name - The tool set name (e.g., 'read', 'deliver', 'dispatch')
	 * @returns {ITool[]} Array of ITool instances for the named tool set
	 * @throws {Error} If the tool set does not exist
	 */
	getToolSet(name: string): ITool[] {
		this.ensureReady();

		const toolNames = this.toolSets.get(name);
		if (!toolNames) {
			throw new Error(`Tool set '${name}' not found`);
		}

		return this.resolveTools(toolNames);
	}

	/**
	 * Gets combined tools from multiple tool sets, with duplicates removed.
	 * Tools from later tool sets take precedence if there are duplicates (though tool names should be unique).
	 *
	 * @param {string[]} names - Array of tool set names to combine
	 * @returns {ITool[]} Combined array of ITool instances with duplicates removed
	 * @throws {Error} If any tool set does not exist
	 */
	getCombinedToolSet(names: string[]): ITool[] {
		this.ensureReady();

		const seenTools = new Map<string, ITool>();

		for (const name of names) {
			const tools = this.getToolSet(name);
			for (const tool of tools) {
				// Later tool sets overwrite earlier ones (though names should be unique)
				seenTools.set(tool.name, tool);
			}
		}

		return Array.from(seenTools.values());
	}

	/**
	 * Checks if a tool set with the given name exists.
	 *
	 * @param {string} name - The tool set name to check
	 * @returns {boolean} True if the tool set exists
	 */
	hasToolSet(name: string): boolean {
		this.ensureReady();
		return this.toolSets.has(name);
	}

	/**
	 * Gets all registered tool set names.
	 *
	 * @returns {string[]} Array of all tool set names
	 */
	getAllToolSetNames(): string[] {
		this.ensureReady();
		return Array.from(this.toolSets.keys());
	}

	/**
	 * Resolves an array of tool names to ITool instances.
	 *
	 * @private
	 * @param {string[]} toolNames - Array of tool names to resolve
	 * @returns {ITool[]} Array of resolved ITool instances
	 */
	private resolveTools(toolNames: string[]): ITool[] {
		const commonTools = ToolRegistry.getCommonTools();
		const taskFinishTool = ToolRegistry.getTaskFinishTool();

		// Build lookup map
		const toolMap = new Map<string, ITool>();
		for (const tool of commonTools) {
			toolMap.set(tool.name, tool);
		}
		toolMap.set(taskFinishTool.name, taskFinishTool);

		// Resolve names to tools
		return toolNames.map((name) => {
			const tool = toolMap.get(name);
			if (!tool) {
				throw new Error(`Tool '${name}' not found in registry`);
			}
			return tool;
		});
	}

	/**
	 * Guards against reads before the registry has been populated.
	 *
	 * @private
	 * @throws {Error} If `initialize()` has never been called successfully
	 */
	private ensureReady(): void {
		if (!this.ready) {
			throw new Error(
				"ToolSetRegistry not initialized. Call initialize() first.",
			);
		}
	}

	/**
	 * Resets the registry (primarily for testing).
	 */
	reset(): void {
		this.toolSets.clear();
		this.ready = false;
	}
}
