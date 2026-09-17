/**
 * @fileoverview Title generation for agent sessions.
 *
 * Triggered by the drain loop after the run answering the session's first
 * user message. Runs a single-round, tool-less AgentRunner against an
 * ephemeral BackendSession (fileUri = null — it emits events like any other
 * session, but nobody subscribes and nothing is persisted), then routes the
 * result through the normal rename path (metadata → file rename →
 * broadcasts).
 *
 * @module backend/titleGenerator
 */

import { createUserMessage, extractText } from '@moonshot-ai/kosong';
import type { AgentMessage } from '../types';
import { createEmptyToolSet } from '../tools.d/toolManager';
import { RenderDataBuilder } from '../agent/renderDataBuilder';
import { getModelCredentials, getTitleModelSelection, sanitizeFileName } from '../utils';
import { debugLogger } from '../debugLogger';
import { BackendSession } from './backendSession';
import type { BackendSessionDeps } from './interfaces';

/** Build the title-generation system prompt and user message. */
function createTitlePrompt(messages: AgentMessage[]): { systemPrompt: string; userText: string } {
    // Split into rounds and take the last 6
    const dialogMessages = messages.filter(msg => msg.role !== 'system');
    const rounds: AgentMessage[][] = [];
    let currentRound: AgentMessage[] = [];
    for (const msg of dialogMessages) {
        if (msg.role === 'user') {
            if (currentRound.length > 0) {
                rounds.push(currentRound);
            }
            currentRound = [msg];
        } else {
            currentRound.push(msg);
        }
    }
    if (currentRound.length > 0) {
        rounds.push(currentRound);
    }
    const recentRounds = rounds.length <= 6 ? rounds : rounds.slice(-6);
    const contextJson = JSON.stringify(recentRounds.flat(), null, 2);

    return {
        systemPrompt:
            'Please generate a short title based on the following conversation content. ' +
            'The title should summarize the main topic of the conversation. ' +
            'Conversation data is provided in JSON format, containing messages from user, assistant, tool roles. ' +
            'Requirements:\n1. Length should be 10-20 characters\n2. No special characters like \\\/:*?"<>|' +
            '\n3. Return only the title text, no explanations or prefixes',
        userText: `Please generate a title for this conversation:\n\n${contextJson.substring(0, 4000)}`,
    };
}

/**
 * Generates conversation titles via a one-shot ephemeral session.
 */
export class TitleGenerator {
    constructor(private readonly deps: BackendSessionDeps) {}

    /**
     * Generate and apply a title for the given session. Best-effort: any
     * failure is logged and swallowed.
     */
    async generateForSession(session: BackendSession): Promise<void> {
        // Title model priority: settings titleGeneratorModel > session metadata pair
        let selection = getTitleModelSelection();
        if (!selection && session.metadata.model && session.metadata.provider) {
            selection = { model: session.metadata.model, provider: session.metadata.provider };
        }
        if (!selection) {
            debugLogger.log('[TitleGenerator] Skipped: no titleGeneratorModel setting or session metadata pair');
            return;
        }

        let credentials: { apiKey: string; baseUrl: string; providerType: import('@moonshot-ai/kosong').ProviderType };
        try {
            credentials = getModelCredentials(selection.model, selection.provider);
        } catch (err: any) {
            debugLogger.log(`[TitleGenerator] Failed to resolve credentials: ${err.message}`);
            return;
        }

        try {
            const { systemPrompt, userText } = createTitlePrompt(session.history);

            const ephemeral = BackendSession.createEphemeral(this.deps, {
                emptyToolSet: true,
                maxLoops: 1,
                metadata: {
                    model: selection.model,
                    provider: selection.provider,
                },
            });
            ephemeral.renderDataBuilder = new RenderDataBuilder();

            const { AgentRunner } = await import('../agent/agentRunner');
            const runner = new AgentRunner(
                {
                    model: selection.model,
                    apiKey: credentials.apiKey,
                    baseUrl: credentials.baseUrl,
                    providerType: credentials.providerType,
                    maxLoops: 1,
                },
                createEmptyToolSet(),
                ephemeral,
            );

            const wireHistory: AgentMessage[] = [createUserMessage(userText) as AgentMessage];
            const newMessages = await runner.run(new AbortController(), { systemPrompt, wireHistory });

            const lastAssistantMsg = [...newMessages].reverse().find(m => m.role === 'assistant');
            let title = lastAssistantMsg ? extractText(lastAssistantMsg).trim() : '';
            title = sanitizeFileName(title);
            if (title.length > 30) {
                title = title.substring(0, 30);
            }
            if (!title) {
                return;
            }
            await session.rename(title);
        } catch (error) {
            debugLogger.log(`[TitleGenerator] Failed: ${error}`);
        }
    }
}
