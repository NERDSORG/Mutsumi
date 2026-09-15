/**
 * @fileoverview LLM Stream Handler for processing streaming responses using LLMClient.
 * @module llmStream
 */

import { LLMClient, StreamChunk } from './llmClient';
import type { ToolCall } from '@moonshot-ai/kosong';
import type { AgentMessage } from '../types';
import { toOpenAIMessage } from './openaiProjection';

/**
 * Callback function type for streaming progress updates.
 * @callback StreamProgressCallback
 * @param {string} content - Accumulated content from the stream
 * @param {string} reasoning - Accumulated reasoning content from the stream
 * @param {any[]} [toolCalls] - Accumulated raw tool calls (may be partial/incomplete)
 */
export type StreamProgressCallback = (content: string, reasoning: string, toolCalls?: any[]) => void;

/**
 * Result of a streaming response operation.
 * @interface StreamResponseResult
 */
export interface StreamResponseResult {
    /** Accumulated content from the LLM response */
    roundContent: string;
    /** Accumulated reasoning content (e.g., from DeepSeek reasoning models) */
    roundReasoning: string;
    /** Parsed tool calls from the response */
    toolCalls: ToolCall[];
}

/**
 * Checks if an error is retryable (network-related).
 * @param {any} error - The error to check
 * @returns {boolean} True if the error is retryable
 * @example
 * if (isRetryableError(error)) {
 *     await retryWithBackoff();
 * }
 */
function isRetryableError(error: any): boolean {
    if (!error) return false;
    
    const errorMessage = error.message || error.toString();
    const retryablePatterns = [
        'ECONNRESET',
        'ETIMEDOUT',
        'ECONNREFUSED',
        'ENOTFOUND',
        'EAI_AGAIN',
        'socket hang up',
        'network timeout',
        'failed to fetch',
        'disconnected',
        'network error',
        'aborted' // Only when not user-initiated
    ];
    
    return retryablePatterns.some(pattern => 
        errorMessage.toLowerCase().includes(pattern.toLowerCase())
    );
}

/**
 * Delays execution for the specified milliseconds.
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 * @example
 * await delay(1000); // Wait 1 second
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Handles LLM streaming responses and tool call parsing.
 * @description Manages the streaming interaction with LLM via LLMClient,
 * collecting content, reasoning content, and tool calls from the stream.
 * Includes exponential backoff retry logic for network failures.
 * @class LLMStreamHandler
 * @example
 * const handler = new LLMStreamHandler(llmClient);
 * const result = await handler.streamResponse(messages, tools, signal, (content, reasoning) => {
 *   console.log('Progress:', content);
 * });
 */
export class LLMStreamHandler {
    /** Maximum number of retry attempts for failed requests */
    private readonly maxRetries = 3;
    /** Base delay in milliseconds for exponential backoff (1s, 2s, 4s) */
    private readonly baseDelayMs = 1000;

    /**
     * Creates a new LLMStreamHandler instance.
     * @constructor
     * @param {LLMClient} llmClient - LLM client instance for making API calls
     */
    constructor(private llmClient: LLMClient) {}

    /**
     * Streams the LLM response and collects content, reasoning, and tool calls.
     * @description Runs the conversation loop with the LLM, handling streaming,
     * retries with exponential backoff for network errors, and result collection.
     * @param {any[]} messages - Current message history
     * @param {any[]} tools - Tool definitions to provide to the LLM
     * @param {AbortSignal} signal - Abort signal for cancellation
     * @param {StreamProgressCallback} [onProgress] - Optional callback for progress updates
     * @returns {Promise<StreamResponseResult>} Object containing roundContent, roundReasoning, and toolCalls
     * @throws {Error} If the API call fails after all retries or is aborted
     * @example
     * const result = await handler.streamResponse(
     *   messages,
     *   toolDefinitions,
     *   abortController.signal,
     *   (content, reasoning) => updateUI(content, reasoning)
     * );
     */
    async streamResponse(
        messages: AgentMessage[],
        tools: any[],
        signal: AbortSignal,
        onProgress?: StreamProgressCallback
    ): Promise<StreamResponseResult> {
        let attempt = 0;
        
        while (attempt <= this.maxRetries) {
            try {
                return await this.doStreamResponse(messages, tools, signal, onProgress);
            } catch (error) {
                // Don't retry if user aborted
                if (signal.aborted) {
                    throw error;
                }
                
                // Check if this is a retryable error
                if (isRetryableError(error) && attempt < this.maxRetries) {
                    attempt++;
                    const delayMs = this.baseDelayMs * Math.pow(2, attempt - 1);
                    console.warn(`LLM stream failed, retrying (${attempt}/${this.maxRetries}) after ${delayMs}ms...`, error);
                    await delay(delayMs);
                    continue;
                }
                
                // Not retryable or max retries exceeded
                throw error;
            }
        }
        
        throw new Error('Max retries exceeded for LLM stream request');
    }

