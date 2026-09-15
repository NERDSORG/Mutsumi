/**
 * @fileoverview Utility functions for the Mutsumi VSCode extension.
 * @module utils
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { ProviderType } from '@moonshot-ai/kosong';
import {
    Provider,
    ModelSelection,
    DEFAULT_PROVIDERS,
    DEFAULT_MODELS,
    DEFAULT_MODEL_SELECTION,
    VALID_PROVIDER_TYPES
} from './types';

/**
 * Resolved model selection: the canonical { model, provider } pair plus the
 * matched provider entry from the same single provider lookup.
 * @interface ResolvedModelSelection
 */
export interface ResolvedModelSelection extends ModelSelection {
    /** The provider entry that matched the canonical provider name */
    providerEntry: Provider;
}

/**
 * Validates and canonicalizes a model selection.
 * @description Trims names, verifies the provider exists and declares a valid
 * wire type, and verifies the provider declares the requested model. Returns a
 * canonical { model, provider }
 * pair together with the matched provider entry. Legacy string values and
 * incomplete objects are rejected.
 * @param {unknown} selection - The value to validate
 * @returns {ResolvedModelSelection} Canonical model/provider pair plus the matched provider entry
 * @throws {Error} If selection is not a complete valid pair or provider/model is missing
 */
export function resolveModelSelection(selection: unknown): ResolvedModelSelection {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
        throw new Error('Model selection must be an object with "model" and "provider"');
    }

    const s = selection as Record<string, unknown>;
    if (typeof s.model !== 'string' || typeof s.provider !== 'string') {
        throw new Error('Model selection must have string "model" and "provider"');
    }

    const model = s.model.trim();
    const provider = s.provider.trim();

    if (!model) {
        throw new Error('Model selection "model" must be a non-empty string');
    }
    if (!provider) {
        throw new Error('Model selection "provider" must be a non-empty string');
    }

    const config = vscode.workspace.getConfiguration('mutsumi');
    let providers = config.get<Provider[]>('providers', []);
    const models = getModelsConfig();

    if (providers.length === 0) {
        providers = DEFAULT_PROVIDERS;
    }

    // Check for duplicate provider names after trimming
    const seenNames = new Set<string>();
    for (const p of providers) {
        const trimmedName = p.name.trim();
        if (seenNames.has(trimmedName)) {
            throw new Error(`Duplicate provider name after normalization: "${trimmedName}"`);
        }
        seenNames.add(trimmedName);
    }

    // Provider must exist by explicit name
    const matchedProvider = providers.find(p => p.name.trim() === provider);
    if (!matchedProvider) {
        throw new Error(`Provider "${provider}" not found`);
    }

    // Provider entry must declare a valid wire type (settings JSON is untrusted)
    if (!VALID_PROVIDER_TYPES.includes(matchedProvider.type)) {
        throw new Error(
            `Provider "${provider}" has missing or invalid "type": ${JSON.stringify(matchedProvider.type)}. ` +
            `Valid types: ${VALID_PROVIDER_TYPES.join(', ')}`
        );
    }

    // Provider must declare the requested model
    let providerDeclaresModel = false;
    for (const [pName, modelList] of Object.entries(models)) {
        if (pName.trim() === provider && Array.isArray(modelList) && modelList.includes(model)) {
            providerDeclaresModel = true;
            break;
        }
    }
    if (!providerDeclaresModel) {
        throw new Error(`Model "${model}" is not declared by provider "${provider}"`);
    }

    return { model, provider, providerEntry: matchedProvider };
}

/**
 * Gets the provider credentials for a given model/provider pair.
 * @description Resolves and validates the pair through resolveModelSelection,
 * then reads the API key, base URL and wire type from the matched provider
 * entry returned by that single lookup. Provider is required; no first-match
 * fallback is performed.
 * @param {string} modelName - The model identifier
 * @param {string} providerName - The provider name (required)
 * @returns {{ apiKey: string; baseUrl: string; providerType: ProviderType }} Provider credentials with camelCase property names
 * @throws {Error} If provider not found, model not declared, or required fields are empty
 */
export function getModelCredentials(modelName: string, providerName: string): { apiKey: string; baseUrl: string; providerType: ProviderType } {
    const { provider, providerEntry } = resolveModelSelection({ model: modelName, provider: providerName });

    const baseUrl = providerEntry.baseurl.trim();
    if (!baseUrl) {
        throw new Error(`Provider "${provider}" has empty baseurl`);
    }

    const apiKey = providerEntry.api_key;
    if (!apiKey) {
        throw new Error(`Provider "${provider}" has empty api_key`);
    }

    return { apiKey, baseUrl, providerType: providerEntry.type };
}

/**
 * Gets the models configuration from VS Code settings.
 * @description Returns user-configured models if available, otherwise returns
 * the built-in default models. The configuration maps provider names to arrays
 * of model identifiers supported by that provider.
 * @returns {Record<string, string[]>} Models configuration (provider name -> model identifiers)
 */
export function getModelsConfig(): Record<string, string[]> {
    const config = vscode.workspace.getConfiguration('mutsumi');
    const models = config.get<Record<string, string[]>>('models', {});

    if (Object.keys(models).length > 0) {
        return models;
    }

    return DEFAULT_MODELS;
}

/**
 * Gets the list of all available model names from the models configuration.
 * @description Flattens the provider-to-models mapping and returns unique model names.
 * @returns {string[]} Array of unique model names
 */
export function getAvailableModelNames(): string[] {
    const models = getModelsConfig();
    return [...new Set(Object.values(models).flat())];
}

/**
 * Resolves the default model selection from VS Code settings.
 * @description Reads mutsumi.defaultModel and validates it through the gate.
 * Falls back to the built-in default pair when unset.
 * @returns {ModelSelection} Validated default model/provider pair
 * @throws {Error} If the configured value is invalid
 */
