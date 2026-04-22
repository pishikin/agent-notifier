import { createHash } from 'node:crypto';
import type {
    AgentAttentionEvent,
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

    async send(target: AgentAttentionEvent): Promise<NotificationSendResult> {
        const content = buildNotificationContent(target);
        const groupId = `agent-notifier-${buildGroupHash(target.eventId)}`;
        const safeWorkspace = sanitizeShellArg(target.workspacePath);
        const safeProject = sanitizeShellArg(target.projectName);

        const primaryResult = await this.executor.exec('terminal-notifier', [
            '-title', content.title,
            '-message', content.message,
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
                title: content.title,
                message: content.message,
                groupId,
                clickActionEnabled: true,
                ...(primaryResult.stderr ? { stderr: primaryResult.stderr } : {}),
            };
        }

        const fallbackResult = await this.executor.exec('osascript', [
            '-e',
            buildAppleScript(content.title, content.message, this.sound),
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
                title: content.title,
                message: content.message,
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
            title: content.title,
            message: content.message,
            groupId,
            clickActionEnabled: false,
            ...(stderr ? { stderr } : {}),
        };
    }
}

export function buildNotificationContent(target: AgentAttentionEvent): {
    readonly title: string;
    readonly message: string;
} {
    return {
        title: buildNotificationTitle(target),
        message: buildNotificationBody(target),
    };
}

function buildNotificationTitle(target: AgentAttentionEvent): string {
    switch (target.kind) {
        case 'turn-complete':
            return `${target.agentType} replied`;
        case 'turn-failed':
            return `${target.agentType} stopped with error`;
        case 'approval-request':
            return `${target.agentType} needs approval`;
    }
}

function buildNotificationBody(target: AgentAttentionEvent): string {
    switch (target.kind) {
        case 'turn-complete':
            return target.gitBranch
                ? `${target.projectName} · ${target.gitBranch}`
                : target.projectName;
        case 'turn-failed': {
            const failureType = target.providerEvent?.failureType;
            return failureType
                ? `${target.projectName} · ${failureType}`
                : target.projectName;
        }
        case 'approval-request':
            return buildApprovalMessage(target);
    }
}

function buildApprovalMessage(target: AgentAttentionEvent): string {
    const toolName = target.providerEvent?.toolName;
    const toolDescription = target.providerEvent?.toolDescription;
    const toolCommand = target.providerEvent?.toolCommand;
    const notificationTitle = target.providerEvent?.notificationTitle;
    const notificationMessage = target.providerEvent?.notificationMessage;

    if (toolName && toolDescription) {
        return `${target.projectName} · ${toolName}: ${toolDescription}`;
    }
    if (toolName && toolCommand) {
        return `${target.projectName} · ${toolName}: ${truncate(toolCommand, 72)}`;
    }
    if (toolDescription) {
        return `${target.projectName} · ${toolDescription}`;
    }
    if (notificationTitle && notificationMessage) {
        return `${target.projectName} · ${notificationTitle}: ${truncate(notificationMessage, 72)}`;
    }
    if (notificationMessage) {
        return `${target.projectName} · ${truncate(notificationMessage, 72)}`;
    }
    if (notificationTitle) {
        return `${target.projectName} · ${notificationTitle}`;
    }
    return target.projectName;
}

function truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
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
