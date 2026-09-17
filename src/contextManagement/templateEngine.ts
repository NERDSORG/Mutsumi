import * as vscode from 'vscode';
import * as pp from 'preprocess';
import {
    extractBracketContent,
    parseReference,
    readResource,
    executeToolCall,
    extractMacroDefinitions
} from './utils';
import { ContextItem } from '../types';

/**
 * Template Engine Class
 * @description A unified template engine handling both file references
 * @[path] and tool calls @[tool{args}] in a single pass
 */
export class TemplateEngine {
    /**
     * @description Render template content with full pipeline
     * @param content - Template text to process
     * @param context - Macro context object
     * @param rootUri - Workspace root URI
     * @param allowedUris - Allowed URIs for security
     * @param mode - Parse mode (INLINE or APPEND)
     * @param processingStack - Stack of URIs being processed (for circular reference detection)
     * @returns {Promise<{ renderedText: string; collectedItems: ContextItem[] }>}
     */
    static async render(
        content: string,
        context: Record<string, any>,
        rootUri: vscode.Uri,
        allowedUris: string[],
        mode: 'INLINE' | 'APPEND' = 'INLINE',
        processingStack: string[] = []
    ): Promise<{ renderedText: string; collectedItems: ContextItem[] }> {
        const collectedItems: ContextItem[] = [];
        
        // Step 1: Extract and merge macros from the content
        const localMacros = extractMacroDefinitions(content);
        const effectiveContext = { ...context, ...localMacros };

        // Step 2: Single pass processing of both file refs and tool calls
        const renderedText = await this.processContent(
            content,
            effectiveContext,
            rootUri,
            allowedUris,
            mode,
            collectedItems,
            processingStack
        );

        return { renderedText, collectedItems };
    }

    /**
     * @description Process content in a single pass, handling both file refs and tool calls
     */
    private static async processContent(
        text: string,
        context: Record<string, any>,
        rootUri: vscode.Uri,
        allowedUris: string[],
        mode: 'INLINE' | 'APPEND',
        collectedItems: ContextItem[],
        processingStack: string[] = []
    ): Promise<string> {
        if (!text.includes('@[')) return text;

        let result = '';
        let lastIndex = 0;
        let i = 0;

        while (i < text.length) {
            const start = text.indexOf('@[', i);
            if (start === -1) {
                result += text.substring(lastIndex);
                break;
            }

            const { content: bracketContent, endIdx } = extractBracketContent(text, start + 2);
            if (endIdx === -1) {
                i = start + 2;
                continue;
            }

            result += text.substring(lastIndex, start);

            // Determine if this is a tool call or file ref based on presence of { }
            const braceStart = bracketContent.indexOf('{');
            const braceEnd = bracketContent.lastIndexOf('}');

            if (braceStart !== -1 && braceEnd !== -1 && braceStart < braceEnd) {
                // This is a tool call
                result += await this.processToolCall(
                    bracketContent,
                    context,
                    allowedUris,
                    mode,
                    collectedItems,
                    text.substring(start, endIdx + 1)
                );
            } else {
                // This is a file reference
                result += await this.processFileReference(
                    bracketContent,
                    context,
                    rootUri,
                    allowedUris,
                    mode,
                    collectedItems,
                    text.substring(start, endIdx + 1),
                    processingStack
                );
            }

            lastIndex = endIdx + 1;
            i = lastIndex;
        }

        return result;
    }

    /**
     * @description Process a single tool call @[tool{args}]
     */
    private static async processToolCall(
        content: string,
        context: Record<string, any>,
        allowedUris: string[],
        mode: 'INLINE' | 'APPEND',
        collectedItems: ContextItem[],
        originalTag: string
    ): Promise<string> {
        try {
            // Preprocess the content to handle macros in arguments
            const processedContent = pp.preprocess(content, context, { type: 'html' });
            
            const braceStart = processedContent.indexOf('{');
            const braceEnd = processedContent.lastIndexOf('}');
            
            if (braceStart === -1 || braceEnd === -1 || braceStart >= braceEnd) {
                return originalTag;
            }

            const toolName = processedContent.substring(0, braceStart).trim();
            const jsonArgs = processedContent.substring(braceStart, braceEnd + 1);
            const args = JSON.parse(jsonArgs);
            
            const output = await executeToolCall(toolName, args, allowedUris);

            if (mode === 'INLINE') {
                return output;
            } else {
                collectedItems.push({
                    type: 'tool',
                    key: toolName,
                    content: output,
                    metadata: args
                });
                return originalTag;
            }
        } catch (e: any) {
            const errorMessage = `> Error executing tool: ${e.message}`;
            if (mode === 'INLINE') {
                return errorMessage;
            } else {
                // Try to extract tool name for the error item
                const braceStart = content.indexOf('{');
                const toolName = braceStart !== -1 ? content.substring(0, braceStart).trim() : 'unknown';
                collectedItems.push({
                    type: 'tool',
                    key: toolName,
                    content: errorMessage,
                    metadata: content
                });
                return originalTag;
            }
        }
    }

    /**
     * @description Process a single file reference @[path]
     */
    private static async processFileReference(
        content: string,
        context: Record<string, any>,
        rootUri: vscode.Uri,
        allowedUris: string[],
        mode: 'INLINE' | 'APPEND',
        collectedItems: ContextItem[],
        originalTag: string,
        processingStack: string[] = []
    ): Promise<string> {
        try {
            // Preprocess the path to handle macros
            const processedPath = pp.preprocess(content, context, { type: 'html' });
            const { uri, startLine, endLine } = parseReference(processedPath, rootUri);

            // Check for circular references
            const uriKey = uri.toString();
            if (processingStack.includes(uriKey)) {
                const errorMessage = `> Error: Circular reference detected: ${processingStack.join(' -> ')} -> ${uriKey}`;
                if (mode === 'INLINE') {
                    return errorMessage;
                } else {
                    collectedItems.push({
                        type: 'file',
                        key: processedPath,
                        content: errorMessage
                    });
                    return originalTag;
                }
            }
            
            // Read file content
            const rawContent = await readResource(uri, startLine, endLine);

            // Determine preprocess type based on file extension
            const ext = uri.path.split('.').pop()?.toLowerCase();
            let ppType = 'js';
            if (ext && ['md', 'markdown', 'html', 'xml', 'txt'].includes(ext)) {
                ppType = 'html';
            } else if (ext && ['sh', 'yaml', 'yml', 'py', 'rb', 'pl'].includes(ext)) {
                ppType = 'shell';
            }

            // Preprocess macros in the file content
            const preprocessedContent = pp.preprocess(rawContent, context, { type: ppType });

            // Recursively render the content (always INLINE for nested content)
            const { renderedText: finalContent } = await this.render(
                preprocessedContent,
                context,
                rootUri,
                allowedUris,
                'INLINE',
                [...processingStack, uriKey]
            );

            if (mode === 'INLINE') {
                return finalContent;
            } else {
                collectedItems.push({
                    type: 'file',
                    key: processedPath,
                    content: finalContent
                });
                return originalTag;
            }
        } catch (e: any) {
            // If file not found (ENOENT) in INLINE mode, return original tag unchanged
            if (e.code === "FileNotFound") {
                return originalTag;
            }

            const errorMessage = `> Error including file: ${e.message}`;
            if (mode === 'INLINE') {
                return errorMessage;
            } else {
                // Use original content as key for error item
                collectedItems.push({
                    type: 'file',
                    key: content,
                    content: errorMessage
                });
                return originalTag;
            }
        }
    }
}
