/**
 * @fileoverview Configuration loader for Mutsumi Agent Type system.
 * @module agentTypes/loader
 */

import * as vscode from "vscode";
import {
	type MutsumiConfig,
	type AgentTypeConfig,
	DEFAULT_MUTSUMI_CONFIG,
	validateMutsumiConfig,
	ConfigValidationError,
} from "./types";

/**
 * Deep merge two MutsumiConfig objects.
 * User config overrides built-in defaults, with partial overrides supported.
 * @param defaults - Built-in default configuration
 * @param userConfig - User-provided configuration
 * @returns Merged configuration
 */
function mergeConfig(
	defaults: MutsumiConfig,
	userConfig: Partial<MutsumiConfig>,
): MutsumiConfig {
	// Start with default toolSets
	const mergedToolSets: Record<string, string[]> = { ...defaults.toolSets };

	if (userConfig.toolSets) {
		for (const [name, tools] of Object.entries(userConfig.toolSets)) {
			if (Array.isArray(tools)) {
				mergedToolSets[name] = tools;
			}
		}
	}

	const mergedAgentTypes: Record<string, AgentTypeConfig> = {};

	for (const [name, config] of Object.entries(defaults.agentTypes)) {
		mergedAgentTypes[name] = { ...config };
	}

	if (userConfig.agentTypes) {
		for (const [name, userAgentConfig] of Object.entries(
			userConfig.agentTypes,
		)) {
			if (userAgentConfig && typeof userAgentConfig === "object") {
				if (mergedAgentTypes[name]) {
					mergedAgentTypes[name] = {
						...mergedAgentTypes[name],
						...userAgentConfig,
					};
				} else {
					mergedAgentTypes[name] = userAgentConfig as AgentTypeConfig;
				}
			}
		}
	}

	return {
		version: defaults.version,
		toolSets: mergedToolSets,
		agentTypes: mergedAgentTypes,
		mcpServers: { ...defaults.mcpServers },
	};
}

/**
 * Load Mutsumi configuration from VSCode Settings.
 *
 * 1. Starts with built-in default configuration
 * 2. Reads `mutsumi.agentConfig` from VSCode Settings (user-level + workspace overlay)
 * 3. Merges user config with defaults (user config takes precedence)
 * 4. Validates the merged configuration
 *
 * @param registeredTools - Optional set of registered tool names for validation
 * @returns Validated MutsumiConfig
 * @throws ConfigValidationError if configuration is invalid
 */
export function loadMutsumiConfig(
	registeredTools?: Set<string>,
): MutsumiConfig {
	const userConfig =
		vscode.workspace
			.getConfiguration("mutsumi")
			.get<Partial<MutsumiConfig>>("agentConfig") ?? {};

	const config = mergeConfig(DEFAULT_MUTSUMI_CONFIG, userConfig);
	config.mcpServers = vscode.workspace
		.getConfiguration("mutsumi")
		.get("mcpServers", {});

	validateMutsumiConfig(config, registeredTools);

	return config;
}
