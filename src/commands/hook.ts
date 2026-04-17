import fs from 'node:fs/promises';
import { loadConfig } from '../infra/Config.js';
import { CommandExecutor } from '../infra/CommandExecutor.js';
import { Logger } from '../infra/Logger.js';
import { buildAgentTurnEvent } from '../core/EventIdentity.js';
import { EventLedger } from '../core/EventLedger.js';
import {
    parseClaudeStopPayloadDetailed,
    parseCodexNotifyPayloadDetailed,
} from '../core/HookEventParser.js';
import { NotificationService } from '../core/NotificationService.js';
import type { HookEventCandidate, NotificationSendResult } from '../types.js';
import {
    getConfigDir,
    getFocusScriptPath,
    getHooksLogPath,
    getLogsDir,
} from '../utils/paths.js';

export async function hookCommand(options: { agent?: string; payload?: string }): Promise<void> {
    const agent = options.agent;
    if (agent !== 'claude' && agent !== 'codex') {
        throw new Error(`Unsupported hook agent: ${agent ?? 'unknown'}`);
    }

    const payload = agent === 'claude'
        ? await readStdin()
        : (options.payload ?? '');

    const config = loadConfig();
    await fs.mkdir(getConfigDir(), { recursive: true });
    await fs.mkdir(getLogsDir(), { recursive: true });

    const logger = new Logger(
        getHooksLogPath(),
        config.logLevel,
        config.logMaxSizeMb * 1024 * 1024,
    );

    try {
        logger.info('hook:received', {
            agentType: agent,
            payloadBytes: Buffer.byteLength(payload),
        });

        const parsed = agent === 'claude'
            ? parseClaudeStopPayloadDetailed(payload)
            : parseCodexNotifyPayloadDetailed(payload, process.cwd());

        for (const warning of parsed.warnings) {
            logger.debug(warning, { agentType: agent });
        }

        if (!parsed.candidate) {
            logger.debug('hook:parse-rejected', {
                agentType: agent,
                reason: parsed.rejectionReason ?? 'unknown',
            });
            return;
        }

        const candidate = parsed.candidate;
        if (shouldSuppressSemantically(candidate)) {
            logger.info('hook:semantic-suppressed', buildLogMeta(candidate));
            return;
        }

        const executor = new CommandExecutor();
        const ledger = new EventLedger(config, logger);
        const notifier = new NotificationService(executor, logger, getFocusScriptPath(), config.notificationSound);
        const event = await buildAgentTurnEvent(candidate, {
            showGitBranch: config.showGitBranch,
            executor,
            logger,
        });

        const reservation = await ledger.reserve(event);
        if (reservation.kind === 'duplicate') {
            logger.info('hook:duplicate', buildLogMeta(event));
            return;
        }
        if (reservation.kind === 'inflight') {
            logger.info('hook:inflight', buildLogMeta(event));
            return;
        }

        logger.info('hook:reserved', buildLogMeta(event));

        let sendResult: NotificationSendResult;
        try {
            sendResult = await notifier.send(event);
        } catch (error) {
            sendResult = {
                outcome: 'backend-failed',
                backend: 'none',
                fallbackUsed: false,
                stderr: String(error),
                title: event.outcome === 'failed'
                    ? `${event.agentType} stopped with error`
                    : `${event.agentType} replied`,
                message: event.projectName,
                clickActionEnabled: false,
            };
        }

        try {
            await ledger.finalize(event.eventId, sendResult);
        } catch (error) {
            logger.error('ledger:finalize-failed', {
                ...buildLogMeta(event),
                error: String(error),
            });
            throw error;
        }

        logger.info(mapNotificationMessage(sendResult), {
            ...buildLogMeta(event),
            outcome: event.outcome,
        });
    } finally {
        logger.close();
    }
}

function shouldSuppressSemantically(candidate: HookEventCandidate): boolean {
    return candidate.source === 'claude-stop'
        && candidate.providerEvent?.hookEventName === 'Stop'
        && candidate.providerEvent.claudeStopHookActive === true;
}

function mapNotificationMessage(result: NotificationSendResult): string {
    switch (result.outcome) {
        case 'backend-accepted':
            return 'notification:backend-accepted';
        case 'fallback-accepted':
            return 'notification:fallback-accepted';
        case 'backend-failed':
            return 'notification:backend-failed';
    }
}

function buildLogMeta(candidate: Pick<HookEventCandidate, 'agentType' | 'source' | 'workspacePath' | 'providerSessionId'> & {
    readonly projectName?: string;
    readonly eventId?: string;
    readonly outcome?: string;
}): Record<string, unknown> {
    return {
        ...(candidate.eventId ? { eventId: candidate.eventId } : {}),
        agentType: candidate.agentType,
        source: candidate.source,
        workspacePath: candidate.workspacePath,
        ...(candidate.projectName ? { projectName: candidate.projectName } : {}),
        ...(candidate.providerSessionId ? { providerSessionId: candidate.providerSessionId } : {}),
        ...(candidate.outcome ? { outcome: candidate.outcome } : {}),
    };
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];

    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString('utf8');
}
