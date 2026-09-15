/**
 * @fileoverview Compress conversation command for Mutsumi notebook.
 * @module notebook/commands/compressConversation
 */

import * as vscode from 'vscode';
import { AgentMessage, AgentMetadata } from '../../types';
import { createUserMessage, extractText } from '@moonshot-ai/kosong';
import { LiteAdapter, LiteAgentSessionConfig } from '../../adapters/liteAdapter';
import { buildInteractionHistory } from '../../contextManagement/history';
import { createEmptyToolSet } from '../../tools.d/toolManager';
import type { AgentRunOptions } from '../../agent/types';
import { MutsumiSerializer } from '../serializer';
import { formatMessagesToString, createDebugSessionFromNotebook } from './utils';
import { getCompressModelSelection, getModelCredentials, resolveModelSelection } from '../../utils';
import { t } from '../../i18n';

/**
 * Register the compress conversation command.
 * @param {vscode.ExtensionContext} context - Extension context for registering disposables
 */
export function registerCompressConversationCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('mutsumi.compressConversation', async () => {
            const editor = vscode.window.activeNotebookEditor;
            if (!editor) {
                vscode.window.showWarningMessage(t('notebook.noEditor'));
                return;
            }

            if (editor.notebook.notebookType !== 'mutsumi-notebook') {
                vscode.window.showWarningMessage(t('notebook.onlyMutsumi'));
                return;
            }

            const cells = editor.notebook.getCells();
            let lastCodeCellIndex = -1;
            for (let i = cells.length - 1; i >= 0; i--) {
                if (cells[i].kind === vscode.NotebookCellKind.Code) {
                    lastCodeCellIndex = i;
                    break;
                }
            }

            if (lastCodeCellIndex === -1) {
                vscode.window.showWarningMessage(t('notebook.noCodeCell'));
                return;
            }

            try {
                // Validate the source agent's persisted model/provider pair before producing a new file.
                const sourceMetadata = editor.notebook.metadata as AgentMetadata;
                const sourceModel = sourceMetadata?.model;
                const sourceProvider = sourceMetadata?.provider;
                if (sourceModel && !sourceProvider) {
                    vscode.window.showErrorMessage(t('compress.failed',
                        `Source agent has model "${sourceModel}" but no provider. Update the file with an explicit { model, provider } pair.`));
                    return;
                }
                if (sourceModel && sourceProvider) {
                    try {
                        resolveModelSelection({ model: sourceModel, provider: sourceProvider });
                    } catch (err: any) {
                        vscode.window.showErrorMessage(t('compress.failed', err.message));
                        return;
                    }
                }

                // Resolve compression model selection: compress → title → default
                let compressSelection: { model: string; provider: string };
                try {
                    compressSelection = getCompressModelSelection();
                } catch (err: any) {
                    vscode.window.showErrorMessage(t('compress.failed', err.message));
                    return;
                }
                const compressModel = compressSelection.model;
                const compressProvider = compressSelection.provider;

                let credentials: { apiKey: string; baseUrl: string };
                try {
                    credentials = getModelCredentials(compressModel, compressProvider);
                } catch (err: any) {
                    vscode.window.showErrorMessage(t('compress.failed', err.message));
                    return;
                }
                const { apiKey, baseUrl } = credentials;

                // Build session and get full interaction history
                const session = await createDebugSessionFromNotebook(editor.notebook, lastCodeCellIndex);
                const { messages } = await buildInteractionHistory(session);

                if (messages.length <= 1) {
                    vscode.window.showWarningMessage(t('compress.notEnough'));
                    return;
                }

                // Show progress
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('compress.progress'),
                    cancellable: false
                }, async () => {
                    // Dynamically import AgentRunner to avoid circular dependency
                    const { AgentRunner } = await import('../../agent/agentRunner.js');

                    // Format messages for compression using the shared utility
                    const conversationText = formatMessagesToString(messages, { includeHeader: false, maxContentLength: 3000 });

                    // Create compression prompt messages
                    const compressionMessages: AgentMessage[] = [
                        {
                            role: 'system',
                            content: [{ type: 'text', text: 'You are a conversation compression assistant. Your task is to compress a long conversation into a concise summary while preserving all important information, decisions, and context.\n\n' +
                                'Requirements:\n' +
                                '1. Summarize the main topics and goals discussed\n' +
                                '2. Preserve all key decisions and conclusions\n' +
                                '3. Include important code snippets or technical details (in markdown code blocks)\n' +
                                '4. Maintain the chronological flow of the conversation\n' +
                                '5. Keep the summary concise but comprehensive\n' +
                                '6. Use markdown formatting for clarity\n' +
                                '7. Do not include meta-commentary about the compression process' }],
                            toolCalls: []
                        },
                        createUserMessage(`Please compress the following conversation into a concise summary:\n\n${conversationText}`)
                    ];

                    // Create lite adapter and session for compression
                    const adapter = new LiteAdapter();
                    const compressConfig: LiteAgentSessionConfig = {
                        model: compressModel,
                        apiKey,
                        baseUrl,
                        metadata: editor.notebook.metadata 
                            ? JSON.parse(JSON.stringify(editor.notebook.metadata)) as AgentMetadata 
                            : undefined
                    };
                    const compressSession = await adapter.createSession({
                        config: compressConfig
                    });

                    // Create empty tool set (no tools = single round)
                    const emptyToolSet = createEmptyToolSet();

                    // Create agent runner
                    const runOptions: AgentRunOptions = {
                        model: compressModel,
                        apiKey,
                        baseUrl,
                        maxLoops: 1 // Single round since no tools
                    };
                    const runner = new AgentRunner(runOptions, emptyToolSet, compressSession);

                    // Run compression
                    const abortController = new AbortController();
                    const compressedMessages = await runner.run(abortController, compressionMessages);

                    // Extract compressed content
                    const lastAssistantMsg = [...compressedMessages].reverse().find(m => m.role === 'assistant');
                    const compressedContent = lastAssistantMsg ? extractText(lastAssistantMsg) : '';
                    if (!compressedContent) {
                        throw new Error('Compression failed: no response from LLM');
                    }

                    // Generate new file name
                    const originalUri = editor.notebook.uri;
                    const originalName = originalUri.path.split('/').pop() || 'compressed.mtm';
                    const baseName = originalName.replace(/\.mtm$/, '');
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
                    const newFileName = `${baseName}-compressed-${timestamp}.mtm`;

                    // Determine save location (same directory as original)
                    const parentDir = originalUri.with({ path: originalUri.path.substring(0, originalUri.path.lastIndexOf('/')) });
                    const newUri = vscode.Uri.joinPath(parentDir, newFileName);

                    // Create compressed notebook data
                    const originalMetadata = editor.notebook.metadata as AgentMetadata;
                    const { v4: uuidv4 } = await import('uuid');
                    const compressedMetadata: AgentMetadata = {
                        ...originalMetadata,
                        uuid: uuidv4(),
                        name: t('compress.nameSuffix', originalMetadata?.name || t('serializer.newAgent')),
                        created_at: new Date().toISOString(),
                        parent_agent_id: null,
                        model: sourceModel ?? compressModel,
                        provider: sourceProvider ?? compressProvider
                    };

                    // Create single user message with compressed content
                    const compressedText = `## Conversation Summary\n\n${compressedContent}\n\n---\n\n*This is a compressed version of the original conversation. Original file: ${originalName}*`;

                    // Create notebook data using serializer
                    const serializer = new MutsumiSerializer();
                    const notebookData = new vscode.NotebookData([
                        new vscode.NotebookCellData(
                            vscode.NotebookCellKind.Code,
                            compressedText,
                            'markdown'
                        )
                    ]);
                    notebookData.metadata = compressedMetadata;

                    // Serialize and save
                    const tokenSource = new vscode.CancellationTokenSource();
                    const bytes = await serializer.serializeNotebook(notebookData, tokenSource.token);
                    await vscode.workspace.fs.writeFile(newUri, bytes);

                    // Open the new file
                    const doc = await vscode.workspace.openNotebookDocument(newUri);
                    await vscode.window.showNotebookDocument(doc);

                    vscode.window.showInformationMessage(t('compress.done', newFileName));
                });
            } catch (error: any) {
                console.error('Failed to compress conversation:', error);
                vscode.window.showErrorMessage(t('compress.failedOverall', error.message));
            }
        })
    );
}
