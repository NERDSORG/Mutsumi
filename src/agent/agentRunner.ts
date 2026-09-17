/**
 * @fileoverview Agent runner for executing LLM interactions and tool calls.
 * @module agent/agentRunner
 */

import { ToolSet } from '../tools.d/toolManager';
import { AgentMessage } from '../types';
import { createProvider, isAbortError } from '@moonshot-ai/kosong';
import type { ChatProvider, ProviderConfig } from '@moonshot-ai/kosong';
import { RenderDataBuilder } from './renderDataBuilder';
import { RenderBlock } from '../shared/renderTypes';
import { streamGenerate } from './generateStream';
import type { StreamGenerateResult } from './interfaces';
import { ToolExecutor } from './toolExecutor';
import type { BackendSession } from '../backend/backendSession';
import { projectUserMessageToWire } from '../contextManagement/history';
import { debugLogger } from '../debugLogger';
import type { AgentRunOptions } from './interfaces';

/**
 * Executes the main agent loop for LLM interactions.
 * @description Manages the conversation flow with the LLM, handling streaming responses,
 * tool calls, and render-IR publishing. The session (BackendSession) owns the
 * history and render state; every produced message is appended immediately.
 * @class AgentRunner
 * @example
 * const runner = new AgentRunner(options, toolSet, session);
 * const newMessages = await runner.run(abortController, { systemPrompt, wireHistory });
 */
export class AgentRunner {
    /** Maximum number of tool interaction loops */
    private maxLoops: number;
    /** kosong chat provider for API communication */
    private provider: ChatProvider;
    /** Tool executor for handling tool calls */
    private toolExecutor: ToolExecutor | undefined;
    /** Agent session (owns history, queue and render state) */
    private session: BackendSession;
    /** Tool set for this agent instance */
    private toolSet: ToolSet;

    /**
     * Creates a new AgentRunner instance.
     * @constructor
     * @param {AgentRunOptions} options - Configuration options
     * @param {ToolSet} toolSet - Tool set for this agent instance
     * @param {BackendSession} session - The agent session
     */
    constructor(
        private options: AgentRunOptions,
        toolSet: ToolSet,
        session: BackendSession
    ) {
        this.session = session;
        this.toolSet = toolSet;
        this.maxLoops = options.maxLoops || 30;
        // One provider per runner instance, reused for the whole run: the
        // ReasoningKeyDialect learning is meant to be shared across rounds.
        this.provider = createProvider({
            type: options.providerType,
            model: options.model,
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            defaultHeaders: { 'User-Agent': 'KimiCLI/1.30.0' }
        } as ProviderConfig);

        // reasoning_effort → withThinking mapping (frozen contract):
        // - any concrete value (including 'off') → withThinking(value), passed
        //   through verbatim; kosong treats unrecognized values as model-declared
        //   efforts, so server validation errors stay visible to the user.
        // - default (undefined) on the openai wire → withThinking('off'):
        //   suppresses the adapter's auto-enable (it would otherwise send
        //   reasoning_effort='medium' once history contains think parts);
        //   without a configured offEffort this sends NO field on the wire —
        //   byte-equivalent to the previous "default sends nothing" behavior.
        // - default on other wires → no morph (server-side default; on kimi
        //   withThinking('off') would actively send thinking=disabled, which
        //   is "off", not "default", so it must not be used for suppression).
        const effort = options.reasoningEffort;
        if (effort !== undefined) {
            this.provider = this.provider.withThinking(effort);
        } else if (options.providerType === 'openai') {
            this.provider = this.provider.withThinking('off');
        }
    }

