import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';

// We need to mock the paths module before importing loadConfig
vi.mock('../../src/utils/paths.js', () => ({
    getConfigPath: vi.fn().mockReturnValue('/tmp/nonexistent-agent-notifier-config.json'),
    getConfigDir: vi.fn().mockReturnValue('/tmp/agent-notifier'),
}));

const { loadConfig } = await import('../../src/infra/Config.js');
const { getConfigPath } = await import('../../src/utils/paths.js');

describe('loadConfig', () => {
    afterEach(() => {
        const configPath = vi.mocked(getConfigPath)();
        try { fs.unlinkSync(configPath); } catch { /* fine */ }
    });

    it('returns full defaults when config file does not exist', () => {
        vi.mocked(getConfigPath).mockReturnValue('/tmp/__nonexistent__.json');
        const config = loadConfig();
        expect(config.watchProcesses).toEqual(['claude', 'codex']);
        expect(config.scanIntervalMs).toBe(2000);
        expect(config.showGitBranch).toBe(true);
    });

    it('parses a valid config file', () => {
        const configPath = '/tmp/test-agent-notifier-valid.json';
        vi.mocked(getConfigPath).mockReturnValue(configPath);
        fs.writeFileSync(configPath, JSON.stringify({
            watchProcesses: ['claude'],
            scanIntervalMs: 3000,
            notificationSound: 'Ping',
            showGitBranch: false,
            historySize: 10,
            logLevel: 'debug',
            logMaxSizeMb: 2,
        }));
        const config = loadConfig();
        expect(config.watchProcesses).toEqual(['claude']);
        expect(config.scanIntervalMs).toBe(3000);
        expect(config.notificationSound).toBe('Ping');
        expect(config.showGitBranch).toBe(false);
    });

    it('uses defaults for missing fields in partial config', () => {
        const configPath = '/tmp/test-agent-notifier-partial.json';
        vi.mocked(getConfigPath).mockReturnValue(configPath);
        fs.writeFileSync(configPath, JSON.stringify({ scanIntervalMs: 5000 }));
        const config = loadConfig();
        expect(config.scanIntervalMs).toBe(5000);
        expect(config.watchProcesses).toEqual(['claude', 'codex']); // default
    });

    it('returns defaults for invalid type (string instead of number)', () => {
        const configPath = '/tmp/test-agent-notifier-invalid-type.json';
        vi.mocked(getConfigPath).mockReturnValue(configPath);
        fs.writeFileSync(configPath, JSON.stringify({ scanIntervalMs: 'abc' }));
        const config = loadConfig();
        expect(config.scanIntervalMs).toBe(2000); // default
    });

    it('returns defaults for out-of-range value', () => {
        const configPath = '/tmp/test-agent-notifier-oor.json';
        vi.mocked(getConfigPath).mockReturnValue(configPath);
        fs.writeFileSync(configPath, JSON.stringify({ scanIntervalMs: -1 }));
        const config = loadConfig();
        expect(config.scanIntervalMs).toBe(2000);
    });

    it('returns defaults for corrupt JSON', () => {
        const configPath = '/tmp/test-agent-notifier-corrupt.json';
        vi.mocked(getConfigPath).mockReturnValue(configPath);
        fs.writeFileSync(configPath, '{invalid json{{');
        const config = loadConfig();
        expect(config.scanIntervalMs).toBe(2000);
    });

    it('rejects invalid logLevel and uses default', () => {
        const configPath = '/tmp/test-agent-notifier-loglevel.json';
        vi.mocked(getConfigPath).mockReturnValue(configPath);
        fs.writeFileSync(configPath, JSON.stringify({ logLevel: 'verbose' }));
        const config = loadConfig();
        expect(config.logLevel).toBe('info');
    });
});
