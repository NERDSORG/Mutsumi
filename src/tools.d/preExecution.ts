/**
 * @fileoverview Pre-execution (user tool plane) tracking.
 *
 * The pre-execution plane covers every tool call authored directly by the
 * user in template content (`@[tool{...}]` in messages, rules, skills or
 * macros) rather than emitted by the model. These calls always execute
 * directly: no approval UI, no approval sidebar round-trip, regardless of
 * readOnly hints or the global auto-approve setting.
 *
 * Kept independent of the backend approval module so contextManagement does
 * not acquire a dependency on the backend (which itself depends on
 * contextManagement).
 *
 * @module tools.d/preExecution
 */

import type { BackendSession } from '../backend/backendSession';

/**
 * Tracks nested pre-execution activity.
 */
class PreExecutionManager {
    private static instance: PreExecutionManager;
    private depth = 0;

    private constructor() {}

    public static getInstance(): PreExecutionManager {
        if (!PreExecutionManager.instance) {
            PreExecutionManager.instance = new PreExecutionManager();
        }
        return PreExecutionManager.instance;
    }

    public isActive(): boolean {
        return this.depth > 0;
    }

    public async with<T>(fn: () => Promise<T>): Promise<T> {
        this.depth++;
        try {
            return await fn();
        } finally {
            this.depth--;
        }
    }
}

/**
 * Check if tool execution is currently happening on the pre-execution plane.
 */
export function isInPreExecution(): boolean {
    return PreExecutionManager.getInstance().isActive();
}

/**
 * Execute a function on the pre-execution (user-authored) tool plane.
 * Tool calls made during the execution are auto-approved.
 */
export async function withPreExecution<T>(fn: () => Promise<T>): Promise<T> {
    return PreExecutionManager.getInstance().with(fn);
}

// ============================================================================
// Pre-execution session factory
// ============================================================================

/**
 * Tool pre-execution still needs a `ToolContext.session` handle. The backend
 * registers a factory for a shared ephemeral BackendSession here at
 * activation time; contextManagement consumes it without importing the
 * backend (type-only import above keeps the module graph acyclic).
 */
let preExecutionSessionFactory: (() => BackendSession) | undefined;

/** Register the ephemeral-session factory used for pre-execution tool calls. */
export function registerPreExecutionSessionFactory(factory: () => BackendSession): void {
    preExecutionSessionFactory = factory;
}

/** Get the shared ephemeral session for pre-execution tool calls. */
export function getPreExecutionSession(): BackendSession {
    if (!preExecutionSessionFactory) {
        throw new Error('Pre-execution session factory not registered (backend not initialized)');
    }
    return preExecutionSessionFactory();
}
