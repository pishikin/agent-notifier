import fs from 'node:fs/promises';
import path from 'node:path';
import type { HookInstallState, HookStatus, ICommandExecutor, InstallManifest } from '../types.js';
import { resolveCurrentRuntime, shellJoinArgs } from './CliInvocation.js';
import {
    countClaudeStopHooks,
    hasClaudeStopHook,
    inspectCodexNotifyConfig,
    parseClaudeSettings,
    removeClaudeStopHook,
    restoreCodexNotify,
    serializeClaudeSettings,
    upsertClaudeStopHook,
    upsertCodexNotify,
} from './HookConfig.js';
import {
    getBinDir,
    getClaudeHookWrapperPath,
    getClaudeSettingsPath,
    getCodexConfigPath,
    getCodexHookWrapperPath,
    getCodexLegacyNotifyPath,
    getConfigDir,
    getHookInstallStatePath,
    getHooksDir,
    getHooksLogPath,
    getHooksWrapperLogPath,
    getInstallManifestPath,
    getLogsDir,
    getShimPath,
} from '../utils/paths.js';

const BASH_PATH = '/bin/bash';
const WRAPPER_VERSION = 2;

export interface HookInstallResult {
    readonly manifest: InstallManifest;
    readonly warnings: string[];
}

export interface HookUninstallResult {
    readonly restoredCodexNotify: boolean;
    readonly removedManifest: boolean;
}

export class HookInstaller {
    constructor(private readonly executor: ICommandExecutor) {}

    async install(): Promise<HookInstallResult> {
        await fs.mkdir(getConfigDir(), { recursive: true });
        await fs.mkdir(getHooksDir(), { recursive: true });
        await fs.mkdir(getBinDir(), { recursive: true });
        await fs.mkdir(getLogsDir(), { recursive: true });

        const runtime = await resolveCurrentRuntime(this.executor);
        const managedNotifyArgs = this.getManagedCodexNotifyArgs();
        const rawCodexConfig = await readFileIfExists(getCodexConfigPath()) ?? '';
        const codexInspection = inspectCodexNotifyConfig(rawCodexConfig);
        if (codexInspection.state === 'unsupported') {
            throw new Error('Unsupported Codex notify format. Only single-line notify = [...] can be updated safely.');
        }

        const codexOriginalNotify = codexInspection.notifyArgs && !arraysEqual(codexInspection.notifyArgs, managedNotifyArgs)
            ? codexInspection.notifyArgs
            : undefined;
        const codexManagedMode = codexOriginalNotify ? 'chain-existing' : 'exclusive-managed';

        const rawClaudeSettings = await readFileIfExists(getClaudeSettingsPath()) ?? '{}';
        const parsedClaudeSettings = parseClaudeSettings(rawClaudeSettings);
        const claudeManagedCommand = this.getClaudeHookCommand();
        const claudeStopCounts = countClaudeStopHooks(parsedClaudeSettings, claudeManagedCommand);

        const manifest: InstallManifest = {
            schemaVersion: 2,
            installedAt: new Date().toISOString(),
            codexManagedMode,
            shimPath: getShimPath(),
            runtime,
            claudeManagedCommand,
            detectedOtherClaudeStopHooksAtInstall: claudeStopCounts.other,
            wrapperVersion: 2,
            ...(codexOriginalNotify ? { codexOriginalNotify } : {}),
        };

        await this.writeManifest(manifest);
        await this.writeShim();
        await this.writeCodexLegacyWrapper(codexOriginalNotify);
        await this.writeCodexWrapper();
        await this.writeClaudeWrapper();

        const nextCodexConfig = upsertCodexNotify(rawCodexConfig, managedNotifyArgs);
        await fs.mkdir(path.dirname(getCodexConfigPath()), { recursive: true });
        await fs.writeFile(getCodexConfigPath(), nextCodexConfig, 'utf8');

        const nextClaudeSettings = upsertClaudeStopHook(parsedClaudeSettings, claudeManagedCommand);
        await fs.mkdir(path.dirname(getClaudeSettingsPath()), { recursive: true });
        await fs.writeFile(getClaudeSettingsPath(), serializeClaudeSettings(nextClaudeSettings), 'utf8');

        await fs.rm(getHookInstallStatePath(), { force: true });

        const warnings: string[] = [];
        if (codexManagedMode === 'chain-existing') {
            warnings.push('Existing Codex notify command detected; it will be chained after the managed notifier and may still produce desktop notifications.');
        }
        if (claudeStopCounts.other > 0) {
            warnings.push(`Detected ${claudeStopCounts.other} other Claude Stop hook(s); Claude completion timing becomes best-effort when multiple Stop hooks coexist.`);
        }

        return { manifest, warnings };
    }

