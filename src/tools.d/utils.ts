import * as vscode from "vscode";
import * as os from "os";

/**
 * Resolve a string input to a vscode.Uri.
 * Supports:
 * - URI strings (e.g. "file:///...", "ftp://...")
 * - Absolute paths (Windows "C:\...", POSIX "/...") -> Tries to infer scheme from workspace
 * - Relative paths -> Resolves against workspace root
 */
export function resolveUri(input: string): vscode.Uri {
	try {
		// 1. If it has a scheme, parse it directly
		if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) {
			return vscode.Uri.parse(input);
		}

		// 2. Handle absolute paths (Windows or POSIX)
		const isWinAbs = /^[a-zA-Z]:[\\/]/.test(input);
		const isPosixAbs = input.startsWith("/");

		if (isWinAbs || isPosixAbs) {
			// If we have a workspace, try to keep the scheme consistent
			if (
				vscode.workspace.workspaceFolders &&
				vscode.workspace.workspaceFolders.length > 0
			) {
				const root = vscode.workspace.workspaceFolders[0].uri;
				// If the root is not local file, apply its scheme to the absolute path
				if (root.scheme !== "file") {
					// For remote/virtual fs, we assume the input path is valid on that fs
					// Note: This constructs uri like scheme://authority/input
					return root.with({ path: input });
				}
			}
			// Default to local file
			return vscode.Uri.file(input);
		}

		// 3. Handle relative paths
		if (
			vscode.workspace.workspaceFolders &&
			vscode.workspace.workspaceFolders.length > 0
		) {
			const root = vscode.workspace.workspaceFolders[0].uri;
			return vscode.Uri.joinPath(root, input);
		}

		// 4. Fallback: No workspace, treat as local relative/file
		return vscode.Uri.file(input);
	} catch (e) {
		throw new Error(`Failed to resolve URI from input: ${input}`);
	}
}

/**
 * Check if the agent is allowed to access the target URI based on allowed list.
 * Comparisons are done using URI components (scheme, authority, path) rather than fsPath string matching.
 */
export function checkAccess(
	targetUri: vscode.Uri,
	allowedUris: string[],
): boolean {
	const targetScheme = targetUri.scheme.toLowerCase();
	const targetAuth = targetUri.authority.toLowerCase();
	// Use lower case path for secure comparison (defaulting to case-insensitive safety)
	const targetPath = targetUri.path.toLowerCase();

	for (const allowed of allowedUris) {
		if (allowed === "/") return true; // Global access

		let allowedUri: vscode.Uri;
		try {
			allowedUri = resolveUri(allowed);
		} catch {
			continue;
		}

		// 1. Scheme Check
		if (allowedUri.scheme.toLowerCase() !== targetScheme) continue;

		// 2. Authority Check
		if (allowedUri.authority.toLowerCase() !== targetAuth) continue;

		// 3. Path Inclusion Check
		let allowedPath = allowedUri.path.toLowerCase();

		// Exact match
		if (targetPath === allowedPath) return true;

		// Directory match: ensure allowedPath ends with '/' for prefix checking
		if (!allowedPath.endsWith("/")) {
			allowedPath += "/";
		}

		if (targetPath.startsWith(allowedPath)) return true;
	}

	return false;
}

/**
 * Get a unique key for the URI to use in Maps/Sets.
 * Using toString() ensures uniqueness across schemes.
 */
export function getUriKey(uri: vscode.Uri): string {
	return uri.toString();
}

const COMMON_IGNORED = new Set([
	"node_modules",
	".git",
	".vscode",
	".mutsumi",
	"dist",
	"out",
	"build",
	"__pycache__",
	"coverage",
]);

/** Glob fragment matching COMMON_IGNORED as directory segments at any depth. */
export const COMMON_IGNORE_GLOBS = `{${[...COMMON_IGNORED]
	.map((name) => `**/${name}/**`)
	.join(",")}}`;

export function isCommonIgnored(name: string): boolean {
	return name.startsWith(".") || COMMON_IGNORED.has(name);
}

/**
 * Strip a leading `$(icon)` token (plus its single separator space) from a
 * display label, for hosts that cannot render codicons (system
 * notifications, plain-text tooltips). Labels without a leading token pass
 * through unchanged. Counterpart of the webview's `extractLeadingIcon`.
 */
