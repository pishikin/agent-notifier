import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    AgentAttentionEvent,
    EventMarker,
    HookEventCandidate,
    NotificationSendResult,
    ReservationResult,
} from '../../src/types.js';

let tmpHome = '';
let parseResult: { candidate: HookEventCandidate | null; rejectionReason?: string; warnings: string[] };
let builtEvent: AgentAttentionEvent;
let reserveResult: ReservationResult;
let sendResult: NotificationSendResult;
const reserveSpy = vi.fn();
const finalizeSpy = vi.fn();
const sendSpy = vi.fn();

vi.mock('../../src/infra/Config.js', () => ({
    loadConfig: () => ({
        watchProcesses: ['claude', 'codex'],
        scanIntervalMs: 2000,
        notificationSound: 'Glass',
        showGitBranch: true,
        historySize: 50,
        logLevel: 'info',
        logMaxSizeMb: 5,
    }),
}));

vi.mock('../../src/infra/CommandExecutor.js', () => ({
    CommandExecutor: class {},
}));

vi.mock('../../src/infra/Logger.js', () => ({
    Logger: class {
        debug() {}
        info() {}
        warn() {}
        error() {}
        close() {}
    },
}));

vi.mock('../../src/core/HookEventParser.js', () => ({
    parseCodexNotifyPayloadDetailed: () => parseResult,
    parseCodexStopPayloadDetailed: () => parseResult,
    parseCodexPermissionRequestPayloadDetailed: () => parseResult,
    parseClaudeStopPayloadDetailed: () => parseResult,
    parseClaudeNotificationPayloadDetailed: () => parseResult,
}));

vi.mock('../../src/core/EventIdentity.js', () => ({
    buildAgentAttentionEvent: () => Promise.resolve(builtEvent),
}));

vi.mock('../../src/core/EventLedger.js', () => ({
    EventLedger: class {
        async reserve() {
            reserveSpy();
            return reserveResult;
        }

        async finalize() {
            finalizeSpy();
        }
    },
}));

vi.mock('../../src/core/NotificationService.js', () => ({
    NotificationService: class {
        async send() {
            sendSpy();
            return sendResult;
        }
    },
    buildNotificationContent: () => ({
        title: 'fallback title',
        message: 'fallback message',
    }),
}));

vi.mock('../../src/utils/paths.js', () => ({
    getConfigDir: () => path.join(tmpHome, '.agent-notifier'),
    getLogsDir: () => path.join(tmpHome, '.agent-notifier', 'logs'),
    getHooksLogPath: () => path.join(tmpHome, '.agent-notifier', 'logs', 'hooks.log'),
    getFocusScriptPath: () => path.join(tmpHome, 'focus-window.sh'),
}));

function makeDuplicateMarker(): EventMarker {
    return {
        schemaVersion: 3,
        eventId: 'evt-1',
        eventIdHash: 'hash',
        source: 'codex-stop',
        agentType: 'codex',
        kind: 'turn-complete',
        workspacePath: '/tmp/project',
        projectName: 'project',
        windowId: 'win1',
        occurredAt: '2026-04-17T00:00:00.000Z',
        processingState: 'backend-accepted',
        reservedAt: '2026-04-17T00:00:00.000Z',
        updatedAt: '2026-04-17T00:00:01.000Z',
    };
}