export function getDefaultModelSelection(): ModelSelection {
    const config = vscode.workspace.getConfiguration('mutsumi');
    const defaultModel = config.get<ModelSelection>('defaultModel');
    if (defaultModel === undefined || defaultModel === null) {
        return DEFAULT_MODEL_SELECTION;
    }
    return resolveModelSelection(defaultModel);
}

/**
 * Resolves the title generator model selection from VS Code settings.
 * @description Reads mutsumi.titleGeneratorModel and validates it through the
 * gate. Returns undefined when unset.
 * @returns {ModelSelection | undefined} Validated title model/provider pair, or undefined
 * @throws {Error} If the configured value is invalid
 */
export function getTitleModelSelection(): ModelSelection | undefined {
    const config = vscode.workspace.getConfiguration('mutsumi');
    const titleModel = config.get<ModelSelection>('titleGeneratorModel');
    if (titleModel === undefined || titleModel === null) {
        return undefined;
    }
    return resolveModelSelection(titleModel);
}

/**
 * Resolves the conversation compression model selection from VS Code settings.
 * @description Reads mutsumi.compressModel and validates it through the gate.
 * Falls back to titleGeneratorModel, then to the default model selection.
 * @returns {ModelSelection} Validated compress model/provider pair
 * @throws {Error} If no valid selection can be resolved
 */
export function getCompressModelSelection(): ModelSelection {
    const config = vscode.workspace.getConfiguration('mutsumi');
    const compressModel = config.get<ModelSelection>('compressModel');
    if (compressModel !== undefined && compressModel !== null) {
        return resolveModelSelection(compressModel);
    }

    const titleModel = getTitleModelSelection();
    if (titleModel) {
        return titleModel;
    }

    return getDefaultModelSelection();
}

/**
 * Sanitizes a string to be safe for use as a file name.
 * @description Removes or replaces characters that are invalid in file systems
 * and normalizes whitespace.
 * @param {string} name - Original name to sanitize
 * @returns {string} Sanitized name safe for file system use
 */
export function sanitizeFileName(name: string): string {
    return name
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Ensures a file name is unique by appending a numeric suffix if needed.
 * @description Checks against existing names and generates a unique variant
 * by adding "-1", "-2", etc. as needed.
 * @param {string} baseName - Base file name without extension
 * @param {string[]} existingNames - Array of existing file names to check against
 * @returns {string} Unique file name
 */
export function ensureUniqueFileName(baseName: string, existingNames: string[]): string {
    if (!existingNames.includes(baseName)) {
        return baseName;
    }

    let counter = 1;
    let newName = `${baseName}-${counter}`;

    while (existingNames.includes(newName)) {
        counter++;
        newName = `${baseName}-${counter}`;
    }

    return newName;
}

/**
 * Get language identifier for Markdown code block based on file extension
 */
export function getLanguageIdentifier(ext: string): string {
    const langMap: Record<string, string> = {
        'ts': 'typescript',
        'tsx': 'tsx',
        'js': 'javascript',
        'jsx': 'jsx',
        'py': 'python',
        'rb': 'ruby',
        'go': 'go',
        'rs': 'rust',
        'java': 'java',
        'kt': 'kotlin',
        'swift': 'swift',
        'c': 'c',
        'cpp': 'cpp',
        'cc': 'cpp',
        'h': 'c',
        'hpp': 'cpp',
        'cs': 'csharp',
        'php': 'php',
        'html': 'html',
        'htm': 'html',
        'css': 'css',
        'scss': 'scss',
        'sass': 'sass',
        'less': 'less',
        'json': 'json',
        'xml': 'xml',
        'yaml': 'yaml',
        'yml': 'yaml',
        'toml': 'toml',
        'md': 'markdown',
        'sh': 'bash',
        'bash': 'bash',
        'zsh': 'zsh',
        'fish': 'fish',
        'ps1': 'powershell',
        'sql': 'sql',
        'dockerfile': 'dockerfile',
        'makefile': 'makefile',
        'vue': 'vue',
        'svelte': 'svelte',
        'astro': 'astro'
    };
    return langMap[ext.toLowerCase()] || '';
}

/**
 * Resolves the better-sqlite3 native binding path for the current platform/arch.
 * @description Returns the absolute path to the bundled `.node` binary when
 * running inside a universal VSIX. If the current platform is unsupported or
 * the binary does not exist, returns `undefined` so better-sqlite3 falls back
 * to its default binding resolution (preserving platform-specific package behavior).
 * @param {string} extensionPath - The extension root path (from `vscode.ExtensionContext.extensionPath`)
 * @returns {string | undefined} Absolute path to the native binary, or undefined to fall back
 */
export function getBetterSqlite3NativeBinding(extensionPath: string): string | undefined {
    const supportedPlatforms = [
        'win32-x64',
        'darwin-arm64',
        'linux-x64',
        'linux-arm64',
    ] as const;

    type SupportedPlatform = typeof supportedPlatforms[number];

    const filenameMap: Record<SupportedPlatform, string> = {
        'win32-x64': 'better_sqlite3-win32-x64.node',
        'darwin-arm64': 'better_sqlite3-darwin-arm64.node',
        'linux-x64': 'better_sqlite3-linux-x64.node',
        'linux-arm64': 'better_sqlite3-linux-arm64.node',
    };

    const platformKey = `${process.platform}-${process.arch}` as SupportedPlatform;
    if (!supportedPlatforms.includes(platformKey)) {
        return undefined;
    }

    const filename = filenameMap[platformKey];
    const nativePath = path.join(extensionPath, 'native', 'better-sqlite3', filename);

    if (!fs.existsSync(nativePath)) {
        return undefined;
    }

    return nativePath;
}
