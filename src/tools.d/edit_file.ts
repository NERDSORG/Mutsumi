import * as vscode from "vscode";
import * as path from "path";
import * as Diff from "diff";
import { v4 as uuidv4 } from "uuid";
import type { ToolContext } from "./interface";
import { resolveUri, checkAccess, getUriKey } from "./utils";
import { t } from "../i18n";

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Internal transaction state
 */
interface EditTransactionState {
	id: string;
	approvalRequestId?: string;
	resolve: (value: string) => void;
	reject: (reason: any) => void;
	originalUri: vscode.Uri;
	backupUri: vscode.Uri;
	editUri: vscode.Uri;
	toolName: string;
	isNewFile?: boolean; // Whether the file is newly created
}

// ============================================================================
// TempFileHandler - Manages temporary file operations
// ============================================================================

/**
 * Ensure a file exists at the given URI.
 * Creates the file (and parent directories if needed) if it doesn't exist.
 * Returns true if a new file was created, false if file already exists.
 */
async function ensureFileExists(originalUri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(originalUri);
		return false;
	} catch {
		const parentUri = vscode.Uri.joinPath(originalUri, "..");
		await vscode.workspace.fs.createDirectory(parentUri);
		await vscode.workspace.fs.writeFile(originalUri, new Uint8Array(0));
		return true;
	}
}

class TempFileHandler {
	private readonly backupUri: vscode.Uri;
	private readonly editUri: vscode.Uri;

	constructor(originalUri: vscode.Uri, transactionId: string) {
		const p = path.posix;
		const originalPath = originalUri.path;
		const ext = p.extname(originalPath);
		const basename = p.basename(originalPath, ext);

		const shortId = transactionId.split("-")[0];

		const backupName = `.${basename}.${shortId}.temp-backup${ext}`;
		const editName = `.${basename}.${shortId}.temp-edit${ext}`;

		this.backupUri = vscode.Uri.joinPath(originalUri, "..", backupName);
		this.editUri = vscode.Uri.joinPath(originalUri, "..", editName);
	}

	getBackupUri(): vscode.Uri {
		return this.backupUri;
	}

	getEditUri(): vscode.Uri {
		return this.editUri;
	}

	/**
	 * Initialize temp files with the same content
	 */
	async initialize(content: string): Promise<void> {
		const encoder = new TextEncoder();
		const contentBytes = encoder.encode(content);
		await vscode.workspace.fs.writeFile(this.backupUri, contentBytes);
		await vscode.workspace.fs.writeFile(this.editUri, contentBytes);
	}

	/**
	 * Read user-edited content from the editable temp file.
	 * Prefers the open editor buffer: the user may have edited the proposal in
	 * the diff view without pressing Ctrl+S. A dirty buffer is saved first so
	 * the on-disk temp file and the buffer stay consistent.
	 */
	async readUserContent(): Promise<string> {
		const editUriString = this.editUri.toString();
		const openDoc = vscode.workspace.textDocuments.find(
			(doc) => doc.uri.toString() === editUriString,
		);
		if (openDoc) {
			if (openDoc.isDirty) {
				try {
					await openDoc.save();
				} catch {
					// Fall through: the buffer text below still holds the edits.
				}
			}
			return openDoc.getText();
		}
		const bytes = await vscode.workspace.fs.readFile(this.editUri);
		return new TextDecoder().decode(bytes);
	}

	/**
	 * Read backup content (original AI proposal)
	 */
	async readBackupContent(): Promise<string> {
		const bytes = await vscode.workspace.fs.readFile(this.backupUri);
		return new TextDecoder().decode(bytes);
	}

	/**
	 * Overwrite the original file with user content
	 */
	async overwriteOriginal(
		originalUri: vscode.Uri,
		userContentBytes: Uint8Array,
	): Promise<void> {
		await vscode.workspace.fs.writeFile(originalUri, userContentBytes);
	}

	/**
	 * Clean up temp files silently (ignore errors)
	 */
	async cleanup(): Promise<void> {
		await this.deleteSilently(this.editUri);
		await this.deleteSilently(this.backupUri);
	}

	private async deleteSilently(uri: vscode.Uri): Promise<void> {
		try {
			await vscode.workspace.fs.delete(uri);
		} catch {
			// Silently ignore deletion errors
		}
	}

	async deleteNewEmptyFileSilently(uri: vscode.Uri): Promise<void> {
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.size == 0) {
			await this.deleteSilently(uri);
		}
	}
}

// ============================================================================
// DiffEditorController - Manages diff editor UI operations
// ============================================================================

class DiffEditorController {
	/**
	 * Open diff editor between original and temp file.
	 */
	async openDiff(originalUri: vscode.Uri, editUri: vscode.Uri): Promise<void> {
		const originalName = path.posix.basename(originalUri.path);
		await vscode.commands.executeCommand(
			"vscode.diff",
			originalUri,
			editUri,
			`Diff: ${originalName}`,
			{ preview: false },
		);
	}

