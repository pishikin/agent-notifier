import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentTurnEvent, HookEventCandidate, ICommandExecutor, ILogger } from '../types.js';
import { buildWindowId } from '../utils/identity.js';
import { getGitBranch } from '../utils/git.js';

export async function buildAgentTurnEvent(
    candidate: HookEventCandidate,
    options: {
        readonly showGitBranch: boolean;
        readonly executor: ICommandExecutor;
        readonly logger?: ILogger;
    },
): Promise<AgentTurnEvent> {
    const completedAt = new Date().toISOString();
    const projectName = path.basename(candidate.workspacePath);
    const windowId = buildWindowId(candidate.workspacePath);
    const providerEvent = await enrichProviderEvent(candidate);
    const eventId = buildEventId(candidate, providerEvent);

    let event: AgentTurnEvent = {
        eventId,
        source: candidate.source,
        outcome: candidate.outcome ?? 'completed',
        agentType: candidate.agentType,
        workspacePath: candidate.workspacePath,
        projectName,
        completedAt,
        state: 'completed',
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
    providerEvent: AgentTurnEvent['providerEvent'],
): string {
    if (candidate.agentType === 'codex') {
        const turnId = providerEvent?.codexTurnId;
        if (turnId) {
            return `codex-notify:${turnId}`;
        }

        return `codex-notify:${sha256(JSON.stringify({
            source: candidate.source,
            dedupeKeyHint: candidate.dedupeKeyHint,
            workspacePath: candidate.workspacePath,
            providerSessionId: candidate.providerSessionId,
            summary: candidate.summary,
            codexThreadId: providerEvent?.codexThreadId,
        }))}`;
    }

    const identity = {
        source: candidate.source,
        providerSessionId: candidate.providerSessionId,
        transcriptPath: providerEvent?.transcriptPath,
        transcriptStat: providerEvent?.transcriptStat,
        summaryHash: sha256(candidate.summary ?? ''),
        failureType: providerEvent?.failureType,
        workspaceHash: sha256(candidate.workspacePath),
    };
    return `${candidate.source}:${sha256(JSON.stringify(identity))}`;
}

async function enrichProviderEvent(candidate: HookEventCandidate): Promise<AgentTurnEvent['providerEvent']> {
    const transcriptPath = candidate.transcriptPath ?? candidate.providerEvent?.transcriptPath;
    const transcriptStat = transcriptPath ? await readTranscriptStat(transcriptPath) : undefined;

    return {
        ...(candidate.providerEvent ?? {}),
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(transcriptStat ? { transcriptStat } : {}),
    };
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
