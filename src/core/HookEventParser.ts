import { createHash } from 'node:crypto';
import type { HookEventCandidate } from '../types.js';

export interface HookParseResult {
    readonly candidate: HookEventCandidate | null;
    readonly rejectionReason?: string;
    readonly warnings: string[];
}

export function parseCodexNotifyPayload(payload: string, fallbackWorkspacePath: string): HookEventCandidate | null {
    return parseCodexNotifyPayloadDetailed(payload, fallbackWorkspacePath).candidate;
}

export function parseCodexStopPayload(payload: string): HookEventCandidate | null {
    return parseCodexStopPayloadDetailed(payload).candidate;
}

export function parseCodexPermissionRequestPayload(payload: string): HookEventCandidate | null {
    return parseCodexPermissionRequestPayloadDetailed(payload).candidate;
}

export function parseClaudeStopPayload(payload: string): HookEventCandidate | null {
    return parseClaudeStopPayloadDetailed(payload).candidate;
}

export function parseClaudeNotificationPayload(payload: string): HookEventCandidate | null {
    return parseClaudeNotificationPayloadDetailed(payload).candidate;
}

export function parseCodexNotifyPayloadDetailed(payload: string, fallbackWorkspacePath: string): HookParseResult {
    const parsed = parseJsonRecord(payload);
    if (!parsed) {
        return rejected('codex_payload_invalid_json');
    }

    const turnId = getFirstString(parsed, ['turn-id', 'turn_id', 'turnId']);
    const type = getFirstString(parsed, ['type']);
    if (type !== 'agent-turn-complete') {
        if (type || !turnId) {
            return rejected(type ? 'codex_payload_wrong_type' : 'codex_payload_missing_type');
        }
    }

    const workspacePath = getFirstString(parsed, ['cwd', 'workdir', 'working_directory']) ?? fallbackWorkspacePath;
    if (!workspacePath) {
        return rejected('codex_payload_missing_workspace');
    }

    const threadId = getFirstString(parsed, ['thread-id', 'thread_id', 'threadId']);
    const providerSessionId = getFirstString(parsed, ['session_id', 'session-id', 'sessionId']);
    const summary = getFirstString(parsed, [
        'last-assistant-message',
        'last_assistant_message',
        'lastAgentMessage',
        'last_agent_message',
    ]);

    const structuredKey = JSON.stringify({
        turnId,
        threadId,
        workspacePath,
        summary,
        providerSessionId,
        raw: parsed,
    });

    return {
        candidate: {
            agentType: 'codex',
            source: 'codex-notify',
            kind: 'turn-complete',
            dedupeKeyHint: turnId ?? sha256(structuredKey),
            workspacePath,
            ...(providerSessionId ? { providerSessionId } : {}),
            ...(summary ? { summary } : {}),
            providerEvent: {
                ...(turnId ? { codexTurnId: turnId } : {}),
                ...(threadId ? { codexThreadId: threadId } : {}),
            },
        },
        warnings: type ? [] : ['codex_payload_missing_type'],
    };
}

export function parseCodexStopPayloadDetailed(payload: string): HookParseResult {
    const parsed = parseJsonRecord(payload);
    if (!parsed) {
        return rejected('codex_stop_payload_invalid_json');
    }

    const hookEventName = getFirstString(parsed, ['hook_event_name']);
    if (hookEventName && hookEventName !== 'Stop') {
        return rejected('codex_stop_payload_wrong_event');
    }

    const workspacePath = getFirstString(parsed, ['cwd']);
    const turnId = getFirstString(parsed, ['turn_id']);
    if (!workspacePath) {
        return rejected('codex_stop_payload_missing_cwd');
    }
    if (!turnId) {
        return rejected('codex_stop_payload_missing_turn_id');
    }

    const providerSessionId = getFirstString(parsed, ['session_id']);
    const summary = getFirstString(parsed, ['last_assistant_message']);
    const stopHookActive = getBoolean(parsed, ['stop_hook_active']);

    return {
        candidate: {
            agentType: 'codex',
            source: 'codex-stop',
            kind: 'turn-complete',
            dedupeKeyHint: turnId,
            workspacePath,
            ...(providerSessionId ? { providerSessionId } : {}),
            ...(summary ? { summary } : {}),
            providerEvent: {
                hookEventName: 'Stop',
                codexTurnId: turnId,
                ...(typeof stopHookActive === 'boolean' ? { stopHookActive } : {}),
            },
        },
        warnings: [],
    };
}

