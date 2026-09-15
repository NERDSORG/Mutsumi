/**
 * @fileoverview Generic LLM Client for unified API access.
 * @module agent/llmClient
 * @description Provides a unified interface for LLM operations, abstracting away
 * the underlying SDK (OpenAI). This allows for easier testing, mocking, and
 * potential future support for other LLM providers.
 */

import OpenAI from 'openai';

/**
 * Configuration for LLM client.
 * @interface LLMClientConfig
 */
export interface LLMClientConfig {
    /** API key for authentication */
    apiKey: string;
    /** Base URL for the API (optional, for custom endpoints) */
    baseUrl?: string;
    /** Model identifier to use */
    model: string;
    /** Default headers to include in requests */
    defaultHeaders?: Record<string, string>;
    /** Top-level reasoning effort value to send with completion requests */
    reasoningEffort?: string;
}

/**
 * Options for chat completion requests.
 * @interface ChatCompletionOptions
 */
export interface ChatCompletionOptions {
    /** Messages for the conversation (projected OpenAI wire messages, see agent/openaiProjection.ts) */
    messages: any[];
    /** Tools/functions available to the model */
    tools?: any[];
    /** Force specific tool choice */
    tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
    /** Temperature for sampling (0-2) */
    temperature?: number;
    /** Maximum tokens to generate */
    max_tokens?: number;
    /** Abort signal for cancellation */
    signal?: AbortSignal;
}

/**
 * Result of a non-streaming chat completion.
 * @interface ChatCompletionResult
 */
export interface ChatCompletionResult {
    /** Generated message content */
    content: string | null;
    /** Reasoning/thinking content if available */
    reasoning_content?: string;
    /** Tool calls requested by the model */
    tool_calls?: any[];
    /** Usage statistics */
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

/**
 * Chunk from a streaming chat completion.
 * @interface StreamChunk
 */
export interface StreamChunk {
    /** Content delta */
    content?: string;
    /** Reasoning content delta */
    reasoning_content?: string;
    /** Tool call deltas */
    tool_calls?: any[];
    /** Whether this is the final chunk */
    done: boolean;
}

/**
 * Unified LLM Client for all AI operations.
 * @description Encapsulates the OpenAI SDK and provides a clean interface
 * for chat completions, both streaming and non-streaming.
 * @class LLMClient
 * @example
 * const client = new LLMClient({
 *     apiKey: 'sk-...',
 *     baseUrl: 'https://api.openai.com/v1',
 *     model: 'gpt-4'
 * });
 * 
 * // Non-streaming
 * const result = await client.chatCompletion({
 *     messages: [{ role: 'user', content: 'Hello' }]
 * });
 * 
 * // Streaming
 * for await (const chunk of client.streamChatCompletion({
 *     messages: [{ role: 'user', content: 'Hello' }]
 * })) {
 *     console.log(chunk.content);
 * }
 */
export class LLMClient {
    private openai: OpenAI;
    private model: string;
    private reasoningEffort: string | undefined;

    /**
     * Creates a new LLMClient instance.
     * @constructor
     * @param {LLMClientConfig} config - Client configuration
     */
    constructor(config: LLMClientConfig) {
        this.openai = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseUrl,
            defaultHeaders: config.defaultHeaders || { 'User-Agent': 'KimiCLI/1.30.0' }
        });
        this.model = config.model;
        this.reasoningEffort = config.reasoningEffort;
    }

    /**
     * Performs a non-streaming chat completion.
     * @param {ChatCompletionOptions} options - Request options
     * @returns {Promise<ChatCompletionResult>} The completion result
     * @throws {Error} If the API call fails
     * @example
     * const result = await client.chatCompletion({
     *     messages: [
     *         { role: 'system', content: 'You are helpful.' },
     *         { role: 'user', content: 'Hello!' }
     *     ],
     *     temperature: 0.7
     * });
     * console.log(result.content);
     */
    async chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
        const response = await this.openai.chat.completions.create({
            model: this.model,
            messages: options.messages as any,
            tools: options.tools,
            tool_choice: options.tool_choice,
            temperature: options.temperature ?? 1,
            max_tokens: options.max_tokens,
            ...(this.reasoningEffort !== undefined
                ? { reasoning_effort: this.reasoningEffort as any }
                : {})
        }, { signal: options.signal });

        const choice = response.choices[0];
        const message = choice?.message;

        return {
            content: message?.content || null,
            reasoning_content: (message as any)?.reasoning_content || (message as any)?.reasoning,
            tool_calls: message?.tool_calls,
            usage: response.usage ? {
                prompt_tokens: response.usage.prompt_tokens,
                completion_tokens: response.usage.completion_tokens,
                total_tokens: response.usage.total_tokens
            } : undefined
        };
    }

    /**
     * Performs a streaming chat completion.
     * @description Returns an async iterator that yields chunks as they arrive
     * from the LLM. This is useful for real-time UI updates.
     * @param {ChatCompletionOptions} options - Request options
     * @returns {AsyncIterableIterator<StreamChunk>} Async iterator of stream chunks
     * @throws {Error} If the API call fails
     * @example
     * const stream = client.streamChatCompletion({
     *     messages: [{ role: 'user', content: 'Tell me a story' }]
     * });
     * 
     * for await (const chunk of stream) {
     *     if (chunk.content) {
     *         process.stdout.write(chunk.content);
     *     }
     *     if (chunk.done) {
     *         console.log('\n[Done]');
     *     }
     * }
     */
    async *streamChatCompletion(options: ChatCompletionOptions): AsyncIterableIterator<StreamChunk> {
        const stream = await this.openai.chat.completions.create({
            model: this.model,
            messages: options.messages as any,
            tools: options.tools,
            tool_choice: options.tool_choice,
            temperature: options.temperature ?? 1,
            max_tokens: options.max_tokens,
            stream: true,
            ...(this.reasoningEffort !== undefined
                ? { reasoning_effort: this.reasoningEffort as any }
                : {})
        }, { signal: options.signal });

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            
            if (!delta) continue;

            const reasoningVal = (delta as any)?.reasoning_content || (delta as any)?.reasoning;

            yield {
                content: delta.content ?? undefined,
                reasoning_content: reasoningVal,
                tool_calls: delta.tool_calls,
                done: false
            };
        }

        yield { done: true };
    }

    /**
     * Updates the model used by this client.
     * @param {string} model - New model identifier
     * @example
     * client.setModel('gpt-4-turbo');
     */
    setModel(model: string): void {
        this.model = model;
    }

    /**
     * Gets the current model used by this client.
     * @returns {string} Current model identifier
     */
    getModel(): string {
        return this.model;
    }
}

// Import vscode at the end to avoid circular dependency issues
import * as vscode from 'vscode';
