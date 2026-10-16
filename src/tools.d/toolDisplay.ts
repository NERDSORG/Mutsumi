/**
 * @fileoverview Tool display metadata queries for non-execution scenarios.
 *
 * Resolves the pre-execution (user) tool set and delegates to its per-tool
 * display metadata. Used by snapshot re-rendering and other call sites that
 * need a human-readable summary or rendering configuration for a tool call
 * without executing it.
 *
 * @module tools.d/toolDisplay
 */

import { getUserToolSet } from "./userToolSet";

/**
 * Gets the pretty print (human-readable summary) string for a tool call.
 * @param {string} name - Tool name
 * @param {any} args - Tool arguments
 * @param {boolean} isSubAgent - True for non-root/child sessions
 * @returns {string} Human-readable description
 */
export function getToolSummary(
	name: string,
	args: any,
	isSubAgent: boolean,
): string {
	return getUserToolSet(isSubAgent).getPrettyPrint(name, args);
}

/**
 * Gets the rendering configuration for a tool.
 * @param {string} name - Tool name
 * @param {boolean} isSubAgent - True for non-root/child sessions
 * @returns {Object | undefined} Rendering configuration
 */
export function getToolRenderConfig(
	name: string,
	isSubAgent: boolean,
):
	| {
			argsToCodeBlock?: string[];
			codeBlockFilePaths?: (string | undefined)[];
	  }
	| undefined {
	return getUserToolSet(isSubAgent).getRenderingConfig(name);
}
