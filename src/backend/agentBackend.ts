/**
 * @fileoverview AgentBackend — the singleton backend facade.
 *
 * Holds the EventBus, SessionStore, AgentRegistry, ApprovalRequestManager,
 * DispatchSessionManager, TitleGenerator and the materialized-session cache
 * (sessions are never evicted). Registers the complete FtB handler set
 * exactly once (the mapped type makes omissions a compile error).
 *
 * The backend has zero UI dependencies: it talks to frontends exclusively
 * through BtF events.
 *
 * @module backend/agentBackend
 */

import * as vscode from 'vscode';
import { debugLogger } from '../debugLogger';
import { registerPreExecutionSessionFactory } from '../tools.d/preExecution';
import { EventBus } from './eventBus';
import { SessionStore } from './sessionStore';
import { AgentRegistry } from './agentRegistry';
import { ApprovalRequestManager, setAutoApproveEnabled } from './approvalManager';
import { DispatchSessionManager } from './dispatchManager';
import { BackendSession } from './backendSession';
import type { BackendSessionDeps, BackendSessionOptions } from './interfaces';
import { TitleGenerator } from './titleGenerator';
import type { FtBEventMap } from './events';

/**
 * The agent backend singleton. See module docstring.
 */
export class AgentBackend {
    readonly bus = new EventBus();
    readonly store = new SessionStore();
    readonly approvals: ApprovalRequestManager;
    readonly registry: AgentRegistry;
    readonly dispatches: DispatchSessionManager;
    readonly titles: TitleGenerator;

    /** Materialized sessions by uuid (never evicted). */
    private readonly sessions = new Map<string, BackendSession>();
    private readonly sessionDeps: BackendSessionDeps;
    private focusedSessionId: string | null = null;
    private preExecutionSession: BackendSession | null = null;

    constructor() {
        this.approvals = new ApprovalRequestManager(this.bus);
        this.registry = new AgentRegistry(this.bus, this.store, uuid => this.getOrMaterialize(uuid));
        this.dispatches = new DispatchSessionManager(this.bus, this.registry);
        this.sessionDeps = {
            bus: this.bus,
            store: this.store,
            approvals: this.approvals,
            dispatches: this.dispatches,
            registry: this.registry,
            onFirstTurnCompleted: session => {
                void this.titles.generateForSession(session);
            },
        };
        this.titles = new TitleGenerator(this.sessionDeps);

        // Whenever an agent is deleted (by user action, dispatch rejection or
        // an external file delete), drop its materialized session first.
        this.registry.onBeforeDelete = async (uuid) => {
            const session = this.sessions.get(uuid);
            if (session) {
                await session.interrupt();
                this.sessions.delete(uuid);
            }
        };
    }

    /** Scan `.mutsumi/` and register the complete FtB handler set. */
    async initialize(): Promise<void> {
        await this.registry.scanAllAgents();
        this.registerHandlers();
        registerPreExecutionSessionFactory(() => this.getPreExecutionSession());
    }

    /**
     * Materialize a session: serve from the cache, or read the .mtm file and
     * build the BackendSession.
     */
    async getOrMaterialize(sessionId: string): Promise<BackendSession> {
        const cached = this.sessions.get(sessionId);
        if (cached) {
            return cached;
        }
        const entry = this.registry.get(sessionId);
        if (!entry) {
            throw new Error(`Unknown session: ${sessionId}`);
        }
        const fileUri = vscode.Uri.parse(entry.fileUri);
        const { metadata, context } = await this.store.read(fileUri);
        metadata.uuid = sessionId;
        const session = new BackendSession(this.sessionDeps, metadata, context, fileUri);
        this.sessions.set(sessionId, session);
        return session;
    }

    /** Create an ephemeral session (title generation, Lite one-shot runs). */
    createEphemeralSession(options?: BackendSessionOptions & { metadata?: Partial<BackendSession['metadata']> }): BackendSession {
        return BackendSession.createEphemeral(this.sessionDeps, options);
    }

    /**
     * Create an agent session. In-process callers (commands, dispatch tool)
     * may await this directly; the same logic backs the `session.create` FtB
     * event.
     */
    async createSession(payload: FtBEventMap['session.create']): Promise<BackendSession> {
        const session = await this.registry.createAgent({
            agentType: payload.agentType,
            name: payload.name,
            prompt: payload.prompt,
            allowedUris: payload.allowedUris,
            modelSelection:
                payload.model && payload.provider
                    ? { model: payload.model, provider: payload.provider }
                    : undefined,
            rules: payload.rules,
            skills: payload.skills,
            mcpServers: payload.mcpServers,
            requestId: payload.requestId,
        });
        if (payload.prompt && payload.prompt.trim()) {
            session.enqueueUserMessage(payload.prompt, 'queue');
        }
        return session;
    }

    /** An .mtm file was deleted externally: drop the session everywhere. */
    async notifyFileDeleted(uri: vscode.Uri): Promise<void> {
        const agent = this.registry.findByFileUri(uri.toString());
        if (!agent) {
            return;
        }
        const parentId = agent.parentId;
        await this.registry.deleteAgent(agent.uuid, { deleteFile: false });
        if (parentId) {
            this.dispatches.handleChildDeleted(parentId, agent.uuid);
        }
    }

    // ------------------------------------------------------------------
    // FtB handlers
    // ------------------------------------------------------------------

