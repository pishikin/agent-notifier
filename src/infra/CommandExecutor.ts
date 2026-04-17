import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecResult, ICommandExecutor } from '../types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT = 5_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

export class CommandExecutor implements ICommandExecutor {
    async exec(
        command: string,
        args: string[],
        options?: { timeout?: number },
    ): Promise<ExecResult> {
        try {
            const { stdout, stderr } = await execFileAsync(command, args, {
                maxBuffer: DEFAULT_MAX_BUFFER,
                timeout: options?.timeout ?? DEFAULT_TIMEOUT,
            });
            return { stdout, stderr, exitCode: 0 };
        } catch (error: unknown) {
            const e = error as { stdout?: string; stderr?: string; code?: number };
            return {
                stdout: e.stdout ?? '',
                stderr: e.stderr ?? '',
                exitCode: e.code ?? 1,
            };
        }
    }

    execSync(command: string, args: string[]): Buffer | null {
        try {
            return execFileSync(command, args, { maxBuffer: DEFAULT_MAX_BUFFER });
        } catch {
            return null;
        }
    }
}
