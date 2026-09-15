/**
 * @fileoverview Service for generating structural code outlines using Tree-sitter.
 * Provides functionality to parse source files and extract class/function/method definitions.
 * @module service
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import Parser from 'web-tree-sitter';
import { EXT_TO_LANG, LANGUAGE_CONFIGS, LanguageConfig } from './definitions';

/**
 * Represents a node in the code outline tree.
 * @interface OutlineNode
 */
export interface OutlineNode {
    /** The type of the outline node (e.g., 'Class', 'Function', 'Method') */
    type: string;
    /** The name/identifier of the node */
    name: string;
    /** The full namespace path (e.g., 'MyClass.NestedClass.myMethod') */
    fullPath: string;
    /** Zero-based starting line number */
    startLine: number;
    /** Zero-based ending line number */
    endLine: number;
    /** Child nodes contained within this node */
    children: OutlineNode[];
}

/**
 * Singleton service for parsing code files and generating structural outlines.
 * Uses Tree-sitter parsers to extract definitions like classes, functions, and methods.
 * @class CodebaseService
 * @example
 * const service = CodebaseService.getInstance();
 * await service.initialize(context);
 * const outline = await service.getFileOutline(uri);
 */
export class CodebaseService {
    private static instance: CodebaseService;
    private parsers: Map<string, Parser> = new Map();
    private languages: Map<string, Parser.Language> = new Map();
    private initialized = false;
    private context?: vscode.ExtensionContext;

    /**
     * In-memory cache for file outlines: uri string -> array of root outline nodes.
     * @private
     */
    private outlineCache: Map<string, OutlineNode[]> = new Map();

    /**
     * Private constructor to enforce singleton pattern.
     * @private
     */
    private constructor() {}

    /**
     * Gets the singleton instance of CodebaseService.
     * Creates the instance if it doesn't exist.
     * @returns {CodebaseService} The singleton instance
     * @example
     * const service = CodebaseService.getInstance();
     */
    public static getInstance(): CodebaseService {
        if (!CodebaseService.instance) {
            CodebaseService.instance = new CodebaseService();
        }
        return CodebaseService.instance;
    }

    /**
     * Initializes the Tree-sitter parser library.
     * Must be called before using other methods of this service.
     * @param {vscode.ExtensionContext} context - The VSCode extension context
     * @returns {Promise<void>}
     * @throws {Error} If initialization fails
     * @example
     * await service.initialize(context);
     */
    public async initialize(context: vscode.ExtensionContext): Promise<void> {
        if (this.initialized) return;
        this.context = context;

        try {
            await Parser.init();
            console.log('Tree-sitter initialized');
            this.initialized = true;
        } catch (e) {
            console.error('Failed to initialize tree-sitter:', e);
        }
    }

    /**
     * Loads and returns the Tree-sitter Language object for a given language ID.
     * Languages are cached after first load.
     * @param {string} langId - The language identifier (e.g., 'typescript', 'python')
     * @returns {Promise<Parser.Language | null>} The language object or null if loading fails
     * @private
     */
    private async getLanguage(langId: string): Promise<Parser.Language | null> {
        if (this.languages.has(langId)) return this.languages.get(langId)!;
        if (!this.context) return null;

        const config = LANGUAGE_CONFIGS[langId];
        if (!config) return null;

        const wasmPath = path.join(this.context.extensionPath, 'assets', 'tree-sitter', config.wasmName);

        try {
            if (!fs.existsSync(wasmPath)) {
                console.warn(`WASM file not found at ${wasmPath}`);
                return null;
            }
            const lang = await Parser.Language.load(wasmPath);
            this.languages.set(langId, lang);
            return lang;
        } catch (e) {
            console.error(`Failed to load language ${langId} from ${wasmPath}:`, e);
            return null;
        }
    }

    /**
     * Gets or creates a Tree-sitter parser for the specified language.
     * Parsers are cached after first creation.
     * @param {string} langId - The language identifier
     * @returns {Promise<Parser | null>} The parser instance or null if creation fails
     * @private
     */
    private async getParser(langId: string): Promise<Parser | null> {
        if (this.parsers.has(langId)) return this.parsers.get(langId)!;

        const lang = await this.getLanguage(langId);
        if (!lang) return null;

        const parser = new Parser();
        parser.setLanguage(lang);
        this.parsers.set(langId, parser);
        return parser;
    }

    /**
     * Generates a structural outline of a source file.
     * Parses the file content and extracts definitions like classes, functions, methods, etc.
     * Results are cached for subsequent calls.
     * @param {vscode.Uri} uri - The URI of the file to analyze
     * @param {string} [content] - Optional file content. If not provided, the file will be read from disk
     * @returns {Promise<OutlineNode[] | null>} Array of root outline nodes or null if parsing fails
     * @example
     * const outline = await service.getFileOutline(vscode.Uri.file('/path/to/file.ts'));
     * console.log(service.formatOutline(outline));
     */
    public async getFileOutline(uri: vscode.Uri, content?: string): Promise<OutlineNode[] | null> {
        if (!this.initialized) return null;

        const ext = path.extname(uri.path).toLowerCase();
        const langId = EXT_TO_LANG[ext];
        if (!langId) return null;

        const parser = await this.getParser(langId);
        if (!parser) return null;

        let fileContent = content;
        if (fileContent === undefined) {
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                fileContent = new TextDecoder().decode(bytes);
            } catch (e) {
                return null;
            }
        }

