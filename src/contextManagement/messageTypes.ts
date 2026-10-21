/**
 * @fileoverview `metadata.messageType` pipeline field: message-type
 * discrimination and construction (the only module touching the field).
 *
 * @module contextManagement/messageTypes
 */

import { AgentMessage, AgentMessageType } from '../types';

/**
 * Normalized read of `metadata.messageType`: 'injection'/'agent' as-is,
 * everything else normalizes to 'user'. Only meaningful on role 'user'.
 */
export function getMessageType(msg: AgentMessage): AgentMessageType {
    const type = msg.metadata?.messageType;
    return type === 'injection' || type === 'agent' ? type : 'user';
}

/** Produce a context-injection message from terminal markdown. */
export function createInjectionMessage(markdown: string): AgentMessage {
    return {
        role: 'user',
        content: [{ type: 'text', text: markdown }],
        toolCalls: [],
        metadata: { messageType: 'injection' },
    };
}
