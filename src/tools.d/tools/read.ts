import { ITool, ToolContext } from '../interface';
import { resolveUri } from '../utils';
import * as vscode from 'vscode';
import { TextDecoder } from 'util';

export const readFileTool: ITool = {
    name: 'read',
    definition: {
        name: 'read',
        description: 'Read the contents of a file at the given URI. Pass optional "range" to read only a specific line range.',
        parameters: {
            type: 'object',
            properties: {
                uri: { type: 'string', description: 'The file URI or path to read.' },
                range: {
                    type: 'array',
                    items: { type: 'integer' },
                    description: 'Optional line range [start, end] (1-based, inclusive). When provided, only those lines are returned, each prefixed with its line number.'
                }
            },
            required: ['uri']
        }
    },
    execute: async (args: any, context: ToolContext) => {
        try {
            const uriInput = args.uri;
            if (!uriInput) return 'Error: Missing "uri" argument.';

            const uri = resolveUri(uriInput);

            if (args.range === undefined || args.range === null) {
                const bytes = await vscode.workspace.fs.readFile(uri);
                return new TextDecoder().decode(bytes);
            }

            const range = args.range;
            if (!Array.isArray(range) || range.length !== 2 ||
                typeof range[0] !== 'number' || typeof range[1] !== 'number') {
                return 'Error: "range" must be [start, end] (1-based, inclusive line numbers).';
            }

            const doc = await vscode.workspace.openTextDocument(uri);
            const lineCount = doc.lineCount;

            const start = Math.max(0, Math.floor(range[0]) - 1);
            const end = Math.min(lineCount - 1, Math.floor(range[1]) - 1);

            if (start > end) return '(Range invalid or out of bounds)';

            const resultLines: string[] = [];
            for (let i = start; i <= end; i++) {
                resultLines.push(`${i + 1}: ${doc.lineAt(i).text}`);
            }

            return resultLines.join('\n');
        } catch (err: any) {
            return `Error reading file: ${err.message}`;
        }
    },
    prettyPrint: (args: any) => {
        if (Array.isArray(args.range)) {
            return `📖 Mutsumi read lines ${args.range[0] ?? '?'}-${args.range[1] ?? '?'} of ${args.uri || '(unknown file)'}`;
        }
        return `📖 Mutsumi read ${args.uri || '(unknown file)'}`;
    }
};
