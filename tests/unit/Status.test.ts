import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookStatus } from '../../src/types.js';

let tmpHome = '';
let hookStatus: HookStatus;
let legacyDaemonRunning = false;
let recentMarkers: Array<Record<string, unknown>> = [];

vi.mock('../../src/utils/paths.js', () => ({
    getActivePath: () => path.join(tmpHome, '.agent-notifier', 'active-sessions.json'),
    getHistoryPath: () => path.join(tmpHome, '.agent-notifier', 'history.json'),
}));

vi.mock('../../src/infra/Config.js', () => ({
    loadConfig: () => ({
        watchProcesses: ['claude', 'codex'],
        scanIntervalMs: 2000,
        notificationSound: 'Glass',
        showGitBranch: true,
        historySize: 50,
        logLevel: 'info',
        logMaxSizeMb: 5,
    }),
}));

vi.mock('../../src/infra/CommandExecutor.js', () => ({
    CommandExecutor: class {},
}));

vi.mock('../../src/infra/HookInstaller.js', () => ({
    HookInstaller: class {
        async getStatus() {
            return hookStatus;
        }
    },
}));

vi.mock('../../src/infra/LaunchAgent.js', () => ({
    LaunchAgent: class {
        async isRunning() {
            return legacyDaemonRunning;
        }
    },
}));

vi.mock('../../src/core/EventLedger.js', () => ({
    EventLedger: class {
        async listRecent() {
            return recentMarkers;
        }
    },
}));

vi.mock('../../src/utils/process.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/utils/process.js')>('../../src/utils/process.js');
    return {
        ...actual,
        formatTimeAgo: () => 'just now',
    };
});

describe('statusCommand', () => {
    beforeEach(async () => {
        tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-notifier-status-'));
        await fs.mkdir(path.join(tmpHome, '.agent-notifier'), { recursive: true });
        hookStatus = {
            codexConfigured: true,
            claudeConfigured: true,
            otherClaudeStopHooks: 0,
            manifestPresent: true,
            staleWrapperVersionDetected: false,
        };
        legacyDaemonRunning = false;
        recentMarkers = [];
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await fs.rm(tmpHome, { recursive: true, force: true });
        vi.resetModules();
    });

    it('prints recent marker-based events', async () => {
        recentMarkers = [
            {
                eventId: 'evt-1',
                agentType: 'codex',
                projectName: 'project',
                gitBranch: 'main',
                outcome: 'completed',
                completedAt: '2026-04-17T00:00:00.000Z',
                finalizedAt: '2026-04-17T00:00:01.000Z',
            },
        ];

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const { statusCommand } = await import('../../src/commands/status.js');
        await statusCommand();

        const output = consoleSpy.mock.calls.flat().join('\n');
        expect(output).toContain('Mode: hook-first');
        expect(output).toContain('Recent completed turns');
        expect(output).toContain('codex project · main');
    });

    it('falls back to install and doctor guidance when health is degraded', async () => {
        hookStatus = {
            codexConfigured: false,
            claudeConfigured: true,
            otherClaudeStopHooks: 2,
            manifestPresent: true,
            staleWrapperVersionDetected: true,
            codexManagedMode: 'chain-existing',
        };

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const { statusCommand } = await import('../../src/commands/status.js');
        await statusCommand();

        const output = consoleSpy.mock.calls.flat().join('\n');
        expect(output).toContain('Run `agent-notifier install`');
        expect(output).toContain('Run `agent-notifier doctor`');
    });
});
