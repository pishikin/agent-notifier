import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexApprovalLogMonitor } from '../../src/core/CodexApprovalLogMonitor.js';
import type { ILogger } from '../../src/types.js';

let tmpDir = '';
let logPath = '';

const silentLogger: ILogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    close: () => undefined,
};

describe('CodexApprovalLogMonitor', () => {
    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-notifier-codex-log-'));
        logPath = path.join(tmpDir, 'codex-tui.log');
        await fs.writeFile(logPath, '', 'utf8');
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('emits approval-request candidates immediately for require_escalated exec commands without prefix_rule', async () => {
        const threadId = 'thread-1';
        const turnId = 'turn-1';
        const workspacePath = '/tmp/project';
        const justification = 'Run tests outside the sandbox.';
        const command = 'npm test';

        const monitor = new CodexApprovalLogMonitor(silentLogger, logPath);
        expect(await monitor.poll()).toEqual([]);

        await appendLines([
            execCommandLine({
                timestamp: '2026-04-22T13:26:34.509132Z',
                threadId,
                turnId,
                workspacePath,
                command,
                justification,
                sandboxPermissions: 'require_escalated',
            }),
        ]);

        const candidates = await monitor.poll();
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
            agentType: 'codex',
            source: 'codex-log-exec-approval',
            kind: 'approval-request',
            workspacePath,
            providerSessionId: threadId,
            providerEvent: {
                codexTurnId: turnId,
                toolName: 'Bash',
                toolCommand: command,
                toolDescription: justification,
            },
        });

        await appendLines([
            execApprovalLine({
                timestamp: '2026-04-22T13:26:36.026183Z',
                threadId,
                submissionId: 'approval-1',
            }),
        ]);

        expect(await monitor.poll()).toEqual([]);
    });

    it('waits for exec_approval when the escalated command carries a prefix_rule', async () => {
        const threadId = 'thread-1';
        const turnId = 'turn-1';
        const workspacePath = '/tmp/project';
        const command = 'ssh root@example.com';

        await appendLines([
            execCommandLine({
                timestamp: '2026-04-22T13:26:34.509132Z',
                threadId,
                turnId,
                workspacePath,
                command,
                justification: 'Run tests outside the sandbox.',
                sandboxPermissions: 'require_escalated',
                prefixRule: ['ssh', 'root@example.com'],
            }),
        ]);

        const monitor = new CodexApprovalLogMonitor(silentLogger, logPath);
        expect(await monitor.poll()).toEqual([]);

        await appendLines([
            execApprovalLine({
                timestamp: '2026-04-22T13:26:36.026183Z',
                threadId,
                submissionId: 'approval-1',
            }),
        ]);

        const candidates = await monitor.poll();
        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
            agentType: 'codex',
            source: 'codex-log-exec-approval',
            kind: 'approval-request',
            workspacePath,
            providerSessionId: threadId,
            providerEvent: {
                codexTurnId: turnId,
                toolName: 'Bash',
                toolCommand: command,
            },
        });
    });

    it('clears stale pending approvals when later tool calls continue without approval', async () => {
        const threadId = 'thread-1';
        const turnId = 'turn-1';
        const workspacePath = '/tmp/project';

        await appendLines([
            execCommandLine({
                timestamp: '2026-04-22T13:26:34.509132Z',
                threadId,
                turnId,
                workspacePath,
                command: 'npm test',
                justification: 'Run tests outside the sandbox.',
                sandboxPermissions: 'require_escalated',
                prefixRule: ['npm', 'test'],
            }),
        ]);

        const monitor = new CodexApprovalLogMonitor(silentLogger, logPath);
        expect(await monitor.poll()).toEqual([]);

        await appendLines([
            execCommandLine({
                timestamp: '2026-04-22T13:26:40.000000Z',
                threadId,
                turnId,
                workspacePath,
                command: 'pwd',
            }),
        ]);
        expect(await monitor.poll()).toEqual([]);

        await appendLines([
            execApprovalLine({
                timestamp: '2026-04-22T13:26:42.000000Z',
                threadId,
                submissionId: 'approval-1',
            }),
        ]);

        expect(await monitor.poll()).toEqual([]);
    });
});

async function appendLines(lines: string[]): Promise<void> {
    await fs.appendFile(logPath, `${lines.join('\n')}\n`, 'utf8');
}

function execCommandLine(input: {
    readonly timestamp: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly workspacePath: string;
    readonly command: string;
    readonly justification?: string;
    readonly sandboxPermissions?: string;
    readonly prefixRule?: string[];
}): string {
    const payload: Record<string, unknown> = {
        cmd: input.command,
        workdir: input.workspacePath,
    };
    if (input.justification) {
        payload.justification = input.justification;
    }
    if (input.sandboxPermissions) {
        payload.sandbox_permissions = input.sandboxPermissions;
    }
    if (input.prefixRule) {
        payload.prefix_rule = input.prefixRule;
    }

    return `${input.timestamp}  INFO session_loop{thread_id=${input.threadId}}:submission_dispatch{otel.name="op.dispatch.user_input" submission.id="submission-1" codex.op="user_input"}:turn{otel.name="session_task.turn" thread.id=${input.threadId} turn.id=${input.turnId} model=gpt-5.4}: codex_core::stream_events_utils: ToolCall: exec_command ${JSON.stringify(payload)} thread_id=${input.threadId}`;
}

function execApprovalLine(input: {
    readonly timestamp: string;
    readonly threadId: string;
    readonly submissionId: string;
}): string {
    return `${input.timestamp}  INFO session_loop{thread_id=${input.threadId}}:submission_dispatch{otel.name="op.dispatch.exec_approval" submission.id="${input.submissionId}" codex.op="exec_approval"}: codex_core::codex: new`;
}
