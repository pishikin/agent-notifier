import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventMarker, HookStatus, InstallManifest } from '../../src/types.js';

let tmpHome = '';
let manifest: InstallManifest | null = null;
let hookStatus: HookStatus;
let backgroundMonitorRunning = false;
let ledgerStats: {
    finalizedCount: number;
    reservedCount: number;
    backupCount: number;
    lastFinalized: EventMarker | null;
} = {
    finalizedCount: 0,
    reservedCount: 0,
    backupCount: 0,
    lastFinalized: null,
};
let execMock: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

vi.mock('../../src/utils/paths.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../../src/utils/paths.js')>();
    return {
        ...actual,
        getConfigDir: () => path.join(tmpHome, '.agent-notifier'),
        getHooksDir: () => path.join(tmpHome, '.agent-notifier', 'hooks'),
        getBinDir: () => path.join(tmpHome, '.agent-notifier', 'bin'),
        getShimPath: () => path.join(tmpHome, '.agent-notifier', 'bin', 'agent-notifier-shim'),
        getCodexHookWrapperPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-notify.sh'),
        getCodexStopHookWrapperPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-stop.sh'),
        getCodexPermissionHookWrapperPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-permission-request.sh'),
        getClaudeHookWrapperPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'claude-stop.sh'),
        getClaudeNotificationHookWrapperPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'claude-notification.sh'),
        getInstallManifestPath: () => path.join(tmpHome, '.agent-notifier', 'install-manifest.json'),
        getHooksLogPath: () => path.join(tmpHome, '.agent-notifier', 'logs', 'hooks.log'),
        getEventMarkersDir: () => path.join(tmpHome, '.agent-notifier', 'events', 'markers'),
        getFocusScriptPath: () => path.join(tmpHome, 'focus-window.sh'),
        getCodexHooksPath: () => path.join(tmpHome, '.codex', 'hooks.json'),
    };
});

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
    CommandExecutor: class {
        exec(command: string, args: string[]) {
            return execMock(command, args);
        }
    },
}));

vi.mock('../../src/infra/HookInstaller.js', () => ({
    HookInstaller: class {
        async loadManifest() {
            return manifest;
        }

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
        async getStats() {
            return ledgerStats;
        }
    },
}));

