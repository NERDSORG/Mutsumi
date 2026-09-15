import * as vscode from 'vscode';
import * as path from 'path';
import { isCommonIgnored } from '../tools.d/utils';
import { ToolManager } from '../tools.d/toolManager';
import { t } from '../i18n';

/**
 * Recursively append a JSON-shaped snippet placeholder for a tool parameter schema.
 * Supports primitive defaults, enum/choice, boolean true/false picker, arrays and objects.
 */
function appendSchemaSnippet(snip: vscode.SnippetString, schema: any): void {
    if (!schema || typeof schema !== 'object') {
        snip.appendPlaceholder('');
        return;
    }

    const enumValues = schema.enum;
    if (Array.isArray(enumValues) && enumValues.length > 0) {
        const choices = enumValues.map(v => String(v));
        snip.appendChoice(choices);
        return;
    }

    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

    switch (type) {
        case 'boolean':
            snip.appendChoice(['true', 'false']);
            break;

        case 'number':
        case 'integer':
            snip.appendPlaceholder('0');
            break;

        case 'string':
            snip.appendText('"');
            snip.appendPlaceholder('');
            snip.appendText('"');
            break;

        case 'array': {
            snip.appendText('[');
            const itemSchema = schema.items;
            if (itemSchema && typeof itemSchema === 'object') {
                appendSchemaSnippet(snip, itemSchema);
            } else {
                snip.appendPlaceholder('');
            }
            snip.appendText(']');
            break;
        }

        case 'object': {
            snip.appendText('{');
            const props = schema.properties || {};
            const keys = Object.keys(props);
            keys.forEach((key, idx) => {
                if (idx > 0) {
                    snip.appendText(', ');
                }
                snip.appendText(`"${key}": `);
                appendSchemaSnippet(snip, props[key]);
            });
            snip.appendText('}');
            break;
        }

        default:
            snip.appendPlaceholder('');
            break;
    }
}

/**
 * @description Provider class for reference auto-completion functionality
 * @class ReferenceCompletionProvider
 * @implements {vscode.CompletionItemProvider}
 */
export class ReferenceCompletionProvider implements vscode.CompletionItemProvider {

    /**
     * @description Provide completion items
     */
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[]> {

        // Check trigger condition: user inputs @ followed by optional path characters
        const linePrefix = document.lineAt(position).text.substr(0, position.character);

        const match = linePrefix.match(/@([^@\s]*)$/);
        if (!match) {
            return [];
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return [];

        const items: vscode.CompletionItem[] = [];

        // 2. File suggestions (using findFiles)
        const files = await vscode.workspace.findFiles('**/*', undefined, 5000, token);

        for (const file of files) {
            if (token.isCancellationRequested) break;

            const relPath = vscode.workspace.asRelativePath(file, workspaceFolders.length > 1);

            if (relPath.split(/[/\\]/).some(part => isCommonIgnored(part))) {
                continue;
            }

            const item = new vscode.CompletionItem(relPath, vscode.CompletionItemKind.File);

            item.insertText = `[${relPath}]`;
            item.detail = t('completion.fileReference');
            item.documentation = new vscode.MarkdownString(t('completion.referenceDoc', relPath));
            item.sortText = '000_' + relPath;
            items.push(item);
        }

        // 3. Directory suggestions (shallow scan)
        for (const folder of workspaceFolders) {
            if (token.isCancellationRequested) break;

            const folderRoot = folder.uri;
            try {
                const dirEntries = await vscode.workspace.fs.readDirectory(folderRoot);

                for (const [name, type] of dirEntries) {
                    if (type === vscode.FileType.Directory && !isCommonIgnored(name)) {
                        const prefix = workspaceFolders.length > 1 ? `${folder.name}/` : '';
                        const displayLabel = prefix + name + '/';

                        const item = new vscode.CompletionItem(displayLabel, vscode.CompletionItemKind.Folder);
                        item.insertText = `[${displayLabel}]`;
                        item.detail = t('completion.directoryReference');
                        item.sortText = '001_' + displayLabel;
                        items.push(item);
                    }
                }
            } catch (e) {
                // Ignore read errors
            }
        }

        // 4. Tool suggestions
        try {
            const tm = ToolManager.getInstance();
            const tools = tm.getToolsDefinitions(false);

            for (const tool of tools) {
                const name = tool.name;
                const desc = tool.description || t('completion.tool');
                const parameters = tool.parameters as {
                    properties?: Record<string, { type?: string | string[]; description?: string }>;
                    required?: string[];
                };

                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
                item.detail = t('completion.toolCall');

                const properties = parameters.properties || {};
                const required = parameters.required || [];
                const paramNames = Object.keys(properties);

                const snip = new vscode.SnippetString();
                snip.appendText(`[${name}{`);

                paramNames.forEach((paramName, idx) => {
                    if (idx > 0) {
                        snip.appendText(', ');
                    }
                    snip.appendText(`"${paramName}": `);
                    appendSchemaSnippet(snip, properties[paramName]);
                });

                snip.appendText('}]');
                snip.appendTabstop(0);
                item.insertText = snip;

                let docContent = desc;
                if (paramNames.length > 0) {
                    docContent += '\n\n**Parameters:**\n\n';
                    paramNames.forEach(paramName => {
                        const paramDef = properties[paramName];
                        const isRequired = required.includes(paramName);
                        const paramType = Array.isArray(paramDef.type) ? paramDef.type.join(' | ') : (paramDef.type || 'any');
                        const paramDesc = paramDef.description || '';

                        const reqMarker = isRequired ? '**(required)**' : '(optional)';
                        docContent += `- \`${paramName}\` \`${paramType}\` ${reqMarker}`;
                        if (paramDesc) {
                            docContent += ` - ${paramDesc}`;
                        }
                        docContent += '\n';
                    });
                }
                item.documentation = new vscode.MarkdownString(docContent);
                item.sortText = '002_' + name;
                items.push(item);
            }
        } catch (e) {
            // Ignore tool retrieval errors
        }

        return items;
    }
}
