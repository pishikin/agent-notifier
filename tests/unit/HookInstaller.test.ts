import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICommandExecutor } from '../../src/types.js';

let tmpHome = '';

vi.mock('../../src/utils/paths.js', () => ({
    getConfigDir: () => path.join(tmpHome, '.agent-notifier'),
    getLogsDir: () => path.join(tmpHome, '.agent-notifier', 'logs'),
    getHooksDir: () => path.join(tmpHome, '.agent-notifier', 'hooks'),
    getBinDir: () => path.join(tmpHome, '.agent-notifier', 'bin'),
    getShimPath: () => path.join(tmpHome, '.agent-notifier', 'bin', 'agent-notifier-shim'),
    getCodexHookWrapperPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-notify.sh'),
    getCodexLegacyNotifyPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-legacy-notify.sh'),
    getClaudeHookWrapperPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'claude-stop.sh'),
    getHookInstallStatePath: () => path.join(tmpHome, '.agent-notifier', 'hook-install-state.json'),
    getInstallManifestPath: () => path.join(tmpHome, '.agent-notifier', 'install-manifest.json'),
    getHooksLogPath: () => path.join(tmpHome, '.agent-notifier', 'logs', 'hooks.log'),
    getHooksWrapperLogPath: () => path.join(tmpHome, '.agent-notifier', 'logs', 'hooks-wrapper.log'),
    getCodexConfigPath: () => path.join(tmpHome, '.codex', 'config.toml'),
    getClaudeSettingsPath: () => path.join(tmpHome, '.claude', 'settings.json'),
}));

describe('HookInstaller', () => {
    beforeEach(async () => {
        tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-notifier-install-'));
    });

    afterEach(async () => {
        await fs.rm(tmpHome, { recursive: true, force: true });
        vi.resetModules();
    });

    async function importHookInstaller() {
        const module = await import('../../src/infra/HookInstaller.js');
        return module.HookInstaller;
    }

    function makeExecutor(cliPath = '/usr/local/bin/agent-notifier'): ICommandExecutor {
        return {
            exec: vi.fn().mockImplementation((command: string, args: string[]) => {
                if (command === 'which' && args[0] === 'agent-notifier') {
                    return Promise.resolve({ stdout: `${cliPath}\n`, stderr: '', exitCode: 0 });
                }
                return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
            }),
            execSync: vi.fn().mockReturnValue(null),
        };
    }

    it('writes install manifest, shim, and managed wrapper headers', async () => {
        await fs.mkdir(path.join(tmpHome, '.codex'), { recursive: true });
        await fs.writeFile(path.join(tmpHome, '.codex', 'config.toml'), 'model = "gpt-5.4"\n', 'utf8');
        await fs.mkdir(path.join(tmpHome, '.claude'), { recursive: true });
        await fs.writeFile(path.join(tmpHome, '.claude', 'settings.json'), '{}', 'utf8');

        const HookInstaller = await importHookInstaller();
        const installer = new HookInstaller(makeExecutor());
        const result = await installer.install();

        const manifest = JSON.parse(await fs.readFile(path.join(tmpHome, '.agent-notifier', 'install-manifest.json'), 'utf8')) as Record<string, unknown>;
        const codexWrapper = await fs.readFile(path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-notify.sh'), 'utf8');
        const claudeWrapper = await fs.readFile(path.join(tmpHome, '.agent-notifier', 'hooks', 'claude-stop.sh'), 'utf8');
        const shim = await fs.readFile(path.join(tmpHome, '.agent-notifier', 'bin', 'agent-notifier-shim'), 'utf8');

        expect(manifest['schemaVersion']).toBe(2);
        expect(result.manifest.wrapperVersion).toBe(2);
        expect(codexWrapper).toContain('# agent-notifier-managed wrapper-version=2 provider=codex');
        expect(claudeWrapper).toContain('# agent-notifier-managed wrapper-version=2 provider=claude');
        expect(shim).toContain('wrapper-version=2');
    });

    it('stores chain-existing mode and warning when Codex notify already exists', async () => {
        await fs.mkdir(path.join(tmpHome, '.codex'), { recursive: true });
        await fs.writeFile(
            path.join(tmpHome, '.codex', 'config.toml'),
            'notify = ["/bin/bash","/tmp/custom-notify.sh"]\n',
            'utf8',
        );
        await fs.mkdir(path.join(tmpHome, '.claude'), { recursive: true });
        await fs.writeFile(path.join(tmpHome, '.claude', 'settings.json'), '{}', 'utf8');

        const HookInstaller = await importHookInstaller();
        const installer = new HookInstaller(makeExecutor());
        const result = await installer.install();

        expect(result.manifest.codexManagedMode).toBe('chain-existing');
        expect(result.manifest.codexOriginalNotify).toEqual(['/bin/bash', '/tmp/custom-notify.sh']);
        expect(result.warnings.some(warning => warning.includes('Existing Codex notify command detected'))).toBe(true);
    });

    it('restores original Codex notify on uninstall when managed state is intact', async () => {
        await fs.mkdir(path.join(tmpHome, '.codex'), { recursive: true });
        await fs.writeFile(
            path.join(tmpHome, '.codex', 'config.toml'),
            'notify = ["/bin/bash","/tmp/custom-notify.sh"]\n',
            'utf8',
        );
        await fs.mkdir(path.join(tmpHome, '.claude'), { recursive: true });
        await fs.writeFile(path.join(tmpHome, '.claude', 'settings.json'), '{}', 'utf8');

        const HookInstaller = await importHookInstaller();
        const installer = new HookInstaller(makeExecutor());
        await installer.install();
        await installer.uninstall();

        const codexConfig = await fs.readFile(path.join(tmpHome, '.codex', 'config.toml'), 'utf8');
        expect(codexConfig).toContain('notify = ["/bin/bash","/tmp/custom-notify.sh"]');
    });

    it('fails when Codex notify format is unsupported for safe mutation', async () => {
        await fs.mkdir(path.join(tmpHome, '.codex'), { recursive: true });
        await fs.writeFile(
            path.join(tmpHome, '.codex', 'config.toml'),
            'notify = [\n  "/bin/bash",\n  "/tmp/custom-notify.sh"\n]\n',
            'utf8',
        );
        await fs.mkdir(path.join(tmpHome, '.claude'), { recursive: true });
        await fs.writeFile(path.join(tmpHome, '.claude', 'settings.json'), '{}', 'utf8');

        const HookInstaller = await importHookInstaller();
        const installer = new HookInstaller(makeExecutor());

        await expect(installer.install()).rejects.toThrow('Unsupported Codex notify format');
    });
});
