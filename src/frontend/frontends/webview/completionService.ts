/**
 * @fileoverview Adapter-side data source for the `@` completion menu: files
 * and directories via VS Code's built-in search, tools via the pre-execution
 * tool registry. Reached through the adapter-local RPC envelope only.
 *
 * File lists are served from a module-level cache (TTL 60s from the last
 * scan, keyed by a workspace-folder fingerprint): the webview fetches the
 * full unfiltered list once when the menu opens and re-filters locally on
 * every keystroke, so a scan only happens on a cache miss. The stale window
 * is at most 60s, matching VS Code's own completion behavior.
 *
 * @module frontend/frontends/webview/completionService
 */

import * as vscode from 'vscode';
import { isCommonIgnored } from '../../../tools.d/utils';
import { stripBriefParam } from '../../../tools.d/brief';
import { PreExecutionToolController } from '../../../tools.d/preExecution';
import { McpRegistry } from '../../../tools.d/mcp/registry';
import { getMcpToolExposedName } from '../../../tools.d/mcp/utils';
import type { CompletionToolInfo, WorkspaceFileList } from './interfaces';

/** Raw file search cap. */
const MAX_SEARCH_RESULTS = 5000;
/** Cache time-to-live, from the last scan. */
const CACHE_TTL_MS = 60_000;

interface WorkspaceFileCache {
    /** Sorted workspace-folder URIs joined — the invalidation fingerprint. */
    foldersKey: string;
    files: string[];
    dirs: string[];
    fetchedAt: number;
}

let cache: WorkspaceFileCache | undefined;

/**
 * Full unfiltered relative-path list: every workspace file (up to
 * {@link MAX_SEARCH_RESULTS}) plus shallow root-level directory rows. Served
 * from {@link cache} while it is fresh and the workspace folders are
 * unchanged; a miss triggers one full scan.
 */
export async function listWorkspaceFiles(): Promise<WorkspaceFileList> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return { files: [], dirs: [] };
    }
    const foldersKey = workspaceFolders
        .map(folder => folder.uri.toString())
        .sort()
        .join('\n');
    if (cache && cache.foldersKey === foldersKey && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
        return { files: cache.files, dirs: cache.dirs };
    }
    const multiRoot = workspaceFolders.length > 1;

    // exclude = undefined → files.exclude applies and .gitignore is honoured.
    const uris = await vscode.workspace.findFiles('**', undefined, MAX_SEARCH_RESULTS);
    const files = uris
        .map(uri => vscode.workspace.asRelativePath(uri, multiRoot))
        .filter(rel => !rel.split(/[/\\]/).some(part => isCommonIgnored(part)));

    // Directory rows: shallow scan of each workspace root.
    const dirs: string[] = [];
    for (const folder of workspaceFolders) {
        try {
            const entries = await vscode.workspace.fs.readDirectory(folder.uri);
            for (const [name, type] of entries) {
                if (type === vscode.FileType.Directory && !isCommonIgnored(name)) {
                    dirs.push((multiRoot ? `${folder.name}/` : '') + name + '/');
                }
            }
        } catch {
            // Ignore roots that cannot be listed.
        }
    }

    cache = { foldersKey, files, dirs, fetchedAt: Date.now() };
    return { files, dirs };
}

/**
 * Tool rows for the completion menu: the pre-execution tool set (built-in
 * common tools plus every connected, schema-valid MCP tool). MCP rows carry
 * display metadata: `serverId/originalName` is shown, the hashed exposed
 * name is inserted.
 *
 * Built-in schemas are stripped of the model-facing `brief` trace parameter
 * (see tools.d/brief) so humans are never asked to fill it; MCP schemas are
 * external and pass through verbatim — a same-named MCP parameter is
 * functional and must stay visible.
 */
export function listCompletionTools(): CompletionToolInfo[] {
    // exposed name → display identity
    const mcpDisplay = new Map<string, { serverId: string; originalName: string }>();
    for (const record of McpRegistry.getInstance().getRecords()) {
        if (record.status !== 'connected') {
            continue;
        }
        for (const tool of record.tools) {
            if (!tool.schemaValid) {
                continue;
            }
            mcpDisplay.set(getMcpToolExposedName(record.serverId, tool.name), {
                serverId: record.serverId,
                originalName: tool.name,
            });
        }
    }

    return PreExecutionToolController.getInstance()
        .getToolsDefinitions(false)
        .map(def => {
            const mcp = mcpDisplay.get(def.name);
            return {
                name: def.name,
                displayName: mcp ? `${mcp.serverId}/${mcp.originalName}` : def.name,
                description: def.description,
                parameters: (mcp
                    ? def.parameters
                    : stripBriefParam(def.parameters)) as CompletionToolInfo['parameters'],
                serverId: mcp?.serverId,
            };
        });
}
