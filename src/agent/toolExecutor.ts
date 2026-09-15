/**
 * @fileoverview Tool executor for handling LLM tool calls.
 * @module agent/toolExecutor
 */

import type { ToolSet } from "../tools.d/toolManager";
import type { ToolContext } from "../tools.d/interface";
import { ToolSession } from "../tools.d/toolSession";
import type { AgentMessage } from "../types";
import type { ToolCall } from "@moonshot-ai/kosong";
import { createToolMessage } from "@moonshot-ai/kosong";
import type { UIRenderer } from "./uiRenderer";
import type { RenderBlock } from "../notebook/renderTypes";
import type { IAgentSession } from "../adapters/interfaces";
import { getCachedResult, setCachedResult } from "../tools.d/cache";

/** Race a thenable against an abort signal; rejects when the signal fires. */
function raceAbort<T>(signal: AbortSignal, p: Thenable<T>): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("aborted"));
		signal.addEventListener("abort", onAbort);
		Promise.resolve(p).then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}

// Re-export for statusBar
export { clearToolCache, getToolCacheSize } from "../tools.d/cache";

/**
 * Callbacks for UI updates and termination signaling.
 * @interface ToolExecutorCallbacks
 */
export interface ToolExecutorCallbacks {
	/** Append a completed render block to the UI */
	appendOutput: (block: RenderBlock) => Promise<void>;
	/** Signal that the task should terminate */
	signalTermination: () => void;
}

/**
 * Result of executing tools
 * @interface ToolExecutionResult
 */
export interface ToolExecutionResult {
	/** Messages from tool executions */
	messages: AgentMessage[];
	/** Whether the agent should terminate */
	shouldTerminate: boolean;
	/** Whether this is a successful task completion (e.g., from task_finish tool) */
	isTaskComplete: boolean;
}

/**
 * Executes tool calls from LLM responses.
 * @description Manages the execution of tool calls, handling context building,
 * error handling, and result collection.
 * @class ToolExecutor
 * @example
 * const executor = new ToolExecutor(tools, allowedUris, session, isSubAgent, uiRenderer);
 * const result = await executor.executeTools(toolCalls, abortSignal, callbacks);
 */
export class ToolExecutor {
	/**
	 * Creates a new ToolExecutor instance.
	 * @constructor
	 * @param {ToolSet} toolSet - Tool set for executing tools
	 * @param {string[]} allowedUris - List of allowed URIs for the agent
	 * @param {IAgentSession} session - The agent session
	 * @param {boolean} isSubAgent - Whether this is a sub-agent
	 * @param {UIRenderer} uiRenderer - UI renderer for formatting tool calls
	 */
	constructor(
		private toolSet: ToolSet,
		private allowedUris: string[],
		private session: IAgentSession,
		_isSubAgent: boolean,
		private uiRenderer: UIRenderer,
	) {}

	/**
	 * Executes a list of tool calls and returns the results.
	 * @description Iterates through each tool call, builds the tool context,
	 * executes the tool, collects results, and notifies callbacks for UI updates.
	 * @param {ToolCall[]} toolCalls - Tool calls to execute
	 * @param {AbortSignal} abortSignal - Signal for cancellation
	 * @param {ToolExecutorCallbacks} callbacks - Callbacks for UI updates and termination
	 * @returns {Promise<{messages: AgentMessage[], shouldTerminate: boolean}>} Tool execution results
	 * @throws {TerminationError} If a termination tool signals task completion
	 * @example
	 * const result = await executor.executeTools(toolCalls, abortSignal, {
	 *     appendOutput: async (block) => { /* update UI * / },
	 *     signalTermination: () => { /* handle termination * / }
	 * });
	 */
	async executeTools(
		toolCalls: ToolCall[],
		abortSignal: AbortSignal,
		callbacks: ToolExecutorCallbacks,
	): Promise<ToolExecutionResult> {
		const toolMessages: AgentMessage[] = [];
		let shouldTerminate = false;
		let isTaskComplete = false;

		for (const tc of toolCalls) {
			if (this.session.token.isCancellationRequested) {
				break;
			}

			const toolName = tc.name;
			const toolArgsStr = tc.arguments ?? '{}';
			let toolArgs: any;
			try {
				toolArgs = JSON.parse(toolArgsStr);
			} catch (err: any) {
				toolMessages.push({
					...createToolMessage(tc.id, `Error: invalid tool arguments JSON: ${err.message}`),
					name: toolName,
				});
				continue;
			}

			const toolSession = new ToolSession(this.session.id, toolName);
			const onAgentAbort = () => toolSession.abort();
			abortSignal.addEventListener("abort", onAgentAbort);

			const context: ToolContext = {
				allowedUris: this.allowedUris,
				notebook: undefined,
				execution: undefined,
				session: this.session,
				toolSession,
				abortSignal: toolSession.abortSignal,
				// Tools emit markdown strings via ToolContext; wrap them as content
			// blocks before forwarding to the RenderBlock-based callback.
			appendOutput: (content: string) =>
				callbacks.appendOutput({ type: "content", markdown: content }),
				signalTermination: (taskComplete = false) => {
					shouldTerminate = true;
					isTaskComplete = taskComplete;
					callbacks.signalTermination();
				},
			};

			const shouldCache = this.toolSet.getShouldCache(toolName);

			let toolResult = "";
			try {
				if (shouldCache) {
					const cached = getCachedResult(toolName, toolArgs);
					if (cached !== undefined) {
						toolResult = cached;
					} else {
						toolResult = await raceAbort(
							toolSession.abortSignal,
							this.toolSet.execute(toolName, toolArgs, context),
						);
						setCachedResult(toolName, toolArgs, toolResult);
					}
				} else {
					toolResult = await raceAbort(
						toolSession.abortSignal,
						this.toolSet.execute(toolName, toolArgs, context),
					);
				}
			} catch (err: any) {
				if (toolSession.isAborted) {
					toolResult = `[Interrupted] The ${toolName} tool execution was forcibly stopped by the user.`;
					shouldTerminate = true;
				} else {
					toolResult = `Error executing tool: ${err.message}`;
				}
			} finally {
				abortSignal.removeEventListener("abort", onAgentAbort);
				toolSession.complete();
			}

			// Get the pretty print summary for this tool call
			const prettyPrintSummary = this.toolSet.getPrettyPrint(
				toolName,
				toolArgs,
			);
			const config = this.toolSet.getRenderingConfig(toolName);
			await callbacks.appendOutput(
				this.uiRenderer.formatToolCall(
					toolName,
					toolArgs,
					prettyPrintSummary,
					false,
					toolResult,
					config,
				),
			);

			toolMessages.push({
				...createToolMessage(tc.id, toolResult),
				name: toolName,
			});
		}
		return { messages: toolMessages, shouldTerminate, isTaskComplete };
	}
}
