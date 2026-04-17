import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventLedger, buildEventIdHash } from '../../src/core/EventLedger.js';
import type { AgentTurnEvent, AppConfig, ILogger, NotificationSendResult } from '../../src/types.js';

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

function makeEvent(id: string, overrides: Partial<AgentTurnEvent> = {}): AgentTurnEvent {
    return {
        eventId: id,
        source: 'claude-stop',
        outcome: 'completed',
        agentType: 'claude',
        workspacePath: '/Users/user/project',
        projectName: 'project',
        completedAt: '2026-04-17T00:00:00.000Z',
        state: 'completed',
        windowId: 'abc123',
        ...overrides,
    };
}

function makeResult(overrides: Partial<NotificationSendResult> = {}): NotificationSendResult {
    return {
        outcome: 'backend-accepted',
        backend: 'terminal-notifier',
        fallbackUsed: false,
        primaryExitCode: 0,
        title: 'claude replied',
        message: 'project',
        groupId: 'agent-notifier-1',
        clickActionEnabled: true,
        ...overrides,
    };
}

describe('EventLedger', () => {
    let tmpDir: string;
    let markersDir: string;
    let tmpEventsDir: string;
    let maintenanceStatePath: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-notifier-ledger-'));
        markersDir = path.join(tmpDir, 'markers');
        tmpEventsDir = path.join(tmpDir, 'tmp');
        maintenanceStatePath = path.join(tmpDir, 'maintenance.json');
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    function createLedger(config: AppConfig = defaultConfig): EventLedger {
        return new EventLedger(config, makeLogger(), {
            markersDir,
            tmpDir: tmpEventsDir,
            maintenanceStatePath,
        });
    }

    it('creates a marker on first reservation and finalizes it', async () => {
        const ledger = createLedger();
        const event = makeEvent('evt-1');

        const reservation = await ledger.reserve(event);
        expect(reservation.kind).toBe('owned');

        await ledger.finalize(event.eventId, makeResult());

        const marker = await ledger.getMarker(event.eventId);
        expect(marker).toMatchObject({
            eventId: 'evt-1',
            processingState: 'backend-accepted',
        });
    });

    it('returns duplicate after finalization', async () => {
        const ledger = createLedger();
        const event = makeEvent('evt-1');

        await ledger.reserve(event);
        await ledger.finalize(event.eventId, makeResult());

        const reservation = await ledger.reserve(event);
        expect(reservation.kind).toBe('duplicate');
    });

    it('returns inflight when reservation is still fresh', async () => {
        const ledger = createLedger();
        const event = makeEvent('evt-1');

        await ledger.reserve(event);

        const reservation = await ledger.reserve(event);
        expect(reservation.kind).toBe('inflight');
    });

    it('can take over a stale reservation', async () => {
        const ledger = createLedger();
        const event = makeEvent('evt-1');
        const markerPath = path.join(markersDir, `${buildEventIdHash(event.eventId)}.json`);

        await fs.mkdir(markersDir, { recursive: true });
        await fs.writeFile(markerPath, JSON.stringify({
            schemaVersion: 2,
            eventId: event.eventId,
            eventIdHash: buildEventIdHash(event.eventId),
            source: event.source,
            agentType: event.agentType,
            outcome: event.outcome,
            workspacePath: event.workspacePath,
            projectName: event.projectName,
            windowId: event.windowId,
            completedAt: event.completedAt,
            processingState: 'reserved',
            reservedAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2020-01-01T00:00:00.000Z',
        }), 'utf8');

        const reservation = await ledger.reserve(event);
        expect(['owned', 'corrupt-retried']).toContain(reservation.kind);
    });

    it('quarantines corrupt marker and retries reservation', async () => {
        const ledger = createLedger();
        const event = makeEvent('evt-1');
        const markerPath = path.join(markersDir, `${buildEventIdHash(event.eventId)}.json`);

        await fs.mkdir(markersDir, { recursive: true });
        await fs.writeFile(markerPath, '{not-json', 'utf8');

        const reservation = await ledger.reserve(event);
        expect(['owned', 'corrupt-retried']).toContain(reservation.kind);

        const files = await fs.readdir(markersDir);
        expect(files.some(name => name.includes('.corrupt.'))).toBe(true);
    });

    it('lists recent finalized events sorted by finalizedAt', async () => {
        const ledger = createLedger();
        const first = makeEvent('evt-1');
        const second = makeEvent('evt-2');

        await ledger.reserve(first);
        await ledger.finalize(first.eventId, makeResult());
        await new Promise(resolve => setTimeout(resolve, 5));
        await ledger.reserve(second);
        await ledger.finalize(second.eventId, makeResult());

        const recent = await ledger.listRecent(2);
        expect(recent.map(marker => marker.eventId)).toEqual(['evt-2', 'evt-1']);
    });

    it('retains only the newest finalized markers during cleanup', async () => {
        const smallConfig: AppConfig = { ...defaultConfig, historySize: 1 };
        const ledger = createLedger(smallConfig);

        for (let i = 0; i < 505; i++) {
            const event = makeEvent(`evt-${i}`);
            await ledger.reserve(event);
            await ledger.finalize(event.eventId, makeResult());
        }

        await fs.writeFile(maintenanceStatePath, JSON.stringify({ schemaVersion: 1, lastCleanupAt: '2020-01-01T00:00:00.000Z' }), 'utf8');
        await ledger.cleanupIfNeeded();

        const recent = await ledger.listRecent(600);
        expect(recent.length).toBe(500);
        const eventIds = recent.map(marker => marker.eventId);
        expect(eventIds).toContain('evt-504');
        expect(eventIds).not.toContain('evt-0');
    });

    it('allows only one owner across concurrent reserve calls', async () => {
        const ledger = createLedger();
        const event = makeEvent('evt-1');

        const results = await Promise.all(
            Array.from({ length: 10 }, () => ledger.reserve(event)),
        );

        const owned = results.filter(result => result.kind === 'owned' || result.kind === 'corrupt-retried');
        expect(owned).toHaveLength(1);
        expect(results.every(result => ['owned', 'corrupt-retried', 'inflight'].includes(result.kind))).toBe(true);
    });
});
