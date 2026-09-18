/**
 * @fileoverview Configuration utilities for Mutsumi Agent Type system.
 * 
 * This module contains validation and helper functions for configuration.
 * 
 * @module agentTypes/utils
 */

import {
    MutsumiConfig,
    AgentTypeConfig
} from './interfaces';
import { validateMcpServersConfig } from '../tools.d/mcp/utils';

/**
 * Validation error for configuration issues.
 */
export class ConfigValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigValidationError';
    }
}

/**
 * Validates that an agent type configuration is internally consistent.
 * @private
 * @param {string} name - The agent type name
 * @param {AgentTypeConfig} config - The configuration to validate
 * @param {Set<string>} allTypeNames - Set of all defined type names
 * @param {Set<string>} toolSetNames - Set of available tool set names
 * @throws {ConfigValidationError} If validation fails
 */
function validateAgentType(
    name: string,
    config: AgentTypeConfig,
    allTypeNames: Set<string>,
    toolSetNames: Set<string>
): void {
    // Validate toolSets reference (must be an array)
    if (!Array.isArray(config.toolSets)) {
        throw new ConfigValidationError(
            `toolSets must be an array for agent type "${name}"`
        );
    }
    for (const toolSetName of config.toolSets) {
        if (typeof toolSetName !== 'string') {
            throw new ConfigValidationError(
                `Tool set name must be a string in agent type "${name}"`
            );
        }
        if (!toolSetNames.has(toolSetName)) {
            throw new ConfigValidationError(
                `Unknown tool set "${toolSetName}" referenced by agent type "${name}"`
            );
        }
    }

    // Validate defaultModel (optional; when present must be a complete pair)
    if (config.defaultModel !== undefined) {
        if (!config.defaultModel || typeof config.defaultModel !== 'object' || Array.isArray(config.defaultModel)) {
            throw new ConfigValidationError(
                `defaultModel must be an object with "model" and "provider" for agent type "${name}"`
            );
        }
        if (typeof config.defaultModel.model !== 'string' || !config.defaultModel.model.trim()) {
            throw new ConfigValidationError(
                `defaultModel.model must be a non-empty string for agent type "${name}"`
            );
        }
        if (typeof config.defaultModel.provider !== 'string' || !config.defaultModel.provider.trim()) {
            throw new ConfigValidationError(
                `defaultModel.provider must be a non-empty string for agent type "${name}"`
            );
        }
    }

    // Validate defaultRules
    if (!Array.isArray(config.defaultRules)) {
        throw new ConfigValidationError(
            `defaultRules must be an array for agent type "${name}"`
        );
    }
    for (const rule of config.defaultRules) {
        if (typeof rule !== 'string') {
            throw new ConfigValidationError(
                `Rule path must be a string in agent type "${name}"`
            );
        }
    }

    // Validate defaultSkills
    if (!Array.isArray(config.defaultSkills)) {
        throw new ConfigValidationError(
            `defaultSkills must be an array for agent type "${name}"`
        );
    }
    for (const skill of config.defaultSkills) {
        if (typeof skill !== 'string') {
            throw new ConfigValidationError(
                `Skill name must be a string in agent type "${name}"`
            );
        }
    }

    // Validate allowedChildTypes
    if (!Array.isArray(config.allowedChildTypes)) {
        throw new ConfigValidationError(
            `allowedChildTypes must be an array for agent type "${name}"`
        );
    }
    for (const childType of config.allowedChildTypes) {
        if (typeof childType !== 'string') {
            throw new ConfigValidationError(
                `Child type name must be a string in agent type "${name}"`
            );
        }
        if (!allTypeNames.has(childType)) {
            throw new ConfigValidationError(
                `Unknown child type "${childType}" in allowedChildTypes of "${name}"`
            );
        }
    }

    if (config.defaultMcpServers !== undefined) {
        if (!Array.isArray(config.defaultMcpServers) || !config.defaultMcpServers.every(serverId => typeof serverId === 'string' && !!serverId)) {
            throw new ConfigValidationError(`defaultMcpServers must be a string array of non-empty IDs for agent type "${name}"`);
        }
        if (new Set(config.defaultMcpServers).size !== config.defaultMcpServers.length) {
            throw new ConfigValidationError(`defaultMcpServers must not contain duplicates for agent type "${name}"`);
        }
    }

    // Validate isEntry
    if (typeof config.isEntry !== 'boolean') {
        throw new ConfigValidationError(
            `isEntry must be a boolean for agent type "${name}"`
        );
    }
}

/**
 * Validates that a tool set is properly defined.
 * @private
 * @param {string} toolSetName - The tool set name
 * @param {unknown} toolList - The tool list to validate
 * @param {Set<string>} [registeredTools] - Optional set of registered tool names
 * @throws {ConfigValidationError} If validation fails
 */
function validateToolSet(
    toolSetName: string,
    toolList: unknown,
    registeredTools?: Set<string>
): void {
    if (!Array.isArray(toolList)) {
        throw new ConfigValidationError(`Tool set "${toolSetName}" must be an array`);
    }
    for (const toolName of toolList) {
        if (typeof toolName !== 'string') {
            throw new ConfigValidationError(
                `Tool name in "${toolSetName}" must be a string: ${toolName}`
            );
        }
        // If registered tools provided, validate tool exists
        if (registeredTools && !registeredTools.has(toolName)) {
            throw new ConfigValidationError(
                `Unknown tool "${toolName}" in tool set "${toolSetName}"`
            );
        }
    }
}

/**
 * Validate a MutsumiConfig object.
 * @param config - Configuration to validate
 * @param registeredTools - Set of registered tool names for validation
 * @throws ConfigValidationError if validation fails
 */
export function validateMutsumiConfig(
    config: MutsumiConfig,
    registeredTools?: Set<string>
): void {
    // Validate version
    if (typeof config.version !== 'number' || config.version !== 1) {
        throw new ConfigValidationError(`Invalid config version: ${config.version}. Expected: 1`);
    }

    // Validate toolSets
    if (!config.toolSets || typeof config.toolSets !== 'object') {
        throw new ConfigValidationError('Missing or invalid toolSets');
    }

    for (const [toolSetName, toolList] of Object.entries(config.toolSets)) {
        validateToolSet(toolSetName, toolList, registeredTools);
    }

    // Validate agentTypes
    if (!config.agentTypes || typeof config.agentTypes !== 'object') {
        throw new ConfigValidationError('Missing or invalid agentTypes');
    }

    try {
        validateMcpServersConfig(config.mcpServers);
    } catch (error) {
        throw new ConfigValidationError(error instanceof Error ? error.message : String(error));
    }

    const agentTypeNames = new Set(Object.keys(config.agentTypes));
    const toolSetNames = new Set(Object.keys(config.toolSets));
    const mcpServerNames = new Set(Object.keys(config.mcpServers));

    for (const [agentTypeName, agentConfig] of Object.entries(config.agentTypes)) {
        validateAgentType(agentTypeName, agentConfig, agentTypeNames, toolSetNames);
        for (const serverId of agentConfig.defaultMcpServers ?? []) {
            if (!mcpServerNames.has(serverId)) {
                throw new ConfigValidationError(`Unknown MCP server "${serverId}" referenced by agent type "${agentTypeName}"`);
            }
        }
    }
}
