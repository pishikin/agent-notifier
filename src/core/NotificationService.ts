import { createHash } from 'node:crypto';
import type {
    AgentTurnEvent,
    ICommandExecutor,
    ILogger,
    INotificationService,
    NotificationSendResult,
} from '../types.js';
import { sanitizeShellArg } from '../utils/process.js';

export class NotificationService implements INotificationService {
    constructor(
        private readonly executor: ICommandExecutor,
        private readonly logger: ILogger,
        private readonly focusScriptPath: string,
        private readonly sound: string,
    ) {}

    async send(target: AgentTurnEvent): Promise<NotificationSendResult> {
        const title = buildNotificationTitle(target);
        const message = buildNotificationBody(target);
        const groupId = `agent-notifier-${buildGroupHash(target.eventId)}`;
        const safeWorkspace = sanitizeShellArg(target.workspacePath);
        const safeProject = sanitizeShellArg(target.projectName);

        const primaryResult = await this.executor.exec('terminal-notifier', [
            '-title', title,
            '-message', message,
            '-sound', this.sound,
            '-group', groupId,
            '-execute', `${this.focusScriptPath} ${safeWorkspace} ${safeProject}`,
        ]);

        if (primaryResult.exitCode === 0) {
            return {
                outcome: 'backend-accepted',
                backend: 'terminal-notifier',
                fallbackUsed: false,
                primaryExitCode: 0,
                title,
                message,
                groupId,
                clickActionEnabled: true,
                ...(primaryResult.stderr ? { stderr: primaryResult.stderr } : {}),
            };
        }

        const fallbackResult = await this.executor.exec('osascript', [
            '-e',
            buildAppleScript(title, message, this.sound),
        ]);

        if (fallbackResult.exitCode === 0) {
            this.logger.warn('notification send fell back to osascript', {
                agentType: target.agentType,
                source: target.source,
                eventId: target.eventId,
                stderr: primaryResult.stderr,
            });
            return {
                outcome: 'fallback-accepted',
                backend: 'osascript',
                fallbackUsed: true,
                primaryExitCode: primaryResult.exitCode,
                fallbackExitCode: 0,
                title,
                message,
                groupId,
                clickActionEnabled: false,
                ...(primaryResult.stderr ? { stderr: primaryResult.stderr } : {}),
            };
        }

        this.logger.warn('notification send failed after fallback', {
            agentType: target.agentType,
            source: target.source,
            eventId: target.eventId,
            stderr: [primaryResult.stderr, fallbackResult.stderr].filter(Boolean).join('\n') || undefined,
        });

        const stderr = [primaryResult.stderr, fallbackResult.stderr].filter(Boolean).join('\n');
        return {
            outcome: 'backend-failed',
            backend: 'terminal-notifier',
            fallbackUsed: true,
            primaryExitCode: primaryResult.exitCode,
            fallbackExitCode: fallbackResult.exitCode,
            title,
            message,
            groupId,
            clickActionEnabled: false,
            ...(stderr ? { stderr } : {}),
        };
    }
}

function buildNotificationTitle(target: AgentTurnEvent): string {
    if (target.outcome === 'failed') {
        return `${target.agentType} stopped with error`;
    }
    return `${target.agentType} replied`;
}

function buildNotificationBody(target: AgentTurnEvent): string {
    if (target.outcome === 'failed') {
        const failureType = target.providerEvent?.failureType;
        return failureType
            ? `${target.projectName} · ${failureType}`
            : target.projectName;
    }

    return target.gitBranch
        ? `${target.projectName} · ${target.gitBranch}`
        : target.projectName;
}

function buildAppleScript(title: string, message: string, sound: string): string {
    const safeTitle = title.replace(/"/g, '\\"');
    const safeMessage = message.replace(/"/g, '\\"');
    const safeSound = sound.replace(/"/g, '\\"');
    return `display notification "${safeMessage}" with title "${safeTitle}" sound name "${safeSound}"`;
}

function buildGroupHash(eventId: string): string {
    return createHash('sha256').update(eventId).digest('hex').slice(0, 40);
}