    async uninstall(): Promise<HookUninstallResult> {
        const manifest = await this.loadManifest();
        const legacyState = manifest ? null : await this.loadLegacyState();
        const managedNotifyArgs = this.getManagedCodexNotifyArgs();
        const rawCodexConfig = await readFileIfExists(getCodexConfigPath());

        let restoredCodexNotify = false;
        if (rawCodexConfig !== null) {
            const nextConfig = restoreCodexNotify(
                rawCodexConfig,
                managedNotifyArgs,
                manifest?.codexOriginalNotify ?? legacyState?.codexOriginalNotify,
            );
            restoredCodexNotify = nextConfig !== rawCodexConfig;
            await fs.writeFile(getCodexConfigPath(), nextConfig, 'utf8');
        }

        const rawClaudeSettings = await readFileIfExists(getClaudeSettingsPath());
        if (rawClaudeSettings !== null) {
            const parsed = parseClaudeSettings(rawClaudeSettings);
            const nextSettings = removeClaudeStopHook(parsed, manifest?.claudeManagedCommand ?? this.getClaudeHookCommand());
            await fs.writeFile(getClaudeSettingsPath(), serializeClaudeSettings(nextSettings), 'utf8');
        }

        await this.cleanupManagedScripts();
        await fs.rm(getInstallManifestPath(), { force: true });
        await fs.rm(getHookInstallStatePath(), { force: true });

        return {
            restoredCodexNotify,
            removedManifest: true,
        };
    }

    async getStatus(): Promise<HookStatus> {
        const manifest = await this.loadManifest();
        const managedCodexNotify = this.getManagedCodexNotifyArgs();
        const codexConfig = await readFileIfExists(getCodexConfigPath());
        const codexInspection = inspectCodexNotifyConfig(codexConfig ?? '');
        const claudeSettingsRaw = await readFileIfExists(getClaudeSettingsPath());
        const claudeCommand = manifest?.claudeManagedCommand ?? this.getClaudeHookCommand();

        const codexConfigured = codexInspection.state === 'supported'
            && arraysEqual(codexInspection.notifyArgs, managedCodexNotify);

        let claudeConfigured = false;
        let otherClaudeStopHooks = 0;
        if (claudeSettingsRaw) {
            try {
                const parsedSettings = parseClaudeSettings(claudeSettingsRaw);
                claudeConfigured = hasClaudeStopHook(parsedSettings, claudeCommand);
                otherClaudeStopHooks = countClaudeStopHooks(parsedSettings, claudeCommand).other;
            } catch {
                claudeConfigured = false;
            }
        }

        const staleWrapperVersionDetected = await this.hasStaleWrapperVersion();

        return {
            codexConfigured,
            claudeConfigured,
            otherClaudeStopHooks,
            manifestPresent: manifest !== null,
            staleWrapperVersionDetected,
            ...(manifest?.codexManagedMode ? { codexManagedMode: manifest.codexManagedMode } : {}),
        };
    }

    async loadManifest(): Promise<InstallManifest | null> {
        const raw = await readFileIfExists(getInstallManifestPath());
        if (!raw) {
            return null;
        }

        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return null;
            }

            const record = parsed as Record<string, unknown>;
            if (record.schemaVersion !== 2) {
                return null;
            }

