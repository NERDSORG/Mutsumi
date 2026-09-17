/**
 * @fileoverview Configuration types and built-in defaults for Mutsumi.
 *
 * This file contains only:
 * - Built-in default configuration (DEFAULT_MUTSUMI_CONFIG)
 * - Re-exports from interfaces.ts
 *
 * For validation utilities, see utils.ts.
 *
 * @module config/types
 */

import {
	type MutsumiConfig,
	AgentTypeConfig,
	ToolSetsConfig,
} from "./interfaces";

// Re-export all interfaces
export {
	MutsumiConfig,
	AgentTypeConfig,
	ToolSetsConfig,
	ToolSetName,
	ToolSetDefinition,
	AgentTypeConfigMap,
	ResolvedAgentDefaults,
	ResolveAgentDefaultsOptions,
} from "./interfaces";

// Re-export validation utilities from utils.ts
export {
	ConfigValidationError,
	validateMutsumiConfig,
} from "./utils";

/**
 * Built-in default configuration.
 * Used when `mutsumi.agentConfig` is not set in VSCode Settings.
 *
 * Base tool sets:
 * - read: File reading, search, and info tools (read-only)
 * - deliver: File writing, editing, shell execution (write operations)
 * - dispatch: Agent orchestration tools (dispatch_subagents, get_agent_types)
 * - communicate: Inter-session messaging (communicate)
 */
export const DEFAULT_MUTSUMI_CONFIG: MutsumiConfig = {
	version: 1,
	mcpServers: {},
	toolSets: {
		read: [
			"read",
			"glob",
			"grep",
			"find_filename",
			"get_env_var",
			"system_info",
			"project_outline",
			"diagnostics",
			"query_codebase",
			"inspect_shell_task",
			"kill_shell_task",
		],
		deliver: [
			"shell",
			"write",
			"edit",
			"mkdir",
		],
		dispatch: ["dispatch_subagents", "get_agent_types"],
		communicate: ["communicate"],
	},
	agentTypes: {
		chat: {
			toolSets: ["read", "communicate"],
			defaultModel: { model: "kimi-for-coding", provider: "kimi-for-coding" },
			defaultRules: ["default/chat.md"],
			defaultSkills: [],
			allowedChildTypes: [],
			isEntry: true,
		},
		implementer: {
			toolSets: ["read", "deliver", "dispatch", "communicate"],
			defaultModel: { model: "kimi-for-coding", provider: "kimi-for-coding" },
			defaultRules: ["default/implementer.md"],
			defaultSkills: [],
			allowedChildTypes: ["implementer", "reviewer"],
			isEntry: true,
		},
		orchestrator: {
			toolSets: ["read", "deliver", "dispatch", "communicate"],
			defaultModel: { model: "kimi-for-coding", provider: "kimi-for-coding" },
			defaultRules: ["default/orchestrator.md"],
			defaultSkills: [],
			allowedChildTypes: ["implementer", "reviewer"],
			isEntry: true,
		},
		reviewer: {
			toolSets: ["read", "communicate"],
			defaultModel: { model: "kimi-for-coding", provider: "kimi-for-coding" },
			defaultRules: ["default/reviewer.md"],
			defaultSkills: [],
			allowedChildTypes: [],
			isEntry: true,
		},
	},
};
