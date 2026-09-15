/**
 * @fileoverview Streaming pump over kosong `generate()`.
 * @module agent/generateStream
 * @description Replaces the hand-rolled llmStream layer: per-part display
 * accumulation, the retry loop (kosong error classification + server
 * `retry-after` directive priority), and round-level UI rollback hooks.
 * The assembled `result.message` is the sole source for history; the
 * accumulators serve display only and are never used to build messages.
 */

import {
    APIStatusError,
    createAbortError,
    generate,
    isAbortError,
    isRetryableGenerateError
} from '@moonshot-ai/kosong';
import type { ToolCall } from '@moonshot-ai/kosong';
import type { StreamGenerateOptions, StreamGenerateResult } from './interfaces';

/** Maximum number of retry attempts for failed requests */
const MAX_RETRIES = 3;
/** Base delay in milliseconds for exponential backoff (1s, 2s, 4s) */
const BASE_DELAY_MS = 1000;

/**
 * Streams one assistant generation through kosong `generate()` with retries.
 * @description Display accumulation is reset on every attempt; the retry loop
 * classifies errors via `isRetryableGenerateError` (empty responses included,
 * filtered ones excluded), honors the server `retry-after` directive when
 * present, and stays abort-responsive during backoff. Aborts and
 * non-retryable errors propagate immediately.
 * @param {StreamGenerateOptions} options - Round options
 * @returns {Promise<StreamGenerateResult>} Assembled message plus display accumulators
 * @throws {DOMException} AbortError on cancellation
 * @throws {Error} Non-retryable error, or the last error after retries are exhausted
 */
export async function streamGenerate(options: StreamGenerateOptions): Promise<StreamGenerateResult> {
    const { provider, systemPrompt, history, tools, signal, onProgress, onRetry } = options;

    let attempt = 0;
    while (true) {
        // Every attempt starts from a clean display state; the UI is rolled
        // back via onRetry BEFORE the attempt begins (an empty-response error
        // is only thrown after the stream drained, i.e. after partial content
        // may already have been rendered).
        let roundContent = '';
        let roundReasoning = '';
        const pendingTools: ToolCall[] = [];

        if (attempt > 0) {
            onRetry?.();
        }

        try {
            const result = await generate(provider, systemPrompt, tools, history, {
                onMessagePart: async (part) => {
                    switch (part.type) {
                        case 'text':
                            roundContent += part.text;
                            break;
                        case 'think':
                            // Hidden/empty thinking skips display accumulation
                            // but still reaches history via result.message.
                            if (!part.hidden && part.think) {
                                roundReasoning += part.think;
                            }
                            break;
                        case 'function':
                            // Tool call header: register a pending call, keeping
                            // the stream index for argument-delta routing.
                            pendingTools.push({
                                type: 'function',
                                id: part.id,
                                name: part.name,
                                arguments: part.arguments ?? '',
                                _streamIndex: part._streamIndex
                            });
                            break;
                        case 'tool_call_part': {
                            if (part.argumentsPart === null) {
                                break;
                            }
                            let target: ToolCall | undefined;
                            if (part.index !== undefined) {
                                target = pendingTools.find(tc => tc._streamIndex === part.index);
                            }
                            // kosong fallback semantics: deltas without an index
                            // append to the most-recently-seen tool call.
                            target ??= pendingTools[pendingTools.length - 1];
                            if (target) {
                                target.arguments = (target.arguments ?? '') + part.argumentsPart;
                            }
                            break;
                        }
                        default:
                            // image_url / audio_url / video_url: not rendered
                            // (still persisted via result.message).
                            break;
                    }
                    if (onProgress) {
                        await onProgress(roundContent, roundReasoning, pendingTools);
                    }
                }
            }, { signal });

            return {
                message: result.message,
                roundContent,
                roundReasoning,
                traceId: result.traceId ?? null
            };
        } catch (error: any) {
            // Cancellation first: never retry an abort.
            if (isAbortError(error) || signal.aborted) {
                throw error;
            }
            if (!isRetryableGenerateError(error) || attempt >= MAX_RETRIES) {
                throw error;
            }
            attempt++;
            // Server directive wins over the local exponential backoff.
            const retryAfterMs = error instanceof APIStatusError ? error.retryAfterMs : null;
            const delayMs = retryAfterMs ?? BASE_DELAY_MS * Math.pow(2, attempt - 1);
            console.warn(`LLM stream failed, retrying (${attempt}/${MAX_RETRIES}) after ${delayMs}ms...`, error);
            await abortableDelay(delayMs, signal);
        }
    }
}

/**
 * Delays for `ms`, rejecting immediately with an AbortError if the signal fires.
 * @param {number} ms - Milliseconds to wait
 * @param {AbortSignal} signal - Abort signal for cancellation
 * @returns {Promise<void>}
 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(createAbortError());
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(createAbortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
