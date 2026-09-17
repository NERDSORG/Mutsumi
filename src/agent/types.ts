/**
 * @fileoverview Agent module type definitions for the Mutsumi VSCode extension.
 * @module agent/types
 * @description Type aliases, constants, and functions. Pure interfaces
 * (AgentRunOptions, DispatchSession, StreamGenerateOptions/Result,
 * RoundSnapshot, ToolExecutorCallbacks/Result, TitleGeneratorConfig,
 * GenerateTitleConfig) live in `agent/interfaces.ts`.
 */

import type { AgentStateInfo, AgentRuntimeStatus } from '../types';

// Re-export imported types
export type { AgentStateInfo, AgentRuntimeStatus };

/**
 * Normalizes a configured reasoning effort for request transmission without mutating the value.
 * @param {string | undefined | null} value - Raw metadata or configuration value
 * @returns {string | undefined} Undefined for null, undefined, an empty string, or the exact
 * 'default' sentinel; every other string is returned verbatim for transmission
 * @remarks Values are intentionally not trimmed or otherwise rewritten. Unknown or whitespace-bearing
 * values must reach the server unchanged so provider validation errors remain visible to the user.
 */
export function normalizeReasoningEffort(value: string | undefined | null): string | undefined {
    return value === null || value === undefined || value === '' || value === 'default' ? undefined : value;
}