	/**
	 * Close the diff editor tab containing the temp file.
	 */
	async closeDiffEditor(tempUri: vscode.Uri): Promise<void> {
		const tempUriString = tempUri.toString();

		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				const input = tab.input as
					| {
							modified?: vscode.Uri;
							original?: vscode.Uri;
							kind?: string;
					  }
					| undefined;

				if (input?.modified && input.modified.toString() === tempUriString) {
					await vscode.window.tabGroups.close(tab);
					return;
				}
			}
		}
	}
}

// ============================================================================
// EditTransaction - Represents a single edit transaction with its lifecycle
// ============================================================================

class EditTransaction {
	public readonly state: EditTransactionState;
	private readonly tempFileHandler: TempFileHandler;
	private readonly targetUri: vscode.Uri;
	private resolved = false;
	private readonly isNewFile: boolean;

	constructor(
		targetUri: vscode.Uri,
		toolName: string,
		resolve: (value: string) => void,
		reject: (reason: any) => void,
		isNewFile: boolean = false,
	) {
		this.targetUri = targetUri;
		this.isNewFile = isNewFile;
		const id = uuidv4();
		this.tempFileHandler = new TempFileHandler(targetUri, id);

		this.state = {
			id,
			resolve,
			reject,
			originalUri: targetUri,
			backupUri: this.tempFileHandler.getBackupUri(),
			editUri: this.tempFileHandler.getEditUri(),
			toolName,
			isNewFile,
		};
	}

	getId(): string {
		return this.state.id;
	}

	getUri(): vscode.Uri {
		return this.targetUri;
	}

	getEditUri(): vscode.Uri {
		return this.state.editUri;
	}

	/**
	 * Initialize temp files
	 */
	async initialize(newContent: string): Promise<void> {
		await this.tempFileHandler.initialize(newContent);
	}

	/**
	 * Handle accept action - apply user edits to original file
	 */
	async accept(): Promise<string> {
		if (this.resolved) {
			return "Transaction already resolved";
		}

		try {
			const userContent = await this.tempFileHandler.readUserContent();
			const backupContent = await this.tempFileHandler.readBackupContent();
			const encoder = new TextEncoder();
			const userContentBytes = encoder.encode(userContent);

			// Overwrite original file
			await this.tempFileHandler.overwriteOriginal(
				this.state.originalUri,
				userContentBytes,
			);

			// Generate diff for feedback
			const fileName = path.posix.basename(this.targetUri.path);
			const patch = Diff.createTwoFilesPatch(
				`AI_Proposal/${fileName}`,
				`User_Edited/${fileName}`,
				backupContent,
				userContent,
				"AI Original",
				"User Final",
			);

			// Construct feedback
			let feedbackMsg: string;
			if (patch.includes("@@")) {
				feedbackMsg = [
					"User accepted the changes with manual edits.",
					"Below is the diff showing what the User changed ON TOP OF your generation:",
					"",
					patch,
					"",
					"Please analyze these manual edits to understand the User's intent.",
				].join("\n");
			} else {
				feedbackMsg =
					"User accepted the changes (no manual modifications made).";
			}

			return feedbackMsg;
		} catch (e: any) {
			throw new Error(`Failed to apply edits: ${e.message}`);
		}
	}

	/**
	 * Handle cancellation
	 */
	cancel(): string {
		if (this.resolved) {
			return "Transaction already resolved";
		}
		return `[Tool Call Cancelled] The ${this.state.toolName} operation was cancelled by user or system.`;
	}

	/**
	 * Clean up resources and mark as resolved
	 */
	async cleanup(diffController: DiffEditorController): Promise<void> {
		if (this.resolved) {
			return;
		}
		this.resolved = true;

		try {
			await diffController.closeDiffEditor(this.state.editUri);
		} catch {
			// Ignore close errors
		}

		await this.tempFileHandler.cleanup();

		if (this.isNewFile) {
			await this.tempFileHandler.deleteNewEmptyFileSilently(
				this.state.originalUri,
			);
		}
	}

	/**
	 * Resolve the promise with a value
	 */
	resolve(value: string): void {
		if (!this.resolved) {
			this.state.resolve(value);
		}
	}

	/**
	 * Reject the promise with a reason
	 */
	reject(reason: any): void {
		if (!this.resolved) {
			this.state.reject(reason);
		}
	}

	/**
	 * Check if transaction is resolved
	 */
	isResolved(): boolean {
		return this.resolved;
	}
}

// ============================================================================
// EditTransactionManager - Core manager for all edit transactions
// ============================================================================

