/**
 * @fileoverview Agent runner for executing LLM interactions and tool calls.
 * @module agent/agentRunner
 */

import * as vscode from 'vscode';
import { ToolSet } from '../tools.d/toolManager';
import { AgentMessage } from '../types';
import { createProvider, extractText, isAbortError } from '@moonshot-ai/kosong';
import type { ChatProvider, Message, ProviderConfig } from '@moonshot-ai/kosong';
import { UIRenderer } from './uiRenderer';
import { MUTSUMI_AGENT_CHAT_MIME, RenderBlock } from '../notebook/renderTypes';
import { streamGenerate } from './generateStream';
import type { StreamGenerateResult } from './generateStream';
import { ToolExecutor } from './toolExecutor';
import { TitleGenerator } from './titleGenerator';
import { IAgentSession, AgentSessionConfig } from '../adapters/interfaces';
import { LiteAgentSession } from '../adapters/liteAdapter';
import { debugLogger } from '../debugLogger';
import { getTitleModelSelection } from '../utils';
import { AgentRunOptions } from './types';
import { t } from '../i18n';

export { AgentRunOptions } from './types';

/**
 * Executes the main agent loop for LLM interactions.
 * @description Manages the conversation flow with the LLM, handling streaming responses,
 * tool calls, and UI updates. Implements the core agent execution logic.
 * @class AgentRunner
 * @example
 * const runner = new AgentRunner(options, toolSet, session);
 * const newMessages = await runner.run(abortController, initialMessages);
 */
export class AgentRunner {
    /** Maximum number of tool interaction loops */
    private maxLoops: number;
    /** UI renderer for notebook output */
    private uiRenderer: UIRenderer;
    /** kosong chat provider for API communication */
    private provider: ChatProvider;
    /** Tool executor for handling tool calls */
    private toolExecutor: ToolExecutor | undefined;
    /** Title generator for notebook titles */
    private titleGenerator: TitleGenerator;
    /** Agent session for UI interactions */
    private session: IAgentSession;
    /** Tool set for this agent instance */
    private toolSet: ToolSet;

    /**
     * Creates a new AgentRunner instance.
     * @constructor
     * @param {AgentRunOptions} options - Configuration options
     * @param {ToolSet} toolSet - Tool set for this agent instance
     * @param {IAgentSession} session - The agent session
     */
    constructor(
        private options: AgentRunOptions,
        toolSet: ToolSet,
        session: IAgentSession
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
        // - 'none' → withThinking('off') (the only value translation)
        // - other concrete values → passed through verbatim
        // - default (undefined) on the openai wire → withThinking('off'):
        //   suppresses the adapter's auto-enable (it would otherwise send
        //   reasoning_effort='medium' once history contains think parts);
        //   without a configured offEffort this sends NO field on the wire —
        //   byte-equivalent to the previous "default sends nothing" behavior.
        // - default on other wires → no morph (server-side default; on kimi
        //   withThinking('off') would actively send thinking=disabled, which
        //   is "off", not "default", so it must not be used for suppression).
        const effort = options.reasoningEffort;
        if (effort === 'none') {
            this.provider = this.provider.withThinking('off');
        } else if (effort !== undefined) {
            this.provider = this.provider.withThinking(effort);
        } else if (options.providerType === 'openai') {
            this.provider = this.provider.withThinking('off');
        }
        this.uiRenderer = new UIRenderer();
        // ToolExecutor will be initialized in run() after we can await getConfig()
        this.titleGenerator = new TitleGenerator();
    }

