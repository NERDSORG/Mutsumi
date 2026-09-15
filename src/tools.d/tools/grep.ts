import type { ITool, ToolContext } from "../interface";
import { resolveUri, COMMON_IGNORE_GLOBS, withAbortableToken } from "../utils";
import * as vscode from "vscode";
import { TextDecoder } from "util";

const MAX_FILES_TO_GREP = 1000;

export const grepTool: ITool = {
	name: "grep",
	definition: {
		name: "grep",
		description:
			'Search for a pattern in a file or directory. By default the keyword is interpreted as an ECMAScript regular expression (like `grep -E`). Use `regex: false` to search for the exact literal text. Supports case-insensitive, whole-word, and inverted matching. For directories, recursively searches all files (ignoring common patterns, skipping binary files, truncating long lines). For files, returns matching lines with optional context. Output format: "path:line:content".',
		parameters: {
			type: "object",
			properties: {
				uri: {
					type: "string",
					description:
						"The file or directory URI to search in.",
				},
				keyword: {
					type: "string",
					description:
						'The search pattern. By default treated as an ECMAScript regular expression (like `grep -E`). Set `regex: false` to search for the exact literal text. Supported regex features: `.`, `*`, `+`, `?`, `^`, `$`, `|`, `[...]`, `\\b`, `(?:...)`, character classes, and quantifiers. Lookaround, back-references, and PCRE-only syntax are not supported.',
				},
				regex: {
					type: "boolean",
					default: true,
					description:
						"If true (default), the keyword is treated as an ECMAScript regular expression. If false, the keyword is matched as a literal string.",
				},
				case_insensitive: {
					type: "boolean",
					default: false,
					description:
						"If true, matching is case-insensitive (equivalent to `grep -i`).",
				},
				whole_word: {
					type: "boolean",
					default: false,
					description:
						"If true, only match whole words (equivalent to `grep -w`). Adds word boundaries around the pattern; do not combine with line anchors like `^` or `$` in the same keyword.",
				},
				invert_match: {
					type: "boolean",
					default: false,
					description:
						"If true, return lines that do NOT match the pattern (equivalent to `grep -v`). Context lines are ignored when inverted matching is enabled.",
				},
				lines_before: {
					type: "integer",
					description:
						"Number of context lines before each match (file mode only, default 0). Ignored when `invert_match` is true.",
				},
				lines_after: {
					type: "integer",
					description:
						"Number of context lines after each match (file mode only, default 0). Ignored when `invert_match` is true.",
				},
			},
			required: ["uri", "keyword"],
		},
	},
	execute: async (args: any, context: ToolContext) => {
		const abortSignal = context.toolSession.abortSignal;
		try {
			const { uri: uriInput, keyword } = args;
			if (!uriInput || !keyword)
				return "Error: Missing arguments (uri, keyword).";
			if (keyword === "")
				return "Error: keyword cannot be empty.";

			const linesBefore =
				typeof args.lines_before === "number" ? args.lines_before : 0;
			const linesAfter =
				typeof args.lines_after === "number" ? args.lines_after : 0;
			const regex =
				typeof args.regex === "boolean" ? args.regex : true;
			const caseInsensitive =
				typeof args.case_insensitive === "boolean"
					? args.case_insensitive
					: false;
			const wholeWord =
				typeof args.whole_word === "boolean"
					? args.whole_word
					: false;
			const invertMatch =
				typeof args.invert_match === "boolean"
					? args.invert_match
					: false;

			const matcherResult = buildMatcher(
				keyword,
				regex,
				caseInsensitive,
				wholeWord,
				invertMatch,
			);
			if ("error" in matcherResult) return matcherResult.error;
			const matcher = matcherResult.matcher;

			const rootUri = resolveUri(uriInput);

			// Determine whether uri is a file or directory
			let stat: vscode.FileStat;
			try {
				stat = await vscode.workspace.fs.stat(rootUri);
			} catch (err: any) {
				if (abortSignal.aborted) {
					return "[Interrupted] The grep tool execution was forcibly stopped by the user.";
				}
				return `Error: Cannot access path "${uriInput}": ${err?.message ?? String(err)}`;
			}

			if (stat.type === vscode.FileType.Directory) {
				return await searchDirectory(rootUri, matcher, abortSignal);
			} else {
				return await searchFile(
					rootUri,
					matcher,
					linesBefore,
					linesAfter,
					invertMatch,
					abortSignal,
				);
			}
		} catch (err: any) {
			if (abortSignal.aborted) {
				return "[Interrupted] The grep tool execution was forcibly stopped by the user.";
			}
			return `Error performing search: ${err.message}`;
		}
	},
	prettyPrint: (args: any) => {
		return `🔍 Mutsumi grepped "${args.keyword || "(unknown)"}" in ${args.uri || "(unknown path)"}`;
	},
};

interface Matcher {
	match: (line: string) => boolean;
}

/**
 * Build a line matcher from the user-provided options.
 *
 * - `regex` controls whether the keyword is a regex or a literal string.
 * - `caseInsensitive` adds the `i` flag.
 * - `wholeWord` wraps the pattern in `\b...\b`.
 * - `invertMatch` inverts the result.
 *
 * Returns either a `matcher` object with a `match` function, or an `error`
 * string if the keyword is not a valid regular expression.
 */
