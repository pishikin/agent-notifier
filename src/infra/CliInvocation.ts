import fs from 'node:fs/promises';
import path from 'node:path';
import type { ICommandExecutor, InstallManifest } from '../types.js';
import { sanitizeShellArg } from '../utils/process.js';

export async function resolveCliPath(executor: ICommandExecutor): Promise<string> {
    const { stdout, exitCode } = await executor.exec('which', ['agent-notifier']);
    if (exitCode === 0 && stdout.trim()) {
        try {
            return await fs.realpath(stdout.trim());
        } catch {
            return stdout.trim();
        }
    }

    const argv1 = process.argv[1];
    return argv1 ? path.resolve(argv1) : process.execPath;
}

export async function resolveCliInvocation(executor: ICommandExecutor): Promise<string[]> {
    const cliPath = await resolveCliPath(executor);
    if (isStandaloneCliPath(cliPath)) {
        return [cliPath];
    }
    return [process.execPath, cliPath];
}

export async function resolveCurrentRuntime(
    executor: ICommandExecutor,
): Promise<InstallManifest['runtime']> {
    const cliPath = await resolveCliPath(executor);
    if (isStandaloneCliPath(cliPath)) {
        return {
            kind: 'binary',
            command: cliPath,
        };
    }

    return {
        kind: 'node',
        nodePath: process.execPath,
        entryPath: cliPath,
    };
}

export function runtimeToInvocation(runtime: InstallManifest['runtime']): string[] {
    if (runtime.kind === 'binary') {
        return [runtime.command];
    }
    return [runtime.nodePath, runtime.entryPath];
}

export function shellJoinArgs(args: string[]): string {
    return args.map(sanitizeShellArg).join(' ');
}

function isStandaloneCliPath(cliPath: string): boolean {
    return !cliPath.endsWith('.js') && !cliPath.endsWith('.ts');
}
