import { ITool, ToolContext } from '../interface';
import { AgentTypeRegistry } from '../../registry/agentTypeRegistry';
import { resolveUri } from '../utils';
import { t } from '../../i18n';

export const dispatchSubagentsTool: ITool = {
    name: 'dispatch_subagents',
    definition: {
        name: 'dispatch_subagents',
        description: 'Split into multiple parallel sub-agents. Sub-agents are created and start running in the background immediately after user approval. This call returns right away with their session ids — it does NOT wait for them. Each sub-agent reports back when it finishes (task_finish): completion reports arrive as user messages. You can also message them (or they you) at any time with the communicate tool.',
        parameters: {
            type: 'object',
            properties: {
                context_broadcast: { 
                    type: 'string', 
                    description: 'Broadcast context information injected into each sub-agent\'s prompt. This is copied to each sub-agent independently - sub-agents cannot communicate with each other. Must include: overall task requirements, brief description of each sub-agent\'s task, and the file URIs each sub-agent is responsible for. This ensures all sub-agents understand the global task scope and other sub-agents\' work areas to prevent unauthorized operations.' 
                },
                sub_agents: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            prompt: { type: 'string', description: 'Detailed description of this sub-agent\'s specific task content, deliverable requirements, and acceptance criteria.' },
                            allowed_uris: { 
                                type: 'array', 
                                items: { type: 'string' },
                                description: 'Allowed paths.'
                            },
                            agent_type: {
                                type: 'string',
                                description: 'The agent type for this sub-agent (e.g., "chat", "orchestrator", "implementer", "reviewer"). The model and capabilities are determined by the agent type configuration. Defaults to "implementer" if not specified.'
                            }
                        },
                        required: ['prompt', 'allowed_uris']
                    }
                }
            },
            required: ['context_broadcast', 'sub_agents']
        }
    },
    execute: async (args: any, context: ToolContext) => {
        const parentUuid = context.session.metadata.uuid;
        const parentAgentType = context.session.metadata.agentType;
        if (!parentUuid) return 'Error: No Agent UUID found.';

        const { context_broadcast, sub_agents } = args;
        
        if (!sub_agents || !Array.isArray(sub_agents) || sub_agents.length === 0) {
            return 'Error: sub_agents list empty.';
        }

        // Validate agent types if parent has a defined type
        const registry = AgentTypeRegistry.getInstance();
        for (const subAgent of sub_agents) {
            const agentType = subAgent.agent_type || 'implementer';
            
            if (parentAgentType) {
                // Check if the requested child type is allowed for the parent
                if (!registry.isValidChildType(parentAgentType, agentType)) {
                    return `Error: Agent type '${parentAgentType}' cannot dispatch '${agentType}'. Allowed child types: ${registry.getAgentType(parentAgentType)?.allowedChildTypes.join(', ') || 'none'}`;
                }
            }
            
            // Validate that the agent type exists
            if (!registry.hasAgentType(agentType)) {
                return `Error: Unknown agent type '${agentType}'. Available types: ${registry.getAllTypes().join(', ')}`;
            }
        }

        try {
            // Normalize allowed_uris to standard URI strings
            const normalizedSubAgents = sub_agents.map((agent: any) => {
                if (agent.allowed_uris && Array.isArray(agent.allowed_uris)) {
                    return {
                        ...agent,
                        allowed_uris: agent.allowed_uris.map((u: string) => {
                            try {
                                return resolveUri(u).toString();
                            } catch (e) {
                                return u; // Fallback to original if resolve fails
                            }
                        })
                    };
                }
                return agent;
            });

            // Approval gate first: nothing is created unless approved.
            const details = normalizedSubAgents
                .map((sub: any, i: number) => `${i + 1}. [${sub.agent_type || 'implementer'}] ${String(sub.prompt).slice(0, 200)}\n   allowed_uris: ${(sub.allowed_uris ?? []).join(', ')}`)
                .join('\n');
            const rejectionMsg = await context.session.requestApproval(
                t('approval.dispatch.action', normalizedSubAgents.length),
                context.session.fileUri?.toString() ?? parentUuid,
                'dispatch_subagents',
                details,
            );
            if (rejectionMsg !== null) {
                return rejectionMsg;
            }

            // Create + start immediately; returns the children manifest.
            return await context.session.requestDispatch(
                context_broadcast,
                normalizedSubAgents,
            );
        } catch (err: any) {
            return `Error during dispatching: ${err.message}`;
        }
    },
    prettyPrint: (args: any) => {
        const agentCount = args.sub_agents?.length || 0;
        return `🍴 Mutsumi dispatched ${agentCount} sub-agent${agentCount !== 1 ? 's' : ''}`;
    },
    argsToCodeBlock: [ 'sub_agents' ],
    codeBlockFilePaths: [ 'sub_agents.json' ]
};