            const runtime = record.runtime;
            if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
                return null;
            }

            if (
                record.codexManagedMode !== 'chain-existing'
                && record.codexManagedMode !== 'exclusive-managed'
            ) {
                return null;
            }

            if (
                record.wrapperVersion !== WRAPPER_VERSION
                || typeof record.installedAt !== 'string'
                || typeof record.shimPath !== 'string'
                || typeof record.claudeManagedCommand !== 'string'
                || typeof record.detectedOtherClaudeStopHooksAtInstall !== 'number'
            ) {
                return null;
            }

            if ((runtime as Record<string, unknown>).kind === 'binary' && typeof (runtime as Record<string, unknown>).command === 'string') {
                const codexOriginalNotify = readStringArray(record.codexOriginalNotify);
                return {
                    schemaVersion: 2,
                    installedAt: record.installedAt,
                    codexManagedMode: record.codexManagedMode,
                    shimPath: record.shimPath,
                    runtime: {
                        kind: 'binary',
                        command: (runtime as Record<string, unknown>).command as string,
                    },
                    claudeManagedCommand: record.claudeManagedCommand,
                    detectedOtherClaudeStopHooksAtInstall: record.detectedOtherClaudeStopHooksAtInstall,
                    wrapperVersion: 2,
                    ...(codexOriginalNotify ? { codexOriginalNotify } : {}),
                };
            }

            if (
                (runtime as Record<string, unknown>).kind === 'node'
                && typeof (runtime as Record<string, unknown>).nodePath === 'string'
                && typeof (runtime as Record<string, unknown>).entryPath === 'string'
            ) {
                const codexOriginalNotify = readStringArray(record.codexOriginalNotify);
                return {
                    schemaVersion: 2,
                    installedAt: record.installedAt,
                    codexManagedMode: record.codexManagedMode,
                    shimPath: record.shimPath,
                    runtime: {
                        kind: 'node',
                        nodePath: (runtime as Record<string, unknown>).nodePath as string,
                        entryPath: (runtime as Record<string, unknown>).entryPath as string,
                    },
                    claudeManagedCommand: record.claudeManagedCommand,
                    detectedOtherClaudeStopHooksAtInstall: record.detectedOtherClaudeStopHooksAtInstall,
                    wrapperVersion: 2,
                    ...(codexOriginalNotify ? { codexOriginalNotify } : {}),
                };
            }
        } catch {
            return null;
        }

        return null;
    }

    private async writeManifest(manifest: InstallManifest): Promise<void> {
        await fs.writeFile(getInstallManifestPath(), JSON.stringify(manifest, null, 2), 'utf8');
    }

    private async cleanupManagedScripts(): Promise<void> {
        await fs.rm(getClaudeHookWrapperPath(), { force: true });
        await fs.rm(getCodexHookWrapperPath(), { force: true });
        await fs.rm(getCodexLegacyNotifyPath(), { force: true });
        await fs.rm(getShimPath(), { force: true });
    }

    private async writeShim(): Promise<void> {
        const script = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const manifestPath = ${JSON.stringify(getInstallManifestPath())};
const logPath = ${JSON.stringify(getHooksWrapperLogPath())};
const selfPath = ${JSON.stringify(getShimPath())};

function logLine(stage, details) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, \`\${new Date().toISOString()} provider=shim wrapper-version=${WRAPPER_VERSION} stage=\${stage} \${details}\\n\`);
  } catch {}
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveFromPath() {
  const result = spawnSync('which', ['agent-notifier'], { encoding: 'utf8' });
  if (result.status === 0) {
    const candidate = result.stdout.trim();
    if (candidate && candidate !== selfPath) {
      return { command: candidate, args: [] };
    }
  }
  return null;
}

function resolveFromManifest() {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    logLine('resolve-failed', 'reason=manifest-unreadable');
    return null;
  }

  if (!manifest || !manifest.runtime || typeof manifest.runtime !== 'object') {
    logLine('resolve-failed', 'reason=manifest-missing-runtime');
    return null;
  }

  if (manifest.runtime.kind === 'binary') {
    if (!isExecutable(manifest.runtime.command)) {
      logLine('resolve-failed', \`reason=missing-binary command=\${manifest.runtime.command}\`);
      return null;
    }
    return { command: manifest.runtime.command, args: [] };
  }

  if (manifest.runtime.kind === 'node') {
    if (!isExecutable(manifest.runtime.nodePath) || !fs.existsSync(manifest.runtime.entryPath)) {
      logLine('resolve-failed', \`reason=missing-node-runtime node=\${manifest.runtime.nodePath} entry=\${manifest.runtime.entryPath}\`);
      return null;
    }
    return { command: manifest.runtime.nodePath, args: [manifest.runtime.entryPath] };
  }

  logLine('resolve-failed', 'reason=unknown-runtime-kind');
  return null;
}

const runtime = resolveFromPath() ?? resolveFromManifest();
if (!runtime) {
  process.exit(1);
}

const result = spawnSync(runtime.command, [...runtime.args, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) {
  logLine('exec-failed', \`command=\${runtime.command} error=\${String(result.error).replace(/\\s+/g, ' ')}\`);
  process.exit(1);
}

process.exit(result.status ?? 1);
`;

        await fs.writeFile(getShimPath(), script, 'utf8');
        await fs.chmod(getShimPath(), 0o755);
    }

    private async writeCodexWrapper(): Promise<void> {
        const script = `#!/bin/bash
# agent-notifier-managed wrapper-version=${WRAPPER_VERSION} provider=codex
set -u

SHIM=${JSON.stringify(getShimPath())}
LEGACY_SCRIPT=${JSON.stringify(getCodexLegacyNotifyPath())}
LOG_PATH=${JSON.stringify(getHooksWrapperLogPath())}
PAYLOAD="\${1:-}"

log_wrapper_failure() {
  local stage="$1"
  local exit_code="$2"
  local stderr="$3"
  mkdir -p "$(dirname "$LOG_PATH")"
  stderr="\${stderr//$'\\n'/\\\\n}"
  printf '%s provider=codex wrapper-version=${WRAPPER_VERSION} stage=%s exit_code=%s stderr=%s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$stage" "$exit_code" "$stderr" >> "$LOG_PATH"
}

if ! output="$("$SHIM" hook codex "$PAYLOAD" 2>&1)"; then
  code=$?
  log_wrapper_failure "shim" "$code" "$output"
fi

if [[ -x "$LEGACY_SCRIPT" ]]; then
  if ! legacy_output="$("$LEGACY_SCRIPT" "$PAYLOAD" 2>&1)"; then
    code=$?
    log_wrapper_failure "legacy-notify" "$code" "$legacy_output"
  fi
fi

exit 0
`;
        await fs.writeFile(getCodexHookWrapperPath(), script, 'utf8');
        await fs.chmod(getCodexHookWrapperPath(), 0o755);
    }

    private async writeCodexLegacyWrapper(originalNotifyArgs?: string[]): Promise<void> {
        if (!originalNotifyArgs || originalNotifyArgs.length === 0) {
            await fs.rm(getCodexLegacyNotifyPath(), { force: true });
            return;
        }

        const command = shellJoinArgs(originalNotifyArgs);
        const script = `#!/bin/bash
# agent-notifier-legacy wrapper-version=${WRAPPER_VERSION} provider=codex
set -u

PAYLOAD="\${1:-}"
${command} "$PAYLOAD"
`;
        await fs.writeFile(getCodexLegacyNotifyPath(), script, 'utf8');
        await fs.chmod(getCodexLegacyNotifyPath(), 0o755);
    }

    private async writeClaudeWrapper(): Promise<void> {
        const script = `#!/bin/bash
# agent-notifier-managed wrapper-version=${WRAPPER_VERSION} provider=claude
set -u

SHIM=${JSON.stringify(getShimPath())}
LOG_PATH=${JSON.stringify(getHooksWrapperLogPath())}
PAYLOAD="$(cat)"

log_wrapper_failure() {
  local stage="$1"
  local exit_code="$2"
  local stderr="$3"
  mkdir -p "$(dirname "$LOG_PATH")"
  stderr="\${stderr//$'\\n'/\\\\n}"
  printf '%s provider=claude wrapper-version=${WRAPPER_VERSION} stage=%s exit_code=%s stderr=%s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$stage" "$exit_code" "$stderr" >> "$LOG_PATH"
}

if ! output="$(printf '%s' "$PAYLOAD" | "$SHIM" hook claude 2>&1)"; then
  code=$?
  log_wrapper_failure "shim" "$code" "$output"
fi

exit 0
`;
        await fs.writeFile(getClaudeHookWrapperPath(), script, 'utf8');
        await fs.chmod(getClaudeHookWrapperPath(), 0o755);
    }

    private async hasStaleWrapperVersion(): Promise<boolean> {
        const [codexHeader, claudeHeader] = await Promise.all([
            readHeaderIfExists(getCodexHookWrapperPath()),
            readHeaderIfExists(getClaudeHookWrapperPath()),
        ]);

        return !isManagedWrapperHeader(codexHeader, 'codex') || !isManagedWrapperHeader(claudeHeader, 'claude');
    }

    private getManagedCodexNotifyArgs(): string[] {
        return [BASH_PATH, getCodexHookWrapperPath()];
    }

    private getClaudeHookCommand(): string {
        return shellJoinArgs([BASH_PATH, getClaudeHookWrapperPath()]);
    }

    private async loadLegacyState(): Promise<HookInstallState> {
        const raw = await readFileIfExists(getHookInstallStatePath());
        if (!raw) {
            return {};
        }

        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {};
            }

            const record = parsed as Record<string, unknown>;
            const codexOriginalNotify = readStringArray(record.codexOriginalNotify);
            return codexOriginalNotify ? { codexOriginalNotify } : {};
        } catch {
            return {};
        }
    }
}

function arraysEqual(left: string[] | null | undefined, right: string[] | null | undefined): boolean {
    if (!left || !right || left.length !== right.length) {
        return false;
    }

    return left.every((value, index) => value === right[index]);
}

function readStringArray(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every(item => typeof item === 'string')
        ? value
        : undefined;
}

function isManagedWrapperHeader(line: string | null, provider: 'codex' | 'claude'): boolean {
    return line === `# agent-notifier-managed wrapper-version=${WRAPPER_VERSION} provider=${provider}`;
}

async function readFileIfExists(filePath: string): Promise<string | null> {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch {
        return null;
    }
}

async function readHeaderIfExists(filePath: string): Promise<string | null> {
    const content = await readFileIfExists(filePath);
    if (!content) {
        return null;
    }
    const lines = content.split('\n');
    return lines.find(line => line.startsWith('# agent-notifier-managed')) ?? null;
}