/**
 * Manages edit transactions (temp-file based propose → approve → apply flow).
 * Approval goes through the session's backend approval path; the diff editor
 * is only opened on demand via the approval's custom action ("view/edit
 * diff"), never automatically.
 */
class EditTransactionManager {
	private static instance: EditTransactionManager;
	private transactions = new Map<string, EditTransaction>(); // Map<uriKey, EditTransaction>
	private diffController = new DiffEditorController();
	private initialized = false;
	/** Session of the latest requestEdit call, used to cancel pending approvals. */
	private activeSessionForCancellation?: ToolContext["session"];

	private constructor() {}

	public static getInstance(): EditTransactionManager {
		if (!EditTransactionManager.instance) {
			EditTransactionManager.instance = new EditTransactionManager();
		}
		return EditTransactionManager.instance;
	}

	/**
	 * Initialize the manager
	 */
	initialize(): void {
		if (this.initialized) {
			return;
		}
		this.initialized = true;
	}

	/**
	 * Request a new edit operation
	 */
	async requestEdit(
		uriInput: string,
		newContent: string,
		context: ToolContext,
		toolName: string = "edit",
	): Promise<string> {
		const uri = resolveUri(uriInput);
		if (!checkAccess(uri, context.allowedUris)) {
			throw new Error(
				`Access Denied: Agent is not allowed to edit ${uri.toString()}`,
			);
		}

		const uriKey = getUriKey(uri);

		// Cancel existing session for this file if any
		this.activeSessionForCancellation = context.session;
		await this.cancelExistingTransaction(uriKey);

		// Check if file exists, create empty file if not
		const isNewFile = await ensureFileExists(uri);

		return new Promise<string>((resolvePromise, rejectPromise) => {
			const transaction = new EditTransaction(
				uri,
				toolName,
				resolvePromise,
				rejectPromise,
				isNewFile,
			);

			void (async () => {
				try {
					// Initialize temp files
					await transaction.initialize(newContent);

					// Register transaction
					this.transactions.set(uriKey, transaction);

					// Request approval through the session's backend path. The diff
					// editor opens only when the user triggers the custom action.
					const { requestId, promise } = context.session.requestApprovalWithAction({
						toolName,
						actionDescription: t("approval.edit.action", path.basename(uri.path)),
						targetUri: uri.toString(),
						details: t("approval.edit.details"),
						customAction: {
							label: t("approval.edit.customAction"),
							localOnly: true,
							handler: async () => {
								try {
									await this.diffController.openDiff(
										uri,
										transaction.getEditUri(),
									);
								} catch (e: any) {
									vscode.window.showErrorMessage(
										t("editFile.reopenFailed", e.message),
									);
								}
							},
						},
						onApprove: () => transaction.accept(),
						abortSignal: context.abortSignal,
					});

					if (requestId) {
						transaction.state.approvalRequestId = requestId;
					}

					const resolution = await promise;

					this.transactions.delete(uriKey);
					if (transaction.isResolved()) {
						// Overridden by a newer transaction for the same file.
						return;
					}

					if (resolution.kind === "approved") {
						transaction.resolve(
							typeof resolution.payload === "string"
								? resolution.payload
								: "User accepted the changes.",
						);
					} else {
						transaction.resolve(
							context.session.formatApprovalResolution(toolName, resolution) ??
								`[Rejected] The ${toolName} operation was rejected by user.`,
						);
					}
					await transaction.cleanup(this.diffController);
				} catch (e) {
					// Cleanup on error
					this.transactions.delete(uriKey);
					await transaction.cleanup(this.diffController);
					rejectPromise(e);
				}
			})();
		});
	}

	/**
	 * Cancel existing transaction for a file
	 */
	private async cancelExistingTransaction(uriKey: string): Promise<void> {
		const existingTx = this.transactions.get(uriKey);
		if (!existingTx || existingTx.isResolved()) {
			return;
		}
		if (existingTx.state.approvalRequestId) {
			// Resolves the still-pending approval as cancelled; its handler
			// observes the transaction as already resolved and no-ops.
			const session = this.activeSessionForCancellation;
			if (session) {
				session.cancelApproval(existingTx.state.approvalRequestId);
			}
		}
		this.transactions.delete(uriKey);
		existingTx.resolve(
			`[Interrupted] The ${existingTx.state.toolName} tool execution was overridden by a new request.`,
		);
		await existingTx.cleanup(this.diffController);
	}
}

// ============================================================================
// Entry points
// ============================================================================

export function activateEditSupport(_context: vscode.ExtensionContext): void {
	EditTransactionManager.getInstance().initialize();
}

export async function handleEdit(
	uriInput: string,
	newContent: string,
	context: ToolContext,
	toolName: string = "edit",
): Promise<string> {
	return EditTransactionManager.getInstance().requestEdit(
		uriInput,
		newContent,
		context,
		toolName,
	);
}