describe('buildDoctorReport', () => {
    beforeEach(async () => {
        tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-notifier-doctor-'));
        await fs.mkdir(path.join(tmpHome, '.agent-notifier', 'hooks'), { recursive: true });
        await fs.mkdir(path.join(tmpHome, '.agent-notifier', 'bin'), { recursive: true });
        await fs.mkdir(path.join(tmpHome, '.agent-notifier', 'logs'), { recursive: true });
        await fs.mkdir(path.join(tmpHome, '.agent-notifier', 'events', 'markers'), { recursive: true });
        await fs.mkdir(path.join(tmpHome, '.codex'), { recursive: true });

        await fs.writeFile(path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-stop.sh'), '#!/bin/bash\n# agent-notifier-managed wrapper-version=3 provider=codex-stop\n', 'utf8');
        await fs.writeFile(path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-permission-request.sh'), '#!/bin/bash\n# agent-notifier-managed wrapper-version=3 provider=codex-permission-request\n', 'utf8');
        await fs.writeFile(path.join(tmpHome, '.agent-notifier', 'hooks', 'claude-stop.sh'), '#!/bin/bash\n# agent-notifier-managed wrapper-version=3 provider=claude-stop\n', 'utf8');
        await fs.writeFile(path.join(tmpHome, '.agent-notifier', 'hooks', 'claude-notification.sh'), '#!/bin/bash\n# agent-notifier-managed wrapper-version=3 provider=claude-notification\n', 'utf8');
        await fs.writeFile(path.join(tmpHome, '.agent-notifier', 'bin', 'agent-notifier-shim'), '#!/usr/bin/env node\n', 'utf8');
        await fs.writeFile(path.join(tmpHome, '.agent-notifier', 'install-manifest.json'), '{}', 'utf8');
        await fs.writeFile(path.join(tmpHome, 'focus-window.sh'), '#!/bin/bash\n', 'utf8');
        await fs.writeFile(path.join(tmpHome, 'agent-notifier-runtime'), '#!/bin/bash\nexit 0\n', 'utf8');
        await fs.writeFile(path.join(tmpHome, '.codex', 'hooks.json'), '{}', 'utf8');

        await fs.chmod(path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-stop.sh'), 0o755);
        await fs.chmod(path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-permission-request.sh'), 0o755);
        await fs.chmod(path.join(tmpHome, '.agent-notifier', 'hooks', 'claude-stop.sh'), 0o755);
        await fs.chmod(path.join(tmpHome, '.agent-notifier', 'hooks', 'claude-notification.sh'), 0o755);
        await fs.chmod(path.join(tmpHome, '.agent-notifier', 'bin', 'agent-notifier-shim'), 0o755);
        await fs.chmod(path.join(tmpHome, 'focus-window.sh'), 0o755);
        await fs.chmod(path.join(tmpHome, 'agent-notifier-runtime'), 0o755);

        await fs.writeFile(
            path.join(tmpHome, '.agent-notifier', 'logs', 'hooks.log'),
            [
                JSON.stringify({ ts: '2026-04-17T00:00:00.000Z', level: 'info', msg: 'hook:duplicate' }),
                JSON.stringify({ ts: '2026-04-17T00:00:01.000Z', level: 'info', msg: 'notification:backend-accepted' }),
            ].join('\n'),
            'utf8',
        );

        manifest = {
            schemaVersion: 3,
            installedAt: '2026-04-17T00:00:00.000Z',
            codexRuntimeMode: 'hooks-first',
            codexHooksFeatureStateBeforeInstall: 'missing',
            shimPath: path.join(tmpHome, '.agent-notifier', 'bin', 'agent-notifier-shim'),
            runtime: { kind: 'binary', command: path.join(tmpHome, 'agent-notifier-runtime') },
            codexStopCommand: "/bin/bash '/tmp/codex-stop.sh'",
            codexPermissionCommand: "/bin/bash '/tmp/codex-permission-request.sh'",
            claudeStopCommand: "/bin/bash '/tmp/claude-stop.sh'",
            claudePermissionPromptCommand: "/bin/bash '/tmp/claude-notification.sh'",
            detectedOtherClaudeStopHooksAtInstall: 0,
            detectedOtherClaudePermissionPromptHooksAtInstall: 0,
            wrapperVersion: 3,
        };
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
        ledgerStats = {
            finalizedCount: 5,
            reservedCount: 0,
            backupCount: 0,
            lastFinalized: {
                schemaVersion: 3,
                eventId: 'evt-1',
                eventIdHash: 'hash',
                source: 'codex-stop',
                agentType: 'codex',
                kind: 'turn-complete',
                workspacePath: '/tmp/project',
                projectName: 'project',
                windowId: 'win',
                occurredAt: '2026-04-17T00:00:00.000Z',
                processingState: 'backend-accepted',
                reservedAt: '2026-04-17T00:00:00.000Z',
                updatedAt: '2026-04-17T00:00:01.000Z',
                finalizedAt: '2026-04-17T00:00:01.000Z',
            },
        };
        execMock = async (command, args) => {
            if (command.endsWith('agent-notifier-shim')) {
                return { stdout: '1.0.0\n', stderr: '', exitCode: 0 };
            }
            if (command === 'which' && args[0] === 'terminal-notifier') {
                return { stdout: '/opt/homebrew/bin/terminal-notifier\n', stderr: '', exitCode: 0 };
            }
            return { stdout: '', stderr: '', exitCode: 0 };
        };
    });

    afterEach(async () => {
        await fs.rm(tmpHome, { recursive: true, force: true });
        vi.resetModules();
    });

    it('reports healthy hooks-first install and includes runtime summaries', async () => {
        const { buildDoctorReport } = await import('../../src/commands/doctor.js');
        const report = await buildDoctorReport();

        expect(report.hasCriticalFailures).toBe(false);
        expect(report.sections[1]?.lines.some(line => line.text.includes('Shim resolves a live agent-notifier runtime.'))).toBe(true);
        expect(report.sections[1]?.lines.some(line => line.text.includes('Codex hooks.json exists'))).toBe(true);
        expect(report.sections[1]?.lines.some(line => line.text.includes('Background monitor is running.'))).toBe(true);
        expect(report.sections[2]?.lines.some(line => line.text.includes('Codex approval path is configured.'))).toBe(true);
        expect(report.sections[4]?.lines.some(line => line.text.includes('Finalized markers: 5'))).toBe(true);
        expect(report.sections[4]?.lines.some(line => line.text.includes('Last finalized event: codex project (turn-complete, backend-accepted)'))).toBe(true);
        expect(report.sections[5]?.lines.some(line => line.text.includes('backend accepted: 1'))).toBe(true);
    });

    it('treats broken runtime and missing provider paths as critical failures', async () => {
        execMock = async (command, args) => {
            if (command.endsWith('agent-notifier-shim')) {
                return { stdout: '', stderr: 'broken', exitCode: 1 };
            }
            if (command === 'which' && args[0] === 'terminal-notifier') {
                return { stdout: '', stderr: '', exitCode: 1 };
            }
            return { stdout: '', stderr: '', exitCode: 0 };
        };
        hookStatus = {
            ...hookStatus,
            codexApprovalConfigured: false,
            otherClaudeStopHooks: 2,
            otherClaudePermissionPromptHooks: 1,
            externalCodexNotifyConfigured: true,
            codexRuntimeMode: 'hybrid',
            staleWrapperVersionDetected: true,
        };
        backgroundMonitorRunning = false;

        const { buildDoctorReport } = await import('../../src/commands/doctor.js');
        const report = await buildDoctorReport();

        expect(report.hasCriticalFailures).toBe(true);
        expect(report.sections[1]?.lines.some(line => line.text.includes('Shim could not resolve'))).toBe(true);
        expect(report.sections[1]?.lines.some(line => line.text.includes('terminal-notifier is missing'))).toBe(true);
        expect(report.sections[1]?.lines.some(line => line.text.includes('Background monitor is not running.'))).toBe(true);
        expect(report.sections[2]?.lines.some(line => line.text.includes('Codex approval path is missing.'))).toBe(true);
        expect(report.sections[3]?.lines.some(line => line.text.includes('hybrid mode'))).toBe(true);
        expect(report.sections[3]?.lines.some(line => line.text.includes('Background monitor is stopped'))).toBe(true);
    });
});
