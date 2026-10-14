/**
 * @fileoverview Adapter-side data source for the `@` completion menu: files
 * and directories via VS Code's built-in search, tools via the pre-execution
 * tool registry. Reached through the adapter-local RPC envelope only.
 *
 * @module frontend/frontends/webview/completionService
 */

import * as vscode from 'vscode';
import { isCommonIgnored } from '../../../tools.d/utils';
import { stripBriefParam } from '../../../tools.d/brief';
import { ToolManager } from '../../../tools.d/toolManager';
import { McpRegistry } from '../../../tools.d/mcp/registry';
import { getMcpToolExposedName } from '../../../tools.d/mcp/utils';
import { fuzzyFilter } from '../../../shared/fuzzyMatch';
import type { CompletionSearchResult, CompletionToolInfo } from './interfaces';

/** Raw file search cap. */
const MAX_SEARCH_RESULTS = 5000;
/** Best-ranked rows shipped per category. */
const DISPLAY_LIMIT = 50;

/** Fuzzy-ranked files plus root-level directory rows for one query. */
export async function searchCompletions(query: string): Promise<CompletionSearchResult> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return { files: [], dirs: [] };
    }
    const multiRoot = workspaceFolders.length > 1;

    // exclude = undefined → files.exclude applies and .gitignore is honoured.
    const uris = await vscode.workspace.findFiles('**/*', undefined, MAX_SEARCH_RESULTS);
    const paths = uris
        .map(uri => vscode.workspace.asRelativePath(uri, multiRoot))
        .filter(rel => !rel.split(/[/\\]/).some(part => isCommonIgnored(part)));
    const files = fuzzyFilter(query, paths, p => p).slice(0, DISPLAY_LIMIT);

    // Directory rows: shallow scan of each workspace root.
    const allDirs: string[] = [];
    for (const folder of workspaceFolders) {
        try {
            const entries = await vscode.workspace.fs.readDirectory(folder.uri);
            for (const [name, type] of entries) {
                if (type === vscode.FileType.Directory && !isCommonIgnored(name)) {
                    allDirs.push((multiRoot ? `${folder.name}/` : '') + name + '/');
                }
            }
        } catch {
            // Ignore roots that cannot be listed.
        }
    }
    const dirs = fuzzyFilter(query, allDirs, d => d).slice(0, DISPLAY_LIMIT);

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

    return ToolManager.getInstance()
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
