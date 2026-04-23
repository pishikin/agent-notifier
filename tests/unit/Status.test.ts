import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventMarker, HookStatus } from '../../src/types.js';

let tmpHome = '';
let hookStatus: HookStatus;
let backgroundMonitorRunning = false;
let recentMarkers: EventMarker[] = [];

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
            return backgroundMonitorRunning;
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
            codexCompletionConfigured: true,
            codexApprovalConfigured: true,
            claudeCompletionConfigured: true,
            claudeApprovalConfigured: true,
            codexRuntimeMode: 'hooks-first',
            codexHooksFeatureEnabled: true,
            externalCodexNotifyConfigured: false,
            otherClaudeStopHooks: 0,
            otherClaudePermissionPromptHooks: 0,
            manifestPresent: true,
            staleWrapperVersionDetected: false,
        };
        backgroundMonitorRunning = true;
        recentMarkers = [];
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await fs.rm(tmpHome, { recursive: true, force: true });
        vi.resetModules();
    });

    it('prints recent marker-based attention events', async () => {
        recentMarkers = [
            {
                schemaVersion: 3,
                eventId: 'evt-1',
                eventIdHash: 'hash',
                source: 'codex-stop',
                agentType: 'codex',
                kind: 'turn-complete',
                workspacePath: '/tmp/project',
                projectName: 'project',
                gitBranch: 'main',
                windowId: 'win',
                occurredAt: '2026-04-17T00:00:00.000Z',
                processingState: 'backend-accepted',
                reservedAt: '2026-04-17T00:00:00.000Z',
                updatedAt: '2026-04-17T00:00:01.000Z',
                finalizedAt: '2026-04-17T00:00:01.000Z',
            },
        ];

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const { statusCommand } = await import('../../src/commands/status.js');
        await statusCommand();

        const output = consoleSpy.mock.calls.flat().join('\n');
        expect(output).toContain('Mode: hooks-first');
        expect(output).toContain('Background monitor: ● running');
        expect(output).toContain('Codex runtime mode: hooks-first');
        expect(output).toContain('Recent attention events');
        expect(output).toContain('codex project · main');
    });

    it('shows install and doctor guidance when health is degraded', async () => {
        hookStatus = {
            ...hookStatus,
            codexCompletionConfigured: false,
            codexApprovalConfigured: false,
            externalCodexNotifyConfigured: true,
            otherClaudeStopHooks: 2,
            otherClaudePermissionPromptHooks: 1,
            staleWrapperVersionDetected: true,
            codexRuntimeMode: 'hybrid',
        };

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const { statusCommand } = await import('../../src/commands/status.js');
        await statusCommand();

        const output = consoleSpy.mock.calls.flat().join('\n');
        expect(output).toContain('Mode: hybrid');
        expect(output).toContain('Codex runtime mode: hybrid');
        expect(output).toContain('Codex external notify: ● present');
        expect(output).toContain('Background monitor: ● running');
        expect(output).toContain('Run `agent-notifier install`');
        expect(output).toContain('Run `agent-notifier doctor`');
    });
});
