import fs from 'node:fs';
import { loadConfig } from '../infra/Config.js';
import { CommandExecutor } from '../infra/CommandExecutor.js';
import { Logger } from '../infra/Logger.js';
import { buildAgentAttentionEvent } from '../core/EventIdentity.js';
import { EventLedger } from '../core/EventLedger.js';
import { CodexApprovalLogMonitor } from '../core/CodexApprovalLogMonitor.js';
import { buildNotificationContent, NotificationService } from '../core/NotificationService.js';
import type { HookEventCandidate, NotificationSendResult } from '../types.js';
import {
    getConfigDir,
    getFocusScriptPath,
    getLogPath,
    getLogsDir,
} from '../utils/paths.js';
import { writePidFile, removePidFile, sleep } from '../utils/process.js';

export async function daemonCommand(options: { scanInterval?: string }): Promise<void> {
    const config = loadConfig();

    const overriddenInterval = Number(options.scanInterval);
    if (overriddenInterval >= 500) {
        config.scanIntervalMs = overriddenInterval;
    }

    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.mkdirSync(getLogsDir(), { recursive: true });

    const logger = new Logger(
        getLogPath(),
        config.logLevel,
        config.logMaxSizeMb * 1024 * 1024,
    );
    const executor = new CommandExecutor();
    const ledger = new EventLedger(config, logger);
    const notifier = new NotificationService(executor, logger, getFocusScriptPath(), config.notificationSound);
    const monitor = new CodexApprovalLogMonitor(logger);

    const abortController = new AbortController();
    const shutdown = (signal: string): void => {
        logger.info(`Received ${signal}, shutting down`);
        abortController.abort();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    writePidFile();
    logger.info('Background monitor started', {
        pid: process.pid,
        scanIntervalMs: config.scanIntervalMs,
    });

    while (!abortController.signal.aborted) {
        try {
            const candidates = await monitor.poll();
            for (const candidate of candidates) {
                await processCandidate(candidate, {
                    config,
                    executor,
                    logger,
                    ledger,
                    notifier,
                });
            }
        } catch (error) {
            logger.error('background-monitor:tick-failed', { error: String(error) });
        }

        await sleep(config.scanIntervalMs, { signal: abortController.signal }).catch(() => undefined);
    }

    removePidFile();
    logger.info('Background monitor stopped');
    logger.close();
}

async function processCandidate(
    candidate: HookEventCandidate,
    dependencies: {
        readonly config: ReturnType<typeof loadConfig>;
        readonly executor: CommandExecutor;
        readonly logger: Logger;
        readonly ledger: EventLedger;
        readonly notifier: NotificationService;
    },
): Promise<void> {
    const { config, executor, logger, ledger, notifier } = dependencies;
    const event = await buildAgentAttentionEvent(candidate, {
        showGitBranch: config.showGitBranch,
        executor,
        logger,
    });

    const reservation = await ledger.reserve(event);
    if (reservation.kind === 'duplicate') {
        logger.info('background-monitor:duplicate', buildLogMeta(event));
        return;
    }
    if (reservation.kind === 'inflight') {
        logger.info('background-monitor:inflight', buildLogMeta(event));
        return;
    }

    logger.info('background-monitor:reserved', buildLogMeta(event));

    let sendResult: NotificationSendResult;
    try {
        sendResult = await notifier.send(event);
    } catch (error) {
        const content = buildNotificationContent(event);
        sendResult = {
            outcome: 'backend-failed',
            backend: 'none',
            fallbackUsed: false,
            stderr: String(error),
            title: content.title,
            message: content.message,
            clickActionEnabled: false,
        };
    }

    await ledger.finalize(event.eventId, sendResult);
    logger.info(mapNotificationMessage(sendResult), {
        ...buildLogMeta(event),
        kind: event.kind,
        source: event.source,
    });
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

function buildLogMeta(candidate: Pick<HookEventCandidate, 'agentType' | 'source' | 'workspacePath' | 'providerSessionId' | 'kind'> & {
    readonly projectName?: string;
    readonly eventId?: string;
}): Record<string, unknown> {
    return {
        ...(candidate.eventId ? { eventId: candidate.eventId } : {}),
        agentType: candidate.agentType,
        source: candidate.source,
        kind: candidate.kind,
        workspacePath: candidate.workspacePath,
        ...(candidate.projectName ? { projectName: candidate.projectName } : {}),
        ...(candidate.providerSessionId ? { providerSessionId: candidate.providerSessionId } : {}),
    };
}
