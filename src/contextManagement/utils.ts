import * as vscode from "vscode";
import * as path from "path";
import * as crypto from "crypto";
import { AgentMessage } from "../types";
import { TextDecoder } from "util";
import { ToolManager } from "../tools.d/toolManager";
import type { ToolContext } from "../tools.d/interface";
import type { ContentPart } from "@moonshot-ai/kosong";
import { ContextItem } from "../types";
import { LiteAdapter } from "../adapters/liteAdapter";
import { ToolSession } from "../tools.d/toolSession";
import { withPreExecution } from "../tools.d/permission";

/** Image regex: matches Markdown images in ![alt](uri) format */
export const IMG_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * Get language identifier for Markdown code block based on file extension
 */
export { getLanguageIdentifier } from "../utils";

/**
 * Read image file as base64 data URL
 */
export async function readImageAsBase64(
	uriStr: string,
): Promise<string | null> {
	try {
		const uri = vscode.Uri.parse(uriStr);
		if (uri.scheme !== "file") {
			if (uri.scheme === "http" || uri.scheme === "https") {
				return uriStr;
			}
			return null;
		}

		const bytes = await vscode.workspace.fs.readFile(uri);
		const buffer = Buffer.from(bytes);

		const ext = uriStr.split(".").pop()?.toLowerCase();
		let mimeType = "image/jpeg";
		if (ext === "png") mimeType = "image/png";
		if (ext === "webp") mimeType = "image/webp";
		if (ext === "gif") mimeType = "image/gif";

		return `data:${mimeType};base64,${buffer.toString("base64")}`;
	} catch (e) {
		console.error("Error reading image file:", e);
		return null;
	}
}

/**
 * Parse user message text and convert embedded images to multimodal content.
 * Always returns ContentPart[] — plain text becomes a single text part.
 */
export async function parseUserMessageWithImages(
	text: string,
): Promise<ContentPart[]> {
	const matches = [...text.matchAll(IMG_REGEX)];

	if (matches.length === 0) {
		return [{ type: "text", text }];
	}

	const content: ContentPart[] = [];
	let lastIndex = 0;

	for (const match of matches) {
		const [fullMatch, altText, uriStr] = match;
		const index = match.index!;

		if (index > lastIndex) {
			content.push({
				type: "text",
				text: text.substring(lastIndex, index),
			});
		}

		try {
			const imageBase64 = await readImageAsBase64(uriStr);
			if (imageBase64) {
				content.push({
					type: "image_url",
					imageUrl: {
						url: imageBase64,
					},
				});
			} else {
				content.push({ type: "text", text: fullMatch });
			}
		} catch (e) {
			console.error(`Failed to read image ${uriStr}:`, e);
			content.push({ type: "text", text: fullMatch });
		}

		lastIndex = index + fullMatch.length;
	}

	if (lastIndex < text.length) {
		content.push({
			type: "text",
			text: text.substring(lastIndex),
		});
	}

	return content;
}

/**
 * Extract content from square brackets, handling nested brackets
 */
export function extractBracketContent(
	text: string,
	start: number,
): { content: string; endIdx: number } {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === "[") depth++;
		else if (text[i] === "]") {
			if (depth === 0) {
				return { content: text.substring(start, i), endIdx: i };
			}
			depth--;
		}
	}
	return { content: "", endIdx: -1 };
}

/**
 * Parse a file reference string into URI and line range
 * Supports multi-root workspace paths like "workspaceFolderName/relative/path"
 * @param ref - Reference string, e.g., "path/to/file.ts:10:20" or "hv-paste/README.md"
 * @param defaultUri - Default base URI for resolving relative paths (typically workspaceFolders[0].uri)
 */
