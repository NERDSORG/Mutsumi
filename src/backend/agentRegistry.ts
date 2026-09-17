/**
 * @fileoverview Backend agent registry.
 *
 * Responsibilities: the uuid → AgentStateInfo registry (in-memory truth,
 * loaded from disk at startup), the sole agent-creation entry point
 * ({@link AgentRegistry.createAgent}), renames (metadata + file), deletion
 * (file + bidirectional parent/child cleanup), and UUID-conflict sanitation
 * for copied files.
 *
 * All file writes go through {@link SessionStore}, whether or not any editor
 * has the file open.
 *
 * @module backend/agentRegistry
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { AgentMetadata, AgentStateInfo } from '../types';
import type { CreateAgentOptions } from './interfaces';
import { resolveAgentDefaults } from '../config/resolver';
import { resolveModelSelection, sanitizeFileName } from '../utils';
import { McpRegistry } from '../mcp/registry';
import { t } from '../i18n';
import { debugLogger } from '../debugLogger';
import type { EventBus } from './eventBus';
import type { SessionStore } from './sessionStore';
import type { BackendSession } from './backendSession';

/**
 * Backend agent registry. See module docstring.
 */
export class AgentRegistry {
    private readonly agents = new Map<string, AgentStateInfo>();

    /** Called before an agent is deleted (backend drops the materialized session). */
    onBeforeDelete?: (uuid: string) => Promise<void>;

    constructor(
        private readonly bus: EventBus,
        private readonly store: SessionStore,
        /** Materialize (or fetch) the BackendSession for a registered uuid. */
        private readonly materialize: (uuid: string) => Promise<BackendSession>,
    ) {}

    // ------------------------------------------------------------------
    // Lookup
    // ------------------------------------------------------------------

    get(uuid: string): AgentStateInfo | undefined {
        return this.agents.get(uuid);
    }

    findByFileUri(uri: string): AgentStateInfo | undefined {
        for (const agent of this.agents.values()) {
            if (agent.fileUri === uri) {
                return agent;
            }
        }
        return undefined;
    }

    /** Notify that the session list/tree changed (sidebar refresh). */
    emitChanged(): void {
        this.bus.emitBtF('sessions.changed', {});
    }

    // ------------------------------------------------------------------
    // Startup scan + UUID conflict sanitation
    // ------------------------------------------------------------------

