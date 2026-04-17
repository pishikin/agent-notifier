import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../../src/core/EventStore.js';
import type { AppConfig, ILogger, TurnCompletionEvent } from '../../src/types.js';

function makeLogger(): ILogger {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), close: vi.fn() };
}

const defaultConfig: AppConfig = {
    watchProcesses: ['claude', 'codex'],
    scanIntervalMs: 2000,
    notificationSound: 'Glass',
    showGitBranch: true,
    historySize: 3,
    logLevel: 'info',
    logMaxSizeMb: 5,
};

function makeEvent(id: string): TurnCompletionEvent {
    return {
        eventId: id,
        source: 'claude-stop',
        outcome: 'completed',
        agentType: 'claude',
        workspacePath: '/Users/user/project',
        projectName: 'project',
        completedAt: '2026-04-15T00:00:00.000Z',
        state: 'completed',
        windowId: 'abc123',
    };
}

describe('EventStore', () => {
    let tmpDir: string;
    let historyPath: string;
    let processedPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notifier-events-'));
        historyPath = path.join(tmpDir, 'history.json');
        processedPath = path.join(tmpDir, 'processed.json');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('records events and exposes history', () => {
        const store = new EventStore(defaultConfig, makeLogger(), historyPath, processedPath);

        expect(store.record(makeEvent('evt-1'))).toBe(true);
        expect(store.getHistory()).toHaveLength(1);
        expect(store.hasProcessed('evt-1')).toBe(true);
    });

    it('deduplicates previously recorded events', () => {
        const store = new EventStore(defaultConfig, makeLogger(), historyPath, processedPath);

        expect(store.record(makeEvent('evt-1'))).toBe(true);
        expect(store.record(makeEvent('evt-1'))).toBe(false);
        expect(store.getHistory()).toHaveLength(1);
    });

    it('trims history to configured size', () => {
        const store = new EventStore(defaultConfig, makeLogger(), historyPath, processedPath);

        store.record(makeEvent('evt-1'));
        store.record(makeEvent('evt-2'));
        store.record(makeEvent('evt-3'));
        store.record(makeEvent('evt-4'));

        expect(store.getHistory()).toHaveLength(3);
        expect(store.getHistory()[0]?.eventId).toBe('evt-4');
    });

    it('loads legacy session history entries', () => {
        fs.writeFileSync(historyPath, JSON.stringify([
            {
                pid: 123,
                agentType: 'codex',
                workspacePath: '/Users/user/project',
                projectName: 'project',
                discoveredAt: '2026-04-15T00:00:00.000Z',
                completedAt: '2026-04-15T00:01:00.000Z',
                windowId: 'legacy123',
            },
        ]));

        const store = new EventStore(defaultConfig, makeLogger(), historyPath, processedPath);

        expect(store.getHistory()).toHaveLength(1);
        expect(store.getHistory()[0]?.source).toBe('legacy-process-exit');
    });
});
