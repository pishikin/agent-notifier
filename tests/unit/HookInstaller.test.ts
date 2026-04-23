import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSettings, CodexHooksSettings } from '../../src/infra/HookConfig.js';
import type { ICommandExecutor } from '../../src/types.js';

let tmpHome = '';

vi.mock('../../src/utils/paths.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../../src/utils/paths.js')>();
    return {
        ...actual,
        getConfigDir: () => path.join(tmpHome, '.agent-notifier'),
        getLogsDir: () => path.join(tmpHome, '.agent-notifier', 'logs'),
        getHooksDir: () => path.join(tmpHome, '.agent-notifier', 'hooks'),
        getBinDir: () => path.join(tmpHome, '.agent-notifier', 'bin'),
        getShimPath: () => path.join(tmpHome, '.agent-notifier', 'bin', 'agent-notifier-shim'),
        getCodexHookWrapperPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-notify.sh'),
        getCodexStopHookWrapperPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-stop.sh'),
        getCodexPermissionHookWrapperPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-permission-request.sh'),
        getCodexLegacyNotifyPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-legacy-notify.sh'),
        getClaudeHookWrapperPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'claude-stop.sh'),
        getClaudeNotificationHookWrapperPath: () => path.join(tmpHome, '.agent-notifier', 'hooks', 'claude-notification.sh'),
        getHookInstallStatePath: () => path.join(tmpHome, '.agent-notifier', 'hook-install-state.json'),
        getInstallManifestPath: () => path.join(tmpHome, '.agent-notifier', 'install-manifest.json'),
        getHooksLogPath: () => path.join(tmpHome, '.agent-notifier', 'logs', 'hooks.log'),
        getHooksWrapperLogPath: () => path.join(tmpHome, '.agent-notifier', 'logs', 'hooks-wrapper.log'),
        getCodexConfigPath: () => path.join(tmpHome, '.codex', 'config.toml'),
        getCodexHooksPath: () => path.join(tmpHome, '.codex', 'hooks.json'),
        getClaudeSettingsPath: () => path.join(tmpHome, '.claude', 'settings.json'),
    };
});

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

    it('writes hooks-first manifest, wrappers, provider configs, and shim', async () => {
        await fs.mkdir(path.join(tmpHome, '.codex'), { recursive: true });
        await fs.writeFile(path.join(tmpHome, '.codex', 'config.toml'), 'model = "gpt-5.4"\n', 'utf8');
        await fs.mkdir(path.join(tmpHome, '.claude'), { recursive: true });
        await fs.writeFile(path.join(tmpHome, '.claude', 'settings.json'), '{}', 'utf8');

        const HookInstaller = await importHookInstaller();
        const installer = new HookInstaller(makeExecutor());
        const result = await installer.install();

        const manifest = JSON.parse(await fs.readFile(path.join(tmpHome, '.agent-notifier', 'install-manifest.json'), 'utf8')) as Record<string, unknown>;
        const codexNotifyWrapper = await fs.readFile(path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-notify.sh'), 'utf8');
        const codexStopWrapper = await fs.readFile(path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-stop.sh'), 'utf8');
        const codexPermissionWrapper = await fs.readFile(path.join(tmpHome, '.agent-notifier', 'hooks', 'codex-permission-request.sh'), 'utf8');
        const claudeStopWrapper = await fs.readFile(path.join(tmpHome, '.agent-notifier', 'hooks', 'claude-stop.sh'), 'utf8');
        const claudeNotificationWrapper = await fs.readFile(path.join(tmpHome, '.agent-notifier', 'hooks', 'claude-notification.sh'), 'utf8');
        const shim = await fs.readFile(path.join(tmpHome, '.agent-notifier', 'bin', 'agent-notifier-shim'), 'utf8');
        const codexConfig = await fs.readFile(path.join(tmpHome, '.codex', 'config.toml'), 'utf8');
        const codexHooks = JSON.parse(await fs.readFile(path.join(tmpHome, '.codex', 'hooks.json'), 'utf8')) as CodexHooksSettings;
        const claudeSettings = JSON.parse(await fs.readFile(path.join(tmpHome, '.claude', 'settings.json'), 'utf8')) as ClaudeSettings;

        expect(manifest['schemaVersion']).toBe(3);
        expect(result.manifest.wrapperVersion).toBe(3);
        expect(result.manifest.codexRuntimeMode).toBe('hooks-first');
        expect(codexNotifyWrapper).toContain('# agent-notifier-managed wrapper-version=3 provider=codex-notify');
        expect(codexStopWrapper).toContain('# agent-notifier-managed wrapper-version=3 provider=codex-stop');
        expect(codexPermissionWrapper).toContain('# agent-notifier-managed wrapper-version=3 provider=codex-permission-request');
        expect(claudeStopWrapper).toContain('# agent-notifier-managed wrapper-version=3 provider=claude-stop');
        expect(claudeNotificationWrapper).toContain('# agent-notifier-managed wrapper-version=3 provider=claude-notification');
        expect(shim).toContain('wrapper-version=3');
        expect(codexConfig).toContain('[features]');
        expect(codexConfig).toContain('codex_hooks = true');
        expect(codexHooks.hooks?.Stop?.[0]?.hooks?.[0]).toMatchObject({ type: 'command' });
        expect(codexHooks.hooks?.PermissionRequest?.[0]).toMatchObject({
            matcher: 'Bash',
        });
        expect(codexHooks.hooks?.PermissionRequest?.[0]?.hooks?.[0]).toMatchObject({
            type: 'command',
            statusMessage: 'Checking approval request',
        });
        expect(claudeSettings.hooks?.Stop?.[0]?.hooks?.[0]).toMatchObject({ type: 'command' });
        expect(claudeSettings.hooks?.Notification?.[0]).toMatchObject({ matcher: 'permission_prompt' });
    });

    it('preserves external Codex notify and warns about duplicate desktop notifications', async () => {
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
        const codexConfig = await fs.readFile(path.join(tmpHome, '.codex', 'config.toml'), 'utf8');

        expect(result.manifest.codexRuntimeMode).toBe('hooks-first');
        expect(result.manifest.codexOriginalNotify).toEqual(['/bin/bash', '/tmp/custom-notify.sh']);
        expect(result.warnings.some(warning => warning.includes('left untouched'))).toBe(true);
        expect(codexConfig).toContain('notify = ["/bin/bash","/tmp/custom-notify.sh"]');
        expect(codexConfig).toContain('codex_hooks = true');
    });

    it('restores prior Codex config state and removes managed hooks on uninstall', async () => {
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
        const uninstallResult = await installer.uninstall();

        const codexConfig = await fs.readFile(path.join(tmpHome, '.codex', 'config.toml'), 'utf8');

        expect(uninstallResult.restoredCodexHooksFeature).toBe(true);
        expect(uninstallResult.removedCodexHooks).toBe(true);
        expect(codexConfig).toContain('notify = ["/bin/bash","/tmp/custom-notify.sh"]');
        expect(codexConfig).not.toContain('codex_hooks = true');
        await expect(fs.access(path.join(tmpHome, '.codex', 'hooks.json'))).rejects.toThrow();
        await expect(fs.access(path.join(tmpHome, '.agent-notifier', 'install-manifest.json'))).rejects.toThrow();
    });

    it('leaves unsupported multiline Codex notify untouched and still installs hooks-first config', async () => {
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
        const result = await installer.install();
        const codexConfig = await fs.readFile(path.join(tmpHome, '.codex', 'config.toml'), 'utf8');

        expect(result.warnings.some(warning => warning.includes('unsupported format'))).toBe(true);
        expect(codexConfig).toContain('notify = [\n  "/bin/bash",\n  "/tmp/custom-notify.sh"\n]');
        expect(codexConfig).toContain('codex_hooks = true');
        await expect(fs.access(path.join(tmpHome, '.codex', 'hooks.json'))).resolves.toBeUndefined();
    });
});
