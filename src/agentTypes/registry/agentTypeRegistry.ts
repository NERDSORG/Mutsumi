/**
 * @fileoverview Agent Type Registry for managing agent type configurations.
 * @module agentTypes/registry/agentTypeRegistry
 */

import type { AgentTypeConfig, AgentTypeConfigMap } from "../interfaces";
import { DEFAULT_MUTSUMI_CONFIG } from "../types";

/**
 * Stores agent type configurations, validates toolSets/child types, provides entry type queries.
 *
 * Initialized during extension activation with config from the `mutsumi.agentConfig`
 * VSCode Setting. Unlike a one-shot init, `initialize()` may be called again (e.g.
 * when the setting changes) to reload the configuration in place. The `ready` flag
 * only guards against reads before the first successful init.
 */
export class AgentTypeRegistry {
	private static instance: AgentTypeRegistry | null = null;
	private agentTypes: Map<string, AgentTypeConfig> = new Map();
	private toolSetNames: Set<string> = new Set();
	private ready = false;

	/**
	 * Gets the singleton instance.
	 * @returns {AgentTypeRegistry} The singleton instance
	 */
	static getInstance(): AgentTypeRegistry {
		if (!AgentTypeRegistry.instance) {
			AgentTypeRegistry.instance = new AgentTypeRegistry();
		}
		return AgentTypeRegistry.instance;
	}

	/**
	 * Private constructor to enforce singleton pattern.
	 */
	private constructor() {}

	/**
	 * Loads (or reloads) the registry with agent type configurations.
	 *
	 * May be called multiple times: each call fully replaces the previous
	 * configuration. This is used during activation and again whenever the
	 * `mutsumi.agentConfig` setting changes. It validates all references
	 * to ensure consistency.
	 *
	 * @param {AgentTypeConfigMap} config - Agent type configuration
	 * @param {string[]} toolSetNames - Available tool set names for validation
	 * @throws {Error} If validation fails
	 */
	initialize(config: AgentTypeConfigMap, toolSetNames: string[]): void {
		// Clear existing types so a reload fully replaces prior state
		this.agentTypes.clear();
		this.toolSetNames = new Set(toolSetNames);

		// First pass: collect all type names for child type validation
		const allTypeNames = new Set(Object.keys(config));

		// Second pass: validate and store each agent type
		for (const [name, typeConfig] of Object.entries(config)) {
			this.validateAgentType(name, typeConfig, allTypeNames);
			this.agentTypes.set(name, { ...typeConfig }); // Clone
		}

		// Mark the registry as ready for queries
		this.ready = true;
	}

	/**
	 * Validates an agent type configuration.
	 * @private
	 * @param {string} name - The agent type name
	 * @param {AgentTypeConfig} config - The configuration to validate
	 * @param {Set<string>} allTypeNames - Set of all defined type names
	 * @throws {Error} If validation fails
	 */
	private validateAgentType(
		name: string,
		config: AgentTypeConfig,
		allTypeNames: Set<string>,
	): void {
		// Validate tool set references (must be an array)
		if (!Array.isArray(config.toolSets)) {
			throw new Error(`Agent type '${name}' must have toolSets as an array`);
		}
		for (const toolSetName of config.toolSets) {
			if (!this.toolSetNames.has(toolSetName)) {
				throw new Error(
					`Agent type '${name}' references unknown tool set: '${toolSetName}'`,
				);
			}
		}

		// Validate allowedChildTypes
		for (const childType of config.allowedChildTypes) {
			if (!allTypeNames.has(childType)) {
				throw new Error(
					`Agent type '${name}' references unknown child type: '${childType}'`,
				);
			}
		}
	}

	/**
	 * Gets an agent type configuration by name.
	 * @param {string} name - The agent type name
	 * @returns {AgentTypeConfig | undefined} The configuration or undefined if not found
	 */
	getAgentType(name: string): AgentTypeConfig | undefined {
		this.ensureReady();
		return this.agentTypes.get(name);
	}

	/**
	 * Lists all agent type names that can be created as entry agents.
	 * @returns {string[]} Array of entry type names
	 */
	listEntryTypes(): string[] {
		this.ensureReady();
		const entries: string[] = [];
		for (const [name, config] of this.agentTypes) {
			if (config.isEntry) {
				entries.push(name);
			}
		}
		return entries;
	}

	/**
	 * Checks if a child type is valid for a given parent type.
	 * @param {string} parentType - The parent agent type name
	 * @param {string} childType - The child agent type name to validate
	 * @returns {boolean} True if the child type is allowed
	 */
	isValidChildType(parentType: string, childType: string): boolean {
		this.ensureReady();
		const parent = this.agentTypes.get(parentType);
		if (!parent) {
			return false;
		}
		return parent.allowedChildTypes.includes(childType);
	}

	/**
	 * Gets all registered agent type names.
	 * @returns {string[]} Array of all agent type names
	 */
	getAllTypes(): string[] {
		this.ensureReady();
		return Array.from(this.agentTypes.keys());
	}

	/**
	 * Checks if an agent type exists.
	 * @param {string} name - The agent type name to check
	 * @returns {boolean} True if the type exists
	 */
	hasAgentType(name: string): boolean {
		this.ensureReady();
		return this.agentTypes.has(name);
	}

	/**
	 * Gets the tool set names for an agent type.
	 * @param {string} name - The agent type name
	 * @returns {string[] | undefined} The tool set names or undefined
	 */
	getToolSetNames(name: string): string[] | undefined {
		this.ensureReady();
		return this.agentTypes.get(name)?.toolSets;
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
				"AgentTypeRegistry not initialized. Call initialize() first.",
			);
		}
	}

	/**
	 * Resets the registry (primarily for testing).
	 */
	reset(): void {
		this.agentTypes.clear();
		this.toolSetNames.clear();
		this.ready = false;
	}
}
