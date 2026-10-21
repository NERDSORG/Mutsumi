/**
 * @fileoverview Context-injection domain logic: the sole producer of injection
 * markdown plus the history scan for referenceable file versions. Message-type
 * discrimination and construction live in messageTypes.ts.
 *
 * @module contextManagement/contextInjection
 */

import { extractText } from '@moonshot-ai/kosong';
import { AgentMessage, ContextItem } from '../types';
import { getLanguageIdentifier } from '../utils';
import { getMessageType } from './messageTypes';

/**
 * Render display items into `<context_injection>` markdown: files first (in
 * render order), then tools. `isReference` file items render a "content
 * unchanged" line, all others their full content. '' when nothing to display.
 */
export function injectionMarkdownFromItems(items: ContextItem[]): string {
    const files = items.filter(item => item.type === 'file');
    const tools = items.filter(item => item.type === 'tool');
    if (files.length === 0 && tools.length === 0) {
        return '';
    }

    let markdown = '\n<context_injection>\n';

    if (files.length > 0) {
        markdown += '\n以下是用户使用@引用的文件（或其最新版本状态）：\n';
    }
    for (const file of files) {
        const versionStr = ` (v${file.version || 1})`;
        if (file.metadata?.isReference) {
            markdown += `\n# Source: ${file.key}${versionStr}\n> Content unchanged. See previous version ${versionStr}.\n`;
            continue;
        }
        const ext = file.key.split('.').pop() || '';
        const lang = getLanguageIdentifier(ext);
        markdown += `\n# Source: ${file.key}${versionStr}\n\n\`\`\`${lang}\n${file.content}\n\`\`\`\n`;
    }

    if (tools.length > 0) {
        markdown += '\n下面是用户使用@指定的工具调用，预执行结果如下：\n';
    }
    for (const tool of tools) {
        markdown += `\n# Tool Call: ${tool.key}\n> Args: ${JSON.stringify(tool.metadata)}\n\n${tool.content}\n`;
    }

    markdown += '\n上述规则展开、文件读取、工具调用均已预执行且保证结果最新。请直接使用其结果，无需重复\n</context_injection>';
    return markdown;
}

/** `# Source: <key> (vN)` header; the greedy key group tolerates ` (vN)` inside keys. */
const SOURCE_HEADER = /^# Source: (.*) \(v(\d+)\)$/;

/**
 * Collect the `${key}::${version}` tokens whose full content a history
 * injection message carries (a `> Content unchanged` line does not count);
 * the assembly differential picks full-content vs reference re-injection.
 */
export function collectAvailableFileVersions(history: readonly AgentMessage[]): Set<string> {
    const available = new Set<string>();
    for (const msg of history) {
        if (getMessageType(msg) !== 'injection') {
            continue;
        }
        const lines = extractText(msg).split('\n');
        for (let i = 0; i < lines.length; i++) {
            const match = SOURCE_HEADER.exec(lines[i]);
            if (!match) {
                continue;
            }
            if ((lines[i + 1] ?? '').startsWith('> Content unchanged')) {
                continue;
            }
            available.add(`${match[1]}::${match[2]}`);
        }
    }
    return available;
}
