import * as vscode from 'vscode';
import * as fs from 'fs';
import { t } from './i18n';

/**
 * Shared debug logger for all Mutsumi modules.
 * Provides a "Mutsumi Debug" output channel plus a persistent log file
 * (under the window's log directory) so startup crashes that take the window
 * down before the output panel initializes still leave a trace on disk.
 */
class DebugLogger {
    private outputChannel?: vscode.OutputChannel;
    private logFile?: string;

    /**
     * Initialize the debug logger. Must be called once during extension activation.
     * @param context - Extension context for registering disposables
     */
    public initialize(context: vscode.ExtensionContext): void {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel(t('outputChannel.debug'));
            context.subscriptions.push(this.outputChannel);
            this.logFile = vscode.Uri.joinPath(context.logUri, 'mutsumi-debug.log').fsPath;
            try {
                fs.mkdirSync(context.logUri.fsPath, { recursive: true });
                fs.appendFileSync(this.logFile, `\n=== Mutsumi log start ${new Date().toISOString()} ===\n`);
            } catch {
                this.logFile = undefined;
            }
        }
    }

    /** Absolute path of the persistent log file (undefined until initialized). */
    public get logFilePath(): string | undefined {
        return this.logFile;
    }

    /**
     * Log a message to the debug channel and the persistent log file.
     * @param message - The message to log
     */
    public log(message: string): void {
        const line = `[${new Date().toLocaleTimeString()}] ${message}`;
        if (this.outputChannel) {
            this.outputChannel.appendLine(line);
        }
        if (this.logFile) {
            try {
                fs.appendFileSync(this.logFile, line + '\n');
            } catch {
                // Logging must never break the extension
            }
        }
    }

    /**
     * Log an error that may precede an extension-host death: goes to the log
     * file and to console.error (which the launching window's debug console
     * captures when running under the extension debugger).
     */
    public fatal(message: string): void {
        this.log(`FATAL: ${message}`);
        console.error(`[Mutsumi] FATAL: ${message}`);
    }

    /**
     * Show the debug channel in the output panel.
     */
    public show(): void {
        this.outputChannel?.show();
    }
}

// Export singleton instance
export const debugLogger = new DebugLogger();
