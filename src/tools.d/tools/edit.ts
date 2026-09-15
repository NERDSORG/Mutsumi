import { ITool, ToolContext } from '../interface';
import { resolveUri, checkAccess } from '../utils';
import { handleEdit } from '../edit_file';
import * as vscode from 'vscode';
import { TextDecoder } from 'util';

export const editFileSearchReplaceTool: ITool = {
    name: 'edit',
    definition: {
        name: 'edit',
        description: 'Replace parts of a file using search and replace. The search_replace parameter specifies the content to be replaced, and new_content specifies the replacement content.',
        parameters: {
            type: 'object',
            properties: { 
                uri: { type: 'string' }, 
                search_replace: { 
                    type: 'string',
                    description: 'The content to search for and replace in the file.'
                },
                new_content: {
                    type: 'string',
                    description: 'The new content to replace the search content with.'
                }
            },
            required: ['uri', 'search_replace', 'new_content']
        }
    },
    execute: async (args: any, context: ToolContext) => {
        if (!args.uri || args.search_replace === undefined || args.new_content === undefined) {
            return 'Error: Missing arguments (uri, search_replace, new_content).';
        }

        const uri = resolveUri(args.uri);
        if (!checkAccess(uri, context.allowedUris)) {
            return `Access Denied: Agent is not allowed to edit ${uri.toString()}`;
        }

        let originalContent = '';
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            originalContent = new TextDecoder().decode(bytes);
        } catch (e: any) {
            return `Error reading file: ${e.message}`;
        }

        const search = args.search_replace;
        const replace = args.new_content;

        // Normalize for line ending handling
        const normalize = (s: string) => s.replace(/\r\n/g, '\n');

        let newContent = originalContent;
        let applied = false;

        if (originalContent.includes(search)) {
            newContent = originalContent.replace(search, replace);
            applied = true;
        } else {
            // Try normalized version (handle different line endings)
            const normContent = normalize(originalContent);
            const normSearch = normalize(search);
            
            if (normContent.includes(normSearch)) {
                newContent = normContent.replace(normSearch, replace);
                applied = true;
            }
        }

        if (!applied) {
            return `Error: Could not find the search content in file.\n\nSearch content:\n${search.substring(0, 500)}${search.length > 500 ? '...' : ''}`;
        }

        // Delegate to core edit handler
        return handleEdit(args.uri, newContent, context, 'edit');
    },
    prettyPrint: (args: any) => {
        return `✏️ Mutsumi edited ${args.uri || '(unknown file)'}`;
    },
    argsToCodeBlock: ['search_replace', 'new_content'],
    codeBlockFilePaths: ['uri', 'uri']
};
