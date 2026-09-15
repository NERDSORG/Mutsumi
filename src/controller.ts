/**
 * @fileoverview Agent controller for executing notebook cells.
 * @module controller
 */

import * as vscode from 'vscode';
import { isAbortError } from '@moonshot-ai/kosong';
import type { ProviderType } from '@moonshot-ai/kosong';
import { ToolSet, ToolRegistry, createToolSetForAgent } from './tools.d/toolManager';
import { AgentRunner } from './agent/agentRunner';
import { AgentOrchestrator } from './agent/agentOrchestrator';
import { NotebookAdapter } from './adapters/notebookAdapter';
import { buildInteractionHistory } from './contextManagement/history';
import { AgentMetadata } from './types';
import { getModelCredentials, getDefaultModelSelection, resolveModelSelection } from './utils';
import { normalizeReasoningEffort } from './agent/types';
import { t } from './i18n';

/**
 * Controls the execution of agent notebooks.
 * @description Manages the lifecycle of agent execution, including configuration loading,
 * cell processing, and coordination with the AgentRunner for LLM interactions.
 * @class AgentController
 * @example
 * const controller = new AgentController();
 * await controller.execute(cells, notebook, notebookController);
 */
export class AgentController {
    /** Execution order counter for tracking cell execution sequence */
    private executionOrder = 0;

    /**
     * Creates a new AgentController instance.
     * @constructor
     */
    constructor() {}

    /**
     * Executes one or more notebook cells.
     * @description Processes each cell in sequence, notifying the orchestrator of
     * start/stop events for the agent lifecycle.
     * @param {vscode.NotebookCell[]} cells - Cells to execute
     * @param {vscode.NotebookDocument} notebook - The notebook document
     * @param {vscode.NotebookController} controller - The notebook controller
     * @returns {Promise<void>}
     * @example
     * await agentController.execute([cell1, cell2], notebook, controller);
     */
    async execute(
        cells: vscode.NotebookCell[], 
        notebook: vscode.NotebookDocument, 
        controller: vscode.NotebookController
    ): Promise<void> {
        const uuid = notebook.metadata.uuid;
        if (uuid) {
            AgentOrchestrator.getInstance().notifyAgentStarted(uuid);
        }

        try {
            for (const cell of cells) {
                await this.processCell(cell, notebook, controller);
            }
        } finally {
            if (uuid) {
                AgentOrchestrator.getInstance().notifyAgentStopped(uuid);
            }
        }
    }

    /**
     * Processes a single notebook cell.
     * @description Loads configuration, initializes execution, creates adapter session,
     * runs the agent loop, and saves interaction metadata.
     * @private
     * @param {vscode.NotebookCell} cell - The cell to process
     * @param {vscode.NotebookDocument} notebook - The notebook document
     * @param {vscode.NotebookController} controller - The notebook controller
     * @returns {Promise<void>}
     */
    private async processCell(
        cell: vscode.NotebookCell,
        notebook: vscode.NotebookDocument,
        controller: vscode.NotebookController
    ): Promise<void> {
        const metadataModel = notebook.metadata?.model;
        const metadataProvider = notebook.metadata?.provider;
        const reasoningEffort = normalizeReasoningEffort(notebook.metadata?.reasoning_effort);

        // Resolve model selection from metadata: complete pair → use; missing model → global default;
        // model without provider → migration error.
        let model: string;
        let provider: string;
        try {
            if (metadataModel && metadataProvider) {
                const resolved = resolveModelSelection({ model: metadataModel, provider: metadataProvider });
                model = resolved.model;
                provider = resolved.provider;
            } else if (!metadataModel) {
                const resolved = getDefaultModelSelection();
                model = resolved.model;
                provider = resolved.provider;
            } else {
                throw new Error(
                    `Agent metadata is missing the required provider field. ` +
                    'Update the agent file by re-selecting the model.'
                );
            }
        } catch (err: any) {
            const adapter = new NotebookAdapter(controller);
            const session = await adapter.createSession({
                resourceUri: cell.document.uri,
                config: {
                    model: metadataModel ?? '',
                    apiKey: '',
                    baseUrl: '',
                    metadata: notebook.metadata as AgentMetadata
                }
            });
            await session.replaceOutput(`Error: ${err.message}`);
            (session as any).end(false);
            return;
        }

        // Get credentials for the model
        let credentials: { apiKey: string; baseUrl: string; providerType: ProviderType };
        try {
            credentials = getModelCredentials(model, provider);
        } catch (err: any) {
            const adapter = new NotebookAdapter(controller);
            const session = await adapter.createSession({
                resourceUri: cell.document.uri,
                config: {
                    model,
                    apiKey: '',
                    baseUrl: '',
                    metadata: notebook.metadata as AgentMetadata
                }
            });
            await session.replaceOutput(`Error: ${err.message}`);
            (session as any).end(false);
            return;
        }
        const { apiKey, baseUrl, providerType } = credentials;

        // Create adapter and session
        const adapter = new NotebookAdapter(controller);
        const session = await adapter.createSession({ 
            resourceUri: cell.document.uri, 
            config: { 
                model, 
                apiKey, 
                baseUrl,
                metadata: notebook.metadata as AgentMetadata
            } 
        });
        // getModelCredentials guarantees apiKey and baseUrl are non-empty

        // Get metadata and create tool set using the new Agent Type System
        const metadata = notebook.metadata as AgentMetadata;
        
        if (!metadata?.agentType) {
            await session.replaceOutput(
                `Error: Agent has no agentType. All agents must have a valid agentType defined in their metadata.`
            );
            (session as any).end(false);
            return;
        }

        try {
            const toolSet = createToolSetForAgent({
                agentType: metadata.agentType,
                agentId: metadata.uuid,
                parentAgentId: metadata.parent_agent_id,
                enabledMcpTools: metadata.enabledMcpTools
            });

            const abortController = new AbortController();
            const tokenDisposable = session.token.onCancellationRequested(() => {
                abortController.abort();
            });

            try {
                const runner = new AgentRunner(
                    { apiKey, baseUrl, model, providerType, reasoningEffort },
                    toolSet,
                    session
                );

                const { messages: history } = await buildInteractionHistory(session);
                const newMessages = await runner.run(abortController, history);

                if (newMessages.length > 0) {
                    // Update session history and persist
                    // This delegates metadata updates (both Cell and Notebook) to the adapter
                    session.setHistory([...history, ...newMessages]);
                    await session.save();
                }

                (session as any).end(true);
            } catch (err: any) {
                const isCancellation =
                    isAbortError(err) ||
                    session.token.isCancellationRequested;

                if (isCancellation) {
                    (session as any).end(false); 
                    return;
                }

                // Network/API errors are handled in AgentRunner to preserve stream history
                // Only show notification here as a fallback for unhandled errors
                const errorMessage = err.message || String(err);
                console.error('Agent execution error:', err);

                const copyDetailsBtn = t('controller.copyDetails');
                vscode.window.showErrorMessage(
                    t('controller.mutsumiError', errorMessage),
                    copyDetailsBtn
                ).then(selection => {
                    if (selection === copyDetailsBtn) {
                        vscode.env.clipboard.writeText(err.stack || errorMessage);
                    }
                });

                // Do NOT replace output - preserve any streamed content that was displayed
                // The AgentRunner should have already appended an error indicator to the UI
                (session as any).end(false);
            } finally {
                tokenDisposable.dispose();
            }
        } catch (err: any) {
            // Error from createToolSetForAgent (e.g., unknown agent type)
            await session.replaceOutput(`Error: ${err.message}`);
            (session as any).end(false);
        }
    }
}
