/**
 * @fileoverview File operations for Agent management.
 * @module agent/fileOps
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { resolveModelSelection } from '../utils';
import { AgentStateInfo, ContextItem, ModelSelection } from '../types';
import { resolveAgentDefaults } from '../config/resolver';
import { McpRegistry } from '../mcp/registry';

/**
 * Handles file-based operations for agents.
 * @description Provides static methods for loading, creating, and updating agent files.
 * All methods are pure functions or class methods that don't involve global state.
 * @class AgentFileOperations
 */
export class AgentFileOperations {
    /**
     * Gets the agent file URI based on workspace root and UUID.
     * @static
     * @param {string} uuid - Agent UUID
     * @returns {vscode.Uri | undefined} The file URI or undefined if no workspace
     * @example
     * const uri = AgentFileOperations.getAgentFileUri('abc-123');
     * // Returns: file:///workspace/.mutsumi/abc-123.mtm
     */
    public static getAgentFileUri(uuid: string): vscode.Uri | undefined {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (!workspaceRoot) return undefined;

        return workspaceRoot.with({
            path: path.posix.join(workspaceRoot.path, '.mutsumi', `${uuid}.mtm`),
        });
    }

    /**
     * Scans the .mutsumi directory and loads all agent files.
     * @static
     * @returns {Promise<AgentStateInfo[]>} Array of loaded agent states
     */
    public static async scanAllAgents(): Promise<AgentStateInfo[]> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (!workspaceRoot) {
            return [];
        }

        const agentDir = workspaceRoot.with({
            path: path.posix.join(workspaceRoot.path, '.mutsumi'),
        });

