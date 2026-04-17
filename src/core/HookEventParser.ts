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

export function parseClaudeStopPayload(payload: string): HookEventCandidate | null {
    return parseClaudeStopPayloadDetailed(payload).candidate;
}

export function parseCodexNotifyPayloadDetailed(payload: string, fallbackWorkspacePath: string): HookParseResult {
    const parsed = parseJsonRecord(payload);
    if (!parsed) {
        return rejected('codex_payload_invalid_json');
    }

    const type = getFirstString(parsed, ['type']);
    const turnId = getFirstString(parsed, ['turn-id', 'turn_id', 'turnId']);
    if (type && type !== 'agent-turn-complete') {
        return rejected('codex_payload_wrong_type');
    }
    if (!type && !turnId) {
        return rejected('codex_payload_missing_type_and_turn_id');
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
        'last_agent_message',
    ]);

    const structuredKey = JSON.stringify({
        type: type ?? 'agent-turn-complete',
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
            outcome: 'completed',
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

    /**
     * Claude Stop means the model finished a reply turn, not necessarily the overall task.
     * stop_hook_active means Claude is already continuing because another Stop hook extended execution.
     * When other Stop hooks exist, this tool can only provide best-effort user-attention timing.
     */
    return {
        candidate: {
            agentType: 'claude',
            source: hookEventName === 'StopFailure' ? 'claude-stop-failure' : 'claude-stop',
            outcome: hookEventName === 'StopFailure' ? 'failed' : 'completed',
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
                ...(typeof stopHookActive === 'boolean'
                    ? { claudeStopHookActive: stopHookActive }
                    : {}),
                ...(transcriptPath ? { transcriptPath } : {}),
                ...(failureType ? { failureType } : {}),
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