function buildMatcher(
	keyword: string,
	regex: boolean,
	caseInsensitive: boolean,
	wholeWord: boolean,
	invertMatch: boolean,
): { matcher: Matcher } | { error: string } {
	let source = keyword;
	const flags = caseInsensitive ? "i" : "";

	try {
		if (!regex) {
			source = escapeRegExp(keyword);
		}
		if (wholeWord) {
			source = `\\b(?:${source})\\b`;
		}
		const re = new RegExp(source, flags);
		return {
			matcher: {
				match: (line: string) => {
					const matched = re.test(line);
					return invertMatch ? !matched : matched;
				},
			},
		};
	} catch (err: any) {
		return {
			error: `Invalid search expression "${keyword}": ${err?.message ?? String(err)}`,
		};
	}
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Recursive directory search — mirrors the behaviour of the former directory
 * search tool: ignore COMMON_IGNORE_GLOBS, cap result files, skip binary
 * files, truncate long lines.  Output: `path:line:content`.
 */
async function searchDirectory(
	rootUri: vscode.Uri,
	matcher: Matcher,
	abortSignal: AbortSignal,
): Promise<string> {
	const relativePattern = new vscode.RelativePattern(rootUri, "**/*");
	const exclude = COMMON_IGNORE_GLOBS;

	let files: vscode.Uri[];
	try {
		files = await withAbortableToken(abortSignal, (token) =>
			vscode.workspace.findFiles(
				relativePattern,
				exclude,
				MAX_FILES_TO_GREP,
				token,
			),
		);
	} catch (err: any) {
		if (abortSignal.aborted) {
			return "[Interrupted] The grep tool execution was forcibly stopped by the user.";
		}
		return `Error searching directory: ${err?.message ?? String(err)}`;
	}
	if (abortSignal.aborted) {
		return "[Interrupted] The grep tool execution was forcibly stopped by the user.";
	}

	if (files.length === 0) return "No files found in directory.";

	const lines: string[] = [];
	for (const fileUri of files) {
		if (abortSignal.aborted) {
			return "[Interrupted] The grep tool execution was forcibly stopped by the user.";
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(fileUri);
			const content = new TextDecoder().decode(bytes);
			if (content.includes("\0")) continue; // skip binary
			const fileLines = content.split(/\r?\n/);
			const relPath = fileUri
				.toString()
				.startsWith(rootUri.toString())
				? fileUri.toString().substring(rootUri.toString().length)
				: vscode.workspace.asRelativePath(fileUri);
			const displayPath = relPath.startsWith("/")
				? relPath.substring(1)
				: relPath;
			for (let idx = 0; idx < fileLines.length; idx++) {
				const line = fileLines[idx];
				if (matcher.match(line)) {
					const displayLine =
						line.length > 300
							? line.substring(0, 300) + "..."
							: line;
					lines.push(`${displayPath}:${idx + 1}:${displayLine.trim()}`);
				}
			}
		} catch {
			/* ignore individual file errors */
		}
	}

	return lines.join("\n") || "No matches found.";
}

/**
 * Single-file search with context lines — mirrors the behaviour of the
 * former file-context search tool: merge overlapping context regions,
 * separate non-adjacent regions with `...`.
 * Output: `path:line:content`.
 */
async function searchFile(
	uri: vscode.Uri,
	matcher: Matcher,
	linesBefore: number,
	linesAfter: number,
	invertMatch: boolean,
	abortSignal: AbortSignal,
): Promise<string> {
	let content: string;
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		content = new TextDecoder().decode(bytes);
	} catch (err: any) {
		if (abortSignal.aborted) {
			return "[Interrupted] The grep tool execution was forcibly stopped by the user.";
		}
		return `Error reading file: ${err.message}`;
	}

	if (content.includes("\0")) return "Binary file — cannot search.";

	const fileLines = content.split(/\r?\n/);
	const lineCount = fileLines.length;

	const indicesToKeep = new Set<number>();

	for (let i = 0; i < lineCount; i++) {
		if (abortSignal.aborted) {
			return "[Interrupted] The grep tool execution was forcibly stopped by the user.";
		}
		if (matcher.match(fileLines[i])) {
			if (invertMatch) {
				indicesToKeep.add(i);
			} else {
				const start = Math.max(0, i - linesBefore);
				const end = Math.min(lineCount - 1, i + linesAfter);
				for (let j = start; j <= end; j++) {
					indicesToKeep.add(j);
				}
			}
		}
	}

	if (indicesToKeep.size === 0)
		return "No matches found.";

	const sortedIndices = Array.from(indicesToKeep).sort((x, y) => x - y);
	const relPath = vscode.workspace.asRelativePath(uri);

	let result = "";
	let prevIndex = -1;

	for (const idx of sortedIndices) {
		if (prevIndex !== -1 && idx > prevIndex + 1) {
			result += "...\n";
		}
		result += `${relPath}:${idx + 1}:${fileLines[idx]}\n`;
		prevIndex = idx;
	}

	return result.trim();
}
