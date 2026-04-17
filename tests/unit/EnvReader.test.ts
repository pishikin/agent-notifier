import { describe, it, expect, vi } from 'vitest';
import { EnvReader } from '../../src/core/EnvReader.js';
import type { ICommandExecutor } from '../../src/types.js';

function makeExecutor(stdout = '', exitCode = 0): ICommandExecutor {
    return {
        exec: vi.fn().mockResolvedValue({ stdout, stderr: '', exitCode }),
        execSync: vi.fn().mockReturnValue(null),
    };
}

describe('EnvReader.readCwd', () => {
    it('parses lsof -Fn output correctly', async () => {
        const lsofOutput = 'p67900\nfcwd\nn/Users/user/my-project\n';
        const reader = new EnvReader(makeExecutor(lsofOutput));
        const cwd = await reader.readCwd(67900);
        expect(cwd).toBe('/Users/user/my-project');
    });

    it('returns null when lsof fails', async () => {
        const reader = new EnvReader(makeExecutor('', 1));
        expect(await reader.readCwd(1234)).toBeNull();
    });

    it('returns null when lsof returns empty output', async () => {
        const reader = new EnvReader(makeExecutor(''));
        expect(await reader.readCwd(1234)).toBeNull();
    });

    it('handles paths with spaces', async () => {
        const lsofOutput = 'p100\nfcwd\nn/Users/user/my project/path\n';
        const reader = new EnvReader(makeExecutor(lsofOutput));
        expect(await reader.readCwd(100)).toBe('/Users/user/my project/path');
    });

    it('handles paths with unicode characters', async () => {
        const lsofOutput = 'p200\nfcwd\nn/Users/пользователь/проект\n';
        const reader = new EnvReader(makeExecutor(lsofOutput));
        expect(await reader.readCwd(200)).toBe('/Users/пользователь/проект');
    });

    it('passes correct arguments to lsof', async () => {
        const executor = makeExecutor('p1\nfcwd\nn/tmp\n');
        const reader = new EnvReader(executor);
        await reader.readCwd(5678);
        expect(executor.exec).toHaveBeenCalledWith(
            'lsof',
            ['-d', 'cwd', '-Fn', '-a', '-p', '5678'],
        );
    });

    it('returns null when no path line (n-prefixed) is found', async () => {
        const reader = new EnvReader(makeExecutor('p300\nfcwd\n'));
        expect(await reader.readCwd(300)).toBeNull();
    });
});
