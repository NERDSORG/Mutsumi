/**
 * @fileoverview Dispatch Session Manager - Manages lifecycle of dispatch sessions for sub-agents.
 * @module dispatch
 */

import { AgentStateInfo } from './types';
import type { DispatchSession } from './interfaces';

/**
 * Manages dispatch sessions for sub-agents.
 * @description Handles creation, tracking, and completion of dispatch sessions.
 * Each dispatch session represents a parent agent waiting for multiple sub-agents to complete.
 * @class DispatchSessionManager
 * @example
 * const manager = DispatchSessionManager.getInstance();
 * manager.createSession(parentId, childUuids, resolve, reject);
 * manager.addResult(parentId, childUuid, result);
 * if (manager.isSessionComplete(parentId)) {
 *   const report = manager.generateReport(parentId, registry);
 * }
 */
export class DispatchSessionManager {
    /** Singleton instance */
    private static instance: DispatchSessionManager;

    /** Active dispatch sessions (ParentUUID -> Session) */
    private activeDispatches = new Map<string, DispatchSession>();

    /**
     * Private constructor to enforce singleton pattern.
     * @private
     * @constructor
     */
    private constructor() {}

    /**
     * Gets the singleton instance of DispatchSessionManager.
     * @static
     * @returns {DispatchSessionManager} The singleton instance
     * @example
     * const manager = DispatchSessionManager.getInstance();
     */
    public static getInstance(): DispatchSessionManager {
        if (!DispatchSessionManager.instance) {
            DispatchSessionManager.instance = new DispatchSessionManager();
        }
        return DispatchSessionManager.instance;
    }

    /**
     * Creates a new dispatch session.
     * @param {string} parentId - Parent agent ID that initiated the dispatch
     * @param {Set<string>} childUuids - Set of child agent UUIDs in this session
     * @param {(value: string | PromiseLike<string>) => void} resolve - Resolve callback
     * @param {(reason?: any) => void} reject - Reject callback
     * @returns {DispatchSession} The created session
     * @example
     * const session = manager.createSession(
     *   parentId,
     *   new Set(['child-1', 'child-2']),
     *   resolve,
     *   reject
     * );
     */
    public createSession(
        parentId: string,
        childUuids: Set<string>,
        resolve: (value: string | PromiseLike<string>) => void,
        reject: (reason?: any) => void
    ): DispatchSession {
        const session: DispatchSession = {
            parentId,
            resolve,
            reject,
            childUuids,
            results: new Map(),
            deletedChildren: new Set()
        };
        this.activeDispatches.set(parentId, session);
        return session;
    }

    /**
     * Gets a dispatch session by parent ID.
     * @param {string} parentId - Parent agent ID
     * @returns {DispatchSession | undefined} The session or undefined if not found
     * @example
     * const session = manager.getSession(parentId);
     * if (session) {
     *   // process session
     * }
     */
    public getSession(parentId: string): DispatchSession | undefined {
        return this.activeDispatches.get(parentId);
    }

    /**
     * Deletes a dispatch session.
     * @param {string} parentId - Parent agent ID of the session to delete
     * @returns {boolean} True if session was deleted, false if not found
     * @example
     * const deleted = manager.deleteSession(parentId);
     */
    public deleteSession(parentId: string): boolean {
        return this.activeDispatches.delete(parentId);
    }

    /**
     * Checks if a dispatch session exists.
     * @param {string} parentId - Parent agent ID to check
     * @returns {boolean} True if session exists
     * @example
     * if (manager.hasSession(parentId)) {
     *   // session exists
     * }
     */
    public hasSession(parentId: string): boolean {
        return this.activeDispatches.has(parentId);
    }

    /**
     * Adds a result from a child agent to the session.
     * @param {string} parentId - Parent agent ID of the session
     * @param {string} childUuid - Child agent UUID that produced the result
     * @param {string} result - The result report from the child agent
     * @returns {boolean} True if result was added, false if session or child not found
     * @example
     * manager.addResult(parentId, childUuid, 'Task completed successfully');
     */
    public addResult(parentId: string, childUuid: string, result: string): boolean {
        const session = this.activeDispatches.get(parentId);
        if (!session || !session.childUuids.has(childUuid)) {
            return false;
        }
        session.results.set(childUuid, result);
        return true;
    }

