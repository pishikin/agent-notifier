import { describe, it, expect, vi } from 'vitest';
import { ProcessScanner, isCursorProcess } from '../../src/core/ProcessScanner.js';
import { EnvReader } from '../../src/core/EnvReader.js';
import type { AppConfig, ICommandExecutor, ILogger, ProcessInfo } from '../../src/types.js';

function makeExecutor(stdout = ''): ICommandExecutor {
    return {
        exec: vi.fn().mockResolvedValue({ stdout, stderr: '', exitCode: 0 }),
        execSync: vi.fn().mockReturnValue(null),
    };
}

function makeLogger(): ILogger {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), close: vi.fn() };
}

const defaultConfig: AppConfig = {
    watchProcesses: ['claude', 'codex'],
    scanIntervalMs: 2000,
    notificationSound: 'Glass',
    showGitBranch: false,
    historySize: 50,
    logLevel: 'info',
    logMaxSizeMb: 5,
};

const PS_HEADER = '  PID  PPID   UID COMM             COMMAND';
const PS_CURSOR = '    1     0   501 Cursor           /Applications/Cursor.app/Contents/MacOS/Cursor';
const PS_CURSOR_HELPER = '    2     1   501 Cursor Helper    /Applications/Cursor.app/Contents/Helper/Cursor Helper';
const PS_TERMINAL = '    3     1   501 bash             /bin/bash';
const PS_CLAUDE = '   10     2   501 claude           /usr/bin/claude --arg';

describe('ProcessScanner.parsePsOutput', () => {
    it('parses standard ps output correctly', () => {
        const executor = makeExecutor();
        const reader = new EnvReader(executor);
        const scanner = new ProcessScanner(executor, reader, defaultConfig, makeLogger());

        const result = scanner.parsePsOutput([PS_HEADER, PS_CLAUDE].join('\n'));
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ pid: 10, ppid: 2, uid: 501, comm: 'claude', command: '/usr/bin/claude --arg' });
    });

    it('returns empty array for header-only output', () => {
        const executor = makeExecutor();
        const scanner = new ProcessScanner(executor, new EnvReader(executor), defaultConfig, makeLogger());
        expect(scanner.parsePsOutput(PS_HEADER)).toEqual([]);
    });

    it('handles commands with spaces', () => {
        const executor = makeExecutor();
        const scanner = new ProcessScanner(executor, new EnvReader(executor), defaultConfig, makeLogger());
        const line = '  500   1   501 node             /usr/bin/node /path/to/my script.js';
        const result = scanner.parsePsOutput([PS_HEADER, line].join('\n'));
        expect(result[0]?.command).toBe('/usr/bin/node /path/to/my script.js');
    });

    it('skips unparseable lines', () => {
        const executor = makeExecutor();
        const scanner = new ProcessScanner(executor, new EnvReader(executor), defaultConfig, makeLogger());
        const result = scanner.parsePsOutput([PS_HEADER, 'garbage line'].join('\n'));
        expect(result).toHaveLength(0);
    });
});

describe('ProcessScanner.discoverNewSessions', () => {
    function makeScannerWithCwd(cwd: string | null) {
        const executor = makeExecutor();
        const envReader = new EnvReader(executor);
        vi.spyOn(envReader, 'readCwd').mockResolvedValue(cwd);
        const scanner = new ProcessScanner(executor, envReader, defaultConfig, makeLogger());
        return { scanner, envReader };
    }

    it('discovers agent with Cursor ancestor and valid CWD', async () => {
        const psOutput = [PS_HEADER, PS_CURSOR, PS_CURSOR_HELPER, PS_CLAUDE].join('\n');
        const { scanner } = makeScannerWithCwd('/Users/user/project');
        const processes = scanner.parsePsOutput(psOutput);
        const sessions = await scanner.discoverNewSessions(processes, new Set());
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.pid).toBe(10);
        expect(sessions[0]?.workspacePath).toBe('/Users/user/project');
        expect(sessions[0]?.projectName).toBe('project');
    });

    it('does NOT match `claude-config`', async () => {
        const psOutput = [PS_HEADER, PS_CURSOR, '   99     1   501 claude-config    /usr/bin/claude-config'].join('\n');
        const { scanner } = makeScannerWithCwd('/Users/user/proj');
        const processes = scanner.parsePsOutput(psOutput);
        const sessions = await scanner.discoverNewSessions(processes, new Set());
        expect(sessions).toHaveLength(0);
    });

    it('does NOT discover agent if ancestor is bash (not Cursor)', async () => {
        const psOutput = [PS_HEADER, PS_TERMINAL, '   10     3   501 claude           /usr/bin/claude'].join('\n');
        const { scanner } = makeScannerWithCwd('/Users/user/proj');
        const processes = scanner.parsePsOutput(psOutput);
        const sessions = await scanner.discoverNewSessions(processes, new Set());
        expect(sessions).toHaveLength(0);
    });

    it('skips agents when CWD cannot be read', async () => {
        const psOutput = [PS_HEADER, PS_CURSOR, PS_CURSOR_HELPER, PS_CLAUDE].join('\n');
        const { scanner } = makeScannerWithCwd(null);
        const processes = scanner.parsePsOutput(psOutput);
        const sessions = await scanner.discoverNewSessions(processes, new Set());
        expect(sessions).toHaveLength(0);
    });

    it('filters already-known PIDs', async () => {
        const psOutput = [PS_HEADER, PS_CURSOR, PS_CURSOR_HELPER, PS_CLAUDE].join('\n');
        const { scanner } = makeScannerWithCwd('/Users/user/proj');
        const processes = scanner.parsePsOutput(psOutput);
        const sessions = await scanner.discoverNewSessions(processes, new Set([10]));
        expect(sessions).toHaveLength(0);
    });

    it('handles cyclic PPIDs without infinite loop', async () => {
        const psOutput = [
            PS_HEADER,
            '  200   201   501 claude           /usr/bin/claude',
            '  201   200   501 bash             /bin/bash',
        ].join('\n');
        const { scanner } = makeScannerWithCwd('/tmp');
        const processes = scanner.parsePsOutput(psOutput);
        const sessions = await scanner.discoverNewSessions(processes, new Set());
        expect(sessions).toHaveLength(0);
    });
});

describe('isCursorProcess', () => {
    const makeProc = (command: string, comm = 'test'): ProcessInfo => ({
        pid: 1, ppid: 0, uid: 501, comm, command,
    });

    it('matches Cursor.app in command', () => {
        expect(isCursorProcess(makeProc('/Applications/Cursor.app/Contents/MacOS/Cursor'))).toBe(true);
    });

    it('matches Cursor Helper in command', () => {
        expect(isCursorProcess(makeProc('/Applications/Cursor.app/Contents/Helper/Cursor Helper'))).toBe(true);
    });

    it('matches comm === Cursor', () => {
        expect(isCursorProcess(makeProc('/bin/other', 'Cursor'))).toBe(true);
    });

    it('does not match unrelated processes', () => {
        expect(isCursorProcess(makeProc('/usr/bin/bash', 'bash'))).toBe(false);
    });
});
