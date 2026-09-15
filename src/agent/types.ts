/**
 * @fileoverview Agent module type definitions for the Mutsumi VSCode extension.
 * @module agent/types
 */

import type { ProviderType } from '@moonshot-ai/kosong';
import type { AgentStateInfo, AgentRuntimeStatus } from '../types';

// Re-export imported types
export type { AgentStateInfo, AgentRuntimeStatus };

/** Concrete reasoning effort levels sent to the LLM provider. */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** User-configurable reasoning effort values, including provider-default behavior. */
export type ReasoningEffortSetting = ReasoningEffort | 'default';

/**
 * Supported reasoning effort setting values in display order.
 * @remarks QuickPick and HTTP validation import this constant directly as the single source of truth.
 */
export const REASONING_EFFORT_SETTING_VALUES: readonly ReasoningEffortSetting[] = [
    'default',
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
];

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

/**
 * Options for configuring the agent runner.
 * @interface AgentRunOptions
 */
export interface AgentRunOptions {
    /** Model identifier to use for LLM calls */
    model: string;
    /** API key for the resolved provider */
    apiKey: string;
    /** Base URL for the provider's API */
    baseUrl: string | undefined;
    /** Wire protocol type of the resolved provider (kosong `ProviderType`), from the single validation gate */
    providerType: ProviderType;
    /** Maximum number of tool interaction loops */
    maxLoops?: number;
    /** Reasoning effort resolved and injected by the caller; the runner does not read global configuration */
    reasoningEffort?: string;
}

/**
 * Dispatch session information for managing sub-agent lifecycle.
 * @interface DispatchSession
 */
export interface DispatchSession {
    /** Parent agent UUID that created this dispatch session */
    parentId: string;
    /** Resolve function to complete the dispatch session */
    resolve: (value: string[]) => void;
    /** Reject function to fail the dispatch session */
    reject: (reason?: any) => void;
    /** Set of child agent UUIDs created in this session */
    childUuids: Set<string>;
    /** Map of child agent UUID to their results */
    results: Map<string, string>;
    /** Set of child agent UUIDs that have been deleted */
    deletedChildren: Set<string>;
}