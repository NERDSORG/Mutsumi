/**
 * @fileoverview Configuration interfaces for Mutsumi Agent Type system.
 * @module agentTypes/interfaces
 */

import { ModelSelection } from '../types';
import type { McpServersConfig } from "../tools.d/mcp/interfaces";

/**
 * Configuration for a specific agent type.
 * Defines role defaults and capability composition via toolSets.
 * Does not specify adapter (determined by runtime context).
 * LiteAdapter is reserved for internal utility tasks.
 */
export interface AgentTypeConfig {
    /** List of tool set names to combine (tools are unioned, duplicates removed) */
    toolSets: string[];

    /** Default model selection pair; omitted → fall back to global default */
    defaultModel?: ModelSelection;

    /** List of default rule file paths (relative to .mutsumi/rules/) */
    defaultRules: string[];

    /** List of default skill names to activate */
    defaultSkills: string[];

    /** List of agent type names this role may dispatch */
    allowedChildTypes: string[];

    /** Whether this role should appear in 'Mutsumi: New Agent' */
    isEntry: boolean;

    /** MCP servers whose currently discovered tools are selected for new agents. */
    defaultMcpServers?: string[];
}

/**
 * A tool set name is just a string identifier.
 */
export type ToolSetName = string;

/**
 * A tool set definition is an array of registered tool names.
 */
export type ToolSetDefinition = string[];

/**
 * Collection of all tool sets.
 * Maps tool set names to their definitions (arrays of tool names).
 */
export type ToolSetsConfig = Record<ToolSetName, ToolSetDefinition>;

/**
 * Complete Mutsumi configuration.
 */
export interface MutsumiConfig {
    /** Configuration schema version */
    version: number;

    /** Map of tool set names to tool name arrays */
    toolSets: ToolSetsConfig;

    /** Map of agent type names to agent type configurations */
    agentTypes: Record<string, AgentTypeConfig>;

    /** MCP servers configured for the extension host. */
    mcpServers: McpServersConfig;
}

/**
 * Map of agent type names to configurations.
 */
export type AgentTypeConfigMap = Record<string, AgentTypeConfig>;

/**
 * Resolved agent defaults after applying overrides.
 */
export interface ResolvedAgentDefaults {
    /** Resolved model identifier */
    model: string;
    /** Resolved provider identifier */
    provider: string;
    /** Resolved list of active rule files */
    rules: string[];
    /** Resolved list of active skill names */
    skills: string[];
    /** Tool set names for capability configuration */
    toolSets: string[];
    /** MCP server IDs used only when creating a new agent snapshot. */
    mcpServers: string[];
}

/**
 * Options for overriding resolved defaults.
 */
export interface ResolveAgentDefaultsOptions {
    /** Override the model selection (highest priority) */
    modelSelection?: ModelSelection;
    /** Override the rules (highest priority) */
    rules?: string[];
    /** Override the skills (highest priority) */
    skills?: string[];
    /** Available rules in the workspace - if provided, rules will be filtered to only include existing ones */
    availableRules?: string[];
}
