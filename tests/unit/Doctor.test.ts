import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookStatus, InstallManifest } from '../../src/types.js';

let tmpHome = '';
let manifest: InstallManifest | null = null;
let hookStatus: HookStatus;
let legacyDaemonRunning = false;
let ledgerStats = {
    finalizedCount: 0,
    reservedCount: 0,
    backupCount: 0,
    lastFinalized: null,
};
let execMock: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

vi.mock('../../src/utils/paths.js', () => ({
    getConfigDir: () => path.join(tmpHome, '.agent-notifier'),
    getHooksDir: () => path.join(tmpHome, '.agent-notifier', 'hooks'),
    getBinDir: () => path.join(tmpHome, '.agent-notifier', 'bin'),
    getShimPath: () => path.join(tmpHome, '.agent-notifier', 'bin', 'agent-notifier-shim'),
    getCodexHookWrapperPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-notify.sh'),
    getClaudeHookWrapperPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'claude-stop.sh'),
    getInstallManifestPath: () => path.join(tmpHome, '.agent-notifier', 'install-manifest.json'),
    getHooksLogPath: () => path.join(tmpHome, '.agent-notifier', 'logs', 'hooks.log'),
    getEventMarkersDir: () => path.join(tmpHome, '.agent-notifier', 'events', 'markers'),
    getFocusScriptPath: () => path.join(tmpHome, 'focus-window.sh'),
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
            return legacyDaemonRunning;
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
        await fs.writeFile(path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-notify.sh'), '#!/bin/bash\n# agent-notifier-managed wrapper-version=2 provider=codex\n', 'utf8');
        await fs.writeFile(path.join(tmpHome, '.agent-notifier', 'hooks', 'claude-stop.sh'), '#!/bin/bash\n# agent-notifier-managed wrapper-version=2 provider=claude\n', 'utf8');
        await fs.writeFile(path.join(tmpHome, '.agent-notifier', 'bin', 'agent-notifier-shim'), '#!/usr/bin/env node\n', 'utf8');
        await fs.writeFile(path.join(tmpHome, '.agent-notifier', 'install-manifest.json'), '{}', 'utf8');
        await fs.writeFile(path.join(tmpHome, 'focus-window.sh'), '#!/bin/bash\n', 'utf8');
        await fs.writeFile(path.join(tmpHome, 'agent-notifier-runtime'), '#!/bin/bash\nexit 0\n', 'utf8');
        await fs.chmod(path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-notify.sh'), 0o755);
        await fs.chmod(path.join(tmpHome, '.agent-notifier', 'hooks', 'claude-stop.sh'), 0o755);
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
            schemaVersion: 2,
            installedAt: '2026-04-17T00:00:00.000Z',
            codexManagedMode: 'exclusive-managed',
            shimPath: path.join(tmpHome, '.agent-notifier', 'bin', 'agent-notifier-shim'),
            runtime: { kind: 'binary', command: path.join(tmpHome, 'agent-notifier-runtime') },
            claudeManagedCommand: '/bin/bash /tmp/claude-stop.sh',
            detectedOtherClaudeStopHooksAtInstall: 0,
            wrapperVersion: 2,
        };
        hookStatus = {
            codexConfigured: true,
            claudeConfigured: true,
            otherClaudeStopHooks: 0,
            manifestPresent: true,
            staleWrapperVersionDetected: false,
        };
        legacyDaemonRunning = false;
        ledgerStats = {
            finalizedCount: 5,
            reservedCount: 0,
            backupCount: 0,
            lastFinalized: {
                schemaVersion: 2,
                eventId: 'evt-1',
                eventIdHash: 'hash',
                source: 'codex-notify',
                agentType: 'codex',
                outcome: 'completed',
                workspacePath: '/tmp/project',
                projectName: 'project',
                windowId: 'win',
                completedAt: '2026-04-17T00:00:00.000Z',
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

    it('reports healthy install and includes ledger/runtime summaries', async () => {
        const { buildDoctorReport } = await import('../../src/commands/doctor.js');
        const report = await buildDoctorReport();

        expect(report.hasCriticalFailures).toBe(false);
        expect(report.sections[1]?.lines.some(line => line.text.includes('Shim resolves a live agent-notifier runtime.'))).toBe(true);
        expect(report.sections[4]?.lines.some(line => line.text.includes('Finalized markers: 5'))).toBe(true);
        expect(report.sections[5]?.lines.some(line => line.text.includes('backend accepted: 1'))).toBe(true);
    });

    it('treats broken shim target and missing terminal-notifier as critical failures', async () => {
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
            otherClaudeStopHooks: 2,
            codexManagedMode: 'chain-existing',
            staleWrapperVersionDetected: true,
        };
        legacyDaemonRunning = true;

        const { buildDoctorReport } = await import('../../src/commands/doctor.js');
        const report = await buildDoctorReport();

        expect(report.hasCriticalFailures).toBe(true);
        expect(report.sections[1]?.lines.some(line => line.text.includes('Shim could not resolve'))).toBe(true);
        expect(report.sections[1]?.lines.some(line => line.text.includes('terminal-notifier is missing'))).toBe(true);
        expect(report.sections[3]?.lines.some(line => line.text.includes('chain-existing'))).toBe(true);
        expect(report.sections[3]?.lines.some(line => line.text.includes('Legacy daemon'))).toBe(true);
    });
});
