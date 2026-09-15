/**
 * @fileoverview Pure interface contracts for the agent module.
 * @module agent/interfaces
 * @description Pure interfaces only. Type aliases, constants, and functions
 * (e.g. {@link ReasoningEffort}, {@link REASONING_EFFORT_SETTING_VALUES},
 * `normalizeReasoningEffort`) live in `agent/types.ts` per the module
 * file-division convention.
 */

import type { ChatProvider, Message, ProviderType, Tool, ToolCall } from '@moonshot-ai/kosong';
import type { AgentMessage, ModelSelection } from '../types';
import type { RenderBlock } from '../notebook/renderTypes';

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
    resolve: (value: string | PromiseLike<string>) => void;
    /** Reject function to fail the dispatch session */
    reject: (reason?: any) => void;
    /** Set of child agent UUIDs created in this session */
    childUuids: Set<string>;
    /** Map of child agent UUID to their results */
    results: Map<string, string>;
    /** Set of child agent UUIDs that have been deleted */
    deletedChildren: Set<string>;
}

/**
 * Options for a single streamed generation round.
 * @interface StreamGenerateOptions
 */
export interface StreamGenerateOptions {
    /** kosong chat provider (one per AgentRunner instance) */
    provider: ChatProvider;
    /** System prompt extracted at the send boundary */
    systemPrompt: string;
    /** Conversation history with all system messages already stripped */
    history: Message[];
    /** Tool definitions (kosong wire schema) */
    tools: Tool[];
    /** Abort signal for cancellation */
    signal: AbortSignal;
    /** Per-part display progress callback (accumulated values, not deltas) */
    onProgress?: (content: string, reasoning: string, pendingTools: ToolCall[]) => void | Promise<void>;
    /** Fired before every retry attempt (after the first) so the UI can roll the round back */
    onRetry?: () => void;
}

/**
 * Result of a successful streamed generation round.
 * @interface StreamGenerateResult
 */
export interface StreamGenerateResult {
    /** kosong-assembled authoritative assistant message — the ONLY history source */
    message: Message;
    /** Display accumulator: round content (for commitRoundUI) */
    roundContent: string;
    /** Display accumulator: round reasoning (for commitRoundUI) */
    roundReasoning: string;
    /** Provider trace id (Kimi/KFC only), for debug logging */
    traceId: string | null;
}

/**
 * Point-in-time render state captured at round start.
 * @description Used by the retry loop to roll the UI back so a retried
 * attempt renders as if the previous attempt never happened.
 * @interface RoundSnapshot
 */
export interface RoundSnapshot {
    /** Length of the committed block list at snapshot time */
    committedLength: number;
    /** L2 lock state at snapshot time */
    reasoningLocked: boolean;
    /** L2 lock state at snapshot time */
    contentLocked: boolean;
}

/**
 * Callbacks for UI updates and termination signaling.
 * @interface ToolExecutorCallbacks
 */
export interface ToolExecutorCallbacks {
	/** Append a completed render block to the UI */
	appendOutput: (block: RenderBlock) => Promise<void>;
	/** Signal that the task should terminate */
	signalTermination: () => void;
}

/**
 * Result of executing tools
 * @interface ToolExecutionResult
 */
export interface ToolExecutionResult {
	/** Messages from tool executions */
	messages: AgentMessage[];
	/** Whether the agent should terminate */
	shouldTerminate: boolean;
	/** Whether this is a successful task completion (e.g., from task_finish tool) */
	isTaskComplete: boolean;
}

/**
 * Configuration interface for title generation.
 * @interface TitleGeneratorConfig
 */
export interface TitleGeneratorConfig {
    /** Model selection pair to use for title generation */
    modelSelection?: ModelSelection;
}

/**
 * Self-contained configuration for a title generation run.
 * @interface GenerateTitleConfig
 */
export interface GenerateTitleConfig {
    /** API key for the resolved provider */
    apiKey: string;
    /** Base URL for the provider's API */
    baseUrl: string | undefined;
    /** Model identifier to use */
    model: string;
    /** Wire protocol type of the resolved provider */
    providerType: ProviderType;
}
