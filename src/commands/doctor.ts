import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { loadConfig } from '../infra/Config.js';
import { CommandExecutor } from '../infra/CommandExecutor.js';
import { HookInstaller } from '../infra/HookInstaller.js';
import { LaunchAgent } from '../infra/LaunchAgent.js';
import { EventLedger } from '../core/EventLedger.js';
import type { ILogger } from '../types.js';
import {
    getBinDir,
    getClaudeHookWrapperPath,
    getClaudeNotificationHookWrapperPath,
    getConfigDir,
    getCodexHooksPath,
    getCodexPermissionHookWrapperPath,
    getCodexStopHookWrapperPath,
    getEventMarkersDir,
    getFocusScriptPath,
    getHooksDir,
    getHooksLogPath,
    getInstallManifestPath,
    getShimPath,
} from '../utils/paths.js';

interface DoctorLine {
    readonly level: 'ok' | 'warn' | 'error' | 'info';
    readonly text: string;
}

interface DoctorSection {
    readonly title: string;
    readonly lines: DoctorLine[];
}

interface DoctorReport {
    readonly sections: DoctorSection[];
    readonly hasCriticalFailures: boolean;
}

const silentLogger: ILogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    close: () => undefined,
};

export async function doctorCommand(): Promise<void> {
    const report = await buildDoctorReport();

    for (const section of report.sections) {
        console.log(`\n${section.title}`);
        for (const line of section.lines) {
            console.log(`  ${symbolForLevel(line.level)} ${line.text}`);
        }
    }

    if (report.hasCriticalFailures) {
        process.exitCode = 1;
    }
}

export async function buildDoctorReport(): Promise<DoctorReport> {
    const executor = new CommandExecutor();
    const hookInstaller = new HookInstaller(executor);
    const launchAgent = new LaunchAgent(executor);
    const config = loadConfig();
    const ledger = new EventLedger(config, silentLogger);
    const manifest = await hookInstaller.loadManifest();
    const status = await hookInstaller.getStatus();
    const legacyDaemonRunning = await launchAgent.isRunning();

    const sections: DoctorSection[] = [];
    let hasCriticalFailures = false;

    const artifacts = await buildArtifactsSection(status.manifestPresent);
    hasCriticalFailures ||= artifacts.lines.some(line => line.level === 'error');
    sections.push(artifacts);

    const runtime = await buildRuntimeSection(executor, manifest);
    hasCriticalFailures ||= runtime.lines.some(line => line.level === 'error');
    sections.push(runtime);

    const provider = await buildProviderSection(status);
    hasCriticalFailures ||= provider.lines.some(line => line.level === 'error');
    sections.push(provider);

    sections.push(buildSemanticRiskSection(status, legacyDaemonRunning));
    sections.push(await buildLedgerSection(ledger));
    sections.push(await buildRecentHooksSection());
    sections.push({
        title: 'Section 7 — macOS limitations / manual checks',
        lines: [
            {
                level: 'info',
                text: 'Doctor cannot verify whether macOS visibly displayed notifications or whether Focus suppressed them.',
            },
            {
                level: 'info',
                text: 'Click-to-focus is still best-effort and may depend on Accessibility or Automation prompts outside this CLI.',
            },
        ],
    });

    return { sections, hasCriticalFailures };
}

async function buildArtifactsSection(manifestPresent: boolean): Promise<DoctorSection> {
    const lines: DoctorLine[] = [];

    const artifactChecks = await Promise.all([
        checkExists(getConfigDir(), true, 'Config dir exists'),
        checkExists(getHooksDir(), true, 'Hooks dir exists'),
        checkExists(getBinDir(), true, 'Bin dir exists'),
        checkExecutable(getShimPath(), 'Shim exists and is executable'),
        checkExecutable(getCodexStopHookWrapperPath(), 'Codex Stop wrapper exists and is executable'),
        checkExecutable(getCodexPermissionHookWrapperPath(), 'Codex PermissionRequest wrapper exists and is executable'),
        checkExecutable(getClaudeHookWrapperPath(), 'Claude Stop wrapper exists and is executable'),
        checkExecutable(getClaudeNotificationHookWrapperPath(), 'Claude permission_prompt Notification wrapper exists and is executable'),
        checkExists(getInstallManifestPath(), false, 'Install manifest exists'),
    ]);

    lines.push(...artifactChecks);
    if (!manifestPresent) {
        lines.push({
            level: 'error',
            text: 'Install manifest is missing or unreadable.',
        });
    }

    return {
        title: 'Section 1 — managed install artifacts',
        lines,
    };
}

