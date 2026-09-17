import type { Tool } from '@moonshot-ai/kosong';
import type { BackendSession } from '../backend/backendSession';
import type { ToolSession } from './toolSession';

export interface ToolContext {
    allowedUris: string[];
    session: BackendSession;
    /** Per-tool-call execution session; abort this to stop a running tool. */
    toolSession: ToolSession;
    /** Convenience: alias of `toolSession.abortSignal`. */
    abortSignal?: AbortSignal;
    /**
     * Signal that the session should be terminated after this tool call.
     * The tool result will be added to the conversation before termination.
     * @param isTaskComplete - Whether this termination represents a successfully completed task (default: false)
     */
    signalTermination: (isTaskComplete?: boolean) => void;
}

export interface ITool {
    name: string;
    /** Provider-agnostic wire schema (kosong `Tool`), sent to the model as-is */
    definition: Tool;
    execute(args: any, context: ToolContext): Promise<string>;
    /**
     * Generate a human-readable description of the tool call.
     * @param args - The arguments passed to the tool
     * @returns A natural language string describing what the tool is doing
     */
    prettyPrint(args: any): string;
    /**
     * Optional: List of argument names that should be rendered as code blocks.
     */
    argsToCodeBlock?: string[];
    /**
     * Optional: List of argument names (paths) that correspond to the code blocks.
     * Must have the same length as argsToCodeBlock.
     * Used to determine the language for syntax highlighting.
     */
    codeBlockFilePaths?: (string | undefined)[];
    /**
     * Optional: Whether tool results should be cached.
     * Tools that depend on external state (like file system, network, etc.)
     * can set this to true to allow result caching.
     */
    shouldCache?: boolean;
}
