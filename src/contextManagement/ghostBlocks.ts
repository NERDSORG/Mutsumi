/**
 * @fileoverview Canonical structured ghost block operations.
 *
 * GhostBlock is the single source of truth for persisted per-cell context
 * snapshots. Markdown (<content_reference>) is produced only as a final
 * provider-facing projection. Untrusted persisted metadata must enter through
 * decodeGhostBlock(); invalid or absent values become null and are treated as
 * "no ghost block" rather than migrated.
 *
 * @module contextManagement/ghostBlocks
 */

import { ContextItem } from '../types';
import { getLanguageIdentifier } from '../utils';
import { GhostBlock, GhostFileEntry, GhostToolEntry } from './interfaces';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

const asVersion = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;

const asNullableString = (value: unknown): string | null | undefined =>
    value === null || typeof value === 'string' ? value : undefined;

/**
 * Decode one untrusted ghost file entry.
 * @param value - Raw metadata value
 * @returns A valid file entry, or null when the shape is not trustworthy
 */
function decodeGhostFileEntry(value: unknown): GhostFileEntry | null {
    if (!isRecord(value)) {
        return null;
    }
    const key = asString(value.key);
    const version = asVersion(value.version);
    const content = asNullableString(value.content);
    if (key === undefined || version === undefined || content === undefined) {
        return null;
    }
    return { key, version, content };
}

/**
 * Decode one untrusted ghost tool entry.
 * @param value - Raw metadata value
 * @returns A valid tool entry, or null when the shape is not trustworthy
 */
function decodeGhostToolEntry(value: unknown): GhostToolEntry | null {
    if (!isRecord(value)) {
        return null;
    }
    const key = asString(value.key);
    const argsText = asString(value.argsText);
    const content = asString(value.content);
    if (key === undefined || argsText === undefined || content === undefined) {
        return null;
    }
    return { key, argsText, content };
}

/**
 * Best-effort structural decode for untrusted persisted metadata.
 *
 * This is validation, not migration: it does not recognize legacy formats and
 * does not rewrite input. Any value that does not satisfy the current
 * GhostBlock shape is treated as absent.
 *
 * @param value - Raw metadata value read from a session file
 * @returns A normalized GhostBlock containing only known fields, or null when absent/invalid
 */
export function decodeGhostBlock(value: unknown): GhostBlock | null {
    if (!isRecord(value) || !Array.isArray(value.files) || !Array.isArray(value.tools)) {
        return null;
    }

    const files: GhostFileEntry[] = [];
    for (const item of value.files) {
        const file = decodeGhostFileEntry(item);
        if (!file) {
            return null;
        }
        files.push(file);
    }

    const tools: GhostToolEntry[] = [];
    for (const item of value.tools) {
        const tool = decodeGhostToolEntry(item);
        if (!tool) {
            return null;
        }
        tools.push(tool);
    }

    return { files, tools };
}

/**
 * Build the canonical structured ghost block from final display items.
 *
 * Input items must already reflect history.ts differential decisions: file
 * items marked metadata.isReference are stored as reference-only entries with
 * content: null. Files and tools are stored in render order: files first,
 * then tools.
 *
 * @param items - Final context items selected for display in the current ghost block
 * @returns Canonical structured ghost block for persistence and later replay
 */
export function ghostBlockFromContextItems(items: ContextItem[]): GhostBlock {
    const files: GhostFileEntry[] = [];
    const tools: GhostToolEntry[] = [];

    for (const item of items) {
        if (item.type === 'file') {
            files.push({
                key: item.key,
                version: item.version || 1,
                content: item.metadata?.isReference ? null : item.content
            });
        } else if (item.type === 'tool') {
            tools.push({
                key: item.key,
                argsText: JSON.stringify(item.metadata),
                content: item.content
            });
        }
    }

    return { files, tools };
}

/**
 * Check whether a ghost block has no renderable entries.
 * @param block - Structured ghost block, or null/undefined for absent blocks
 * @returns True when there is nothing to project into markdown
 */
export function isEmptyGhostBlock(block: GhostBlock | null | undefined): boolean {
    return !block || (block.files.length === 0 && block.tools.length === 0);
}

/**
 * Remove file entries matching a predicate from a ghost block.
 * Used by sidebar file actions to retroactively shrink persisted context:
 * removing every entry of a key (Remove File) or only non-latest versions
 * (Prune Old Versions). Tools are never touched.
 *
 * @param block - Structured ghost block
 * @param remove - Predicate selecting file entries to remove
 * @returns Filtered ghost block, or null when nothing renderable remains
 */
export function removeGhostFiles(block: GhostBlock, remove: (file: GhostFileEntry) => boolean): GhostBlock | null {
    const result: GhostBlock = {
        files: block.files.filter(file => !remove(file)),
        tools: block.tools
    };
    return isEmptyGhostBlock(result) ? null : result;
}

/**
 * Collect file versions that have full content available in previous ghost blocks.
 *
 * Only entries with content !== null are considered available full-content
 * sources. Reference-only entries preserve render history but do not make a
 * file version eligible for later "content unchanged" references.
 *
 * @param blocks - Previous ghost blocks aligned with historical user messages
 * @returns Set of `${key}::${version}` tokens for versions safe to reference
 */
export function collectAvailableFileVersions(blocks: readonly (GhostBlock | null)[]): Set<string> {
    const available = new Set<string>();
    for (const block of blocks) {
        if (!block) {
            continue;
        }
        for (const file of block.files) {
            if (file.content !== null) {
                available.add(`${file.key}::${file.version}`);
            }
        }
    }
    return available;
}

/**
 * Project a structured ghost block to the exact markdown consumed by LLM messages.
 *
 * This is the only producer of <content_reference> markdown. The returned
 * string is intended for provider-facing AgentMessage.content assembly only;
 * it must not be persisted or parsed back for decisions.
 *
 * @param block - Structured ghost block to render
 * @returns Exact ghost markdown, or an empty string for an empty block
 */
export function ghostBlockToMarkdown(block: GhostBlock): string {
    if (isEmptyGhostBlock(block)) {
        return '';
    }

    let contextMarkdown = '\n<content_reference>\n';

    if (block.files.length > 0) {
        contextMarkdown += '\n以下是用户使用@引用的文件（或其最新版本状态）：\n';
    }
    for (const file of block.files) {
        const versionStr = file.version ? ` (v${file.version})` : '';
        if (file.content === null) {
            contextMarkdown += `\n# Source: ${file.key}${versionStr}\n> Content unchanged. See previous version ${versionStr}.\n`;
            continue;
        }

        const ext = file.key.split('.').pop() || '';
        const lang = getLanguageIdentifier(ext);
        contextMarkdown += `\n# Source: ${file.key}${versionStr}\n\n\`\`\`${lang}\n${file.content}\n\`\`\`\n`;
    }

    if (block.tools.length > 0) {
        contextMarkdown += '\n下面是用户使用@指定的工具调用，预执行结果如下：\n';
    }
    for (const tool of block.tools) {
        contextMarkdown += `\n# Tool Call: ${tool.key}\n> Args: ${tool.argsText}\n\n${tool.content}\n`;
    }

    contextMarkdown += '\n上述规则展开、文件读取、工具调用均已预执行且保证结果最新。请直接使用其结果，无需重复\n</content_reference>';
    return contextMarkdown;
}
