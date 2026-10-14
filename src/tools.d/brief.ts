/**
 * @fileoverview The `brief` trace-annotation parameter.
 *
 * Selected built-in tools declare a required `brief` string in their wire
 * schema: the model states, in a few words, what a call is for, and the
 * tool's prettyPrint shows that intent in place of raw arguments — turning
 * the execution trace into a readable story. Commands, regexes, UUIDs and
 * other unreadable argument values stay hidden until the call is expanded.
 *
 * Contract:
 * - Model-facing only: `brief` is required in the wire schema, but nothing
 *   at runtime validates it. Human pre-execution (`@[tool{...}]`), legacy
 *   session history and the rare non-compliant model all produce args
 *   without `brief`; `getBrief` then yields undefined and prettyPrint falls
 *   back to its deterministic argument-based form.
 * - Built-in tools only: the completion UI strips the parameter from
 *   built-in schemas (see completionService) so humans are never asked to
 *   author it. MCP tool schemas are external and always pass through
 *   verbatim — an MCP parameter that happens to share the name is a
 *   functional parameter, unrelated to this convention.
 * - `execute` implementations ignore `brief` entirely; it is trace metadata.
 *
 * @module tools.d/brief
 */

import type { Tool } from "@moonshot-ai/kosong";

/** Name of the trace-annotation parameter. */
export const BRIEF_PARAM = "brief";

/** Max rendered length of a brief; longer model output is truncated. */
const BRIEF_MAX_LENGTH = 120;

const BRIEF_SCHEMA = {
	type: "string",
	description:
		"Required. A very short phrase (under ~12 words) stating the intent of this call — what it accomplishes, for the human scanning your execution trace. Do not restate argument values (paths, commands, patterns); they are hidden when a brief is present.",
} as const;

/**
 * Return a copy of a built-in tool's wire definition with the required
 * `brief` parameter added. Apply to tools whose raw arguments do not read
 * as a clear intent in the execution trace.
 */
export function withBrief(definition: Tool): Tool {
	const parameters = definition.parameters as {
		properties?: Record<string, unknown>;
		required?: string[];
	};
	return {
		...definition,
		parameters: {
			...parameters,
			properties: {
				...parameters.properties,
				[BRIEF_PARAM]: BRIEF_SCHEMA,
			},
			required: [...(parameters.required ?? []), BRIEF_PARAM],
		},
	};
}

/**
 * Remove the `brief` parameter from a wire-schema parameters object. Used
 * when projecting built-in tool schemas for humans (completion menu /
 * params form), who must never be asked to author a model-facing
 * annotation. No-op when the schema has no `brief` property.
 */
export function stripBriefParam(
	parameters: Record<string, unknown>,
): Record<string, unknown> {
	const properties = parameters.properties as
		| Record<string, unknown>
		| undefined;
	if (!properties || !(BRIEF_PARAM in properties)) {
		return parameters;
	}
	const restProperties = { ...properties };
	delete restProperties[BRIEF_PARAM];
	const required = Array.isArray(parameters.required)
		? (parameters.required as unknown[]).filter(
				(name) => name !== BRIEF_PARAM,
			)
		: parameters.required;
	return {
		...parameters,
		properties: restProperties,
		required,
	};
}

/**
 * The model-authored brief for a tool call, or undefined when absent
 * (human pre-execution, legacy history, non-compliant model) — callers
 * then render their deterministic fallback summary instead.
 */
export function getBrief(args: any): string | undefined {
	if (typeof args?.brief !== "string") return undefined;
	const brief = args.brief.trim();
	if (!brief) return undefined;
	return brief.length > BRIEF_MAX_LENGTH
		? `${brief.substring(0, BRIEF_MAX_LENGTH)}...`
		: brief;
}