    /**
     * Executes the main agent loop.
     * @description Runs the conversation loop with the LLM, handling streaming,
     * tool calls, and termination conditions.
     * @param {AbortController} abortController - Controller for cancellation
     * @param {AgentMessage[]} initialMessages - Initial message history
     * @returns {Promise<AgentMessage[]>} New messages generated during this run
     * @throws {TerminationError} If task_finish tool is called
     * @example
     * const newMessages = await runner.run(abortController, messages);
     */
    async run(
        abortController: AbortController,
        initialMessages: AgentMessage[]
    ): Promise<AgentMessage[]> {
        // Get config from session at the start of run
        const config = await this.session.getConfig();
        const allowedUris = config.allowedUris || [];
        const isSubAgent = config.isSubAgent || false;

        // Initialize ToolExecutor here since we needed async config
        if (!this.toolExecutor) {
            this.toolExecutor = new ToolExecutor(
                this.toolSet,
                allowedUris,
                this.session,
                isSubAgent,
                this.uiRenderer
            );
        }

        const messages = [...initialMessages];
        const newMessages: AgentMessage[] = [];
        let loopCount = 0;

        while (loopCount < this.maxLoops) {
            if (this.session.token.isCancellationRequested) {
                break;
            }
            loopCount++;

            // Send-boundary system extraction: strip ALL system messages
            // (normally just the first one) into the dedicated systemPrompt
            // parameter; the rest stays as history in original order.
            const systemTexts: string[] = [];
            const history: Message[] = [];
            for (const msg of messages) {
                if (msg.role === 'system') {
                    systemTexts.push(extractText(msg));
                } else {
                    history.push(msg);
                }
            }
            const systemPrompt = systemTexts.join('\n\n');

            // Snapshot the renderer at round start so a retry attempt can
            // roll the UI back to "this round never started".
            const roundSnapshot = this.uiRenderer.snapshotRound();

            let roundResult: StreamGenerateResult;
            try {
                roundResult = await streamGenerate({
                    provider: this.provider,
                    systemPrompt,
                    history,
                    tools: this.toolSet.getDefinitions(),
                    signal: abortController.signal,
                    onRetry: () => {
                        this.uiRenderer.rollbackRound(roundSnapshot);
                    },
                    onProgress: async (content, reasoning, pendingTools) => {
                        if (this.session.token.isCancellationRequested) {
                            return;
                        }

                        const pendingBlocks = this.uiRenderer.formatPendingToolCalls(
                            pendingTools,
                            this.toolSet,
                            isSubAgent
                        );

                        const renderData = this.uiRenderer.updateActive(content, reasoning, pendingBlocks);
                        await this.session.replaceOutput(JSON.stringify(renderData), { mimeType: MUTSUMI_AGENT_CHAT_MIME });
                    }
                });
            } catch (error: any) {
                // Handle network/API errors gracefully
                const isCancellation = isAbortError(error) || abortController.signal.aborted;

                if (isCancellation) {
                    // User-initiated cancellation, just end gracefully
                    break;
                }

                // Network/API error - show notification and preserve history
                const errorMessage = error.message || String(error);
                console.error('LLM Stream Error:', error);

                // Show error as VSCode notification (non-modal)
                const copyDetailsBtn = t('controller.copyDetails');
                vscode.window.showErrorMessage(
                    t('agentRunner.llmError', errorMessage),
                    copyDetailsBtn
                ).then(selection => {
                    if (selection === copyDetailsBtn) {
                        vscode.env.clipboard.writeText(error.stack || errorMessage);
                    }
                });

                const errorMarkdown = `\n\n> ⚠️ **Error**: ${errorMessage.replace(/\n/g, ' ')}\n\n*Execution stopped due to network error. Previous output is preserved above.*`;
                this.uiRenderer.appendBlock({ type: 'content', markdown: errorMarkdown });
                await this.session.replaceOutput(JSON.stringify(this.uiRenderer.getCommittedRenderData()), { mimeType: MUTSUMI_AGENT_CHAT_MIME });

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

            if (assistantMsg.toolCalls.length === 0) {
                break;
            }

            this.uiRenderer.commitRoundUI(roundResult.roundContent, roundResult.roundReasoning);

            const result = await this.toolExecutor.executeTools(
                assistantMsg.toolCalls,
                abortController.signal,
                {
                    appendOutput: async (block: RenderBlock) => {
                        this.uiRenderer.appendBlock(block);
                        await this.session.replaceOutput(JSON.stringify(this.uiRenderer.getCommittedRenderData()), { mimeType: MUTSUMI_AGENT_CHAT_MIME });
                    },
                    signalTermination: () => {
                        // Termination handled via return values
                    }
                }
            );
            const toolMessages = result.messages;
            messages.push(...toolMessages);
            newMessages.push(...toolMessages);

            // Handle task completion (e.g., from task_finish tool)
            if (result.isTaskComplete) {
                await this.markSessionAsFinished();
                break;
            }

            // Handle other termination cases (e.g., edit rejection)
            if (result.shouldTerminate) {
                break;
            }
        }

        // Generate title after first user message (only once)
        // Skip for LiteAgentSession which is used for background tasks like title generation
        const userMessageCount = messages.filter(m => m.role === 'user').length;
        if (userMessageCount === 1 && !(this.session instanceof LiteAgentSession)) {
            void this.generateTitleIfNeeded(this.session, messages, config);
        }

        return newMessages;
    }

    /**
     * Generates a title for the session after first user message.
     * @private
     * @param {IAgentSession} session - The agent session
     * @param {AgentMessage[]} allMessages - Complete message history
     * @param {AgentSessionConfig} sessionConfig - Session configuration
     * @returns {Promise<void>}
     */
    private async generateTitleIfNeeded(
        session: IAgentSession,
        allMessages: AgentMessage[],
        sessionConfig: AgentSessionConfig
    ): Promise<void> {
        // Title model priority: settings titleGeneratorModel > session metadata pair
        let titleSelection = getTitleModelSelection();
        if (!titleSelection && sessionConfig.metadata?.model && sessionConfig.metadata?.provider) {
            titleSelection = { model: sessionConfig.metadata.model, provider: sessionConfig.metadata.provider };
        }

        if (!titleSelection) {
            debugLogger.log('[AgentRunner] Title generation skipped: no titleGeneratorModel setting or session metadata pair');
            return;
        }

        debugLogger.log(`[AgentRunner] Generating title for session (first user message received)`);

        const notebook = session.supportsUI && 'execution' in session
            ? (session as any).execution?.cell?.notebook
            : undefined;

        await this.titleGenerator.generateTitleForSession(session, allMessages, {
            modelSelection: titleSelection
        }, notebook);
    }

    /**
     * Marks the session as finished.
     * @private
     * @returns {Promise<void>}
     */
    private async markSessionAsFinished(): Promise<void> {
        // Persist the finished state via the session
        // The session adapter will handle the actual persistence (e.g., notebook metadata, file, etc.)
        const config = await this.session.getConfig();
        if (config.metadata) {
            // Use setConfig to safely update metadata, avoiding read-only object issues
            this.session.setConfig({
                metadata: { ...config.metadata, is_task_finished: true }
            });
        }
        await this.session.save();
    }
}
