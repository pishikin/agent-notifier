import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentAttentionEvent, HookEventCandidate, ICommandExecutor, ILogger } from '../types.js';
import { buildWindowId } from '../utils/identity.js';
import { getGitBranch } from '../utils/git.js';

export async function buildAgentAttentionEvent(
    candidate: HookEventCandidate,
    options: {
        readonly showGitBranch: boolean;
        readonly executor: ICommandExecutor;
        readonly logger?: ILogger;
    },
): Promise<AgentAttentionEvent> {
    const occurredAt = new Date().toISOString();
    const projectName = path.basename(candidate.workspacePath);
    const windowId = buildWindowId(candidate.workspacePath);
    const providerEvent = await enrichProviderEvent(candidate);
    const eventId = buildEventId(candidate, providerEvent);

    let event: AgentAttentionEvent = {
        eventId,
        source: candidate.source,
        kind: candidate.kind,
        agentType: candidate.agentType,
        workspacePath: candidate.workspacePath,
        projectName,
        occurredAt,
        windowId,
        ...(candidate.providerSessionId ? { providerSessionId: candidate.providerSessionId } : {}),
        ...(candidate.summary ? { summary: candidate.summary } : {}),
        ...(providerEvent && Object.keys(providerEvent).length > 0 ? { providerEvent } : {}),
    };

    if (!options.showGitBranch) {
        return event;
    }

    const gitBranch = await getGitBranch(candidate.workspacePath, options.executor, 300);
    if (!gitBranch) {
        if (options.logger) {
            options.logger.debug('hook:git-branch-skipped', {
                workspacePath: candidate.workspacePath,
                source: candidate.source,
            });
        }
        return event;
    }

    event = { ...event, gitBranch };
    return event;
}

export function buildEventId(
    candidate: HookEventCandidate,
    providerEvent: AgentAttentionEvent['providerEvent'],
): string {
    if (candidate.agentType === 'codex') {
        return buildCodexEventId(candidate, providerEvent);
    }

    return buildClaudeEventId(candidate, providerEvent);
}

async function enrichProviderEvent(candidate: HookEventCandidate): Promise<AgentAttentionEvent['providerEvent']> {
    const transcriptPath = candidate.transcriptPath ?? candidate.providerEvent?.transcriptPath;
    const transcriptStat = transcriptPath ? await readTranscriptStat(transcriptPath) : undefined;

    return {
        ...(candidate.providerEvent ?? {}),
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(transcriptStat ? { transcriptStat } : {}),
    };
}

function buildCodexEventId(
    candidate: HookEventCandidate,
    providerEvent: AgentAttentionEvent['providerEvent'],
): string {
    const turnId = providerEvent?.codexTurnId;

    if (candidate.kind === 'approval-request') {
        return `codex-approval:${sha256(JSON.stringify({
            turnId,
            providerSessionId: candidate.providerSessionId,
            dedupeKeyHint: candidate.dedupeKeyHint,
        }))}`;
    }

    if (turnId) {
        return `codex-turn:${turnId}`;
    }

    return `codex-turn:${sha256(JSON.stringify({
        source: candidate.source,
        kind: candidate.kind,
        dedupeKeyHint: candidate.dedupeKeyHint,
        workspacePath: candidate.workspacePath,
        providerSessionId: candidate.providerSessionId,
        summary: candidate.summary,
        codexThreadId: providerEvent?.codexThreadId,
    }))}`;
}

function buildClaudeEventId(
    candidate: HookEventCandidate,
    providerEvent: AgentAttentionEvent['providerEvent'],
): string {
    if (candidate.kind === 'approval-request') {
        return `claude-approval:${sha256(JSON.stringify({
            providerSessionId: candidate.providerSessionId,
            dedupeKeyHint: candidate.dedupeKeyHint,
            workspaceHash: sha256(candidate.workspacePath),
            transcriptPath: providerEvent?.transcriptPath,
            transcriptStat: providerEvent?.transcriptStat,
            notificationType: providerEvent?.notificationType,
            notificationTitle: providerEvent?.notificationTitle,
            notificationMessage: providerEvent?.notificationMessage,
        }))}`;
    }

    return `${candidate.source}:${sha256(JSON.stringify({
        providerSessionId: candidate.providerSessionId,
        transcriptPath: providerEvent?.transcriptPath,
        transcriptStat: providerEvent?.transcriptStat,
        summaryHash: sha256(candidate.summary ?? ''),
        failureType: providerEvent?.failureType,
        workspaceHash: sha256(candidate.workspacePath),
    }))}`;
}

async function readTranscriptStat(transcriptPath: string): Promise<{ size: number; mtimeMs: number } | undefined> {
    try {
        const stat = await fs.stat(transcriptPath);
        return {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
        };
    } catch {
        return undefined;
    }
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}
