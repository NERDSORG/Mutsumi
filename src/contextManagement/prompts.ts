import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import { ContextItem } from '../types';
import { TemplateEngine } from './templateEngine';

/**
 * @description Initialize rules directory and default rules files
 * Creates .mutsumi/rules/default/ and copies default rules from assets if the directory is empty
 */
export async function initializeRules(extensionUri: vscode.Uri, workspaceUri: vscode.Uri) {
    const rulesDir = vscode.Uri.joinPath(workspaceUri, '.mutsumi', 'rules');
    const defaultRulesDir = vscode.Uri.joinPath(rulesDir, 'default');
    const assetsDir = vscode.Uri.joinPath(extensionUri, 'assets', 'default');

    try {
        // Ensure .mutsumi/rules/default/ directory exists (mkdir -p behavior)
        await vscode.workspace.fs.createDirectory(defaultRulesDir);

        // Check if default rules directory is empty
        let isEmpty = false;
        try {
            const entries = await vscode.workspace.fs.readDirectory(defaultRulesDir);
            isEmpty = entries.length === 0;
        } catch {
            isEmpty = true;
        }

        // If empty, copy all files from assets/default/
        if (isEmpty) {
            const assetFiles = await vscode.workspace.fs.readDirectory(assetsDir);
            for (const [fileName, fileType] of assetFiles) {
                if (fileType === vscode.FileType.File && fileName.endsWith('.md')) {
                    const sourceUri = vscode.Uri.joinPath(assetsDir, fileName);
                    const targetUri = vscode.Uri.joinPath(defaultRulesDir, fileName);
                    try {
                        await vscode.workspace.fs.copy(sourceUri, targetUri, { overwrite: false });
                    } catch (e) {
                        console.warn(`Failed to copy ${fileName}:`, e);
                    }
                }
            }
        }
    } catch (e) {
        console.error('Failed to initialize rules from assets', e);
    }
}

/**
 * @description Recursively collect all markdown rule files from a directory
 * @param dirUri - Directory to scan
 * @param baseUri - Base URI for calculating relative paths
 * @returns Array of objects containing relative name and file URI
 */
export async function collectRulesRecursively(dirUri: vscode.Uri, baseUri: vscode.Uri): Promise<{name: string, uri: vscode.Uri}[]> {
    const results: {name: string, uri: vscode.Uri}[] = [];
    try {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        for (const [entryName, entryType] of entries) {
            const entryUri = vscode.Uri.joinPath(dirUri, entryName);
            if (entryType === vscode.FileType.Directory) {
                const subResults = await collectRulesRecursively(entryUri, baseUri);
                results.push(...subResults);
            } else if (entryType === vscode.FileType.File && entryName.endsWith('.md')) {
                const relativePath = dirUri.path.replace(baseUri.path, '').replace(/^\//, '');
                const fullName = relativePath ? `${relativePath}/${entryName}` : entryName;
                results.push({ name: fullName, uri: entryUri });
            }
        }
    } catch (e) {
        console.error('Error reading rules directory', e);
    }
    return results;
}

/**
 * Builds system prompt containing runtime context, allowed URIs, completion obligations, and rules.
 * For non-root agents (isSubAgent=true), includes task_finish obligation.
 */
export async function getSystemPrompt(
    workspaceUri: vscode.Uri,
    allowedUris: string[],
    rulesItems: ContextItem[],
    isSubAgent?: boolean
): Promise<string> {
    let prompt = `### Runtime Context
Current Allowed URIs: ${JSON.stringify(allowedUris)}`;

    if (isSubAgent) {
        prompt += `\n\n## Sub-Agent Identity\nYou are a Sub-Agent. When finishing a task, you must use the \`task_finish\` tool to report completion status to the Parent Agent. You may use the \`communicate\` tool to message your parent or sibling agents by their session id.`;
    }

    if (rulesItems.length > 0) {
        prompt += '\n\n### System Rules\n以下是你必须遵守的规则：\n';
        for (const rule of rulesItems) {
            prompt += `\n# Rule: ${rule.key}\n\n${rule.content}\n`;
        }
    }

    return prompt;
}

/**
 * @description Get rules content as structured context items
 * @param workspaceUri - Workspace root URI (must be file:// scheme)
 * @param allowedUris - List of allowed URIs for security
 * @param activeRules - Optional list of rule filenames to include. If undefined, all rules are included.
 * @param context - Optional context object for macro definitions
 * @returns Array of context items representing rules
 */
export async function getRulesContext(
    workspaceUri: vscode.Uri, 
    allowedUris: string[],
    activeRules?: string[],
    context?: Record<string, any>
): Promise<ContextItem[]> {
    if (workspaceUri.scheme !== 'file') {
        console.warn('Rules context requires a file:// workspace URI');
        return [];
    }
    const rulesDir = vscode.Uri.joinPath(workspaceUri, '.mutsumi', 'rules');
    const items: ContextItem[] = [];

    try {
        const ruleFiles = await collectRulesRecursively(rulesDir, rulesDir);
        ruleFiles.sort((a, b) => a.name.localeCompare(b.name));

        for (const { name, uri } of ruleFiles) {
            if (activeRules && !activeRules.includes(name)) {
                continue;
            }

            const content = await vscode.workspace.fs.readFile(uri);
            const decodedContent = new TextDecoder().decode(content);

            // Use TemplateEngine.render with INLINE mode to expand rules.
            // Tool pre-execution inside the template enters the pre-execution
            // plane by itself and runs without approval.
            const { renderedText: expandedContent } = await TemplateEngine.render(
                decodedContent,
                context || {},
                workspaceUri,
                allowedUris,
                'INLINE'
            );

            items.push({
                type: 'rule',
                key: name,
                content: expandedContent
            });
        }
    } catch (e) {
        console.error('Error reading rules', e);
    }

    return items;
}
