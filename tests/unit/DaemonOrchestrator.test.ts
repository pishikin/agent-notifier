import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DaemonOrchestrator } from '../../src/core/DaemonOrchestrator.js';
import type { AgentSession, AppConfig, ILogger, INotificationService, ISessionRegistry } from '../../src/types.js';
import type { ProcessScanner } from '../../src/core/ProcessScanner.js';

function makeLogger(): ILogger {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), close: vi.fn() };
}

function makeSession(pid: number): AgentSession {
    return {
        pid,
        agentType: 'claude',
        ipcSocketPath: `/tmp/ipc-${pid}.sock`,
        workspacePath: '/Users/user/project',
        projectName: 'project',
        discoveredAt: new Date().toISOString(),
        state: 'running',
        windowId: `win${pid}`,
    };
}

const defaultConfig: AppConfig = {
    watchProcesses: ['claude'],
    scanIntervalMs: 100,
    notificationSound: 'Glass',
    showGitBranch: false,
    historySize: 50,
    logLevel: 'info',
    logMaxSizeMb: 5,
};

function makeOrchestrator(overrides: {
    scanResult?: ReturnType<ProcessScanner['scan']>;
    discoverResult?: ReturnType<ProcessScanner['discoverNewSessions']>;
    completions?: AgentSession[];
    notifier?: INotificationService;
    registry?: Partial<ISessionRegistry>;
    logger?: ILogger;
}) {
    const scanner = {
        scan: vi.fn().mockResolvedValue(overrides.scanResult ?? []),
        discoverNewSessions: vi.fn().mockResolvedValue(overrides.discoverResult ?? []),
    } as unknown as ProcessScanner;

    const registry: ISessionRegistry = {
        add: vi.fn(),
        has: vi.fn().mockReturnValue(false),
        getActivePids: vi.fn().mockReturnValue(new Set()),
        detectCompletions: vi.fn().mockReturnValue(overrides.completions ?? []),
        getActive: vi.fn().mockReturnValue([]),
        getHistory: vi.fn().mockReturnValue([]),
        persistActive: vi.fn(),
        ...overrides.registry,
    };

    const notifier: INotificationService = overrides.notifier ?? {
        send: vi.fn().mockResolvedValue(undefined),
    };

    const logger = overrides.logger ?? makeLogger();

    return {
        orchestrator: new DaemonOrchestrator(scanner, registry, notifier, logger, defaultConfig),
        scanner,
        registry,
        notifier,
        logger,
    };
}

describe('DaemonOrchestrator.tick', () => {
    it('sends notification for each completed session', async () => {
        const { orchestrator, notifier } = makeOrchestrator({
            completions: [makeSession(1), makeSession(2)],
        });
        await orchestrator.tick();
        expect(notifier.send).toHaveBeenCalledTimes(2);
    });

    it('continues sending even if one notification throws', async () => {
        const notifier: INotificationService = {
            send: vi.fn()
                .mockRejectedValueOnce(new Error('terminal-notifier unavailable'))
                .mockResolvedValueOnce(undefined),
        };
        const { orchestrator } = makeOrchestrator({
            completions: [makeSession(1), makeSession(2)],
            notifier,
        });
        await orchestrator.tick();
        expect(notifier.send).toHaveBeenCalledTimes(2);
    });

    it('logs error when notification fails', async () => {
        const logger = makeLogger();
        const notifier: INotificationService = {
            send: vi.fn().mockRejectedValue(new Error('fail')),
        };
        const { orchestrator } = makeOrchestrator({
            completions: [makeSession(5)],
            notifier,
            logger,
        });
        await orchestrator.tick();
        expect(logger.error).toHaveBeenCalledWith('notification failed', expect.objectContaining({ pid: 5 }));
    });

    it('adds discovered sessions to registry', async () => {
        const { orchestrator, registry } = makeOrchestrator({
            discoverResult: Promise.resolve([makeSession(99)]),
        });
        await orchestrator.tick();
        expect(registry.add).toHaveBeenCalledWith(expect.objectContaining({ pid: 99 }));
    });

    it('calls persistActive on every tick', async () => {
        const { orchestrator, registry } = makeOrchestrator({});
        await orchestrator.tick();
        expect(registry.persistActive).toHaveBeenCalledTimes(1);
    });

    it('passes knownPids from registry to scanner', async () => {
        const knownPids = new Set([1, 2, 3]);
        const { orchestrator, scanner } = makeOrchestrator({
            registry: { getActivePids: vi.fn().mockReturnValue(knownPids) },
        });
        await orchestrator.tick();
        expect(scanner.discoverNewSessions).toHaveBeenCalledWith(expect.anything(), knownPids);
    });
});

describe('DaemonOrchestrator.runLoop', () => {
    it('stops when AbortSignal is aborted', async () => {
        const { orchestrator } = makeOrchestrator({});
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 150);

        const start = Date.now();
        await orchestrator.runLoop(controller.signal);
        const elapsed = Date.now() - start;

        // Should stop well under 1 second
        expect(elapsed).toBeLessThan(500);
    });

    it('continues after a tick error', async () => {
        let callCount = 0;
        const scanner = {
            scan: vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) throw new Error('scan failed');
                return Promise.resolve([]);
            }),
            discoverNewSessions: vi.fn().mockResolvedValue([]),
        } as unknown as ProcessScanner;

        const registry: ISessionRegistry = {
            add: vi.fn(),
            has: vi.fn().mockReturnValue(false),
            getActivePids: vi.fn().mockReturnValue(new Set()),
            detectCompletions: vi.fn().mockReturnValue([]),
            getActive: vi.fn().mockReturnValue([]),
            getHistory: vi.fn().mockReturnValue([]),
            persistActive: vi.fn(),
        };

        const notifier = { send: vi.fn().mockResolvedValue(undefined) };
        const orchestrator = new DaemonOrchestrator(scanner, registry, notifier, makeLogger(), defaultConfig);

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 250);
        await orchestrator.runLoop(controller.signal);

        // Should have been called at least twice (first threw, second succeeded)
        expect(callCount).toBeGreaterThanOrEqual(2);
    });
});
