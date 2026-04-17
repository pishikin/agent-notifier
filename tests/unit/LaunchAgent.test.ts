import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LaunchAgent } from '../../src/infra/LaunchAgent.js';
import type { ICommandExecutor } from '../../src/types.js';

// Prevent install() from actually writing to ~/Library/LaunchAgents/
vi.mock('node:fs/promises', () => ({
    default: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
        rm: vi.fn().mockResolvedValue(undefined),
        realpath: vi.fn().mockImplementation((p: string) => Promise.resolve(p)),
    },
}));

function makeExecutor(overrides?: Partial<ICommandExecutor>): ICommandExecutor {
    return {
        exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
        execSync: vi.fn().mockReturnValue(null),
        ...overrides,
    };
}

// Access private method for testing plist generation
function getPlist(agent: LaunchAgent, cliPath: string): string {
    // @ts-expect-error — testing private method
    return agent.generatePlist(cliPath) as string;
}

describe('LaunchAgent.generatePlist', () => {
    it('produces valid plist XML with the label', () => {
        const agent = new LaunchAgent(makeExecutor());
        const plist = getPlist(agent, '/usr/local/bin/agent-notifier');
        expect(plist).toContain('<string>com.agent-notifier.daemon</string>');
    });

    it('includes homebrew PATH in EnvironmentVariables', () => {
        const agent = new LaunchAgent(makeExecutor());
        const plist = getPlist(agent, '/usr/local/bin/agent-notifier');
        expect(plist).toContain('/opt/homebrew/bin');
    });

    it('escapes & in paths', () => {
        const agent = new LaunchAgent(makeExecutor());
        const plist = getPlist(agent, '/usr/local/bin/agent&notifier');
        expect(plist).toContain('&amp;');
        expect(plist).not.toContain('agent&notifier');
    });

    it('escapes < in paths', () => {
        const agent = new LaunchAgent(makeExecutor());
        const plist = getPlist(agent, '/usr/local/bin/agent<notifier');
        expect(plist).toContain('&lt;');
    });

    it('uses node + script for .js path (not standalone)', () => {
        const agent = new LaunchAgent(makeExecutor());
        const plist = getPlist(agent, '/usr/local/lib/node_modules/agent-notifier/dist/index.js');
        // Should include node executable path
        expect(plist).toContain(process.execPath);
    });

    it('treats binary without .js/.ts as standalone (no node prefix)', () => {
        const agent = new LaunchAgent(makeExecutor());
        const plist = getPlist(agent, '/usr/local/bin/agent-notifier');
        // Should NOT include node executable when binary is standalone
        const nodePathInArgs = plist.indexOf(process.execPath);
        const programArgsSection = plist.indexOf('<key>ProgramArguments</key>');
        const firstArrayString = plist.indexOf('<string>', programArgsSection);
        // node path should not appear in ProgramArguments before the binary
        if (nodePathInArgs !== -1) {
            expect(nodePathInArgs).toBeGreaterThan(plist.indexOf('</array>', programArgsSection));
        }
    });
});

describe('LaunchAgent.install', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('calls bootout before bootstrap', async () => {
        const launchctlArgs: string[][] = [];
        const executor: ICommandExecutor = {
            exec: vi.fn().mockImplementation((_cmd: string, args: string[]) => {
                if (args[0] === 'bootout' || args[0] === 'bootstrap') {
                    launchctlArgs.push(args);
                }
                return Promise.resolve({ stdout: '/usr/local/bin/agent-notifier\n', stderr: '', exitCode: 0 });
            }),
            execSync: vi.fn().mockReturnValue(null),
        };

        const agent = new LaunchAgent(executor);
        await agent.install();

        expect(launchctlArgs[0]?.[0]).toBe('bootout');
        expect(launchctlArgs[1]?.[0]).toBe('bootstrap');
    });

    it('throws when bootstrap fails', async () => {
        const executor: ICommandExecutor = {
            exec: vi.fn()
                .mockResolvedValueOnce({ stdout: '/usr/local/bin/agent-notifier\n', stderr: '', exitCode: 0 }) // which
                .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })   // bootout (OK)
                .mockResolvedValueOnce({ stdout: '', stderr: 'error msg', exitCode: 1 }), // bootstrap (fail)
            execSync: vi.fn().mockReturnValue(null),
        };

        const agent = new LaunchAgent(executor);
        await expect(agent.install()).rejects.toThrow('launchctl bootstrap failed');
    });
});

describe('LaunchAgent.isRunning', () => {
    it('returns true when launchctl print shows state = running', async () => {
        const executor = makeExecutor({
            exec: vi.fn().mockResolvedValue({
                stdout: 'label = com.agent-notifier.daemon\nstate = running\n',
                stderr: '',
                exitCode: 0,
            }),
        });
        const agent = new LaunchAgent(executor);
        expect(await agent.isRunning()).toBe(true);
    });

    it('returns false when launchctl print shows state = waiting', async () => {
        const executor = makeExecutor({
            exec: vi.fn().mockResolvedValue({
                stdout: 'state = waiting\n',
                stderr: '',
                exitCode: 0,
            }),
        });
        const agent = new LaunchAgent(executor);
        expect(await agent.isRunning()).toBe(false);
    });

    it('returns false when launchctl print fails (service not loaded)', async () => {
        const executor = makeExecutor({
            exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 }),
        });
        const agent = new LaunchAgent(executor);
        expect(await agent.isRunning()).toBe(false);
    });
});
