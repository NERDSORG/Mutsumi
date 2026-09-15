import type { ITool } from '../interface';
import { shellTaskRegistry } from '../shell/registry';
import { formatShellOutput } from '../shell/shellTask';

export const killShellTaskTool: ITool = {
    name: 'kill_shell_task',
    definition: {
        name: 'kill_shell_task',
        description: 'Terminate a background shell task. Stops the underlying process (SIGTERM), collects its current full output, and removes (consumes) the task from the registry. Returns the collected output prefixed with a termination notice.',
        parameters: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'The task id returned by a background shell call.' }
            },
            required: ['task_id']
        }
    },
    execute: async (args: any) => {
        const id = args.task_id;
        if (!id) return 'Error: Missing "task_id" argument.';
        const task = shellTaskRegistry.get(id);
        if (!task) return `Error: No background shell task with id "${id}".`;

        task.abort();
        await task.waitForExit();
        shellTaskRegistry.remove(id);

        const snap = task.snapshot();
        return `Task terminated. Output:\n\n${formatShellOutput(snap, { showExit: true })}`;
    },
    prettyPrint: (args: any) => `🛑 Mutsumi killed shell task ${args.task_id || '(unknown)'}`,
    shouldCache: false
};