export function parseReference(
	ref: string,
	defaultUri: vscode.Uri,
): { uri: vscode.Uri; startLine?: number; endLine?: number } {
	//这个地方加逗号是语法错误！我给你改回来了，以后别再这样了
	// Parse line numbers from the end, handling Windows paths like "C:/path" vs "path:10:20"
	let filePath = ref;
	let startLine: number | undefined;
	let endLine: number | undefined;

	// Parse line numbers from the right: path:start:end or path:start
	// (References are always relative workspace paths, no Windows drive letters like C:)
	const parts = ref.split(":");
	if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
		const num = parseInt(parts.pop()!, 10);
		if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
			// Two numbers: path:start:end
			endLine = num;
			startLine = parseInt(parts.pop()!, 10);
		} else {
			// One number: path:start (single line)
			startLine = num;
		}
		filePath = parts.join(":");
	}

	// Resolve relative path (references are always workspace-relative)
	const workspaceFolders = vscode.workspace.workspaceFolders;
	const firstSegment = filePath.split(/[\\/]/)[0];
	const isMultiRoot = workspaceFolders && workspaceFolders.length > 1;

	// Check for multi-root workspace format "folderName/rest/of/path"
	const matchingFolder = isMultiRoot
		? workspaceFolders?.find((wf) => wf.name === firstSegment)
		: undefined;

	const uri = matchingFolder
		? vscode.Uri.joinPath(
				matchingFolder.uri,
				filePath.substring(firstSegment.length + 1),
			)
		: vscode.Uri.joinPath(defaultUri, filePath);

	return { uri, startLine, endLine };
}

/**
 * Read resource content from URI, optionally with line range
 */
export async function readResource(
	uri: vscode.Uri,
	start?: number,
	end?: number,
): Promise<string> {
	const stat = await vscode.workspace.fs.stat(uri);

	if (stat.type === vscode.FileType.Directory) {
		const entries = await vscode.workspace.fs.readDirectory(uri);
		return entries
			.map(([name, type]) => {
				const typeStr = type === vscode.FileType.Directory ? "DIR" : "FILE";
				return `[${typeStr}] ${name}`;
			})
			.join("\n");
	} else {
		const bytes = await vscode.workspace.fs.readFile(uri);
		const content = new TextDecoder().decode(bytes);

		if (start !== undefined) {
			const lines = content.split(/\r?\n/);
			const s = Math.max(0, start - 1);
			const e = end !== undefined ? end : s + 1;
			return lines.slice(s, e).join("\n");
		}
		return content;
	}
}

/**
 * Check if URI points to a Markdown file
 */
export function isMarkdownFile(uri: vscode.Uri): boolean {
	const ext = path.extname(uri.path).toLowerCase();
	return ext === ".md";
}

/**
 * Check if file should be recursively parsed for references
 */
export function shouldRecurseFile(uri: vscode.Uri): boolean {
	const ext = path.extname(uri.path).toLowerCase();
	return ext === ".md" || ext === ".txt";
}

/**
 * Execute a user-authored pre-execution tool call (`@[tool{...}]`) by name.
 * Runs on the pre-execution tool plane: built-in common tools plus every
 * currently available MCP tool, always without approval.
 */
export async function executeToolCall(
	name: string,
	args: any,
	allowedUris: string[],
): Promise<string> {
	const tm = ToolManager.getInstance();
	const liteAdapter = new LiteAdapter();
	const session = await liteAdapter.createSession();
	const context: ToolContext = {
		allowedUris: allowedUris,
		session,
		toolSession: new ToolSession(session.id, name),
		signalTermination: () => {}, // No-op for user's explicit tool pre-execution
	};
	return await withPreExecution(() => tm.executeTool(name, args, context, false));
}

/**
 * Extract macro definitions from text
 * Supports two formats:
 * 1. HTML comments: <!-- @def KEY=VALUE -->
 * 2. Explicit definition: @{define KEY, VALUE} (Value can be quoted or unquoted)
 * Returns a map of macros found
 */
/**
 * Compute SHA-256 hash of content
 */
export function computeHash(content: string): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

export function extractMacroDefinitions(text: string): Record<string, string> {
	const macros: Record<string, string> = {};

	// Format 1: <!-- @def KEY=VALUE --> (HTML/Markdown comment style)
	const regexHtml = /<!--\s*@def\s+(\w+)\s*=\s*(.*?)\s*-->/g;
	let match;
	while ((match = regexHtml.exec(text)) !== null) {
		macros[match[1]] = match[2];
	}

	// Format 2: @{define KEY, VALUE}
	// Value can be quoted or unquoted.
	const regexCustom = /@\{define\s+(\w+)\s*,\s*(.*?)\}/g;
	while ((match = regexCustom.exec(text)) !== null) {
		let val = match[2].trim();
		// Remove surrounding quotes if present
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.substring(1, val.length - 1);
		}
		macros[match[1]] = val;
	}

	return macros;
}
