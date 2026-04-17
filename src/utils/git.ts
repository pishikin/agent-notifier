import type { ICommandExecutor } from '../types.js';

/**
 * Returns the current git branch for the given workspace path.
 * Returns undefined if not a git repo or git is unavailable.
 */
export async function getGitBranch(
    workspacePath: string,
    executor: ICommandExecutor,
    timeout = 5_000,
): Promise<string | undefined> {
    const { stdout, exitCode } = await executor.exec('git', [
        '-C', workspacePath,
        'rev-parse', '--abbrev-ref', 'HEAD',
    ], { timeout });
    if (exitCode !== 0) return undefined;
    const branch = stdout.trim();
    return branch.length > 0 ? branch : undefined;
}
