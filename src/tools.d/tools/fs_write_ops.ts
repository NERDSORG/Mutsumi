import { ITool, ToolContext } from '../interface';
import { resolveUri, checkAccess } from '../utils';
import { requestApproval } from '../permission';
import { t } from '../../i18n';
import * as vscode from 'vscode';

export const mkdirTool: ITool = {
    name: 'mkdir',
    definition: {
        name: 'mkdir',
        description: 'Create a directory recursively (like `mkdir -p`). Requires User Approval.',
        parameters: {
            type: 'object',
            properties: {
                uri: { type: 'string', description: 'The directory path to create.' }
            },
            required: ['uri']
        }
    },
    execute: async (args: any, context: ToolContext) => {
        try {
            const uriInput = args.uri;
            if (!uriInput) return 'Error: Missing "uri" argument.';
            
            const uri = resolveUri(uriInput);

            // Access Control
            if (!checkAccess(uri, context.allowedUris)) {
                return `Access Denied: Agent is not allowed to write to ${uri.toString()}`;
            }

            // Approval
            const rejectionMsg = await requestApproval(t('approval.mkdir.action'), uriInput, context, 'mkdir');
            if (rejectionMsg !== null) {
                return rejectionMsg;
            }

            await vscode.workspace.fs.createDirectory(uri);
            
            return `Directory created: ${uriInput}`;
        } catch (err: any) {
            return `Error creating directory: ${err.message}`;
        }
    },
    prettyPrint: (args: any) => {
        return `📂 Mutsumi created directory ${args.uri || '(unknown path)'}`;
    }
};
