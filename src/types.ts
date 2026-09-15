/**
 * @fileoverview Core type definitions for the Mutsumi VSCode extension.
 * @module types
 */

import type { ProviderType } from '@moonshot-ai/kosong';

/**
 * Provider configuration using snake_case for settings schema alignment.
 * @interface Provider
 */
export interface Provider {
    /** Provider name identifier */
    name: string;
    /** Base URL for the provider's API */
    baseurl: string;
    /** API key for the provider */
    api_key: string;
    /** Wire protocol type (kosong `ProviderType`): selects which line protocol / provider adapter talks to this endpoint */
    type: ProviderType;
}

/**
 * Explicit model + provider pair. Used throughout settings, configuration,
 * persistence, and execution to avoid ambiguous first-match resolution.
 * @interface ModelSelection
 */
export interface ModelSelection {
    /** Model identifier */
    model: string;
    /** Provider name that serves the model */
    provider: string;
}

/**
 * Default providers used when user hasn't configured any providers.
 */
export const DEFAULT_PROVIDERS: Provider[] = [
    { name: "kimi-for-coding", baseurl: "https://api.kimi.com/coding/v1", api_key: "", type: "kimi" }
];

/**
 * Runtime mirror of the kosong `ProviderType` union. Consumed by the
 * validation gate in utils.ts on untrusted settings JSON (a type-only
 * import cannot be checked at runtime).
 */
export const VALID_PROVIDER_TYPES = [
    "kimi",
    "openai",
    "openai_responses",
    "anthropic",
    "google-genai",
    "vertexai"
] as const satisfies readonly ProviderType[];

/**
 * Default models configuration used when user hasn't configured any models.
 * Keys are provider names, values are arrays of model identifiers supported
 * by that provider.
 */
export const DEFAULT_MODELS: Record<string, string[]> = {
    "kimi-for-coding": ["kimi-for-coding"]
};

/**
 * Built-in default model selection pair.
 */
export const DEFAULT_MODEL_SELECTION: ModelSelection = {
    model: "kimi-for-coding",
    provider: "kimi-for-coding"
};

/**
 * Metadata for an agent session stored in notebook metadata.
 * @interface AgentMetadata
 */
export interface McpToolSelection {
    serverId: string;
    toolNames: string[];
}

export interface AgentMetadata {
    /** Unique identifier for the agent */
    uuid: string;
    /** Display name of the agent */
    name: string;
    /** ISO timestamp when the agent was created */
    created_at: string;
    /** Parent agent ID if this is a sub-agent, null otherwise */
    parent_agent_id: string | null;
    /** List of URIs the agent is allowed to access */
    allowed_uris: string[];
    /** Whether the agent task has been completed */
    is_task_finished?: boolean;
    /** Model identifier used for this agent */
    model?: string;
    /** Provider name that serves the model (disambiguates when the same model appears under multiple providers) */
    provider?: string;
    /** Concrete reasoning effort override; 'default' or unset is represented by the key being absent */
    reasoning_effort?: string;
    /** Persisted context items (Files, Rules) valid for the whole session */
    contextItems?: ContextItem[];
    /** List of active rule filenames for this agent */
    activeRules?: string[];
    /** List of active skill filenames for this agent */
    activeSkills?: string[];
    /** Agent type identifier for role-based configuration */
    agentType?: string;
    /** Frozen selection of MCP tools enabled for this session. */
    enabledMcpTools?: McpToolSelection[];

    /** Format version marker written by the serializer for future .mtm migrators; never read at runtime */
    mtm_version?: number;

    /** List of sub-agent UUIDs created by this agent */
    sub_agents_list?: string[];
}

// ============================================================================
// kosong message model (everything below McpToolSelection)
// ============================================================================
import type { Message } from '@moonshot-ai/kosong';

/**
 * Message in an agent conversation.
 * Kosong `Message` in full (`content: ContentPart[]` and `toolCalls: ToolCall[]`
 * are both required) plus the Mutsumi cell↔message pipeline metadata channel.
 * `metadata` carries ghost-block / interaction state and never goes on the wire
 * (outbound messages are always rebuilt by explicit field construction).
 * @interface AgentMessage
 */
export interface AgentMessage extends Message {
    /** Pipeline-only metadata (e.g. ghost block state, mutsumi_interaction) */
    metadata?: { [key: string]: any };
}

/**
 * Complete agent context including metadata and conversation history.
 * @interface AgentContext
 */
export interface AgentContext {
    /** Agent metadata */
    metadata: AgentMetadata;
    /** Conversation message history */
    context: AgentMessage[];
}

/**
 * Tool request from the agent.
 * @interface ToolRequest
 */
export interface ToolRequest {
    /** Name of the tool to execute */
    name: string;
    /** Arguments for the tool */
    arguments: any;
}

/**
 * Result of a tool execution.
 * @interface ToolResult
 */
export interface ToolResult {
    /** Result content as string */
    content: string;
    /** Whether the tool execution resulted in an error */
    isError?: boolean;
}

/**
 * Runtime status of an agent.
 * - 'standby': Main agent, not running
 * - 'running': Currently executing
 * - 'pending': Sub-agent, waiting to run
 * - 'finished': Task completed
 */
export type AgentRuntimeStatus = 'standby' | 'running' | 'pending' | 'finished';

/**
 * Runtime state information for an agent.
 * @interface AgentStateInfo
 */
export interface AgentStateInfo {
    /** Unique identifier for the agent */
    uuid: string;
    /** Parent agent ID if this is a sub-agent */
    parentId: string | null;
    /** Display name of the agent */
    name: string;
    /** File URI string where the agent is stored */
    fileUri: string;
    
    /** Whether the notebook window is currently open */
    isWindowOpen: boolean;
    /** Whether the agent is currently running */
    isRunning: boolean;
    /** Whether the agent task has finished */
    isTaskFinished: boolean;
    
    /** Cached prompt text for the agent */
    prompt?: string;
    
    /** Set of child agent UUIDs for building the tree structure */
    childIds?: Set<string>;
}

/**
 * Context item representing a referenced resource (file, tool result, or rule).
 * Stored in cell metadata for persistence, not in message content.
 * @interface ContextItem
 */
export interface ContextItem {
    /** Type of context item */
    type: 'file' | 'tool' | 'rule' | 'macro';
    /** Key identifier (file path, tool name, or rule name) */
    key: string;
    /** Content or execution result */
    content: string;
    /** Additional metadata (e.g., tool arguments) */
    metadata?: any;
    /** Content hash for change detection (SHA-256) */
    lastHash?: string;
    /** Version number for file history tracking (starts at 1) */
    version?: number;
}
