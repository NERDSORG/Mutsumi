import { ITool, ToolContext } from '../interface';
import * as vscode from 'vscode';
import { RagService } from '../../codebase/rag/service';

/**
 * Codebase Query Tool - Natural language semantic search across the codebase
 * 
 * This tool should be used when the user asks questions about:
 * - Finding code by meaning/concept (not by exact filename)
 * - "查找...相关的代码"
 * - "代码库中哪里实现了..."
 * - "哪些文件包含...功能"
 * - "展示...的代码"
 * 
 * DO NOT use this for:
 * - Exact file path lookups (use read)
 * - Directory listings (use glob)
 * - Text grepping (use grep)
 */
export const queryCodebaseTool: ITool = {
    name: 'query_codebase',
    definition: {
        name: 'query_codebase',
        description: 'Query the codebase using natural language to find semantically relevant code. This is the PRIMARY tool for answering questions like "what code does X", "where is Y implemented", "find code related to Z", or "which files contain...". Uses AI-powered semantic search to understand concepts, not just match text.',
        parameters: {
            type: 'object',
            properties: {
                question: {
                    type: 'string',
                    description: 'Natural language question about the codebase. Examples: "how is file saving implemented", "where are errors handled", "find authentication code", "哪些文件处理用户输入", "修复了什么的代码在哪里"'
                },
                max_results: {
                    type: 'number',
                    description: 'Maximum number of code chunks to return (default: 10, max: 50)',
                    default: 10
                }
            },
            required: ['question']
        }
    },
    execute: async (args: any, context: ToolContext) => {
        try {
            const { question, max_results } = args;

            if (!question || typeof question !== 'string') {
                return 'Error: Missing or invalid "question" argument. Please provide a natural language question about the codebase.';
            }

            // Validate and normalize max_results
            let maxResults = 10;
            if (max_results !== undefined) {
                maxResults = Math.max(1, Math.min(50, Math.floor(Number(max_results))));
            }

            // Get all workspaces
            const workspaces = vscode.workspace.workspaceFolders;
            if (!workspaces || workspaces.length === 0) {
                return 'Error: No workspace folders are currently open.';
            }

            // Get RagService instance
            let ragService: RagService;
            try {
                ragService = await RagService.getInstance();
            } catch (err: any) {
                return `Error: Codebase query service is not initialized. ${err.message}`;
            }

            // Search across all workspaces
            const workspaceResults: Array<{
                workspace: string;
                results: Awaited<ReturnType<RagService['search']>>;
            }> = [];

            for (const ws of workspaces) {
                try {
                    const results = await ragService.search(ws.uri, question, maxResults);
                    workspaceResults.push({
                        workspace: ws.name,
                        results
                    });
                } catch (err: any) {
                    workspaceResults.push({
                        workspace: ws.name,
                        results: []
                    });
                }
            }

            // Build formatted output
            let output = `=== Codebase Query Results ===\n\n`;
            output += `Question: "${question}"\n`;
            output += `Workspaces searched: ${workspaces.length}\n`;

            let totalResults = 0;
            for (const { workspace, results } of workspaceResults) {
                output += `\n--- Workspace: ${workspace} ---\n\n`;

                if (results.length === 0) {
                    output += '(No relevant code found)\n';
                    continue;
                }

                totalResults += results.length;
                for (let i = 0; i < results.length; i++) {
                    const r = results[i];
                    // 与 embedding 格式一致：文件路径 - 命名空间路径
                    const fullPath = r.symbolName ? `${r.filePath} - ${r.symbolName}` : r.filePath;
                    output += `[${i + 1}] ${fullPath}\n`;
                    output += `    (lines ${r.startLine}-${r.endLine}, relevance: ${(1 - r.distance).toFixed(2)})\n`;
                    output += '```\n';
                    // 给 LLM 看的版本不截断，提供完整代码
                    output += r.text;
                    output += '\n```\n\n';
                }
            }

            output += `=== End of Results (${totalResults} total) ===\n`;
            return output;

        } catch (err: any) {
            return `Error querying codebase: ${err.message}`;
        }
    },
    prettyPrint: (args: any) => {
        return `🔍 Query codebase: "${args.question || '(unknown question)'}"`;
    }
};
