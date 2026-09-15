/**
 * @fileoverview TEMPORARY kosong → OpenAI chat-completions wire projection.
 * @module agent/openaiProjection
 *
 * Exists only for milestone M2: the in-memory/persisted message model is
 * kosong-shaped while the LLM channel (llmClient/llmStream) still speaks the
 * OpenAI wire format.
 *
 * DELETE IN M3 together with llmClient.ts and llmStream.ts.
 * Sole call site: llmStream.doStreamResponse, right before invoking llmClient.
 *
 * Non-goals: `partial` / `tools` / `extras` / `encrypted` are not projected
 * (the OpenAI line has no consumer for them); audio/video parts are not
 * produced in M2. `metadata` is a pipeline-only field and never projected.
 */

import { extractText } from '@moonshot-ai/kosong';
import type { ThinkPart } from '@moonshot-ai/kosong';
import type { AgentMessage } from '../types';

/** OpenAI chat-completions content part (snake_case wire shape). */
type OpenAiContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

/** OpenAI chat-completions tool call (nested wire shape). */
interface OpenAiToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

/** OpenAI chat-completions message produced by the projection. */
export interface OpenAiChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | OpenAiContentPart[] | null;
    reasoning_content?: string;
    tool_calls?: OpenAiToolCall[];
    tool_call_id?: string;
    name?: string;
}

/**
 * Project a single kosong-shaped AgentMessage to the OpenAI wire shape.
 * Behavior is pinned per role to stay byte-equivalent with the pre-M2 wire:
 * - system    → { role, content: extractText }
 * - user      → all-text content becomes a plain string; content with images
 *               becomes snake_case parts (`image_url: { url }`, no `detail`)
 * - assistant → { role, content: text | null (null iff tool calls present and
 *               no text), reasoning_content?: joined think parts,
 *               tool_calls?: nested shape }
 * - tool      → { role, content: extractText, tool_call_id, name }
 */
export function toOpenAIMessage(msg: AgentMessage): OpenAiChatMessage {
    switch (msg.role) {
        case 'system':
            return { role: 'system', content: extractText(msg) };

        case 'user': {
            const hasImages = msg.content.some(part => part.type === 'image_url');
            if (!hasImages) {
                return { role: 'user', content: extractText(msg) };
            }
            const parts: OpenAiContentPart[] = [];
            for (const part of msg.content) {
                if (part.type === 'text') {
                    parts.push({ type: 'text', text: part.text });
                } else if (part.type === 'image_url') {
                    parts.push({ type: 'image_url', image_url: { url: part.imageUrl.url } });
                }
            }
            return { role: 'user', content: parts };
        }

        case 'assistant': {
            const text = extractText(msg);
            const reasoning = msg.content
                .filter((part): part is ThinkPart => part.type === 'think')
                .map(part => part.think)
                .join('');
            const out: OpenAiChatMessage = {
                role: 'assistant',
                // LiteLLM-class strict validators require null (not '') when
                // tool calls are present and there is no text.
                content: msg.toolCalls.length > 0 ? (text || null) : text
            };
            if (reasoning) {
                out.reasoning_content = reasoning;
            }
            if (msg.toolCalls.length > 0) {
                out.tool_calls = msg.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.arguments ?? '' }
                }));
            }
            return out;
        }

        case 'tool': {
            const out: OpenAiChatMessage = { role: 'tool', content: extractText(msg) };
            if (msg.toolCallId !== undefined) {
                out.tool_call_id = msg.toolCallId;
            }
            if (msg.name !== undefined) {
                out.name = msg.name;
            }
            return out;
        }
    }
}