    /**
     * Performs the actual streaming request.
     * @private
     * @param {any[]} messages - Current message history
     * @param {any[]} tools - Tool definitions to provide to the LLM
     * @param {AbortSignal} signal - Abort signal for cancellation
     * @param {StreamProgressCallback} [onProgress] - Optional callback for progress updates
     * @returns {Promise<StreamResponseResult>} Object containing roundContent, roundReasoning, and toolCalls
     * @throws {Error} If the API call fails or is aborted
     */
    private async doStreamResponse(
        messages: AgentMessage[],
        tools: any[],
        signal: AbortSignal,
        onProgress?: StreamProgressCallback
    ): Promise<StreamResponseResult> {
        const stream = this.llmClient.streamChatCompletion({
            // Outbound kosong messages are projected to the OpenAI wire shape
            // (see openaiProjection.ts).
            messages: messages.map(toOpenAIMessage),
            tools,
            tool_choice: 'auto',
            signal
        });

        let currentRoundContent = '';
        let currentReasoningContent = '';
        const toolCallBuffers: { [index: number]: any } = {};

        for await (const chunk of stream) {
            if (signal.aborted) {
                break;
            }

            let progressUpdateNeeded = false;

            // Accumulate reasoning content
            if (chunk.reasoning_content) {
                currentReasoningContent += chunk.reasoning_content;
                progressUpdateNeeded = true;
            }

            // Accumulate regular content
            if (chunk.content) {
                currentRoundContent += chunk.content;
                progressUpdateNeeded = true;
            }

            // Buffer tool calls from the stream
            if (chunk.tool_calls) {
                for (const tc of chunk.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallBuffers[idx]) {
                        toolCallBuffers[idx] = { ...tc, arguments: '' };
                    }
                    if (tc.function?.name) {
                        toolCallBuffers[idx].function.name = tc.function.name;
                    }
                    if (tc.function?.arguments) {
                        toolCallBuffers[idx].function.arguments += tc.function.arguments;
                    }
                }
                progressUpdateNeeded = true;
            }

            // Call progress callback if provided and update is needed
            if (progressUpdateNeeded && onProgress) {
                onProgress(currentRoundContent, currentReasoningContent, Object.values(toolCallBuffers));
            }
        }

        const rawToolCalls = Object.values(toolCallBuffers);
        const finalToolCalls = this.parseToolCalls(rawToolCalls);

        return {
            roundContent: currentRoundContent,
            roundReasoning: currentReasoningContent,
            toolCalls: finalToolCalls
        };
    }

    /**
     * Parses raw tool calls from the stream into structured format.
     * @description Handles JSON parsing of tool arguments, including error recovery
     * for malformed JSON and deduplication of repeated arguments.
     * @param {any[]} rawToolCalls - Raw tool call data from stream
     * @returns {ToolCall[]} Parsed tool calls in kosong flat shape
     * @example
     * const toolCalls = handler.parseToolCalls(rawToolCalls);
     * // Returns: [{ type: 'function', id: 'call_xxx', name: 'toolName', arguments: '{}' }]
     */
    parseToolCalls(rawToolCalls: any[]): ToolCall[] {
        const finalToolCalls: ToolCall[] = [];
        
        for (const tc of rawToolCalls) {
            const toolName = tc.function.name;
            const toolArgsStr = tc.function.arguments;
            let argsArray: any[] = [];

            try {
                // Try to parse as single object first
                const parsed = JSON.parse(toolArgsStr);
                argsArray = [parsed];
            } catch (e) {
                // If single parse fails, try to fix and parse as array
                try {
                    const fixedStr = '[' + toolArgsStr.replace(/}\s*{/g, '},{') + ']';
                    const parsedArr = JSON.parse(fixedStr);
                    if (Array.isArray(parsedArr) && parsedArr.length > 0) {
                        // Deduplicate arguments
                        const uniqueArgs = new Set(parsedArr.map(x => JSON.stringify(x)));
                        argsArray = Array.from(uniqueArgs).map(x => JSON.parse(x));
                    } else {
                        throw e;
                    }
                } catch (e2) {
                    console.error(`JSON Parse Error for tool ${toolName}:`, toolArgsStr);
                    continue; 
                }
            }

            // Create a tool call entry for each argument set
            argsArray.forEach((args, i) => {
                const callId = (i === 0 && tc.id) ? tc.id : 'call_' + Math.random().toString(36).substring(2, 11);
                finalToolCalls.push({
                    type: 'function',
                    id: callId,
                    name: toolName,
                    arguments: JSON.stringify(args)
                });
            });
        }
        return finalToolCalls;
    }
}