async function buildRuntimeSection(
    executor: CommandExecutor,
    manifest: Awaited<ReturnType<HookInstaller['loadManifest']>>,
): Promise<DoctorSection> {
    const lines: DoctorLine[] = [];
    const shimResult = await executor.exec(getShimPath(), ['--version']);
    lines.push({
        level: shimResult.exitCode === 0 ? 'ok' : 'error',
        text: shimResult.exitCode === 0
            ? 'Shim resolves a live agent-notifier runtime.'
            : 'Shim could not resolve a live agent-notifier runtime.',
    });

    if (manifest?.runtime.kind === 'binary') {
        lines.push(await checkExecutable(manifest.runtime.command, 'Manifest binary runtime exists and is executable'));
    } else if (manifest?.runtime.kind === 'node') {
        lines.push(await checkExecutable(manifest.runtime.nodePath, 'Manifest node runtime exists and is executable'));
        lines.push(await checkExists(manifest.runtime.entryPath, false, 'Manifest entry path exists'));
    } else {
        lines.push({ level: 'error', text: 'Manifest runtime is missing.' });
    }

    const terminalNotifier = await executor.exec('which', ['terminal-notifier']);
    lines.push({
        level: terminalNotifier.exitCode === 0 ? 'ok' : 'error',
        text: terminalNotifier.exitCode === 0
            ? 'terminal-notifier is available on PATH.'
            : 'terminal-notifier is missing from PATH.',
    });

    lines.push(await checkExecutable(getFocusScriptPath(), 'Focus script exists and is executable'));
    lines.push(await checkExists(getCodexHooksPath(), false, 'Codex hooks.json exists'));

    return {
        title: 'Section 2 — runtime target health',
        lines,
    };
}

async function buildProviderSection(status: Awaited<ReturnType<HookInstaller['getStatus']>>): Promise<DoctorSection> {
    return {
        title: 'Section 3 — provider configuration health',
        lines: [
            {
                level: status.codexCompletionConfigured ? 'ok' : 'error',
                text: status.codexCompletionConfigured
                    ? 'Codex completion path is configured.'
                    : 'Codex completion path is missing.',
            },
            {
                level: status.codexApprovalConfigured ? 'ok' : 'error',
                text: status.codexApprovalConfigured
                    ? 'Codex approval path is configured.'
                    : 'Codex approval path is missing.',
            },
            {
                level: status.claudeCompletionConfigured ? 'ok' : 'error',
                text: status.claudeCompletionConfigured
                    ? 'Claude managed Stop hook is installed.'
                    : 'Claude managed Stop hook is missing.',
            },
            {
                level: status.claudeApprovalConfigured ? 'ok' : 'error',
                text: status.claudeApprovalConfigured
                    ? 'Claude managed permission_prompt Notification hook is installed.'
                    : 'Claude managed permission_prompt Notification hook is missing.',
            },
            {
                level: status.codexHooksFeatureEnabled ? 'ok' : 'warn',
                text: status.codexHooksFeatureEnabled
                    ? 'Codex hooks feature flag is enabled.'
                    : 'Codex hooks feature flag is disabled.',
            },
        ],
    };
}

