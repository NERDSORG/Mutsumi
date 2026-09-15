/**
 * @fileoverview Agent runner for executing LLM interactions and tool calls.
 * @module agent/agentRunner
 */

import * as vscode from 'vscode';
import { ToolSet } from '../tools.d/toolManager';
import { AgentMessage } from '../types';
import type { ContentPart, ToolCall } from '@moonshot-ai/kosong';
import { UIRenderer } from './uiRenderer';
import { MUTSUMI_AGENT_CHAT_MIME, RenderBlock } from '../notebook/renderTypes';
import { LLMStreamHandler } from './llmStream';
import { ToolExecutor } from './toolExecutor';
import { TitleGenerator } from './titleGenerator';
import { LLMClient } from './llmClient';
import { IAgentSession, AgentSessionConfig } from '../adapters/interfaces';
import { LiteAgentSession } from '../adapters/liteAdapter';
import { debugLogger } from '../debugLogger';
import { getModelCredentials, getTitleModelSelection } from '../utils';
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
    /** LLM streaming handler */
    private llmStreamHandler: LLMStreamHandler;
    /** Tool executor for handling tool calls */
    private toolExecutor: ToolExecutor | undefined;
    /** Title generator for notebook titles */
    private titleGenerator: TitleGenerator;
    /** LLM client for API communication */
    private llmClient: LLMClient;
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
        this.llmClient = new LLMClient({
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            model: options.model,
            defaultHeaders: { 'User-Agent': 'KimiCLI/1.30.0' },
            reasoningEffort: options.reasoningEffort
        });
        this.uiRenderer = new UIRenderer();
        this.llmStreamHandler = new LLMStreamHandler(this.llmClient);
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

            let roundContent = '';
            let roundReasoning = '';
            let toolCalls: ToolCall[] = [];

            try {
                const result = await this.llmStreamHandler.streamResponse(
                    messages,
                    this.toolSet.getDefinitions(),
                    abortController.signal,
                    async (content, reasoning, partialToolCalls) => {
                        if (this.session.token.isCancellationRequested) {
                            return;
                        }

                        const pendingTools = this.uiRenderer.formatPendingToolCalls(
                            partialToolCalls,
                            this.toolSet,
                            isSubAgent
                        );

                        const renderData = this.uiRenderer.updateActive(content, reasoning, pendingTools);
                        await this.session.replaceOutput(JSON.stringify(renderData), { mimeType: MUTSUMI_AGENT_CHAT_MIME });
                    }
                );
                roundContent = result.roundContent;
                roundReasoning = result.roundReasoning;
                toolCalls = result.toolCalls;
            } catch (error: any) {
                // Handle network/API errors gracefully
                const isCancellation = 
                    error.name === 'APIUserAbortError' ||
                    error.name === 'AbortError' ||
                    abortController.signal.aborted;

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

            // Assemble kosong content parts: think part first, then text part.
            // Empty content normalizes to [].
            const roundParts: ContentPart[] = [];
            if (roundReasoning) {
                roundParts.push({ type: 'think', think: roundReasoning });
            }
            if (roundContent) {
                roundParts.push({ type: 'text', text: roundContent });
            }

            if (!toolCalls.length && !roundContent && !roundReasoning) {
                this.uiRenderer.appendBlock({ type: 'content', markdown: '_Mutsumi Debug: No content, reasoning, or tool calls received from API._' });
                await this.session.replaceOutput(JSON.stringify(this.uiRenderer.getCommittedRenderData()), { mimeType: MUTSUMI_AGENT_CHAT_MIME });
                const msg: AgentMessage = { role: 'assistant', content: roundParts, toolCalls: [] };
                messages.push(msg);
                newMessages.push(msg);
                break;
            }

            if (toolCalls.length === 0) {
                const assistantMsg: AgentMessage = { role: 'assistant', content: roundParts, toolCalls: [] };
                messages.push(assistantMsg);
                newMessages.push(assistantMsg);
                break;
            }

            const assistantMsgWithTool: AgentMessage = {
                role: 'assistant',
                content: roundParts,
                toolCalls
            };
            messages.push(assistantMsgWithTool);
            newMessages.push(assistantMsgWithTool);

            this.uiRenderer.commitRoundUI(roundContent, roundReasoning);

            const result = await this.toolExecutor.executeTools(
                toolCalls,
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
