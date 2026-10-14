import { ITool, ToolContext } from '../interface';
import { simplifyUri } from '../utils';
import { getBrief, withBrief } from '../brief';
import { handleEdit } from '../edit_file';

export const createOrReplaceTool: ITool = {
    name: 'write',
    definition: withBrief({
        name: 'write',
        description: 'Replace the full content of a file. Shows a diff view to the user for confirmation. If the file does not exist, creates a new file.',
        parameters: {
            type: 'object',
            properties: { 
                uri: { type: 'string' }, 
                new_content: { type: 'string' } 
            },
            required: ['uri', 'new_content']
        }
    }),
    execute: async (args: any, context: ToolContext) => {
        if (!args.uri || args.new_content === undefined) {
            return 'Error: Missing arguments (uri, new_content).';
        }
        return handleEdit(args.uri, args.new_content, context, 'write');
    },
    prettyPrint: (args: any) => {
        const brief = getBrief(args);
        const suri = simplifyUri(args.uri);
        return brief
            ? `$(new-file) Write ${suri}: ${brief}`
            : `$(new-file) Write ${suri}`;
    },
    argsToCodeBlock: ['new_content'],
    codeBlockFilePaths: ['uri']
};