    /**
     * Executes the main agent loop.
     * @description Runs the conversation loop with the LLM, handling streaming,
     * tool calls, round-boundary steering injection, and termination conditions.
     * @param {AbortController} abortController - Controller for cancellation
     * @param input - System prompt (explicit) and wire-projected history
     * @returns {Promise<AgentMessage[]>} New messages produced during this run
     */
    async run(
        abortController: AbortController,
        input: { systemPrompt: string; wireHistory: AgentMessage[] }
    ): Promise<AgentMessage[]> {
        const session = this.session;
        const builder = session.renderDataBuilder ?? (session.renderDataBuilder = new RenderDataBuilder());

        const allowedUris = session.metadata.allowed_uris || ['/'];
        const isSubAgent = session.isSubAgent;

        // Initialize ToolExecutor here since we needed the builder
        if (!this.toolExecutor) {
            this.toolExecutor = new ToolExecutor(
                this.toolSet,
                allowedUris,
                this.session,
                isSubAgent,
                builder
            );
        }

        const messages = [...input.wireHistory];
        const newMessages: AgentMessage[] = [];
        let loopCount = 0;

        while (loopCount < this.maxLoops) {
            if (abortController.signal.aborted) {
                break;
            }
            loopCount++;

            // Snapshot the builder at round start so a retry attempt can
            // roll the UI back to "this round never started".
            const roundSnapshot = builder.snapshotRound();

            let roundResult: StreamGenerateResult;
            try {
                roundResult = await streamGenerate({
                    provider: this.provider,
                    systemPrompt: input.systemPrompt,
                    history: messages,
                    tools: this.toolSet.getDefinitions(),
                    signal: abortController.signal,
                    onRetry: () => {
                        builder.rollbackRound(roundSnapshot);
                    },
                    onProgress: async (content, reasoning, pendingTools) => {
                        if (abortController.signal.aborted) {
                            return;
                        }

                        const pendingBlocks = builder.formatPendingToolCalls(
                            pendingTools,
                            this.toolSet,
                            isSubAgent
                        );

                        const renderData = builder.updateActive(content, reasoning, pendingBlocks);
                        session.publishRenderData(renderData);
                    }
                });
            } catch (error: any) {
                // Handle network/API errors gracefully
                const isCancellation = isAbortError(error) || abortController.signal.aborted;

                if (isCancellation) {
                    // User-initiated cancellation, just end gracefully
                    break;
                }

                // Network/API error — broadcast it (the session.error event is
                // surfaced by the webview banner and the notification
                // micro-frontend); the message stream only ever renders
                // produced content, so nothing is appended to the render IR.
                const errorMessage = error.message || String(error);
                console.error('LLM Stream Error:', error);
                session.reportError(errorMessage, true);

                break;
            }

            if (roundResult.traceId) {
                debugLogger.log(`[AgentRunner] traceId: ${roundResult.traceId}`);
            }

            // The kosong-assembled message is the sole history source (think
            // parts with encrypted signatures included; the display
            // accumulators never feed history).
            const assistantMsg: AgentMessage = roundResult.message;
            messages.push(assistantMsg);
            newMessages.push(assistantMsg);
            session.appendMessage(assistantMsg);

            if (assistantMsg.toolCalls.length === 0) {
                break;
            }

            builder.commitRoundUI(roundResult.roundContent, roundResult.roundReasoning);

            const result = await this.toolExecutor.executeTools(
                assistantMsg.toolCalls,
                abortController.signal,
                {
                    appendOutput: async (block: RenderBlock) => {
                        builder.appendBlock(block);
                        session.publishRenderData(builder.getCommittedRenderData());
                    },
                    signalTermination: () => {
                        // Termination handled via return values
                    }
                }
            );
            const toolMessages = result.messages;
            messages.push(...toolMessages);
            newMessages.push(...toolMessages);
            for (const toolMessage of toolMessages) {
                session.appendMessage(toolMessage);
            }

            // Handle task completion (e.g., from task_finish tool; the tool
            // itself already reported through session.reportTaskFinished)
            if (result.isTaskComplete) {
                break;
            }

            // Handle other termination cases (e.g., edit rejection)
            if (result.shouldTerminate) {
                break;
            }

            // Round boundary: inject steered user messages after the tool
            // batch, before the next LLM call. Queue-mode messages are never
            // injected here; they are handled by the drain loop after the run
            // comes to a natural stop.
            const steered = session.drainSteering();
            for (const text of steered) {
                const persisted = await session.commitUserMessage(text);
                builder.commitTurnBoundary();
                session.publishRenderData(builder.getRenderData());
                const wireMessage = await projectUserMessageToWire(persisted);
                messages.push(wireMessage);
                newMessages.push(persisted);
            }
        }

        // Commit whatever remains in the active area so the turn's final state
        // is fully committed. The final round has no tool calls and never hits
        // the commitRoundUI path inside the loop; interrupt/error exits can
        // also leave active content behind. A no-op when nothing is active.
        builder.commitRoundUI('', '');
        session.publishRenderData(builder.getCommittedRenderData());

        return newMessages;
    }
}
