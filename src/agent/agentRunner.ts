/**
 * @fileoverview Agent runner for executing LLM interactions and tool calls.
 * @module agent/agentRunner
 */

import { ToolSet } from '../tools.d/toolSet';
import { AgentMessage } from '../types';
import { createProvider, isAbortError } from '@moonshot-ai/kosong';
import type { ChatProvider, ProviderConfig } from '@moonshot-ai/kosong';
import { RenderDataBuilder } from './renderDataBuilder';
import { RenderBlock } from '../shared/renderTypes';
import { streamGenerate } from './generateStream';
import type { StreamGenerateResult } from './interfaces';
import { ToolExecutor } from './toolExecutor';
import type { BackendSession } from '../backend/backendSession';
import { projectMessageToWire } from '../contextManagement/history';
import { debugLogger } from '../debugLogger';
import type { AgentRunOptions } from './interfaces';

/**
 * Executes the main agent loop for one turn: streams the LLM response,
 * executes tool calls and publishes render IR through the session. The session
 * owns history and render state; every produced message is appended immediately.
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

    /** Creates a runner bound to one session, tool set and provider config. */
    constructor(
        private options: AgentRunOptions,
        toolSet: ToolSet,
        session: BackendSession
    ) {
        this.session = session;
        this.toolSet = toolSet;
        this.maxLoops = options.maxLoops || 30;
        // One provider per runner: ReasoningKeyDialect learning is shared across rounds.
        this.provider = createProvider({
            type: options.providerType,
            model: options.model,
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            defaultHeaders: { 'User-Agent': 'KimiCLI/1.30.0' }
        } as ProviderConfig);

        // reasoning_effort → withThinking: a concrete value (including 'off')
        // passes through verbatim; undefined morphs to 'off' on the openai wire
        // only, other wires keep the server-side default.
        const effort = options.reasoningEffort;
        if (effort !== undefined) {
            this.provider = this.provider.withThinking(effort);
        } else if (options.providerType === 'openai') {
            this.provider = this.provider.withThinking('off');
        }
    }

    /**
     * Run the loop: stream, execute tools, drain steered inbound items at round
     * boundaries.
     * @returns Messages produced during this run
     */
    async run(
        abortController: AbortController,
        input: { systemPrompt: string; wireHistory: AgentMessage[] }
    ): Promise<AgentMessage[]> {
        const session = this.session;
        const builder = session.renderDataBuilder ?? (session.renderDataBuilder = new RenderDataBuilder());

        const allowedUris = session.metadata.allowed_uris || ['/'];

        // ToolExecutor needs the render builder.
        if (!this.toolExecutor) {
            this.toolExecutor = new ToolExecutor(
                this.toolSet,
                allowedUris,
                this.session,
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

            // Round-start snapshot for retry rollback.
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
                            this.toolSet
                        );

                        const renderData = builder.updateActive(content, reasoning, pendingBlocks);
                        session.publishRenderData(renderData);
                    }
                });
            } catch (error: any) {
                const isCancellation = isAbortError(error) || abortController.signal.aborted;

                if (isCancellation) {
                    break;
                }

                // Network/API error: broadcast it as `session.error`; nothing is
                // appended to the render IR.
                const errorMessage = error.message || String(error);
                console.error('LLM Stream Error:', error);
                session.reportError(errorMessage, true);

                break;
            }

            if (roundResult.traceId) {
                debugLogger.log(`[AgentRunner] traceId: ${roundResult.traceId}`);
            }

            // The kosong-assembled message is the sole history source.
            const assistantMsg: AgentMessage = roundResult.message;
            messages.push(assistantMsg);
            newMessages.push(assistantMsg);
            session.commitMessage(assistantMsg);

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
                session.commitMessage(toolMessage);
            }

            // task_finish already reported through session.reportTaskFinished.
            if (result.isTaskComplete) {
                break;
            }

            // Edit rejection and other terminal tool outcomes.
            if (result.shouldTerminate) {
                break;
            }

            // Round boundary: commit steered inbound items one at a time before
            // the next LLM call; `queue` items drain after the run stops.
            for await (const committed of session.drainInbound(queued => queued.mode === 'steer')) {
                session.applyCommittedToTurn();
                messages.push(await projectMessageToWire(committed));
                newMessages.push(committed);
            }
        }

        // Commit any leftover active content so the turn's final state is fully
        // committed; a no-op when nothing is active.
        builder.commitRoundUI('', '');
        session.publishRenderData(builder.getCommittedRenderData());

        return newMessages;
    }
}
