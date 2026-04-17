import { describe, it, expect, vi } from 'vitest';
import { NotificationService } from '../../src/core/NotificationService.js';
import { sanitizeShellArg } from '../../src/utils/process.js';
import type { AgentTurnEvent, ICommandExecutor, ILogger } from '../../src/types.js';

function makeLogger(): ILogger {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), close: vi.fn() };
}

function makeExecutor(exitCode = 0): ICommandExecutor {
    return {
        exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode }),
        execSync: vi.fn().mockReturnValue(null),
    };
}

function makeEvent(overrides: Partial<AgentTurnEvent> = {}): AgentTurnEvent {
    return {
        eventId: 'evt-123',
        source: 'claude-stop',
        outcome: 'completed',
        agentType: 'claude',
        workspacePath: '/Users/user/my-project',
        projectName: 'my-project',
        completedAt: '2026-04-17T00:00:00.000Z',
        state: 'completed',
        windowId: 'abc123def456',
        ...overrides,
    };
}

describe('NotificationService.send', () => {
    it('calls terminal-notifier with unique per-event group and returns success result', async () => {
        const executor = makeExecutor(0);
        const service = new NotificationService(executor, makeLogger(), '/path/to/focus.sh', 'Glass');

        const result = await service.send(makeEvent());

        expect(executor.exec).toHaveBeenCalledWith(
            'terminal-notifier',
            expect.arrayContaining([
                '-title', 'claude replied',
                '-message', 'my-project',
                '-sound', 'Glass',
            ]),
        );
        const call = vi.mocked(executor.exec).mock.calls[0];
        const args = call?.[1] ?? [];
        const groupIndex = args.indexOf('-group');
        expect(args[groupIndex + 1]).toMatch(/^agent-notifier-[a-f0-9]{40}$/);
        expect(result).toMatchObject({
            outcome: 'backend-accepted',
            backend: 'terminal-notifier',
            fallbackUsed: false,
            clickActionEnabled: true,
        });
    });

    it('includes git branch in message body when present', async () => {
        const executor = makeExecutor(0);
        const service = new NotificationService(executor, makeLogger(), '/path/to/focus.sh', 'Glass');

        await service.send(makeEvent({ gitBranch: 'main' }));

        const call = vi.mocked(executor.exec).mock.calls[0];
        const args = call?.[1] ?? [];
        const msgIdx = args.indexOf('-message');
        expect(args[msgIdx + 1]).toBe('my-project · main');
    });

    it('formats failure notifications using failure type', async () => {
        const executor = makeExecutor(0);
        const service = new NotificationService(executor, makeLogger(), '/path/to/focus.sh', 'Glass');

        const result = await service.send(makeEvent({
            agentType: 'claude',
            source: 'claude-stop-failure',
            outcome: 'failed',
            providerEvent: { hookEventName: 'StopFailure', failureType: 'tool_error' },
        }));

        expect(result.title).toBe('claude stopped with error');
        expect(result.message).toBe('my-project · tool_error');
    });

    it('uses osascript fallback when terminal-notifier fails', async () => {
        const executor: ICommandExecutor = {
            exec: vi.fn()
                .mockResolvedValueOnce({ stdout: '', stderr: 'not found', exitCode: 127 })
                .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }),
            execSync: vi.fn().mockReturnValue(null),
        };
        const logger = makeLogger();
        const service = new NotificationService(executor, logger, '/focus.sh', 'Glass');

        const result = await service.send(makeEvent());

        expect(executor.exec).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            outcome: 'fallback-accepted',
            backend: 'osascript',
            fallbackUsed: true,
            clickActionEnabled: false,
        });
        expect(logger.warn).toHaveBeenCalled();
    });

    it('returns backend-failed when primary and fallback both fail', async () => {
        const executor: ICommandExecutor = {
            exec: vi.fn()
                .mockResolvedValueOnce({ stdout: '', stderr: 'not found', exitCode: 127 })
                .mockResolvedValueOnce({ stdout: '', stderr: 'osascript failed', exitCode: 1 }),
            execSync: vi.fn().mockReturnValue(null),
        };
        const service = new NotificationService(executor, makeLogger(), '/focus.sh', 'Glass');

        const result = await service.send(makeEvent());

        expect(result).toMatchObject({
            outcome: 'backend-failed',
            backend: 'terminal-notifier',
            fallbackUsed: true,
            clickActionEnabled: false,
        });
    });

    it('sanitizes workspace path in -execute argument', async () => {
        const executor = makeExecutor(0);
        const service = new NotificationService(executor, makeLogger(), '/focus.sh', 'Glass');

        const weirdPath = "/Users/user/project with spaces & $pecial";
        await service.send(makeEvent({ workspacePath: weirdPath, projectName: 'project with spaces & $pecial' }));

        const call = vi.mocked(executor.exec).mock.calls[0];
        const executeArg = call?.[1]?.find((_, i, arr) => arr[i - 1] === '-execute') ?? '';
        expect(executeArg).toContain(sanitizeShellArg(weirdPath));
    });
});

describe('sanitizeShellArg', () => {
    it('wraps plain values in single quotes', () => {
        expect(sanitizeShellArg('hello')).toBe("'hello'");
    });

    it('handles spaces', () => {
        expect(sanitizeShellArg('my project')).toBe("'my project'");
    });

    it('escapes existing single quotes', () => {
        expect(sanitizeShellArg("it's")).toBe("'it'\\''s'");
    });

    it('handles shell metacharacters', () => {
        const value = '$(rm -rf /)';
        const safe = sanitizeShellArg(value);
        expect(safe.startsWith("'")).toBe(true);
        expect(safe.endsWith("'")).toBe(true);
    });

    it('handles empty string', () => {
        expect(sanitizeShellArg('')).toBe("''");
    });
});
