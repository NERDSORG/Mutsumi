import type { ITool } from '../interface';
import { shellTaskRegistry } from '../shell/registry';
import { formatShellOutput } from '../shell/shellTask';
import * as vscode from 'vscode';

export const inspectShellTaskTool: ITool = {
    name: 'inspect_shell_task',
    definition: {
        name: 'inspect_shell_task',
        description: 'Inspect a background shell task and retrieve its output. If the task is still running, returns a snapshot without removing it. If the task has exited, returns the full output and consumes (removes) the task from the registry. Optional wait_for parameter waits in the foreground for the specified number of seconds before returning.',
        parameters: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'The task id returned by a background shell call.' },
                wait_for: {
                    type: 'number',
                    description: 'Optional. Seconds to wait in the foreground for the task to exit before returning. 0 or omitted means no foreground wait. -1 means waiting for the default shell sync timeout.'
                    // Other negative values are also allowed for the tool's success rate and compatibility
                }
            },
            required: ['task_id']
        }
    },
    execute: async (args: any) => {
        const id = args.task_id;
        if (!id) return 'Error: Missing "task_id" argument.';
        const task = shellTaskRegistry.get(id);
        if (!task) return `Error: No background shell task with id "${id}".`;

        const waitFor = args.wait_for ?? 0;
        let effectiveWait = 0;
        if (waitFor > 0) {
            effectiveWait = waitFor;
        } else if (waitFor < 0) {
            effectiveWait = vscode.workspace
                .getConfiguration("mutsumi")
                .get<number>("shellSyncTimeout", 60);
        }

        if (effectiveWait > 0 && task.isRunning) {
            await Promise.race([
                task.waitForExit(),
                new Promise<void>((resolve) => setTimeout(resolve, effectiveWait * 1000)),
            ]);
        }

        const snap = task.snapshot();
        const parts: string[] = [];
        if (snap.running) {
            parts.push(`[Task ${id} still running — snapshot, task not removed]`);
        }
        parts.push(formatShellOutput(snap, { showExit: false }));

        if (!snap.running) {
            shellTaskRegistry.remove(id);
        }
        return parts.join('\n\n').trim() || '(no output yet)';
    },
    prettyPrint: (args: any) => `🔍 Mutsumi inspected shell task ${args.task_id || '(unknown)'}`,
    shouldCache: false
};
