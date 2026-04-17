import { describe, expect, it } from 'vitest';
import {
    parseClaudeStopPayload,
    parseClaudeStopPayloadDetailed,
    parseCodexNotifyPayload,
    parseCodexNotifyPayloadDetailed,
} from '../../src/core/HookEventParser.js';

describe('parseCodexNotifyPayload', () => {
    it('parses agent-turn-complete payload with official field names', () => {
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
            outcome: 'completed',
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

    it('accepts payload missing type when turn-id is present and surfaces compatibility warning', () => {
        const payload = JSON.stringify({
            'turn-id': 'turn-123',
            cwd: '/Users/user/project',
        });

        const result = parseCodexNotifyPayloadDetailed(payload, '/fallback');

        expect(result.candidate?.dedupeKeyHint).toBe('turn-123');
        expect(result.warnings).toContain('codex_payload_missing_type');
    });

    it('falls back to process cwd when payload has no cwd', () => {
        const payload = JSON.stringify({
            type: 'agent-turn-complete',
            turn_id: 'turn-123',
        });

        const result = parseCodexNotifyPayload(payload, '/fallback/project');

        expect(result?.workspacePath).toBe('/fallback/project');
    });

    it('rejects payload with wrong type even when turn-id exists', () => {
        const payload = JSON.stringify({
            type: 'session-started',
            turn_id: 'turn-123',
        });

        expect(parseCodexNotifyPayload(payload, '/fallback')).toBeNull();
    });
});

describe('parseClaudeStopPayload', () => {
    it('parses Claude Stop payload', () => {
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
            outcome: 'completed',
            dedupeKeyHint: result?.dedupeKeyHint,
            workspacePath: '/Users/user/project',
            providerSessionId: 'claude-session',
            summary: 'Done.',
            transcriptPath: '/Users/user/.claude/projects/session.jsonl',
            providerEvent: {
                hookEventName: 'Stop',
                claudeStopHookActive: true,
                transcriptPath: '/Users/user/.claude/projects/session.jsonl',
            },
        });
    });

    it('parses Claude StopFailure payload', () => {
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
            outcome: 'failed',
            providerEvent: {
                hookEventName: 'StopFailure',
                failureType: 'tool_error',
            },
        });
    });

    it('rejects payloads missing required fields', () => {
        const payload = JSON.stringify({
            hook_event_name: 'Stop',
            cwd: '/Users/user/project',
        });

        expect(parseClaudeStopPayload(payload)).toBeNull();
    });

    it('ignores unsupported events', () => {
        const payload = JSON.stringify({
            hook_event_name: 'Notification',
            session_id: 'claude-session',
            cwd: '/Users/user/project',
        });

        expect(parseClaudeStopPayload(payload)).toBeNull();
    });
});