    private registerHandlers(): void {
        this.bus.registerBackendHandlers({
            'session.create': payload => {
                void this.createSession(payload).catch(err => {
                    // No sessionId exists yet; correlate via requestId.
                    this.bus.emitBtF('session.error', {
                        sessionId: payload.requestId,
                        message: err?.message || String(err),
                        recoverable: false,
                    });
                });
            },
            'session.open': payload => this.guard(payload.sessionId, async () => {
                const session = await this.getOrMaterialize(payload.sessionId);
                const entry = this.registry.get(payload.sessionId);
                if (entry) {
                    entry.openClientCount++;
                    this.registry.emitChanged();
                }
                await session.broadcastSnapshot();
            }),
            'session.close': payload => {
                const entry = this.registry.get(payload.sessionId);
                if (entry) {
                    entry.openClientCount = Math.max(0, entry.openClientCount - 1);
                    this.registry.emitChanged();
                }
            },
            'session.focus': payload => {
                this.focusedSessionId = payload.sessionId;
            },
            'session.delete': payload => this.guard(payload.sessionId, async () => {
                const entry = this.registry.get(payload.sessionId);
                const parentId = entry?.parentId;
                await this.registry.deleteAgent(payload.sessionId);
                if (parentId) {
                    this.dispatches.handleChildDeleted(parentId, payload.sessionId);
                }
            }),
            'session.rename': payload => this.guard(payload.sessionId, async () => {
                const session = await this.getOrMaterialize(payload.sessionId);
                await session.rename(payload.name);
            }),
            'session.setModel': payload => this.guard(payload.sessionId, async () => {
                const session = await this.getOrMaterialize(payload.sessionId);
                await session.setModel(payload.model, payload.provider);
            }),
            'session.setReasoningEffort': payload => this.guard(payload.sessionId, async () => {
                const session = await this.getOrMaterialize(payload.sessionId);
                await session.setReasoningEffort(payload.effort);
            }),
            'userMessage.send': payload => this.guard(payload.sessionId, async () => {
                const session = await this.getOrMaterialize(payload.sessionId);
                session.enqueueUserMessage(payload.text, payload.mode ?? 'queue');
            }),
            'run.interrupt': payload => this.guard(payload.sessionId, async () => {
                const session = await this.getOrMaterialize(payload.sessionId);
                await session.interrupt();
            }),
            'history.truncate': payload => this.guard(payload.sessionId, async () => {
                const session = await this.getOrMaterialize(payload.sessionId);
                await session.truncateFrom(payload.fromIndex);
                await session.broadcastSnapshot();
            }),
            'history.pruneGhostBlocks': payload => this.guard(payload.sessionId, async () => {
                const session = await this.getOrMaterialize(payload.sessionId);
                await session.pruneGhostBlocks();
                await session.broadcastSnapshot();
            }),
            'context.debug': payload => this.guard(payload.sessionId, async () => {
                const session = await this.getOrMaterialize(payload.sessionId);
                const formatted = await session.debugContext();
                this.bus.emitBtF('context.debugResult', { sessionId: payload.sessionId, formatted });
            }),
            'context.toggleRule': payload => this.guard(payload.sessionId, async () => {
                const session = await this.getOrMaterialize(payload.sessionId);
                await session.toggleRule(payload.rule, payload.active);
            }),
            'context.toggleSkill': payload => this.guard(payload.sessionId, async () => {
                const session = await this.getOrMaterialize(payload.sessionId);
                await session.toggleSkill(payload.skill, payload.active);
            }),
            'context.setMcpTools': payload => this.guard(payload.sessionId, async () => {
                const session = await this.getOrMaterialize(payload.sessionId);
                await session.setMcpTools(payload.selection);
            }),
            'context.removeFile': payload => this.guard(payload.sessionId, async () => {
                const session = await this.getOrMaterialize(payload.sessionId);
                await session.removeContextFile(payload.key);
            }),
            'context.removeMacro': payload => this.guard(payload.sessionId, async () => {
                const session = await this.getOrMaterialize(payload.sessionId);
                await session.removeMacro(payload.key);
            }),
            'approval.respond': payload => {
                void this.approvals.respond(
                    payload.sessionId,
                    payload.requestId,
                    payload.outcome,
                    payload.reason,
                    payload.origin,
                );
            },
            'dispatch.respond': payload => {
                void this.dispatches.respond(
                    payload.sessionId,
                    payload.requestId,
                    payload.outcome,
                    payload.origin,
                );
            },
            'settings.setAutoApprove': payload => {
                void setAutoApproveEnabled(payload.enabled).then(() => {
                    this.bus.emitBtF('settings.autoApprove', { enabled: payload.enabled });
                });
            },
        });
    }

    /** Run an FtB handler body; failures surface as `session.error` facts. */
    private guard(sessionId: string, fn: () => Promise<void> | void): void {
        void Promise.resolve()
            .then(fn)
            .catch(err => {
                const message = err?.message || String(err);
                debugLogger.log(`[AgentBackend] handler error for ${sessionId}: ${message}`);
                this.bus.emitBtF('session.error', { sessionId, message, recoverable: true });
            });
    }

    /** Shared ephemeral session for template pre-execution (`@[tool{...}]`). */
    private getPreExecutionSession(): BackendSession {
        if (!this.preExecutionSession) {
            this.preExecutionSession = BackendSession.createEphemeral(this.sessionDeps, {
                emptyToolSet: true,
            });
        }
        return this.preExecutionSession;
    }
}