        try {
            const files = await vscode.workspace.fs.readDirectory(agentDir);
            const agents: AgentStateInfo[] = [];

            for (const [name, type] of files) {
                if (type === vscode.FileType.File && name.endsWith('.mtm')) {
                    const fileUri = agentDir.with({ path: path.posix.join(agentDir.path, name) });
                    try {
                        const content = await vscode.workspace.fs.readFile(fileUri);
                        const data = JSON.parse(new TextDecoder().decode(content));
                        
                        if (data.metadata && data.metadata.uuid) {
                            agents.push({
                                uuid: data.metadata.uuid,
                                parentId: data.metadata.parent_agent_id || null,
                                name: data.metadata.name || 'Unknown Agent',
                                fileUri: fileUri.toString(),
                                isWindowOpen: false,
                                isRunning: false,
                                isTaskFinished: !!data.metadata.is_task_finished,
                                childIds: new Set(data.metadata.sub_agents_list || [])
                            });
                        }
                    } catch (e) {
                        console.error(`Failed to load agent file ${name}:`, e);
                    }
                }
            }
            return agents;
        } catch (e) {
            // Directory might not exist or other error
            console.log('No .mutsumi directory found or error reading it:', e);
            return [];
        }
    }

    /**
     * Loads an agent from file if it exists.
     * @static
     * @param {string} uuid - Agent UUID to load
     * @returns {Promise<AgentStateInfo | undefined>} The loaded agent info or undefined
     * @example
     * const agent = await AgentFileOperations.loadAgentFromFile('abc-123');
     */
    public static async loadAgentFromFile(uuid: string): Promise<AgentStateInfo | undefined> {
        const fileUri = this.getAgentFileUri(uuid);
        if (!fileUri) return undefined;

        try {
            const content = await vscode.workspace.fs.readFile(fileUri);
            const data = JSON.parse(new TextDecoder().decode(content));
            
            const agent: AgentStateInfo = {
                uuid,
                parentId: data.metadata?.parent_agent_id || null,
                name: data.metadata?.name || 'Unknown Agent',
                fileUri: fileUri.toString(),
                isWindowOpen: false,
                isRunning: false,
                isTaskFinished: !!data.metadata?.is_task_finished,
                childIds: new Set(data.metadata?.sub_agents_list || [])
            };
            
            return agent;
        } catch {
            return undefined;
        }
    }

    /**
     * Creates a new agent file.
     * @static
     * @param {string} uuid - UUID for the new agent
     * @param {string | null} parentId - Parent agent ID or null
     * @param {string} [prompt] - Initial prompt for the agent (used for name generation). If undefined or empty, agent name will be "New Agent" and context will be empty.
     * @param {string[]} allowedUris - Allowed URIs for the agent
     * @param {string} agentType - Agent type identifier (e.g., 'chat', 'orchestrator', 'implementer', 'reviewer')
     * @param {ModelSelection} [modelSelection] - Model/provider pair to use (overrides agent type default)
     * @param {ContextItem[]} [contextItems] - Context items for the agent
     * @returns {Promise<vscode.Uri | undefined>} The created file URI or undefined on failure
     * @example
     * const uri = await AgentFileOperations.createAgentFile(
     *   'abc-123',
     *   'parent-456',
     *   'Process files',
     *   ['/workspace'],
     *   'implementer',
     *   { model: 'kimi-for-coding', provider: 'kimi-for-coding' },
     *   []
     * );
     */
    public static async createAgentFile(
        uuid: string,
        parentId: string | null,
        prompt: string | undefined,
        allowedUris: string[],
        agentType: string,
        modelSelection?: ModelSelection,
        contextItems?: ContextItem[]
    ): Promise<vscode.Uri | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (!workspaceRoot) {
            return undefined;
        }

        const folderUri = workspaceRoot.with({
            path: path.posix.join(workspaceRoot.path, '.mutsumi'),
        });
        const fileUri = folderUri.with({
            path: path.posix.join(folderUri.path, `${uuid}.mtm`),
        });

        // Ensure directory exists
        try {
            await vscode.workspace.fs.createDirectory(folderUri);
        } catch {
            // Directory may already exist
        }

        // Resolve agent type defaults using centralized resolver
        const defaults = resolveAgentDefaults(agentType, {
            modelSelection
        });

        // Validate the resolved selection through the gate
        const resolvedSelection = resolveModelSelection({
            model: defaults.model,
            provider: defaults.provider
        });

        // Determine name and context based on prompt
        const hasPrompt = prompt && prompt.trim().length > 0;
        const agentName = hasPrompt ? prompt!.slice(0, 20) + '...' : 'New Agent';
        const context = hasPrompt
            ? [{ role: 'user', content: [{ type: 'text', text: prompt }], toolCalls: [] }]
            : [];

        // Inject ROLE macro based on agentType (user could override later)
        contextItems = contextItems ?? [];
        contextItems.push({
            type: 'macro',
            key: 'ROLE',
            content: agentType
        });

        const content: any = {
            metadata: {
                uuid: uuid,
                name: agentName,
                created_at: new Date().toISOString(),
                parent_agent_id: parentId,
                allowed_uris: allowedUris,
                is_task_finished: false,
                model: resolvedSelection.model,
                provider: resolvedSelection.provider,
                mtm_version: 2,  // Format marker for future migrators (write-only)
                sub_agents_list: [],  // New agent starts with empty sub-agent list
                contextItems: contextItems,
                activeRules: defaults.rules,
                activeSkills: defaults.skills,
                agentType: agentType, // Store the agent type in metadata
                enabledMcpTools: McpRegistry.getInstance().resolveDefaultSelection(defaults.mcpServers)
            },
            context: context
        };
        
        const encoded = new TextEncoder().encode(JSON.stringify(content, null, 2));
        await vscode.workspace.fs.writeFile(fileUri, encoded);

        return fileUri;
    }

    /**
     * Updates the parent reference of an agent in its file.
     * @static
     * @description Uses WorkspaceEdit to update notebook metadata if the document is open,
     * otherwise writes directly to file. This avoids conflicts with VS Code's editor buffer.
     * @param {AgentStateInfo} agent - The agent to update
     * @param {string | null} newParentId - New parent ID or null
     * @returns {Promise<boolean>} True if update was successful
     * @example
     * await AgentFileOperations.updateAgentParentInFile(agent, 'new-parent-456');
     */
    public static async updateAgentParentInFile(
        agent: AgentStateInfo,
        newParentId: string | null
    ): Promise<boolean> {
        try {
            const fileUri = vscode.Uri.parse(agent.fileUri);
            
            // Check if the notebook document is currently open
            const openDoc = vscode.workspace.notebookDocuments.find(
                doc => doc.uri.toString() === fileUri.toString()
            );
            
            if (openDoc) {
                // Use WorkspaceEdit to update metadata through VS Code's API
                const edit = new vscode.WorkspaceEdit();
                const newMetadata = { 
                    ...openDoc.metadata, 
                    parent_agent_id: newParentId 
                };
                const nbEdit = vscode.NotebookEdit.updateNotebookMetadata(newMetadata);
                edit.set(fileUri, [nbEdit]);
                await vscode.workspace.applyEdit(edit);
            } else {
                // Document not open, write directly to file
                const content = await vscode.workspace.fs.readFile(fileUri);
                const data = JSON.parse(new TextDecoder().decode(content));
                
                data.metadata.parent_agent_id = newParentId;
                
                const encoded = new TextEncoder().encode(JSON.stringify(data, null, 2));
                await vscode.workspace.fs.writeFile(fileUri, encoded);
            }
            return true;
        } catch (e) {
            console.error('Failed to update agent parent in file:', e);
            return false;
        }
    }

    /**
     * Updates the model selection of an agent in its file or open notebook.
     * @static
     * @description Uses WorkspaceEdit to update notebook metadata if the document is open,
     * otherwise writes directly to file. This is the single write point for agent
     * model/provider metadata mutations.
     * @param {vscode.Uri} fileUri - URI of the agent file
     * @param {ModelSelection} selection - Complete model/provider pair
     * @returns {Promise<void>}
     * @throws {Error} If the selection is invalid or the update fails
     */
    public static async updateAgentModelSelection(
        fileUri: vscode.Uri,
        selection: ModelSelection
    ): Promise<void> {
        const resolved = resolveModelSelection(selection);

        const openDoc = vscode.workspace.notebookDocuments.find(
            doc => doc.uri.toString() === fileUri.toString()
        );

        if (openDoc) {
            const edit = new vscode.WorkspaceEdit();
            const newMetadata = {
                ...openDoc.metadata,
                model: resolved.model,
                provider: resolved.provider
            };
            const nbEdit = vscode.NotebookEdit.updateNotebookMetadata(newMetadata);
            edit.set(fileUri, [nbEdit]);
            await vscode.workspace.applyEdit(edit);
        } else {
            const content = await vscode.workspace.fs.readFile(fileUri);
            const data = JSON.parse(new TextDecoder().decode(content));

            data.metadata.model = resolved.model;
            data.metadata.provider = resolved.provider;

            const encoded = new TextEncoder().encode(JSON.stringify(data, null, 2));
            await vscode.workspace.fs.writeFile(fileUri, encoded);
        }
    }

    /**
     * Updates the sub_agents_list of a parent agent in its file.
     * @static
     * @description Uses WorkspaceEdit to update notebook metadata if the document is open,
     * otherwise writes directly to file. This avoids conflicts with VS Code's editor buffer.
     * @param {AgentStateInfo} parent - The parent agent to update
     * @returns {Promise<boolean>} True if update was successful
     * @example
     * await AgentFileOperations.updateParentSubAgentsList(parent);
     */
    public static async updateParentSubAgentsList(parent: AgentStateInfo): Promise<boolean> {
        try {
            const fileUri = vscode.Uri.parse(parent.fileUri);
            
            // Check if the notebook document is currently open
            const openDoc = vscode.workspace.notebookDocuments.find(
                doc => doc.uri.toString() === fileUri.toString()
            );
            
            if (openDoc) {
                // Use WorkspaceEdit to update metadata through VS Code's API
                const edit = new vscode.WorkspaceEdit();
                const newMetadata = { 
                    ...openDoc.metadata, 
                    sub_agents_list: Array.from(parent.childIds || []) 
                };
                const nbEdit = vscode.NotebookEdit.updateNotebookMetadata(newMetadata);
                edit.set(fileUri, [nbEdit]);
                await vscode.workspace.applyEdit(edit);
            } else {
                // Document not open, write directly to file
                const content = await vscode.workspace.fs.readFile(fileUri);
                const data = JSON.parse(new TextDecoder().decode(content));
                
                data.metadata.sub_agents_list = Array.from(parent.childIds || []);
                
                const encoded = new TextEncoder().encode(JSON.stringify(data, null, 2));
                await vscode.workspace.fs.writeFile(fileUri, encoded);
            }
            return true;
        } catch (e) {
            console.error('Failed to update parent sub_agents_list:', e);
            return false;
        }
    }

    /**
     * Sanitizes an agent file by generating a new UUID and clearing parent/child relationships.
     * @static
     * @description Used when detecting duplicate UUIDs (e.g., copied files). 
     * Generates new UUID, renames agent to "Copy of {original_name}", clears parent_agent_id and sub_agents_list.
     * Performs raw JSON file operations without involving Notebook API.
     * @param {vscode.Uri} uri - URI of the .mtm file to sanitize
     * @returns {Promise<{ newUuid: string; newMetadata: any }>} The new UUID and updated metadata
     * @throws {Error} If file is not a .mtm file or if reading/writing fails
     * @example
     * const { newUuid, newMetadata } = await AgentFileOperations.sanitizeAgentFile(uri);
     */
    public static async sanitizeAgentFile(uri: vscode.Uri): Promise<{ newUuid: string; newMetadata: any }> {
        // Validate file extension
        if (!uri.path.endsWith('.mtm')) {
            throw new Error(`File ${uri.path} is not a .mtm file`);
        }

        try {
            // Read file content
            const content = await vscode.workspace.fs.readFile(uri);
            const data = JSON.parse(new TextDecoder().decode(content));

            if (!data.metadata) {
                throw new Error(`Invalid mtm file: missing metadata`);
            }

            // Generate new UUID
            const newUuid = uuidv4();

            // Update metadata
            const originalName = data.metadata.name || 'Unknown Agent';
            data.metadata.uuid = newUuid;
            data.metadata.name = `Copy of ${originalName}`;
            data.metadata.parent_agent_id = null;
            data.metadata.sub_agents_list = [];
            data.metadata.created_at = new Date().toISOString();

            // Write back to file
            const encoded = new TextEncoder().encode(JSON.stringify(data, null, 2));
            await vscode.workspace.fs.writeFile(uri, encoded);

            return { newUuid, newMetadata: data.metadata };
        } catch (e) {
            console.error(`[AgentFileOperations] Failed to sanitize agent file ${uri.path}:`, e);
            throw e;
        }
    }
}
