import { describe, expect, it } from 'vitest';
import {
    parseClaudeNotificationPayload,
    parseClaudeNotificationPayloadDetailed,
    parseClaudeStopPayload,
    parseClaudeStopPayloadDetailed,
    parseCodexNotifyPayload,
    parseCodexNotifyPayloadDetailed,
    parseCodexPermissionRequestPayload,
    parseCodexStopPayload,
} from '../../src/core/HookEventParser.js';

describe('parseCodexNotifyPayload', () => {
    it('parses legacy completion payloads with explicit type', () => {
        const payload = JSON.stringify({
            type: 'agent-turn-complete',
            'turn-id': 'turn-123',
            'thread-id': 'thread-1',
            session_id: 'session-1',
            cwd: '/Users/user/project',
            'last-assistant-message': 'Finished the task.',
        });

        const result = parseCodexNotifyPayload(payload, '/fallback');

        expect(result).toEqual({
            agentType: 'codex',
            source: 'codex-notify',
            kind: 'turn-complete',
            dedupeKeyHint: 'turn-123',
            workspacePath: '/Users/user/project',
            providerSessionId: 'session-1',
            summary: 'Finished the task.',
            providerEvent: {
                codexTurnId: 'turn-123',
                codexThreadId: 'thread-1',
            },
        });
    });

    it('accepts legacy payloads missing explicit type when turn id is present', () => {
        const payload = JSON.stringify({
            'turn-id': 'turn-123',
            cwd: '/Users/user/project',
        });

        const result = parseCodexNotifyPayloadDetailed(payload, '/fallback');

        expect(result.candidate).toMatchObject({
            agentType: 'codex',
            source: 'codex-notify',
            kind: 'turn-complete',
            dedupeKeyHint: 'turn-123',
            workspacePath: '/Users/user/project',
        });
        expect(result.warnings).toEqual(['codex_payload_missing_type']);
    });

    it('falls back to process cwd when payload has no cwd', () => {
        const payload = JSON.stringify({
            type: 'agent-turn-complete',
            turn_id: 'turn-123',
        });

        const result = parseCodexNotifyPayload(payload, '/fallback/project');

        expect(result?.workspacePath).toBe('/fallback/project');
    });
});

describe('parseCodexStopPayload', () => {
    it('parses Stop payloads as final completion events', () => {
        const payload = JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 'session-1',
            turn_id: 'turn-123',
            cwd: '/Users/user/project',
            last_assistant_message: 'Final answer.',
            stop_hook_active: false,
        });

        const result = parseCodexStopPayload(payload);

        expect(result).toEqual({
            agentType: 'codex',
            source: 'codex-stop',
            kind: 'turn-complete',
            dedupeKeyHint: 'turn-123',
            workspacePath: '/Users/user/project',
            providerSessionId: 'session-1',
            summary: 'Final answer.',
            providerEvent: {
                hookEventName: 'Stop',
                codexTurnId: 'turn-123',
                stopHookActive: false,
            },
        });
    });
});

describe('parseCodexPermissionRequestPayload', () => {
    it('parses approval requests from Codex hooks', () => {
        const payload = JSON.stringify({
            hook_event_name: 'PermissionRequest',
            session_id: 'session-1',
            turn_id: 'turn-123',
            cwd: '/Users/user/project',
            tool_name: 'Bash',
            tool_input: {
                command: 'npm install',
                description: 'Install dependencies',
            },
        });

        const result = parseCodexPermissionRequestPayload(payload);

        expect(result).toMatchObject({
            agentType: 'codex',
            source: 'codex-permission-request',
            kind: 'approval-request',
            workspacePath: '/Users/user/project',
            providerSessionId: 'session-1',
            providerEvent: {
                hookEventName: 'PermissionRequest',
                codexTurnId: 'turn-123',
                toolName: 'Bash',
                toolCommand: 'npm install',
                toolDescription: 'Install dependencies',
            },
        });
        expect(result?.dedupeKeyHint).toMatch(/^[a-f0-9]{64}$/);
    });
});

describe('parseClaudeStopPayload', () => {
    it('parses Claude Stop payloads as completion events', () => {
        const payload = JSON.stringify({
            hook_event_name: 'Stop',
            session_id: 'claude-session',
            cwd: '/Users/user/project',
            transcript_path: '/Users/user/.claude/projects/session.jsonl',
            last_assistant_message: 'Done.',
            stop_hook_active: true,
        });

        const result = parseClaudeStopPayload(payload);

        expect(result).toEqual({
            agentType: 'claude',
            source: 'claude-stop',
            kind: 'turn-complete',
            dedupeKeyHint: result?.dedupeKeyHint,
            workspacePath: '/Users/user/project',
            providerSessionId: 'claude-session',
            summary: 'Done.',
            transcriptPath: '/Users/user/.claude/projects/session.jsonl',
            providerEvent: {
                hookEventName: 'Stop',
                stopHookActive: true,
                transcriptPath: '/Users/user/.claude/projects/session.jsonl',
            },
        });
    });

    it('parses Claude StopFailure payloads as failed turns', () => {
        const payload = JSON.stringify({
            hook_event_name: 'StopFailure',
            session_id: 'claude-session',
            cwd: '/Users/user/project',
            error: 'tool_error',
        });

        const result = parseClaudeStopPayloadDetailed(payload);

        expect(result.candidate).toMatchObject({
            agentType: 'claude',
            source: 'claude-stop-failure',
            kind: 'turn-failed',
            providerEvent: {
                hookEventName: 'StopFailure',
                failureType: 'tool_error',
            },
        });
    });
});

describe('parseClaudeNotificationPayload', () => {
    it('parses permission_prompt notifications as approval requests', () => {
        const payload = JSON.stringify({
            hook_event_name: 'Notification',
            session_id: 'claude-session',
            cwd: '/Users/user/project',
            notification_type: 'permission_prompt',
            title: 'Permission needed',
            message: 'Claude needs your permission to run Bash',
            transcript_path: '/Users/user/.claude/projects/session.jsonl',
        });

        const result = parseClaudeNotificationPayload(payload);

        expect(result).toMatchObject({
            agentType: 'claude',
            source: 'claude-notification',
            kind: 'approval-request',
            workspacePath: '/Users/user/project',
            providerSessionId: 'claude-session',
            transcriptPath: '/Users/user/.claude/projects/session.jsonl',
            providerEvent: {
                hookEventName: 'Notification',
                notificationType: 'permission_prompt',
                notificationTitle: 'Permission needed',
                notificationMessage: 'Claude needs your permission to run Bash',
                transcriptPath: '/Users/user/.claude/projects/session.jsonl',
            },
        });
    });

    it('rejects unrelated notification types', () => {
        const payload = JSON.stringify({
            hook_event_name: 'Notification',
            session_id: 'claude-session',
            cwd: '/Users/user/project',
            notification_type: 'idle_prompt',
        });

        const result = parseClaudeNotificationPayloadDetailed(payload);

        expect(result.candidate).toBeNull();
        expect(result.rejectionReason).toBe('claude_notification_wrong_type');
    });
});
