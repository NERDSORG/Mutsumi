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
 * Also hosts `PreExecutionToolController`, the dedicated controller for
 * human-authored pre-execution tool calls (definitions + cached execution).
 *
 * @module tools.d/preExecution
 */

import type { BackendSession } from '../backend/backendSession';
import type { ToolContext } from './interface';
import type { Tool } from '@moonshot-ai/kosong';
import { getUserToolSet } from './userToolSet';
import { getCachedResult, setCachedResult } from './cache';

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

// ============================================================================
// Pre-execution tool controller
// ============================================================================

/**
 * Controller dedicated to human pre-execution (`@[tool{...}]`) tool calls.
 * Provides tool definitions (for completion) and execution with result
 * caching, all resolved through the pre-execution user tool set. Display
 * metadata queries (prettyPrint / rendering config) live in
 * `tools.d/toolDisplay`.
 */
export class PreExecutionToolController {
    /** Singleton instance */
    private static instance: PreExecutionToolController;

    private constructor() {}

    /**
     * Gets the singleton instance.
     * @static
     * @returns {PreExecutionToolController} The singleton instance
     */
    public static getInstance(): PreExecutionToolController {
        if (!PreExecutionToolController.instance) {
            PreExecutionToolController.instance = new PreExecutionToolController();
        }
        return PreExecutionToolController.instance;
    }

    /**
     * Gets tool definitions in the provider-agnostic kosong wire schema.
     * @param {boolean} isSubAgent - True for non-root/child sessions (includes task_finish)
     * @returns {Tool[]} Array of tool definitions
     */
    public getToolsDefinitions(isSubAgent: boolean): Tool[] {
        return getUserToolSet(isSubAgent).getDefinitions();
    }

    /**
     * Executes a tool with the given arguments and context.
     * @param {string} name - Tool name
     * @param {any} args - Tool arguments
     * @param {ToolContext} context - Execution context
     * @param {boolean} isSubAgent - True for non-root/child sessions (includes task_finish)
     * @returns {Promise<string>} Tool execution result
     */
    public async executeTool(
        name: string,
        args: any,
        context: ToolContext,
        isSubAgent: boolean,
    ): Promise<string> {
        const toolSet = getUserToolSet(isSubAgent);

        const shouldCache = toolSet.getShouldCache(name);

        if (shouldCache) {
            const cached = getCachedResult(name, args);
            if (cached !== undefined) {
                return cached;
            }
        }

        const result = await toolSet.execute(name, args, context);

        if (shouldCache) {
            setCachedResult(name, args, result);
        }

        return result;
    }
}
