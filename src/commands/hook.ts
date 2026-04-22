import fs from 'node:fs/promises';
import { loadConfig } from '../infra/Config.js';
import { CommandExecutor } from '../infra/CommandExecutor.js';
import { Logger } from '../infra/Logger.js';
import { buildAgentAttentionEvent } from '../core/EventIdentity.js';
import { EventLedger } from '../core/EventLedger.js';
import {
    parseClaudeNotificationPayloadDetailed,
    parseClaudeStopPayloadDetailed,
    parseCodexNotifyPayloadDetailed,
    parseCodexPermissionRequestPayloadDetailed,
    parseCodexStopPayloadDetailed,
} from '../core/HookEventParser.js';
import { buildNotificationContent, NotificationService } from '../core/NotificationService.js';
import type { HookEventCandidate, NotificationSendResult } from '../types.js';
import {
    getConfigDir,
    getFocusScriptPath,
    getHooksLogPath,
    getLogsDir,
} from '../utils/paths.js';

type ManagedHookEvent =
    | 'codex'
    | 'codex-notify'
    | 'codex-stop'
    | 'codex-permission-request'
    | 'claude'
    | 'claude-stop'
    | 'claude-notification';

export async function hookCommand(options: { agent?: string; payload?: string }): Promise<void> {
    const hookEvent = normalizeHookEvent(options.agent);
    if (!hookEvent) {
        throw new Error(`Unsupported hook agent: ${options.agent ?? 'unknown'}`);
    }

    const payload = readsPayloadFromStdin(hookEvent)
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
            hookEvent,
            payloadBytes: Buffer.byteLength(payload),
        });

        const parsed = parseHookPayload(hookEvent, payload);
        for (const warning of parsed.warnings) {
            logger.debug(warning, { hookEvent });
        }

        if (!parsed.candidate) {
            logger.debug('hook:parse-rejected', {
                hookEvent,
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
        const event = await buildAgentAttentionEvent(candidate, {
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
            kind: event.kind,
        });
    } finally {
        logger.close();
    }
}

function normalizeHookEvent(value: string | undefined): ManagedHookEvent | null {
    switch (value) {
        case 'codex':
        case 'codex-notify':
        case 'codex-stop':
        case 'codex-permission-request':
        case 'claude':
        case 'claude-stop':
        case 'claude-notification':
            return value;
        default:
            return null;
    }
}

function readsPayloadFromStdin(hookEvent: ManagedHookEvent): boolean {
    switch (hookEvent) {
        case 'codex-stop':
        case 'codex-permission-request':
        case 'claude':
        case 'claude-stop':
        case 'claude-notification':
            return true;
        case 'codex':
        case 'codex-notify':
            return false;
    }
}

function parseHookPayload(hookEvent: ManagedHookEvent, payload: string) {
    switch (hookEvent) {
        case 'codex':
        case 'codex-notify':
            return parseCodexNotifyPayloadDetailed(payload, process.cwd());
        case 'codex-stop':
            return parseCodexStopPayloadDetailed(payload);
        case 'codex-permission-request':
            return parseCodexPermissionRequestPayloadDetailed(payload);
        case 'claude':
        case 'claude-stop':
            return parseClaudeStopPayloadDetailed(payload);
        case 'claude-notification':
            return parseClaudeNotificationPayloadDetailed(payload);
    }
}

function shouldSuppressSemantically(candidate: HookEventCandidate): boolean {
    return (
        (candidate.source === 'claude-stop' || candidate.source === 'codex-stop')
        && candidate.providerEvent?.hookEventName === 'Stop'
        && candidate.providerEvent.stopHookActive === true
    );
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

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];

    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString('utf8');
}
