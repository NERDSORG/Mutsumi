/**
 * @fileoverview Adapter layer type definitions for Mutsumi.
 * Contains types specific to different adapter implementations (Notebook, Headless).
 * @module adapters/types
 */

import type {
  AgentMetadata,
  AgentMessage,
  AgentContext,
  ToolRequest,
  ToolResult,
  AgentRuntimeStatus,
  AgentStateInfo,
  ContextItem,
} from '../types';

// Re-export common types for convenience
export {
  AgentMetadata,
  AgentMessage,
  AgentContext,
  ToolRequest,
  ToolResult,
  AgentRuntimeStatus,
  AgentStateInfo,
  ContextItem,
};

/**
 * Adapter type identifier.
 * - 'notebook': UI-based adapter using VSCode Notebook API
 * - 'headless': API-based adapter for HTTP/ programmatic access
 */
export type AdapterType = 'notebook' | 'headless' | 'lite';

// Re-export LiteAdapter types for convenience
export { LiteAgentSessionConfig } from './liteAdapter';

// ============================================================================
// Headless Adapter HTTP API Types
// ============================================================================

/**
 * Chat request payload for Headless Adapter HTTP API.
 * @interface ChatRequest
 */
export interface ChatRequest {
  /** User prompt text */
  prompt: string;
  /** Optional model identifier to use for this request */
  model?: string;
}

/**
 * Chat response payload from Headless Adapter HTTP API.
 * @interface ChatResponse
 */
export interface ChatResponse {
  /** Generated response content */
  content: string;
  /** Response status indicator */
  status: string;
}