export function stripLeadingIconToken(text: string): string {
	return text.replace(/^\$\([a-z0-9-]+\) ?/, "");
}

/**
 * Simplify a URI-ish argument string for human-facing display (prettyPrint
 * summaries only — never used on execution paths).
 *
 * Rules, in priority order:
 * 1. Falsy input -> "(unknown path)"; unresolvable input -> returned as-is.
 * 2. Non-file schemes (mcp://, vscode-remote://, ...) pass through unchanged.
 * 3. A path inside a workspace folder becomes workspace-relative:
 *    multi-root -> `<folderName>/<rel>`, single-root -> `<rel>`; the folder
 *    itself displays as `<folderName>` (multi-root) or `.`. Longest root
 *    wins when roots are nested.
 * 4. A path inside the user's home directory becomes `~` or `~/<rel>`.
 * 5. Anything else is returned as a plain absolute path (forward slashes).
 *
 * Workspace-relative wins over `~` (a workspace inside home is the common
 * case, and the relative form is the more information-dense one). Matching
 * is case-insensitive (mirrors checkAccess); display keeps the input's
 * original casing.
 */
export function simplifyUri(input: string | undefined | null): string {
	if (!input) return "(unknown path)";
	let uri: vscode.Uri;
	try {
		uri = resolveUri(input);
	} catch {
		return input;
	}
	if (uri.scheme !== "file") {
		return input;
	}
	const displayPath = normalizeForDisplay(uri.fsPath);

	const folders = vscode.workspace.workspaceFolders ?? [];
	const roots = folders
		.filter((f) => f.uri.scheme === "file")
		.map((f) => ({
			name: f.name,
			path: normalizeForDisplay(f.uri.fsPath),
		}))
		.sort((a, b) => b.path.length - a.path.length);
	for (const root of roots) {
		const rel = relativeDisplayPath(root.path, displayPath);
		if (rel === null) continue;
		if (rel === "") return folders.length > 1 ? root.name : ".";
		return folders.length > 1 ? `${root.name}/${rel}` : rel;
	}

	const home = normalizeForDisplay(os.homedir());
	const relHome = relativeDisplayPath(home, displayPath);
	if (relHome !== null) {
		return relHome === "" ? "~" : `~/${relHome}`;
	}

	return displayPath;
}

/** Backslashes -> forward slashes; drop trailing slashes (except root). */
function normalizeForDisplay(p: string): string {
	let out = p.replace(/\\/g, "/");
	while (out.length > 1 && out.endsWith("/")) {
		out = out.slice(0, -1);
	}
	return out;
}

/**
 * `p` relative to `root`, or null when `p` is outside `root`. Comparison is
 * case-insensitive but the returned slice keeps the original casing.
 */
function relativeDisplayPath(root: string, p: string): string | null {
	const prefix = root.endsWith("/") ? root : `${root}/`;
	if (p.startsWith(prefix)) return p.substring(prefix.length);
	if (p === root) return "";
	const lowerPrefix = prefix.toLowerCase();
	const lowerP = p.toLowerCase();
	if (lowerP.startsWith(lowerPrefix)) return p.substring(prefix.length);
	if (lowerP === root.toLowerCase()) return "";
	return null;
}

/**
 * Bridge an AbortSignal to a VS Code CancellationToken for a single async call.
 * Cancels the token when the signal aborts and disposes resources afterwards.
 */
export async function withAbortableToken<T>(
	abortSignal: AbortSignal,
	fn: (token: vscode.CancellationToken) => Thenable<T>,
): Promise<T> {
	const cts = new vscode.CancellationTokenSource();
	const onAbort = () => cts.cancel();
	abortSignal.addEventListener("abort", onAbort);
	try {
		return await fn(cts.token);
	} finally {
		abortSignal.removeEventListener("abort", onAbort);
		cts.dispose();
	}
}
