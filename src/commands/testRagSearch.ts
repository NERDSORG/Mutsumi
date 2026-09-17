/**
 * @fileoverview Test RAG search command.
 * @module commands/testRagSearch
 */

import * as vscode from 'vscode';
import { RagService } from '../codebase/rag/service';
import { t } from '../i18n';

/**
 * Register the test RAG search command.
 * @param {vscode.ExtensionContext} context - Extension context for registering disposables
 */
export function registerTestRagSearchCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('mutsumi.testRagSearch', async () => {
            const query = await vscode.window.showInputBox({
                prompt: t('testRag.prompt'),
                placeHolder: t('testRag.placeHolder'),
                ignoreFocusOut: true
            });

            if (!query || !query.trim()) {
                vscode.window.showInformationMessage(t('testRag.cancelled'));
                return;
            }

            try {
                const ragService = await RagService.getInstance(context);
                const workspaces = vscode.workspace.workspaceFolders;

                if (!workspaces || workspaces.length === 0) {
                    vscode.window.showWarningMessage(t('testRag.noWorkspaces'));
                    return;
                }

                let content = '=== RAG Search Results ===\n\n';
                content += `Query: "${query}"\n`;
                content += `Workspaces searched: ${workspaces.length}\n\n`;

                for (const ws of workspaces) {
                    content += `--- Workspace: ${ws.name} (${ws.uri.toString()}) ---\n\n`;

                    try {
                        const results = await ragService.search(ws.uri, query, 5);

                        if (results.length === 0) {
                            content += '(No results found)\n';
                        } else {
                            for (let i = 0; i < results.length; i++) {
                                const r = results[i];
                                const fullPath = r.symbolName ? `${r.filePath} - ${r.symbolName}` : r.filePath;
                                content += `[${i + 1}] ${fullPath}\n`;
                                content += `    (lines ${r.startLine}-${r.endLine}, distance: ${r.distance.toFixed(4)})\n`;
                                content += '```\n';
                                content += r.text.substring(0, 500);
                                if (r.text.length > 500) {
                                    content += '\n...(truncated)';
                                }
                                content += '\n```\n\n';
                            }
                        }
                    } catch (err: any) {
                        content += `(Error: ${err.message})\n`;
                    }

                    content += '\n';
                }

                content += '=== End of Results ===\n';

                const doc = await vscode.workspace.openTextDocument({
                    content: content,
                    language: 'markdown'
                });
                await vscode.window.showTextDocument(doc, { preview: true });

                vscode.window.showInformationMessage(t('testRag.completed', workspaces.length));
            } catch (error: any) {
                console.error('RAG search failed:', error);
                vscode.window.showErrorMessage(t('testRag.failed', error.message));
            }
        })
    );
}