function buildSemanticRiskSection(
    status: Awaited<ReturnType<HookInstaller['getStatus']>>,
    legacyDaemonRunning: boolean,
): DoctorSection {
    const lines: DoctorLine[] = [];

    if (status.otherClaudeStopHooks > 0) {
        lines.push({
            level: 'warn',
            text: `Detected ${status.otherClaudeStopHooks} other Claude Stop hook(s).`,
        });
    }
    if (status.otherClaudePermissionPromptHooks > 0) {
        lines.push({
            level: 'warn',
            text: `Detected ${status.otherClaudePermissionPromptHooks} other Claude permission_prompt Notification hook(s).`,
        });
    }
    if (status.externalCodexNotifyConfigured) {
        lines.push({
            level: 'warn',
            text: 'Codex has an external notify command configured; duplicate desktop notifications are possible.',
        });
    }
    if (status.codexRuntimeMode === 'notify-fallback') {
        lines.push({
            level: 'warn',
            text: 'Codex is still running in legacy notify-fallback mode.',
        });
    }
    if (status.codexRuntimeMode === 'hybrid') {
        lines.push({
            level: 'warn',
            text: 'Codex is in hybrid mode; hooks-first and notify-fallback are both active.',
        });
    }
    if (status.staleWrapperVersionDetected) {
        lines.push({
            level: 'warn',
            text: 'Managed wrapper version header is missing or stale.',
        });
    }
    if (legacyDaemonRunning) {
        lines.push({
            level: 'warn',
            text: 'Legacy daemon is still running and should remain out of the critical path.',
        });
    }
    if (lines.length === 0) {
        lines.push({
            level: 'ok',
            text: 'No semantic risk flags detected.',
        });
    }

    return {
        title: 'Section 4 — semantic risk warnings',
        lines,
    };
}

async function buildLedgerSection(ledger: EventLedger): Promise<DoctorSection> {
    const stats = await ledger.getStats();
    return {
        title: 'Section 5 — event ledger health',
        lines: [
            await checkExists(getEventMarkersDir(), true, 'Marker directory exists'),
            { level: 'info', text: `Finalized markers: ${stats.finalizedCount}` },
            { level: stats.reservedCount > 0 ? 'warn' : 'ok', text: `Reserved/inflight markers: ${stats.reservedCount}` },
            { level: stats.backupCount > 0 ? 'warn' : 'ok', text: `Backup markers: ${stats.backupCount}` },
            {
                level: stats.lastFinalized ? 'info' : 'warn',
                text: stats.lastFinalized
                    ? `Last finalized event: ${stats.lastFinalized.agentType} ${stats.lastFinalized.projectName} (${stats.lastFinalized.kind}, ${stats.lastFinalized.processingState})`
                    : 'No finalized markers yet.',
            },
        ],
    };
}

async function buildRecentHooksSection(): Promise<DoctorSection> {
    const counts = await summarizeHookLog();
    return {
        title: 'Section 6 — recent hook runtime health',
        lines: [
            { level: 'info', text: `parse rejected: ${counts['hook:parse-rejected'] ?? 0}` },
            { level: 'info', text: `semantic suppressions: ${counts['hook:semantic-suppressed'] ?? 0}` },
            { level: 'info', text: `duplicates: ${counts['hook:duplicate'] ?? 0}` },
            { level: 'info', text: `backend accepted: ${counts['notification:backend-accepted'] ?? 0}` },
            { level: 'info', text: `fallback accepted: ${counts['notification:fallback-accepted'] ?? 0}` },
            {
                level: (counts['notification:backend-failed'] ?? 0) > 0 ? 'warn' : 'info',
                text: `backend failed: ${counts['notification:backend-failed'] ?? 0}`,
            },
        ],
    };
}

async function summarizeHookLog(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    try {
        const raw = await fs.readFile(getHooksLogPath(), 'utf8');
        const lines = raw.trim().split('\n').filter(Boolean).slice(-200);
        for (const line of lines) {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const msg = typeof parsed.msg === 'string' ? parsed.msg : null;
            if (!msg) {
                continue;
            }
            counts[msg] = (counts[msg] ?? 0) + 1;
        }
    } catch {
        return counts;
    }
    return counts;
}

async function checkExists(targetPath: string, expectDirectory: boolean, label: string): Promise<DoctorLine> {
    try {
        const stat = await fs.stat(targetPath);
        const ok = expectDirectory ? stat.isDirectory() : stat.isFile();
        return {
            level: ok ? 'ok' : 'error',
            text: ok ? label : `${label}: wrong file type`,
        };
    } catch {
        return {
            level: 'error',
            text: `${label}: missing`,
        };
    }
}

async function checkExecutable(targetPath: string, label: string): Promise<DoctorLine> {
    try {
        await fs.access(targetPath, fsConstants.X_OK);
        return { level: 'ok', text: label };
    } catch {
        return { level: 'error', text: `${label}: missing or not executable` };
    }
}

function symbolForLevel(level: DoctorLine['level']): string {
    switch (level) {
        case 'ok':
            return '✓';
        case 'warn':
            return '!';
        case 'error':
            return '✗';
        case 'info':
            return 'i';
    }
}