describe('hookCommand', () => {
    beforeEach(async () => {
        tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-notifier-hook-'));
        parseResult = { candidate: null, rejectionReason: 'invalid', warnings: [] };
        builtEvent = {
            eventId: 'evt-1',
            source: 'codex-stop',
            kind: 'turn-complete',
            agentType: 'codex',
            workspacePath: '/tmp/project',
            projectName: 'project',
            occurredAt: '2026-04-17T00:00:00.000Z',
            windowId: 'win1',
        };
        reserveResult = { kind: 'owned', markerPath: '/tmp/marker.json' };
        sendResult = {
            outcome: 'backend-accepted',
            backend: 'terminal-notifier',
            fallbackUsed: false,
            primaryExitCode: 0,
            title: 'codex replied',
            message: 'project',
            clickActionEnabled: true,
        };
        reserveSpy.mockReset();
        finalizeSpy.mockReset();
        sendSpy.mockReset();
    });

    afterEach(async () => {
        await fs.rm(tmpHome, { recursive: true, force: true });
        vi.resetModules();
    });

    it('returns early on parse rejection without reserving markers', async () => {
        const { hookCommand } = await import('../../src/commands/hook.js');
        await hookCommand({ agent: 'codex', payload: '{}' });

        expect(reserveSpy).not.toHaveBeenCalled();
        expect(sendSpy).not.toHaveBeenCalled();
        expect(finalizeSpy).not.toHaveBeenCalled();
    });

    it('suppresses Stop events while a stop hook is already active', async () => {
        parseResult = {
            candidate: {
                agentType: 'codex',
                source: 'codex-stop',
                kind: 'turn-complete',
                dedupeKeyHint: 'turn-1',
                workspacePath: '/tmp/project',
                providerEvent: {
                    hookEventName: 'Stop',
                    stopHookActive: true,
                },
            },
            warnings: [],
        };

        const { hookCommand } = await import('../../src/commands/hook.js');
        await hookCommand({ agent: 'codex', payload: '{}' });

        expect(reserveSpy).not.toHaveBeenCalled();
        expect(sendSpy).not.toHaveBeenCalled();
        expect(finalizeSpy).not.toHaveBeenCalled();
    });

    it('suppresses duplicate reservations without sending notifications', async () => {
        parseResult = {
            candidate: {
                agentType: 'codex',
                source: 'codex-notify',
                kind: 'turn-complete',
                dedupeKeyHint: 'turn-1',
                workspacePath: '/tmp/project',
            },
            warnings: [],
        };
        reserveResult = {
            kind: 'duplicate',
            existing: makeDuplicateMarker(),
        };

        const { hookCommand } = await import('../../src/commands/hook.js');
        await hookCommand({ agent: 'codex', payload: '{}' });

        expect(reserveSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy).not.toHaveBeenCalled();
        expect(finalizeSpy).not.toHaveBeenCalled();
    });

    it('sends and finalizes approval-request events', async () => {
        parseResult = {
            candidate: {
                agentType: 'codex',
                source: 'codex-permission-request',
                kind: 'approval-request',
                dedupeKeyHint: 'approval-1',
                workspacePath: '/tmp/project',
                providerEvent: {
                    hookEventName: 'PermissionRequest',
                    toolName: 'Bash',
                    toolDescription: 'Run npm install',
                },
            },
            warnings: [],
        };
        builtEvent = {
            ...builtEvent,
            source: 'codex-permission-request',
            kind: 'approval-request',
            providerEvent: {
                hookEventName: 'PermissionRequest',
                toolName: 'Bash',
                toolDescription: 'Run npm install',
            },
        };

        const { hookCommand } = await import('../../src/commands/hook.js');
        await hookCommand({ agent: 'codex', payload: '{}' });

        expect(reserveSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(finalizeSpy).toHaveBeenCalledTimes(1);
    });

    it('finalizes markers even when notification backend reports failure', async () => {
        parseResult = {
            candidate: {
                agentType: 'codex',
                source: 'codex-notify',
                kind: 'turn-complete',
                dedupeKeyHint: 'turn-1',
                workspacePath: '/tmp/project',
            },
            warnings: [],
        };
        sendResult = {
            outcome: 'backend-failed',
            backend: 'terminal-notifier',
            fallbackUsed: true,
            primaryExitCode: 127,
            fallbackExitCode: 1,
            title: 'codex replied',
            message: 'project',
            clickActionEnabled: false,
        };

        const { hookCommand } = await import('../../src/commands/hook.js');
        await hookCommand({ agent: 'codex', payload: '{}' });

        expect(reserveSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(finalizeSpy).toHaveBeenCalledTimes(1);
    });
});