export const taskFinishTool: ITool = {
    name: 'task_finish',
    definition: {
        name: 'task_finish',
        description: 'Mark task as complete and submit report. The report is delivered to your parent agent as a message. May be called again later to send an updated report.',
        parameters: {
            type: 'object',
            properties: {
                context_summary: { type: 'string', description: 'Final report.' }
            },
            required: ['context_summary']
        }
    },
    execute: async (args: any, context: ToolContext) => {
        const myUuid = context.session.metadata.uuid;
        if (!myUuid) return 'Error: No Agent UUID found.';
        const summary = args.context_summary;

        await context.session.reportTaskFinished(summary);

        // Signal task completion
        if (context.signalTermination) {
            context.signalTermination(true);
        }

        return 'Task Finished. Report submitted.';
    },    prettyPrint: (_args: any) => {
        return `✅ Mutsumi finished task`;
    },
    argsToCodeBlock: [ 'context_summary' ],
    codeBlockFilePaths: [ undefined ]
};

export const communicateTool: ITool = {
    name: 'communicate',
    definition: {
        name: 'communicate',
        description: 'Send a message to another agent session by its session UUID (e.g. your parent agent, or a sibling sub-agent from the same dispatch). The message arrives as a user message in that session: if it is running, it is injected at the next round boundary; if it is stopped, it wakes up to process your message.',
        parameters: {
            type: 'object',
            properties: {
                target_session_id: { type: 'string', description: 'The target agent session UUID.' },
                message: { type: 'string', description: 'The message content. Markdown is supported; @[file] references are expanded in the target session.' }
            },
            required: ['target_session_id', 'message']
        }
    },
    execute: async (args: any, context: ToolContext) => {
        const targetId = args.target_session_id;
        const message = args.message;
        if (!targetId || typeof targetId !== 'string') {
            return 'Error: Missing "target_session_id" argument.';
        }
        if (typeof message !== 'string' || !message.trim()) {
            return 'Error: Missing or empty "message" argument.';
        }
        const myUuid = context.session.metadata.uuid;
        if (targetId === myUuid) {
            return 'Error: Cannot send a message to yourself.';
        }
        const text = `[Agent Message — from '${context.session.metadata.name}' (${myUuid})]\n\n${message}`;
        return context.session.deliverAgentMessage(targetId, text);
    },
    prettyPrint: (args: any) => {
        return `💬 Mutsumi sent a message to ${String(args.target_session_id ?? '').slice(0, 8)}`;
    },
    argsToCodeBlock: ['message'],
    codeBlockFilePaths: [undefined]
};

export const getAgentTypesTool: ITool = {
    name: 'get_agent_types',
    definition: {
        name: 'get_agent_types',
        description: 'Get agent types that the current agent is allowed to dispatch. Returns a filtered list of agent types with their capabilities, default models, and tool sets. Only returns types that can be created as children of the current agent.',
        parameters: {
            type: 'object',
            properties: {
                current_agent_type: {
                    type: 'string',
                    description: 'The current agent type (e.g., "implementer", "orchestrator"). If not provided, will be read from session metadata.'
                }
            }
        }
    },
    execute: async (args: any, context: ToolContext) => {
        try {
            const registry = AgentTypeRegistry.getInstance();
            
            // Get current agent type from args or session metadata
            let currentAgentType: string | undefined = args.current_agent_type;
            if (!currentAgentType) {
                currentAgentType = context.session.metadata.agentType;
            }
            
            if (!currentAgentType) {
                return 'Error: Unable to determine current agent type. Please provide current_agent_type parameter or ensure agent has a type configured.';
            }
            
            // Get allowed child types for current agent
            const currentConfig = registry.getAgentType(currentAgentType);
            if (!currentConfig) {
                return `Error: Unknown agent type '${currentAgentType}'.`;
            }
            
            const allowedChildTypes = currentConfig.allowedChildTypes || [];
            
            if (allowedChildTypes.length === 0) {
                return `Agent type '${currentAgentType}' cannot dispatch any child agents.`;
            }
            
            const lines: string[] = [];
            lines.push(`Agent type '${currentAgentType}' can dispatch the following types:\n`);
            
            for (const typeName of allowedChildTypes) {
                const config = registry.getAgentType(typeName);
                if (!config) continue;
                
                lines.push(`${typeName}:`);
                lines.push(`  Tool Sets: ${config.toolSets.join(', ')}`);
                const defaultModelDisplay = config.defaultModel
                    ? `${config.defaultModel.model} (${config.defaultModel.provider})`
                    : 'global default';
                lines.push(`  Default Model: ${defaultModelDisplay}`);
                
                // Show what this child type can further dispatch
                if (config.allowedChildTypes && config.allowedChildTypes.length > 0) {
                    lines.push(`  Can Further Dispatch: ${config.allowedChildTypes.join(', ')}`);
                } else {
                    lines.push(`  Can Further Dispatch: (none)`);
                }
                
                if (config.defaultRules && config.defaultRules.length > 0) {
                    lines.push(`  Default Rules: ${config.defaultRules.join(', ')}`);
                }
                
                if (config.defaultSkills && config.defaultSkills.length > 0) {
                    lines.push(`  Default Skills: ${config.defaultSkills.join(', ')}`);
                }
                
                lines.push('');
            }
            
            return lines.join('\n');
        } catch (err: any) {
            return `Error reading agent types: ${err.message}`;
        }
    },
    prettyPrint: (_args: any) => {
        return `🐧 Mutsumi listed available agent types`;
    }
};
