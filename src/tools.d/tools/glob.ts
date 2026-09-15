import type { ITool, ToolContext } from "../interface";
import { resolveUri } from "../utils";
import * as vscode from "vscode";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

/**
 * Format POSIX permission bits from a Node.js stat mode into a `ls -l`-style
 * string (e.g. `drwxr-xr-x`, `-rw-r--r--`).
 */
function formatPosixPermissions(mode: number): string {
	const typeMask = mode & 0o170000;
	let typeChar = "-";
	if (typeMask === 0o040000) typeChar = "d";
	else if (typeMask === 0o120000) typeChar = "l";
	else if (typeMask === 0o020000) typeChar = "c";
	else if (typeMask === 0o060000) typeChar = "b";
	else if (typeMask === 0o010000) typeChar = "p";
	else if (typeMask === 0o140000) typeChar = "s";

	const perms: Array<[number, string]> = [
		[0o400, "r"], [0o200, "w"], [0o100, "x"],
		[0o040, "r"], [0o020, "w"], [0o010, "x"],
		[0o004, "r"], [0o002, "w"], [0o001, "x"],
	];

	let permStr = typeChar;
	for (const [bit, char] of perms) {
		permStr += mode & bit ? char : "-";
	}
	return permStr;
}

export const globTool: ITool = {
	name: "glob",
	definition: {
		name: "glob",
		description:
			"Get file system entry metadata. Accepts both file and directory URIs — for a file, returns its size in KB; for a directory, lists all entries with type, (for files) size, and (on POSIX) permission bits. **CRITICAL**: Use this BEFORE reading or editing files to check sizes and decide whether to use partial read/search or full read/replace, to save tokens.",
		parameters: {
			type: "object",
			properties: {
				uri: {
					type: "string",
					description:
						"The file or directory URI to inspect.",
				},
			},
			required: ["uri"],
		},
	},
	execute: async (args: any, context: ToolContext) => {
		try {
			const uriInput = args.uri;
			if (!uriInput) return 'Error: Missing "uri" argument.';

			const uri = resolveUri(uriInput);

			let stat: vscode.FileStat;
			try {
				stat = await vscode.workspace.fs.stat(uri);
			} catch (err: any) {
				return `Error: Cannot access path "${uriInput}": ${err?.message ?? String(err)}`;
			}

			if (stat.type === vscode.FileType.Directory) {
				return await listDirectory(uri);
			} else {
				const sizeKB = (stat.size / 1024).toFixed(2);
				return `Size: ${sizeKB} KB (${stat.size} bytes)`;
			}
		} catch (err: any) {
			return `Error getting file info: ${err.message}`;
		}
	},
	prettyPrint: (args: any) => {
		return `📊 Mutsumi inspected ${args.uri || "(unknown path)"}`;
	},
};

async function listDirectory(uri: vscode.Uri): Promise<string> {
	const entries = await vscode.workspace.fs.readDirectory(uri);

	if (entries.length === 0) return "(Empty Directory)";

	entries.sort((a, b) => {
		if (a[1] === b[1]) return a[0].localeCompare(b[0]);
		return a[1] === vscode.FileType.Directory ? -1 : 1;
	});

	const isPosix = os.platform() !== "win32";
	const result: string[] = [];

	for (const [name, type] of entries) {
		const typeStr =
			type === vscode.FileType.Directory
				? "DIR "
				: type === vscode.FileType.File
					? "FILE"
					: type === vscode.FileType.SymbolicLink
						? "LINK"
						: "UNKN";

		let sizeStr = "";
		let permStr = "";

		if (type === vscode.FileType.Directory) {
			// Directories: do not show size; keep POSIX permission bits if available
			if (uri.scheme === "file" && isPosix) {
				try {
					const entryPath = path.join(uri.fsPath, name);
					const nodeStat = fs.statSync(entryPath);
					permStr = ` ${formatPosixPermissions(nodeStat.mode)}`;
				} catch {
					// stat failed — skip permissions for this directory entry
				}
			}
		} else if (uri.scheme === "file") {
			try {
				const entryPath = path.join(uri.fsPath, name);
				const nodeStat = fs.statSync(entryPath);
				sizeStr = ` ${(nodeStat.size / 1024).toFixed(2)} KB`;
				if (isPosix) {
					permStr = ` ${formatPosixPermissions(nodeStat.mode)}`;
				}
			} catch {
				// stat failed — skip size/permissions for this entry
			}
		} else {
			// Non-local URI: use VS Code API for size only
			try {
				const entryUri = vscode.Uri.joinPath(uri, name);
				const vsStat = await vscode.workspace.fs.stat(entryUri);
				sizeStr = ` ${(vsStat.size / 1024).toFixed(2)} KB`;
			} catch {
				// stat failed — skip size for this entry
			}
		}

		result.push(`[${typeStr}]${permStr}${sizeStr} ${name}`);
	}

	return result.join("\n");
}
