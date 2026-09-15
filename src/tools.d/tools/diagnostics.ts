import { ITool, ToolContext } from '../interface';
import { resolveUri } from '../utils';
import * as vscode from 'vscode';
import * as path from 'path';

export const getWarningErrorTool: ITool = {
    name: 'diagnostics',
    definition: {
        name: 'diagnostics',
        description: 'Retrieve warnings and errors (diagnostics) for the entire workspace, a specific directory, or a specific file.',
        parameters: {
            type: 'object',
            properties: {
                uri: { 
                    type: 'string', 
                    description: 'Optional. The target file or directory URI/path. If empty or omitted, returns diagnostics for the entire workspace.' 
                }
            }
        }
    },
    execute: async (args: any, context: ToolContext) => {
        try {
            const uriInput = args.uri;
            let filterUri: vscode.Uri | undefined;
            let isDirectory = false;

            // 1. Resolve URI if provided
            if (uriInput && uriInput.trim() !== '') {
                filterUri = resolveUri(uriInput);
                try {
                    const stat = await vscode.workspace.fs.stat(filterUri);
                    isDirectory = (stat.type === vscode.FileType.Directory);
                } catch (e) {
                    // Proceed even if stat fails (e.g. unsaved/virtual file)
                }
            }

            // 2. Get all diagnostics
            const allDiagnostics = vscode.languages.getDiagnostics();
            
            // 3. Filter and Format
            const results: string[] = [];
            let totalCount = 0;

            // Sort by URI string for stability
            allDiagnostics.sort((a, b) => a[0].toString().localeCompare(b[0].toString()));

            for (const [fileUri, diagnostics] of allDiagnostics) {
                // Filter by Scope
                if (filterUri) {
                    // Check scheme match first
                    if (fileUri.scheme !== filterUri.scheme) continue;
                    
                    // Simple authority check (case insensitive)
                    if (fileUri.authority.toLowerCase() !== filterUri.authority.toLowerCase()) continue;

                    if (isDirectory) {
                        // Directory match: check if file is child of directory
                        // Use URI path logic
                        const filterPath = filterUri.path.endsWith('/') ? filterUri.path : filterUri.path + '/';
                        if (!fileUri.path.startsWith(filterPath)) {
                            continue;
                        }
                    } else {
                        // File match: exact check (path)
                        if (fileUri.path !== filterUri.path) {
                            continue;
                        }
                    }
                }

                // Filter by Severity (Error & Warning only)
                const relevantDiagnostics = diagnostics.filter(d => 
                    d.severity === vscode.DiagnosticSeverity.Error || 
                    d.severity === vscode.DiagnosticSeverity.Warning
                );

                if (relevantDiagnostics.length === 0) {
                    continue;
                }

                // Sort diagnostics by line number
                relevantDiagnostics.sort((a, b) => a.range.start.line - b.range.start.line);

                const relativePath = vscode.workspace.asRelativePath(fileUri);
                const fileHeader = `FILE: ${relativePath}`;
                const fileOutput = [fileHeader];

                for (const diag of relevantDiagnostics) {
                    totalCount++;
                    const severity = diag.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
                    const line = diag.range.start.line + 1; // 1-based
                    const col = diag.range.start.character + 1;
                    
                    let message = `[${severity}] Line ${line}:${col} - ${diag.message}`;
                    if (diag.source) {
                        message += ` (${diag.source})`;
                    }
                    fileOutput.push(message);
                }
                
                results.push(fileOutput.join('\n'));
            }

            if (results.length === 0) {
                return 'No warnings or errors found.';
            }

            return `Found ${totalCount} problems in ${results.length} files:\n\n` + results.join('\n\n');

        } catch (err: any) {
            return `Error retrieving diagnostics: ${err.message}`;
        }
    },
    prettyPrint: (args: any) => {
        if (args.uri) {
            return `⚠️ Mutsumi checked diagnostics for ${args.uri}`;
        }
        return `⚠️ Mutsumi checked workspace diagnostics`;
    }
};