export function parseCodexPermissionRequestPayloadDetailed(payload: string): HookParseResult {
    const parsed = parseJsonRecord(payload);
    if (!parsed) {
        return rejected('codex_permission_payload_invalid_json');
    }

    const hookEventName = getFirstString(parsed, ['hook_event_name']);
    if (hookEventName && hookEventName !== 'PermissionRequest') {
        return rejected('codex_permission_payload_wrong_event');
    }

    const workspacePath = getFirstString(parsed, ['cwd']);
    const turnId = getFirstString(parsed, ['turn_id']);
    if (!workspacePath) {
        return rejected('codex_permission_payload_missing_cwd');
    }
    if (!turnId) {
        return rejected('codex_permission_payload_missing_turn_id');
    }

    const providerSessionId = getFirstString(parsed, ['session_id']);
    const toolName = getFirstString(parsed, ['tool_name']);
    const toolInput = getFirstObject(parsed, ['tool_input']);
    const toolCommand = toolInput ? getFirstString(toolInput, ['command']) : undefined;
    const toolDescription = toolInput ? getFirstString(toolInput, ['description']) : undefined;

    return {
        candidate: {
            agentType: 'codex',
            source: 'codex-permission-request',
            kind: 'approval-request',
            dedupeKeyHint: sha256(JSON.stringify({
                turnId,
                workspacePath,
                toolName,
                toolCommand,
                toolDescription,
            })),
            workspacePath,
            ...(providerSessionId ? { providerSessionId } : {}),
            providerEvent: {
                hookEventName: 'PermissionRequest',
                codexTurnId: turnId,
                ...(toolName ? { toolName } : {}),
                ...(toolCommand ? { toolCommand } : {}),
                ...(toolDescription ? { toolDescription } : {}),
            },
        },
        warnings: [],
    };
}

export function parseClaudeStopPayloadDetailed(payload: string): HookParseResult {
    const parsed = parseJsonRecord(payload);
    if (!parsed) {
        return rejected('claude_payload_invalid_json');
    }

    const eventName = getFirstString(parsed, ['hook_event_name']);
    if (eventName && eventName !== 'Stop' && eventName !== 'StopFailure') {
        return rejected('claude_payload_unsupported_event');
    }

    const workspacePath = getFirstString(parsed, ['cwd']);
    const sessionId = getFirstString(parsed, ['session_id']);
    if (!workspacePath) {
        return rejected('claude_payload_missing_cwd');
    }
    if (!sessionId) {
        return rejected('claude_payload_missing_session_id');
    }

    const summary = getFirstString(parsed, ['last_assistant_message']);
    const transcriptPath = getFirstString(parsed, ['transcript_path']);
    const stopHookActive = getBoolean(parsed, ['stop_hook_active']);
    const failureType = getFirstString(parsed, ['error', 'error_details']);
    const hookEventName = eventName === 'StopFailure' ? 'StopFailure' : 'Stop';

    return {
        candidate: {
            agentType: 'claude',
            source: hookEventName === 'StopFailure' ? 'claude-stop-failure' : 'claude-stop',
            kind: hookEventName === 'StopFailure' ? 'turn-failed' : 'turn-complete',
            dedupeKeyHint: `${sessionId}:${sha256(JSON.stringify({
                hookEventName,
                workspacePath,
                summary,
                transcriptPath,
                failureType,
            }))}`,
            workspacePath,
            providerSessionId: sessionId,
            ...(summary ? { summary } : {}),
            ...(transcriptPath ? { transcriptPath } : {}),
            providerEvent: {
                hookEventName,
                ...(typeof stopHookActive === 'boolean' ? { stopHookActive } : {}),
                ...(transcriptPath ? { transcriptPath } : {}),
                ...(failureType ? { failureType } : {}),
            },
        },
        warnings: [],
    };
}

export function parseClaudeNotificationPayloadDetailed(payload: string): HookParseResult {
    const parsed = parseJsonRecord(payload);
    if (!parsed) {
        return rejected('claude_notification_invalid_json');
    }

    const eventName = getFirstString(parsed, ['hook_event_name']);
    if (eventName && eventName !== 'Notification') {
        return rejected('claude_notification_wrong_event');
    }

    const workspacePath = getFirstString(parsed, ['cwd']);
    const sessionId = getFirstString(parsed, ['session_id']);
    const notificationType = getFirstString(parsed, ['notification_type']);
    if (!workspacePath) {
        return rejected('claude_notification_missing_cwd');
    }
    if (!sessionId) {
        return rejected('claude_notification_missing_session_id');
    }
    if (notificationType !== 'permission_prompt') {
        return rejected(notificationType ? 'claude_notification_wrong_type' : 'claude_notification_missing_type');
    }

    const message = getFirstString(parsed, ['message']);
    const title = getFirstString(parsed, ['title']);
    const transcriptPath = getFirstString(parsed, ['transcript_path']);

    return {
        candidate: {
            agentType: 'claude',
            source: 'claude-notification',
            kind: 'approval-request',
            dedupeKeyHint: sha256(JSON.stringify({
                sessionId,
                workspacePath,
                notificationType,
                title,
                message,
            })),
            workspacePath,
            providerSessionId: sessionId,
            ...(transcriptPath ? { transcriptPath } : {}),
            providerEvent: {
                hookEventName: 'Notification',
                notificationType: 'permission_prompt',
                ...(title ? { notificationTitle: title } : {}),
                ...(message ? { notificationMessage: message } : {}),
                ...(transcriptPath ? { transcriptPath } : {}),
            },
        },
        warnings: [],
    };
}

function rejected(rejectionReason: string): HookParseResult {
    return {
        candidate: null,
        rejectionReason,
        warnings: [],
    };
}

function parseJsonRecord(payload: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(payload);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        return null;
    }
    return null;
}

function getFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }
    return undefined;
}

function getFirstObject(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
    for (const key of keys) {
        const value = record[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
    }
    return undefined;
}

function getBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'boolean') {
            return value;
        }
    }
    return undefined;
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}