    /** Load all .mtm agent files from `.mutsumi/` into the registry. */
    async scanAllAgents(): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (!workspaceRoot) {
            return;
        }
        const agentDir = vscode.Uri.joinPath(workspaceRoot, '.mutsumi');
        let files: [string, vscode.FileType][];
        try {
            files = await vscode.workspace.fs.readDirectory(agentDir);
        } catch {
            return; // no .mutsumi directory yet
        }
        let count = 0;
        for (const [name, type] of files) {
            if (type !== vscode.FileType.File || !name.endsWith('.mtm')) {
                continue;
            }
            const fileUri = vscode.Uri.joinPath(agentDir, name);
            try {
                const { metadata } = await this.store.read(fileUri);
                if (!metadata.uuid) {
                    continue;
                }
                await this.registerWithConflictCheck({
                    uuid: metadata.uuid,
                    parentId: metadata.parent_agent_id || null,
                    name: metadata.name || 'Unknown Agent',
                    fileUri: fileUri.toString(),
                    openClientCount: 0,
                    isRunning: false,
                    isTaskFinished: !!metadata.is_task_finished,
                    childIds: new Set(metadata.sub_agents_list || []),
                });
                count++;
            } catch (e) {
                console.error(`[AgentRegistry] Failed to load agent file ${name}:`, e);
            }
        }
        debugLogger.log(`[AgentRegistry] Scanned ${count} agents from disk.`);
    }

    /**
     * Register an agent, resolving UUID conflicts (e.g. copied files) by
     * sanitizing the file: new UUID, "Copy of …" name, cleared relationships.
     * @returns The uuid actually registered (may differ from agent.uuid).
     */
    async registerWithConflictCheck(agent: AgentStateInfo): Promise<string> {
        const existing = this.agents.get(agent.uuid);
        if (existing && existing.fileUri !== agent.fileUri) {
            debugLogger.log(`[AgentRegistry] UUID conflict: ${agent.uuid} at ${existing.fileUri} vs ${agent.fileUri}`);
            try {
                const fileUri = vscode.Uri.parse(agent.fileUri);
                const { newUuid, newMetadata } = await this.sanitizeAgentFile(fileUri);
                agent.uuid = newUuid;
                agent.name = newMetadata.name;
                agent.parentId = null;
                agent.childIds = new Set();
                this.agents.set(newUuid, agent);
                return newUuid;
            } catch (e) {
                console.error('[AgentRegistry] Failed to sanitize agent file:', e);
            }
        }
        this.agents.set(agent.uuid, agent);
        return agent.uuid;
    }

    /**
     * Rewrite an .mtm file with a fresh UUID, a "Copy of" name and cleared
     * parent/child relationships. Used for duplicated (copied) agent files.
     */
    async sanitizeAgentFile(uri: vscode.Uri): Promise<{ newUuid: string; newMetadata: AgentMetadata }> {
        if (!uri.path.endsWith('.mtm')) {
            throw new Error(`File ${uri.path} is not a .mtm file`);
        }
        const { metadata, context } = await this.store.read(uri);
        const newUuid = uuidv4();
        const newMetadata: AgentMetadata = {
            ...metadata,
            uuid: newUuid,
            name: `Copy of ${metadata.name || 'Unknown Agent'}`,
            parent_agent_id: null,
            sub_agents_list: [],
            created_at: new Date().toISOString(),
        };
        await this.store.write(uri, newMetadata, context);
        return { newUuid, newMetadata };
    }

    // ------------------------------------------------------------------
    // Creation (sole entry point)
    // ------------------------------------------------------------------

    /**
     * Create a new agent: resolve defaults, write the .mtm file, register,
     * broadcast `session.created`, and return the materialized session.
     *
     * The initial prompt (if any) is not written into the file context; it is
     * kept on the registry entry and enqueued by the caller
     * (`userMessage.send` / dispatch approval), so it passes through the
     * `assembleUserMessage` pipeline exactly once.
     */
    async createAgent(options: CreateAgentOptions): Promise<BackendSession> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (!workspaceRoot) {
            throw new Error('No workspace folder available');
        }
        const defaults = resolveAgentDefaults(options.agentType, {
            modelSelection: options.modelSelection,
            rules: options.rules,
            skills: options.skills,
        });
        const selection = resolveModelSelection({ model: defaults.model, provider: defaults.provider });

        const uuid = uuidv4();
        const agentDir = vscode.Uri.joinPath(workspaceRoot, '.mutsumi');
        try {
            await vscode.workspace.fs.createDirectory(agentDir);
        } catch {
            // Directory may already exist
        }
        const fileUri = vscode.Uri.joinPath(agentDir, `${uuid}.mtm`);

        const allWorkspaceUris = vscode.workspace.workspaceFolders?.map(f => f.uri.toString())
            ?? [workspaceRoot.toString()];

        const hasPrompt = !!options.prompt && options.prompt.trim().length > 0;
        const metadata: AgentMetadata = {
            uuid,
            name: options.name ?? (hasPrompt ? options.prompt!.slice(0, 20) + '...' : t('serializer.newAgent')),
            created_at: new Date().toISOString(),
            parent_agent_id: options.parentId ?? null,
            allowed_uris: options.allowedUris ?? allWorkspaceUris,
            is_task_finished: false,
            model: selection.model,
            provider: selection.provider,
            mtm_version: 2,
            sub_agents_list: [],
            contextItems: [{ type: 'macro', key: 'ROLE', content: options.agentType }],
            activeRules: defaults.rules,
            activeSkills: defaults.skills,
            agentType: options.agentType,
            enabledMcpTools: McpRegistry.getInstance().resolveDefaultSelection(options.mcpServers ?? defaults.mcpServers),
        };

        await this.store.write(fileUri, metadata, []);

        const info: AgentStateInfo = {
            uuid,
            parentId: options.parentId ?? null,
            name: metadata.name,
            fileUri: fileUri.toString(),
            openClientCount: 0,
            isRunning: false,
            isTaskFinished: false,
            prompt: options.prompt,
            childIds: new Set(),
        };
        this.agents.set(uuid, info);

        if (info.parentId) {
            await this.addChildToParent(info.parentId, uuid);
        }

        this.bus.emitBtF('session.created', {
            sessionId: uuid,
            requestId: options.requestId,
            fileUri: fileUri.toString(),
            metadata,
        });
        this.emitChanged();

        return this.materialize(uuid);
    }

    /** Link a child into its parent's registry entry and persisted metadata. */
    private async addChildToParent(parentId: string, childId: string): Promise<void> {
        const parent = this.agents.get(parentId);
        if (!parent) {
            return;
        }
        if (!parent.childIds) {
            parent.childIds = new Set();
        }
        parent.childIds.add(childId);

        // Persist sub_agents_list through the materialized parent session when
        // available (memory is truth), otherwise rewrite the file directly.
        try {
            const session = await this.materialize(parentId);
            session.metadata.sub_agents_list = [...parent.childIds];
            await session.persist();
            session.broadcastMetadata();
        } catch (e) {
            console.error('[AgentRegistry] Failed to persist parent sub_agents_list:', e);
        }
    }

    // ------------------------------------------------------------------
    // Rename / delete
    // ------------------------------------------------------------------

    /**
     * Rename an agent: update the registry entry and rename the .mtm file to a
     * sanitized, deduplicated file name. Returns the new file URI (or the old
     * one when no rename was needed).
     */
    async renameAgentFile(uuid: string, newName: string): Promise<vscode.Uri | undefined> {
        const agent = this.agents.get(uuid);
        if (!agent) {
            return undefined;
        }
        agent.name = newName;

        const sanitized = sanitizeFileName(newName);
        if (!sanitized) {
            return vscode.Uri.parse(agent.fileUri);
        }
        const currentUri = vscode.Uri.parse(agent.fileUri);
        const currentBase = path.basename(currentUri.fsPath, path.extname(currentUri.fsPath));
        if (sanitized === currentBase) {
            return currentUri;
        }

        const dir = path.dirname(currentUri.fsPath);
        let suffix = 0;
        let candidate = sanitized;
        let targetUri = vscode.Uri.file(path.join(dir, `${candidate}.mtm`));
        while (await this.fileExists(targetUri)) {
            suffix += 1;
            candidate = `${sanitized}-${suffix}`;
            targetUri = vscode.Uri.file(path.join(dir, `${candidate}.mtm`));
        }
        await vscode.workspace.fs.rename(currentUri, targetUri, { overwrite: false });
        agent.fileUri = targetUri.toString();
        return targetUri;
    }

    /**
     * Delete an agent: remove the registry entry, clean up bidirectional
     * parent/child references, feed dispatch sessions, delete the file and
     * broadcast `session.deleted`.
     */
    async deleteAgent(uuid: string, options?: { deleteFile?: boolean }): Promise<void> {
        const agent = this.agents.get(uuid);
        if (!agent) {
            return;
        }
        await this.onBeforeDelete?.(uuid);
        const parentId = agent.parentId;

        if (parentId) {
            const parent = this.agents.get(parentId);
            if (parent?.childIds) {
                parent.childIds.delete(uuid);
                try {
                    const parentSession = await this.materialize(parentId);
                    parentSession.metadata.sub_agents_list = [...parent.childIds];
                    await parentSession.persist();
                } catch (e) {
                    console.error('[AgentRegistry] Failed to update parent sub_agents_list:', e);
                }
            }
        }

        if (agent.childIds) {
            for (const childId of agent.childIds) {
                const child = this.agents.get(childId);
                if (child && child.parentId === uuid) {
                    child.parentId = null;
                    try {
                        const childSession = await this.materialize(childId);
                        childSession.metadata.parent_agent_id = null;
                        await childSession.persist();
                    } catch (e) {
                        console.error('[AgentRegistry] Failed to clear child parent:', e);
                    }
                }
            }
        }

        this.agents.delete(uuid);

        if (options?.deleteFile !== false) {
            try {
                await vscode.workspace.fs.delete(vscode.Uri.parse(agent.fileUri));
            } catch {
                // File may already be gone (external delete watcher path).
            }
        }

        this.bus.emitBtF('session.deleted', { sessionId: uuid });
        this.emitChanged();
    }

    private async fileExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // Tree helpers
    // ------------------------------------------------------------------

    /** Root of an agent tree, following parent pointers with cycle protection. */
    static getRootId(uuid: string, registry: Map<string, AgentStateInfo>): string {
        const visited = new Set<string>();
        let current = uuid;
        while (true) {
            if (visited.has(current)) {
                return current;
            }
            visited.add(current);
            const agent = registry.get(current);
            if (!agent || !agent.parentId) {
                return current;
            }
            current = agent.parentId;
        }
    }

    /**
     * Agents to display in the sidebar tree: full trees of every agent that is
     * shown by a frontend (openClientCount > 0) or running in the backend,
     * plus path repair for detached visible agents.
     */
    getTreeNodes(): AgentStateInfo[] {
        const registry = new Map(this.agents);
        const nodes = new Set<AgentStateInfo>();
        const rootsToDisplay = new Set<string>();
        const visibleAgents = new Set<AgentStateInfo>();

        for (const agent of registry.values()) {
            // A tree is displayed when at least one of its agents is shown by
            // a frontend (openClientCount > 0) or is running in the backend.
            if (agent.openClientCount > 0 || agent.isRunning) {
                visibleAgents.add(agent);
                rootsToDisplay.add(AgentRegistry.getRootId(agent.uuid, registry));
            }
        }

        const collectTree = (uuid: string) => {
            const agent = registry.get(uuid);
            if (!agent || nodes.has(agent)) {
                return;
            }
            nodes.add(agent);
            if (agent.childIds) {
                for (const childId of agent.childIds) {
                    collectTree(childId);
                }
            }
        };
        for (const rootId of rootsToDisplay) {
            collectTree(rootId);
        }

        for (const agent of visibleAgents) {
            if (nodes.has(agent)) {
                continue;
            }
            nodes.add(agent);
            let current = agent;
            const pathVisited = new Set<string>([current.uuid]);
            while (current.parentId) {
                if (pathVisited.has(current.parentId)) {
                    break;
                }
                pathVisited.add(current.parentId);
                const parent = registry.get(current.parentId);
                if (!parent) {
                    break;
                }
                nodes.add(parent);
                current = parent;
            }
        }

        return [...nodes];
    }

    /** Runtime status of an agent for the sidebar tree. */
    static computeStatus(agent: AgentStateInfo): 'standby' | 'running' | 'pending' | 'finished' {
        if (agent.isRunning) {
            return 'running';
        }
        if (agent.isTaskFinished) {
            return 'finished';
        }
        if (agent.parentId) {
            return 'pending';
        }
        return 'standby';
    }
}
