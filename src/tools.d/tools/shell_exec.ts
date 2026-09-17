import type { ITool, ToolContext } from "../interface";
import { resolveUri } from "../utils";
import { t } from "../../i18n";
import { toolsLogger } from "../toolsLogger";
import * as path from "path";
import * as vscode from "vscode";
import { ShellTask, formatShellOutput } from "../shell/shellTask";
import { shellTaskRegistry } from "../shell/registry";

function shellLogger(message: string): void {
	const timestamp = new Date().toLocaleTimeString();
	toolsLogger.logLine(`[${timestamp}] [shell] ${message}`);
}

export const shellTool: ITool = {
	name: "shell",
	definition: {
		name: "shell",
		description:
			"Execute a shell command. Requires user approval. By default waits for the command to finish (sync). Set background=true to start it detached and return immediately with a task id; use inspect_shell_task to inspect its output later.",
		parameters: {
			type: "object",
			properties: {
				uri: {
					type: "string",
					description: "The URI where command should be executed (CWD).",
				},
				cmd: { type: "string", description: "The shell command to execute." },
				shell_path: {
					type: "string",
					description:
						"Absolute path to the shell executable (e.g. /bin/bash, C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe). If omitted, defaults to system default.",
				},
				background: {
					type: "boolean",
					description:
						"If true, run detached and return immediately with a task id without waiting for exit. Use inspect_shell_task to inspect. Default: false (sync wait for exit).",
				},
			},
			required: ["uri", "cmd"],
		},
	},
	execute: async (args: any, context: ToolContext) => {
		try {
			const { uri: uriInput, cmd, shell_path: shellPath, background } = args;
			if (!uriInput || !cmd) return 'Error: Missing "uri" or "cmd" argument.';

			const uri = resolveUri(uriInput);

			if (uri.scheme !== "file") {
				return `Error: shell only supports 'file' scheme (local or remote OS file system). Current scheme: '${uri.scheme}'. virtual file systems do not support shell execution.`;
			}

			const cwd = uri.fsPath;
			const shellName = shellPath
				? path.basename(shellPath)
				: "System Default Shell";

			const details = t(
				"approval.shell.details",
				cmd,
				shellName,
				background ? t("approval.shell.yes") : t("approval.shell.no"),
			);
			const rejectionMsg = await context.session.requestApproval(
				t("approval.shell.action", cmd, uriInput),
				uriInput,
				"shell",
				details,
			);

			if (rejectionMsg !== null) {
				return rejectionMsg;
			}

			shellLogger(`Command: ${cmd}`);
			shellLogger(`Working directory: ${cwd}`);
			shellLogger(`Shell: ${shellName}`);
			shellLogger(`Background: ${background ? "yes" : "no"}`);
			shellLogger("--- Execution Start ---");

			const task = new ShellTask({
				cmd,
				cwd,
				shellPath,
				agentSessionId: context.session.id,
				abortSignal: context.toolSession.abortSignal,
				background,
			});
			shellTaskRegistry.register(task);

			if (background) {
				shellLogger("--- Detached, returned task id ---");
				return `[Background] Started shell task ${task.id}, detached.\nCommand: ${cmd}\nUse inspect_shell_task with task_id="${task.id}" to inspect output.`;
			}

			// sync mode: wait for exit, but auto-detach to background after timeout
			// or when the user clicks "move to background" in the UI.
			let timedOut = false;
			let detachedByUser = false;
			const detachPromise = new Promise<void>((resolve) => {
				task.onDetach(() => {
					detachedByUser = !timedOut;
					resolve();
				});
			});
			const timeoutSeconds = vscode.workspace
				.getConfiguration("mutsumi")
				.get<number>("shellSyncTimeout", 60);
			const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0;
			const timer = timeoutMs
				? setTimeout(() => {
						timedOut = true;
						task.detachToBackground();
					}, timeoutMs)
				: undefined;

			await Promise.race([
				task.waitForExit().then(() => "exit"),
				detachPromise.then(() => "detach"),
			]).then(() => {});
			if (timer) clearTimeout(timer);

			const snap = task.snapshot();

			if (detachedByUser) {
				shellLogger("--- User moved sync task to background ---");
				return `[Background] Shell task ${task.id} was moved to background by the user.
Command: ${cmd}
Use inspect_shell_task with task_id="${task.id}" to inspect output.`;
			}

			if (timedOut && task.background) {
				shellLogger("--- Sync timeout, moved to background ---");
				return `[Background] Shell task ${task.id} exceeded ${timeoutSeconds}s and was moved to background.\nCommand: ${cmd}\nUse inspect_shell_task with task_id="${task.id}" to inspect output.`;
			}

			shellLogger("--- Execution End ---");
			shellLogger(
				`Exit code: ${snap.exitCode}${snap.aborted ? " (aborted)" : ""}`,
			);

			shellTaskRegistry.remove(task.id);
			if (snap.aborted) {
				if (context.toolSession.isAborted) {
					return `[Interrupted] The shell tool execution was forcibly stopped by the user.`;
				}
				return `[Stopped] The shell tool execution was stopped by the user. The agent loop continues.\n\n${formatShellOutput(snap, { showExit: true })}`;
			}
			return formatShellOutput(snap, { showExit: true });
		} catch (err: any) {
			return `Error preparing shell execution: ${err.message}`;
		}
	},
	prettyPrint: (args: any) => {
		const cmdPreview = args.cmd
			? args.cmd.length > 40
				? args.cmd.substring(0, 40) + "..."
				: args.cmd
			: "(unknown command)";
		const mode = args.background ? "[background] " : "";
		return `⚡ Mutsumi executed ${mode}"${cmdPreview}" in ${args.uri || "(unknown directory)"}`;
	},
	argsToCodeBlock: ["cmd"],
	codeBlockFilePaths: [undefined],
};
