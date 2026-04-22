import fs from 'node:fs';
import { loadConfig } from '../infra/Config.js';
import { CommandExecutor } from '../infra/CommandExecutor.js';
import { HookInstaller } from '../infra/HookInstaller.js';
import { LaunchAgent } from '../infra/LaunchAgent.js';
import { EventLedger } from '../core/EventLedger.js';
import { formatTimeAgo } from '../utils/process.js';
import { getActivePath, getHistoryPath } from '../utils/paths.js';
import type { AgentSession, EventMarker, ILogger, TurnCompletionEvent } from '../types.js';

function readJsonFile<T>(filePath: string): T | null {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
        return null;
    }
}

const silentLogger: ILogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    close: () => undefined,
};

export async function statusCommand(): Promise<void> {
    const executor = new CommandExecutor();
    const hookInstaller = new HookInstaller(executor);
    const launchAgent = new LaunchAgent(executor);
    const config = loadConfig();
    const ledger = new EventLedger(config, silentLogger);

    const [hookStatus, isLegacyDaemonRunning, recentMarkers] = await Promise.all([
        hookInstaller.getStatus(),
        launchAgent.isRunning(),
        ledger.listRecent(10),
    ]);

    console.log(`Mode: ${deriveRuntimeMode(hookStatus, isLegacyDaemonRunning)}`);
    console.log(`Codex completion hook: ${hookStatus.codexCompletionConfigured ? '● configured' : '○ not configured'}`);
    console.log(`Codex approval hook: ${hookStatus.codexApprovalConfigured ? '● configured' : '○ not configured'}`);
    console.log(`Claude completion hook: ${hookStatus.claudeCompletionConfigured ? '● configured' : '○ not configured'}`);
    console.log(`Claude approval hook: ${hookStatus.claudeApprovalConfigured ? '● configured' : '○ not configured'}`);
    console.log(`Legacy daemon: ${isLegacyDaemonRunning ? '● running (legacy)' : '○ stopped (legacy)'}`);

    if (hookStatus.codexRuntimeMode) {
        console.log(`Codex runtime mode: ${hookStatus.codexRuntimeMode}`);
    }
    if (hookStatus.externalCodexNotifyConfigured) {
        console.log('Codex external notify: ● present');
    }

    const active = readJsonFile<AgentSession[]>(getActivePath()) ?? [];
    if (isLegacyDaemonRunning && active.length > 0) {
        console.log(`\nLegacy active sessions: ${active.length}`);
        for (const session of active) {
            const durationSec = Math.round((Date.now() - new Date(session.discoveredAt).getTime()) / 1000);
            const branchLabel = session.gitBranch ? ` (${session.gitBranch})` : '';
            console.log(`  ${session.agentType} [${session.pid}] ${session.projectName}${branchLabel} — ${durationSec}s`);
        }
    }

    if (recentMarkers.length > 0) {
        console.log(`\nRecent attention events (${recentMarkers.length}):`);
        for (const marker of recentMarkers) {
            console.log(`  ${formatMarker(marker)}`);
        }
    } else {
        const legacyHistory = readCompletionHistory().slice(0, 10);
        if (legacyHistory.length > 0) {
            console.log(`\nRecent completed turns (legacy fallback, ${legacyHistory.length}):`);
            for (const event of legacyHistory) {
                const ago = formatTimeAgo(event.completedAt);
                const branchLabel = event.gitBranch ? ` · ${event.gitBranch}` : '';
                console.log(`  ${event.agentType} ${event.projectName}${branchLabel} — ${ago}`);
            }
        } else if (hasConfiguredHooks(hookStatus) || isLegacyDaemonRunning) {
            console.log('\nNo attention events yet');
        }
    }

    if (!hasConfiguredHooks(hookStatus)) {
        console.log('\nRun `agent-notifier install` to configure the missing hooks.');
    }

    if (
        hookStatus.otherClaudeStopHooks > 0
        || hookStatus.otherClaudePermissionPromptHooks > 0
        || hookStatus.externalCodexNotifyConfigured
        || hookStatus.staleWrapperVersionDetected
        || isLegacyDaemonRunning
    ) {
        console.log('\nRun `agent-notifier doctor` for deeper health diagnostics.');
    }
}

