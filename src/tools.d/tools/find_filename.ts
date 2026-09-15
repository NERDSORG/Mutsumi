import type { ITool, ToolContext } from "../interface";
import { resolveUri, COMMON_IGNORE_GLOBS, withAbortableToken } from "../utils";
import * as vscode from "vscode";

export const searchFileNameIncludesTool: ITool = {
	name: "find_filename",
	definition: {
		name: "find_filename",
		description:
			'Find files whose names include the specified string. Equivalent to `find uri -name "*name_includes*"`.',
		parameters: {
			type: "object",
			properties: {
				uri: {
					type: "string",
					description: "The directory URI to start search.",
				},
				name_includes: {
					type: "string",
					description: "The string that filenames must contain.",
				},
			},
			required: ["uri", "name_includes"],
		},
	},
	execute: async (args: any, context: ToolContext) => {
		const abortSignal = context.toolSession.abortSignal;
		try {
			const { uri: uriInput, name_includes } = args;
			if (!uriInput || !name_includes) return "Error: Missing arguments.";

			const rootUri = resolveUri(uriInput);
			const pattern = `**/*${name_includes}*`;
			const relativePattern = new vscode.RelativePattern(rootUri, pattern);
			const exclude = COMMON_IGNORE_GLOBS;

			let files: vscode.Uri[];
			try {
				files = await withAbortableToken(abortSignal, (token) =>
					vscode.workspace.findFiles(relativePattern, exclude, 200, token),
				);
			} catch (err: any) {
				if (abortSignal.aborted) {
					return "[Interrupted] The find_filename tool execution was forcibly stopped by the user.";
				}
				return `Error searching directory: ${err?.message ?? String(err)}`;
			}
			if (abortSignal.aborted) {
				return "[Interrupted] The find_filename tool execution was forcibly stopped by the user.";
			}

			if (files.length === 0) return "No files found.";

			return files
				.map((uri) => {
					return uri.toString().startsWith(rootUri.toString())
						? uri
								.toString()
								.substring(
									rootUri.toString().length +
										(rootUri.toString().endsWith("/") ? 0 : 1),
								)
						: vscode.workspace.asRelativePath(uri);
				})
				.join("\n");
		} catch (err: any) {
			if (abortSignal.aborted) {
				return "[Interrupted] The find_filename tool execution was forcibly stopped by the user.";
			}
			return `Error searching filenames: ${err.message}`;
		}
	},
	prettyPrint: (args: any) => {
		return `🔍 Mutsumi searched files named "*${args.name_includes || "(unknown)*"}*" in ${args.uri || "(unknown directory)"}`;
	},
};