    /**
     * Marks a child agent as deleted in the session.
     * @param {string} parentId - Parent agent ID of the session
     * @param {string} childUuid - Child agent UUID that was deleted
     * @returns {boolean} True if child was marked as deleted, false if session or child not found
     * @example
     * manager.addDeletedChild(parentId, childUuid);
     */
    public addDeletedChild(parentId: string, childUuid: string): boolean {
        const session = this.activeDispatches.get(parentId);
        if (!session || !session.childUuids.has(childUuid)) {
            return false;
        }
        session.deletedChildren.add(childUuid);
        return true;
    }

    /**
     * Checks if a dispatch session is complete.
     * A session is complete when all children have either produced results or been deleted.
     * @param {string} parentId - Parent agent ID of the session
     * @returns {boolean} True if all children have been accounted for
     * @example
     * if (manager.isSessionComplete(parentId)) {
     *   // generate final report
     * }
     */
    public isSessionComplete(parentId: string): boolean {
        const session = this.activeDispatches.get(parentId);
        if (!session) {
            return false;
        }

        for (const childId of session.childUuids) {
            if (!session.results.has(childId) && !session.deletedChildren.has(childId)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Generates the final report for a completed session.
     * @param {string} parentId - Parent agent ID of the session
     * @param {Map<string, AgentStateInfo>} registry - Agent registry for looking up names
     * @returns {string} The formatted final report, or empty string if session not found
     * @example
     * const report = manager.generateReport(parentId, agentRegistry);
     * console.log(report);
     */
    public generateReport(parentId: string, registry: Map<string, AgentStateInfo>): string {
        const session = this.activeDispatches.get(parentId);
        if (!session) {
            return '';
        }

        const successSummaries = Array.from(session.results.entries())
            .map(([uuid, text]) => {
                const name = registry.get(uuid)?.name || uuid.slice(0, 6);
                return `### Sub-agent '${name}' Finished:\n${text}`;
            });

        const deletedSummaries = Array.from(session.deletedChildren).map(uuid => {
            return `### Sub-agent ${uuid.slice(0, 6)} was deleted (Cancelled).`;
        });

        const finalReport = [...successSummaries, ...deletedSummaries].join('\n\n----------------\n\n');

        if (!finalReport.trim()) {
            return 'All sub-agents were deleted or produced no output.';
        }
        return finalReport;
    }

    /**
     * Cancels an active dispatch session.
     * Rejects the session's promise with the given reason and removes the session.
     * @param {string} parentId - Parent agent ID of the session to cancel
     * @param {string} reason - Reason for cancellation
     * @returns {boolean} True if session was cancelled, false if not found
     * @example
     * manager.cancelSession(parentId, 'User aborted execution');
     */
    public cancelSession(parentId: string, reason: string): boolean {
        const session = this.activeDispatches.get(parentId);
        if (session) {
            session.reject(new Error(reason));
            this.activeDispatches.delete(parentId);
            return true;
        }
        return false;
    }

    /**
     * Gets all active session parent IDs.
     * @returns {string[]} Array of parent IDs for all active sessions
     * @example
     * const activeSessions = manager.getActiveSessionIds();
     */
    public getActiveSessionIds(): string[] {
        return Array.from(this.activeDispatches.keys());
    }

    /**
     * Clears all active dispatch sessions.
     * @description This will reject all pending sessions with a 'Session manager cleared' reason.
     * Use with caution, typically during shutdown.
     * @example
     * manager.clearAllSessions();
     */
    public clearAllSessions(): void {
        for (const [parentId, session] of this.activeDispatches) {
            session.reject(new Error('Session manager cleared'));
        }
        this.activeDispatches.clear();
    }
}
