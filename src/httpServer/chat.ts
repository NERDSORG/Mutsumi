import * as vscode from 'vscode';
import express from 'express';
import { AgentRunner } from '../agent/agentRunner';
import { MutsumiSerializer } from '../notebook/serializer';
import { RenderData, RenderBlock, MUTSUMI_AGENT_CHAT_MIME } from '../notebook/renderTypes';
import { ToolSet, ToolRegistry, createToolSetForAgent } from '../tools.d/toolManager';
import { getAgentFromRegistry } from './utils';
import { AgentFileOperations } from '../agent/fileOps';
import { getModelCredentials, getDefaultModelSelection, resolveModelSelection } from '../utils';
import {
    normalizeReasoningEffort,
    REASONING_EFFORT_SETTING_VALUES
} from '../agent/types';
import type { HeadlessAdapter } from '../adapters/headlessAdapter';
import type { AgentSessionConfig } from '../adapters/interfaces';
import type { AgentMessage, AgentMetadata, ModelSelection } from '../types';

export async function handleChat(
    req: express.Request,
    res: express.Response,
    adapter: HeadlessAdapter,
    abortControllers: Map<string, AbortController>,
    extensionUri: vscode.Uri
): Promise<void> {
    const uuidParam = req.params.uuid;
    const uuid = Array.isArray(uuidParam) ? uuidParam[0] : uuidParam;
    const body = req.body ?? {};
    const { prompt, model, provider, stream } = body;
    const hasReasoningEffort = Object.prototype.hasOwnProperty.call(body, 'reasoning_effort');
    const bodyReasoningEffort = body.reasoning_effort;
    const isStreamMode = stream === true;

    if (!uuid) {
        res.status(400).json({ status: 'error', content: 'Missing agent UUID.' });
        return;
    }

    if (typeof prompt !== 'string' || !prompt.trim()) {
        res.status(400).json({ status: 'error', content: 'Missing prompt.' });
        return;
    }

    if (hasReasoningEffort && (typeof bodyReasoningEffort !== 'string'
        || !REASONING_EFFORT_SETTING_VALUES.includes(bodyReasoningEffort as any))) {
        res.status(400).json({
            status: 'error',
            content: `Invalid reasoning_effort. Valid values: ${REASONING_EFFORT_SETTING_VALUES.join(', ')}`
        });
        return;
    }

    // Get agent from registry to get the actual file URI
    const agentInfo = getAgentFromRegistry(uuid);
    if (!agentInfo) {
        res.status(404).json({ status: 'error', content: 'Agent not found.' });
        return;
    }

    const fileUri = vscode.Uri.parse(agentInfo.fileUri);

    let content: Uint8Array;
    try {
        content = await vscode.workspace.fs.readFile(fileUri);
    } catch {
        res.status(404).json({ status: 'error', content: 'Agent file not found.' });
        return;
    }

    const serializer = new MutsumiSerializer();
    const tokenSource = new vscode.CancellationTokenSource();
    const notebookData = await serializer.deserializeNotebook(content, tokenSource.token);

    // Get VS Code configuration
    const config = vscode.workspace.getConfiguration('mutsumi');
    const maxLoops = config.get<number>('maxLoops') || 30;

    const metadata = notebookData.metadata as AgentMetadata;
    const metadataModel = metadata?.model;
    const metadataProvider = metadata?.provider;

    // Body model/provider must be all-or-nothing.
    const hasModel = typeof model === 'string' && model.trim().length > 0;
    const hasProvider = typeof provider === 'string' && provider.trim().length > 0;
    if (hasModel !== hasProvider) {
        res.status(400).json({
            status: 'error',
            content: 'model and provider must be provided together or omitted together.'
        });
        return;
    }

    let effectiveSelection: ModelSelection;
    try {
        if (hasModel && hasProvider) {
            effectiveSelection = resolveModelSelection({ model, provider });
        } else {
            // Use persisted pair. Missing model → global default; model without provider → migration error.
            if (!metadataModel) {
                effectiveSelection = getDefaultModelSelection();
            } else if (!metadataProvider) {
                throw new Error(
                    `Agent metadata is missing the required provider field. ` +
                    'Update the agent file by re-selecting the model.'
                );
            } else {
                effectiveSelection = resolveModelSelection({ model: metadataModel, provider: metadataProvider });
            }
        }
    } catch (err: any) {
        res.status(400).json({ status: 'error', content: err.message });
        return;
    }

    // Get credentials for the resolved pair.
    let credentials: { apiKey: string; baseUrl: string };
    try {
        credentials = getModelCredentials(effectiveSelection.model, effectiveSelection.provider);
    } catch (err: any) {
        res.status(400).json({ status: 'error', content: err.message });
        return;
    }
    const { apiKey, baseUrl } = credentials;
    // getModelCredentials guarantees apiKey and baseUrl are non-empty

    const effectiveModel = effectiveSelection.model;
    const effectiveProvider = effectiveSelection.provider;
    const reasoningEffort = normalizeReasoningEffort(
        (hasReasoningEffort ? bodyReasoningEffort as string : undefined)
            ?? metadata?.reasoning_effort
    );

    // Persist the resolved pair when it came from the request body.
    if (hasModel && hasProvider) {
        try {
            await AgentFileOperations.updateAgentModelSelection(fileUri, effectiveSelection);
        } catch (err: any) {
            res.status(400).json({ status: 'error', content: err.message });
            return;
        }
    }

    // Get allowedUris from notebook metadata
    const allowedUris = metadata?.allowed_uris || ['/'];
    const isSubAgent = !!metadata?.parent_agent_id;

    // Create tool set using the new Agent Type System
    if (!metadata?.agentType) {
        res.status(500).json({ 
            status: 'error', 
            content: 'Agent has no agentType. All agents must have a valid agentType defined in their metadata.' 
        });
        return;
    }

    let toolSet: ToolSet;
    try {
        toolSet = createToolSetForAgent({
            agentType: metadata.agentType,
            agentId: metadata.uuid,
            parentAgentId: metadata.parent_agent_id,
            enabledMcpTools: metadata.enabledMcpTools
        });
    } catch (err: any) {
        res.status(500).json({ 
            status: 'error', 
            content: `Failed to create tool set: ${err.message}` 
        });
        return;
    }

    // Ensure local metadata reflects the resolved pair (file may have been mutated above).
    const updatedMetadata: AgentMetadata = {
        ...metadata,
        model: effectiveModel,
        provider: effectiveProvider
    };

    // Create session config
    const sessionConfig: AgentSessionConfig = {
        model: effectiveModel,
        apiKey,
        baseUrl,
        maxLoops,
        allowedUris,
        isSubAgent,
        metadata: updatedMetadata
    };

    // Create or get session using adapter
    let session = adapter.getSession(uuid);
    if (!session) {
        session = await adapter.createSession({
            sessionId: uuid,
            resourceUri: fileUri,
            config: sessionConfig
        });
    } else {
        // Synchronize cached session metadata so a later save cannot roll the pair back.
        session.setConfig({
            metadata: {
                model: effectiveModel,
                provider: effectiveProvider
            } as any
        });
    }

    // Set the input prompt
    (session as any).setInput(prompt);

    // Append user message to history
    const userMessage: AgentMessage = {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        toolCalls: []
    };

    // Get existing history and append new user message
    const history = await session.getHistory();
    history.push(userMessage);

    // Serialize updated history back to file (persist user message)
    const userCell = new vscode.NotebookCellData(
        vscode.NotebookCellKind.Code,
        prompt,
        'markdown'
    );
    userCell.metadata = { role: 'user' };
    const notebookDataWithUser = new vscode.NotebookData([
        ...notebookData.cells,
        userCell
    ]);
    notebookData.metadata = updatedMetadata;
    notebookDataWithUser.metadata = updatedMetadata;
    const encoded = await serializer.serializeNotebook(notebookDataWithUser, tokenSource.token);
    await vscode.workspace.fs.writeFile(fileUri, encoded);

    // Update session history
    (session as any).setHistory(history);

    // Create AgentRunner options
    const runnerOptions = {
        model: effectiveModel,
        apiKey,
        baseUrl,
        maxLoops,
        reasoningEffort
    };

    // Create AbortController for cancellation
    const abortController = new AbortController();
    abortControllers.set(uuid, abortController);

    // If stream mode is requested, setup SSE
    if (isStreamMode) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
        res.status(200);

        let lastCommittedLength = 0;
        let isFinished = false;

        // Override session's replaceOutput to capture streaming content
        const originalReplaceOutput = session.replaceOutput.bind(session);

        session.replaceOutput = async (output: string, options?: { isMarkdown?: boolean; mimeType?: string }) => {
            // Call original method
            await originalReplaceOutput(output, options);

            if (isFinished) return;

            // Only process RenderData JSON (custom MIME type)
            if (options?.mimeType !== MUTSUMI_AGENT_CHAT_MIME) return;

            try {
                const renderData: RenderData = JSON.parse(output);
                const committed = renderData.committed || [];

                // Emit new committed blocks
                for (let i = lastCommittedLength; i < committed.length; i++) {
                    const block: RenderBlock = committed[i];
                    const blockEvent = { type: 'block', block };
                    res.write(`data: ${JSON.stringify(blockEvent)}\n\n`);
                }
                lastCommittedLength = committed.length;

                // Emit active state
                const activeEvent = { type: 'active', active: renderData.active };
                res.write(`data: ${JSON.stringify(activeEvent)}\n\n`);
            } catch {
                // If JSON parsing fails, skip (defensive)
            }
        };

        // Run the agent and stream results
        try {
            const runner = new AgentRunner(runnerOptions, toolSet, session);
            const newMessages = await runner.run(abortController, history);

            // Update session with new history
            const updatedHistory = [...history, ...newMessages];
            (session as any).setHistory(updatedHistory);

            isFinished = true;

            // Send final event
            const finalEvent = {
                type: 'done',
                messageCount: newMessages.length
            };
            res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
            res.end();

            console.log(`[Mutsumi] Agent ${uuid} streaming completed with ${newMessages.length} new messages`);
        } catch (error: any) {
            console.error(`[Mutsumi] Agent ${uuid} streaming error:`, error);
            isFinished = true;

            // Send error as SSE event
            const errorEvent = {
                type: 'error',
                error: error.message || String(error)
            };
            res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
            res.end();

            // Append error as assistant message
            const errorMessage: AgentMessage = {
                role: 'assistant',
                content: [{ type: 'text', text: `> ⚠️ **Error**: ${error.message || String(error)}\n\n*Execution failed.*` }],
                toolCalls: []
            };
            const errorHistory = [...history, errorMessage];
            (session as any).setHistory(errorHistory);
            await session.save();
        } finally {
            abortControllers.delete(uuid);
            // Restore original method
            session.replaceOutput = originalReplaceOutput;
        }
    } else {
        // Non-streaming mode: original behavior
        void (async () => {
            try {
                const runner = new AgentRunner(runnerOptions, toolSet, session!);
                const newMessages = await runner.run(abortController, history);

                // Update session with new history
                const updatedHistory = [...history, ...newMessages];
                (session as any).setHistory(updatedHistory);

                console.log(`[Mutsumi] Agent ${uuid} completed with ${newMessages.length} new messages`);
            } catch (error: any) {
                console.error(`[Mutsumi] Agent ${uuid} error:`, error);

                // Append error as assistant message
                const errorMessage: AgentMessage = {
                    role: 'assistant',
                    content: [{ type: 'text', text: `> ⚠️ **Error**: ${error.message || String(error)}\n\n*Execution failed.*` }],
                    toolCalls: []
                };
                const errorHistory = [...history, errorMessage];
                (session as any).setHistory(errorHistory);

                // Persist error to file
                await session!.save();
            } finally {
                abortControllers.delete(uuid);
            }
        })();

        // Return immediately with accepted status
        res.json({
            status: 'accepted',
            content: 'Agent run started. Use GET /agent/:uuid to check status.',
            sessionId: uuid,
            model: effectiveModel
        });
    }
}
