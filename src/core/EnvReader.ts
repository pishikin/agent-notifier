import type { ICommandExecutor } from '../types.js';

/**
 * Reads process working directory using `lsof`.
 *
 * Original plan used `sysctl kern.procargs2.<pid>` to read env vars,
 * but Apple blocked this on macOS 15 Sequoia ("unknown oid" error).
 * `lsof -d cwd` is the reliable alternative — it returns the CWD
 * of any process owned by the same user.
 *
 * We no longer need VSCODE_IPC_HOOK_CLI: the parent chain check
 * (hasAncestor → isCursorProcess) is sufficient to confirm the agent
 * runs inside Cursor.
 */
export class EnvReader {
    logDebug?: (msg: string) => void;

    constructor(private readonly executor: ICommandExecutor) {}

    /**
     * Returns the current working directory of the given PID.
     * Uses `lsof -d cwd -Fn -a -p <pid>` which outputs:
     *   p<pid>
     *   fcwd
     *   n<path>
     *
     * Returns null if the process has exited or lsof fails.
     */
    async readCwd(pid: number): Promise<string | null> {
        const { stdout, stderr, exitCode } = await this.executor.exec(
            'lsof', ['-d', 'cwd', '-Fn', '-a', '-p', String(pid)],
        );
        if (exitCode !== 0 || !stdout.trim()) {
            this.logDebug?.(`lsof failed for pid ${pid}: exitCode=${exitCode}, stderr=${stderr.slice(0, 200)}`);
            return null;
        }

        // Parse lsof -Fn output: lines starting with 'n' contain the path
        const lines = stdout.split('\n');
        for (const line of lines) {
            if (line.startsWith('n') && line.length > 1) {
                return line.slice(1);
            }
        }

        return null;
    }
}