function hasConfiguredHooks(hookStatus: Awaited<ReturnType<HookInstaller['getStatus']>>): boolean {
    return hookStatus.codexCompletionConfigured
        && hookStatus.codexApprovalConfigured
        && hookStatus.claudeCompletionConfigured
        && hookStatus.claudeApprovalConfigured;
}

function deriveRuntimeMode(
    hookStatus: Awaited<ReturnType<HookInstaller['getStatus']>>,
    isLegacyDaemonRunning: boolean,
): 'hooks-first' | 'hybrid' | 'notify-fallback' | 'degraded' {
    if (hookStatus.codexRuntimeMode === 'hybrid') {
        return 'hybrid';
    }
    if (hookStatus.codexRuntimeMode === 'notify-fallback') {
        return 'notify-fallback';
    }
    if (hookStatus.codexRuntimeMode === 'hooks-first' && hasConfiguredHooks(hookStatus) && !isLegacyDaemonRunning) {
        return 'hooks-first';
    }
    return 'degraded';
}

function formatMarker(marker: EventMarker): string {
    const when = formatTimeAgo(marker.finalizedAt ?? marker.occurredAt);
    switch (marker.kind) {
        case 'turn-complete': {
            const suffix = marker.gitBranch ? ` · ${marker.gitBranch}` : '';
            return `${marker.agentType} ${marker.projectName}${suffix} — ${when}`;
        }
        case 'turn-failed': {
            const suffix = marker.providerEvent?.failureType ? ` · ${marker.providerEvent.failureType}` : '';
            return `${marker.agentType} ${marker.projectName}${suffix} — ${when}`;
        }
        case 'approval-request': {
            const approvalLabel = marker.providerEvent?.toolName
                ? `${marker.providerEvent.toolName} approval`
                : 'approval needed';
            return `${marker.agentType} ${marker.projectName} · ${approvalLabel} — ${when}`;
        }
    }
}

function readCompletionHistory(): TurnCompletionEvent[] {
    const raw = readJsonFile<unknown[]>(getHistoryPath()) ?? [];
    if (!Array.isArray(raw)) {
        return [];
    }

    return raw
        .map(entry => coerceCompletionEntry(entry))
        .filter((entry): entry is TurnCompletionEvent => entry !== null);
}

function coerceCompletionEntry(value: unknown): TurnCompletionEvent | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const record = value as Record<string, unknown>;
    const agentType = record.agentType;
    const workspacePath = readString(record.workspacePath);
    const projectName = readString(record.projectName);
    const completedAt = readString(record.completedAt) ?? readString(record.discoveredAt);
    const windowId = readString(record.windowId);
    if ((agentType !== 'claude' && agentType !== 'codex') || !workspacePath || !projectName || !completedAt || !windowId) {
        return null;
    }

    const entry: TurnCompletionEvent = {
        eventId: readString(record.eventId) ?? `legacy:${completedAt}:${projectName}`,
        source: readSource(record.source),
        outcome: 'completed',
        agentType,
        workspacePath,
        projectName,
        completedAt,
        state: 'completed',
        windowId,
    };

    const gitBranch = readString(record.gitBranch);
    return gitBranch === undefined ? entry : { ...entry, gitBranch };
}

function readSource(value: unknown): 'codex-notify' | 'claude-stop' | 'claude-stop-failure' | 'legacy-process-exit' {
    if (
        value === 'codex-notify'
        || value === 'claude-stop'
        || value === 'claude-stop-failure'
        || value === 'legacy-process-exit'
    ) {
        return value;
    }
    return 'legacy-process-exit';
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