        try {
            const tree = parser.parse(fileContent);
            const config = LANGUAGE_CONFIGS[langId];
            const nodes = this.extractNodes(tree.rootNode, config, fileContent);
            tree.delete();

            this.outlineCache.set(uri.toString(), nodes);

            return nodes;
        } catch (e) {
            console.error(`Error parsing ${uri.toString()}:`, e);
            return null;
        }
    }

    /**
     * Recursively extracts outline nodes from a Tree-sitter syntax tree.
     * @param {Parser.SyntaxNode} node - The root node to start extraction from
     * @param {LanguageConfig} config - The language configuration for node type mapping
     * @param {string} source - The source code text
     * @returns {OutlineNode[]} Array of extracted outline nodes
     * @private
     */
    private extractNodes(node: Parser.SyntaxNode, config: LanguageConfig, source: string): OutlineNode[] {
        /**
         * Filters out anonymous nodes that have no named descendants.
         * Recursively processes children first (bottom-up), then decides if current node should be kept.
         * @param {OutlineNode[]} nodes - The nodes to filter
         * @returns {OutlineNode[]} Filtered nodes
         */
        const filterAnonymousNodes = (nodes: OutlineNode[]): OutlineNode[] => {
            const result: OutlineNode[] = [];
            for (const node of nodes) {
                // Recursively filter children first (bottom-up)
                node.children = filterAnonymousNodes(node.children);
                
                // Keep the node if:
                // 1. It's not anonymous (has a real name), OR
                // 2. It has children after filtering (meaning it has named descendants)
                if (node.name !== '<anonymous>' || node.children.length > 0) {
                    result.push(node);
                }
                // Anonymous nodes with no children are pruned (no named descendants)
            }
            return result;
        };

        /**
         * Recursively collects outline nodes from the syntax tree.
         * @param {Parser.SyntaxNode} currentNode - The current node being processed
         * @param {string} [parentPath=''] - The full path of parent node
         * @returns {OutlineNode[]} Array of outline nodes found in this subtree
         */
        const collect = (currentNode: Parser.SyntaxNode, parentPath: string = ''): OutlineNode[] => {
            const nodes: OutlineNode[] = [];

            for (let i = 0; i < currentNode.childCount; i++) {
                const child = currentNode.child(i);
                if (!child) continue;

                const defType = config.definitions[child.type];

                if (defType) {
                    const name = this.getNodeName(child, source);
                    const nodeName = name || '<anonymous>';
                    const fullPath = parentPath ? `${parentPath}.${nodeName}` : nodeName;
                    const newNode: OutlineNode = {
                        type: defType,
                        name: nodeName,
                        fullPath: fullPath,
                        startLine: child.startPosition.row,
                        endLine: child.endPosition.row,
                        children: []
                    };

                    if (config.containers.has(child.type)) {
                        newNode.children = collect(child, fullPath);
                    }

                    nodes.push(newNode);
                } else {
                    if (child.childCount > 0) {
                        const childNodes = collect(child, parentPath);
                        nodes.push(...childNodes);
                    }
                }
            }
            return nodes;
        };

        const collectedNodes = collect(node);
        return filterAnonymousNodes(collectedNodes);
    }

    /**
     * Extracts the identifier/name from a syntax node.
     * Tries multiple strategies: field name lookup, identifier child lookup.
     * @param {Parser.SyntaxNode} node - The syntax node to extract name from
     * @param {string} source - The source code text
     * @returns {string | null} The extracted name or null if not found
     * @private
     */
    private getNodeName(node: Parser.SyntaxNode, source: string): string | null {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
            return nameNode.text;
        }

        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child && (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'name')) {
                return child.text;
            }
        }

        return null;
    }

    /**
     * Formats outline nodes into a human-readable string representation.
     * Useful for debugging and displaying the outline structure.
     * @param {OutlineNode[]} nodes - The outline nodes to format
     * @param {number} [depth=0] - The current indentation depth (for recursion)
     * @returns {string} The formatted string representation
     * @example
     * const outline = await service.getFileOutline(uri);
     * const formatted = service.formatOutline(outline);
     * console.log(formatted);
     * // Output:
     * // - Class MyClass
     * //   - Method myMethod
     * // - Function myFunction
     */
    public formatOutline(nodes: OutlineNode[], depth = 0): string {
        let output = '';
        const indent = '  '.repeat(depth);

        for (const node of nodes) {
            output += `${indent}- ${node.type} ${node.fullPath}\n`;
            if (node.children.length > 0) {
                output += this.formatOutline(node.children, depth + 1);
            }
        }
        return output;
    }
}
