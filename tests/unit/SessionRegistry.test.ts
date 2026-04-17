import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRegistry } from '../../src/core/SessionRegistry.js';
import type { AgentSession, AppConfig, ILogger } from '../../src/types.js';

function makeLogger(): ILogger {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), close: vi.fn() };
}

const defaultConfig: AppConfig = {
    watchProcesses: ['claude'],
    scanIntervalMs: 2000,
    notificationSound: 'Glass',
    showGitBranch: true,
    historySize: 3,
    logLevel: 'info',
    logMaxSizeMb: 5,
};

function makeSession(pid: number, project = 'my-project'): AgentSession {
    return {
        pid,
        agentType: 'claude',
        ipcSocketPath: `/tmp/ipc-${pid}.sock`,
        workspacePath: `/Users/user/${project}`,
        projectName: project,
        discoveredAt: new Date().toISOString(),
        state: 'running',
        windowId: `win${pid}`,
    };
}

describe('SessionRegistry', () => {
    let tmpDir: string;
    let historyPath: string;
    let activePath: string;
    let logger: ILogger;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-notifier-test-'));
        historyPath = path.join(tmpDir, 'history.json');
        activePath = path.join(tmpDir, 'active.json');
        logger = makeLogger();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeRegistry(): SessionRegistry {
        return new SessionRegistry(defaultConfig, logger, historyPath, activePath);
    }

    it('tracks added sessions', () => {
        const reg = makeRegistry();
        const s = makeSession(100);
        reg.add(s);
        expect(reg.has(100)).toBe(true);
        expect(reg.getActivePids()).toEqual(new Set([100]));
    });

    it('returns false for unknown pids', () => {
        const reg = makeRegistry();
        expect(reg.has(999)).toBe(false);
    });

    it('detects completions when PIDs disappear', () => {
        const reg = makeRegistry();
        reg.add(makeSession(1));
        reg.add(makeSession(2));

        const completed = reg.detectCompletions(new Set([1])); // pid 2 is gone

        expect(completed).toHaveLength(1);
        expect(completed[0]?.pid).toBe(2);
        expect(completed[0]?.state).toBe('completed');
        expect(completed[0]?.completedAt).toBeDefined();
    });

    it('removes completed sessions from active map', () => {
        const reg = makeRegistry();
        reg.add(makeSession(5));
        reg.detectCompletions(new Set()); // pid 5 is gone
        expect(reg.has(5)).toBe(false);
        expect(reg.getActive()).toHaveLength(0);
    });

    it('does NOT mutate the original session object', () => {
        const reg = makeRegistry();
        const original = makeSession(10);
        reg.add(original);
        reg.detectCompletions(new Set());
        // Original object must still have state = 'running'
        expect(original.state).toBe('running');
        expect(original.completedAt).toBeUndefined();
    });

    it('moves completed sessions to history', () => {
        const reg = makeRegistry();
        reg.add(makeSession(20));
        reg.detectCompletions(new Set());
        expect(reg.getHistory()).toHaveLength(1);
        expect(reg.getHistory()[0]?.pid).toBe(20);
    });

    it('enforces history size limit', () => {
        const reg = makeRegistry(); // historySize = 3
        for (let i = 1; i <= 5; i++) {
            reg.add(makeSession(i));
            reg.detectCompletions(new Set(Array.from({ length: 5 }, (_, j) => j + 1).filter(p => p !== i)));
        }
        expect(reg.getHistory().length).toBeLessThanOrEqual(3);
    });

    it('persists history to disk on completion', () => {
        const reg = makeRegistry();
        reg.add(makeSession(30));
        reg.detectCompletions(new Set());
        const saved = JSON.parse(fs.readFileSync(historyPath, 'utf8')) as AgentSession[];
        expect(saved).toHaveLength(1);
        expect(saved[0]?.pid).toBe(30);
    });

    it('loads history from disk on construction', () => {
        const session = makeSession(40);
        fs.writeFileSync(historyPath, JSON.stringify([{ ...session, state: 'completed' }]));
        const reg = makeRegistry();
        expect(reg.getHistory()).toHaveLength(1);
        expect(reg.getHistory()[0]?.pid).toBe(40);
    });

    it('recovers gracefully from corrupt history file', () => {
        fs.writeFileSync(historyPath, 'this is not json{{');
        const reg = makeRegistry();
        expect(reg.getHistory()).toEqual([]);
    });

    it('persistActive writes current active sessions', () => {
        const reg = makeRegistry();
        reg.add(makeSession(50));
        reg.persistActive();
        const saved = JSON.parse(fs.readFileSync(activePath, 'utf8')) as AgentSession[];
        expect(saved).toHaveLength(1);
        expect(saved[0]?.pid).toBe(50);
    });

    it('persistActive does not throw on write error', () => {
        const reg = makeRegistry();
        // Make activePath a directory so writing to it fails
        fs.mkdirSync(activePath);
        expect(() => reg.persistActive()).not.toThrow();
        expect(logger.warn).toHaveBeenCalled();
    });

    it('getActive returns a copy — mutation does not affect registry', () => {
        const reg = makeRegistry();
        reg.add(makeSession(60));
        const copy = reg.getActive();
        copy.pop();
        expect(reg.getActive()).toHaveLength(1);
    });
});
