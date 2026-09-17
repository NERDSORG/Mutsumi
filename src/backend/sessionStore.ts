/**
 * @fileoverview .mtm session file store — the single file write path.
 *
 * Reads and writes `{ metadata, context }` JSON directly through
 * `vscode.workspace.fs` (pure byte I/O, no dirty-buffer involvement). Writes
 * are serialized through a per-file promise queue so concurrent producers
 * (runner, registry, …) never interleave.
 *
 * Writes go straight to the target file (truncate + write, seen as CHANGE by
 * watchers). A tmp-then-rename scheme would appear as DELETE + CREATE to file
 * watchers: VS Code closes custom editors of "deleted" resources, and the
 * extension's own `.mtm` deletion watcher would tear the session down on
 * every persist.
 *
 * The backend is the sole writer of .mtm files, whether or not any editor has
 * them open.
 *
 * @module backend/sessionStore
 */

import * as vscode from 'vscode';
import type { AgentMessage, AgentMetadata } from '../types';

/**
 * Direct reader/writer for .mtm session files.
 */
export class SessionStore {
    /** Per-file write queues serializing concurrent writes. */
    private readonly writeQueues = new Map<string, Promise<void>>();

    /**
     * Read a session file. The system prompt is a pure function of metadata
     * and is never persisted; any system messages found in files written by
     * older versions are dropped on load.
     */
    async read(fileUri: vscode.Uri): Promise<{ metadata: AgentMetadata; context: AgentMessage[] }> {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const data = JSON.parse(new TextDecoder().decode(bytes));
        const metadata = (data.metadata ?? {}) as AgentMetadata;
        const context: AgentMessage[] = Array.isArray(data.context) ? data.context : [];
        return {
            metadata,
            context: context.filter(m => m.role !== 'system'),
        };
    }

    /**
     * Persist a session. Calls for the same file are queued; the newest call
     * always writes the newest state.
     */
    write(fileUri: vscode.Uri, metadata: AgentMetadata, context: AgentMessage[]): Promise<void> {
        const key = fileUri.toString();
        const previous = this.writeQueues.get(key) ?? Promise.resolve();
        const next = previous
            .catch(() => { /* keep the queue alive after a failed write */ })
            .then(() => this.writeDirect(fileUri, metadata, context));
        this.writeQueues.set(key, next);
        return next;
    }

    private async writeDirect(fileUri: vscode.Uri, metadata: AgentMetadata, context: AgentMessage[]): Promise<void> {
        const output = {
            metadata: { ...metadata, mtm_version: 2 },
            context,
        };
        const encoded = new TextEncoder().encode(JSON.stringify(output, null, 2));
        await vscode.workspace.fs.writeFile(fileUri, encoded);
    }
}
