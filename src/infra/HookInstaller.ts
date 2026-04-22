import fs from 'node:fs/promises';
import path from 'node:path';
import type { HookInstallState, HookStatus, ICommandExecutor, InstallManifest } from '../types.js';
import { resolveCurrentRuntime, shellJoinArgs } from './CliInvocation.js';
import {
    countClaudePermissionPromptHooks,
    countClaudeStopHooks,
    hasClaudePermissionPromptHook,
    hasClaudeStopHook,
    hasCodexCommandHook,
    inspectCodexHooksFeature,
    inspectCodexNotifyConfig,
    parseClaudeSettings,
    parseCodexHooksSettings,
    removeClaudePermissionPromptHook,
    removeClaudeStopHook,
    removeCodexCommandHook,
    restoreCodexHooksFeature,
    restoreCodexNotify,
    serializeClaudeSettings,
    serializeCodexHooksSettings,
    upsertClaudePermissionPromptHook,
    upsertClaudeStopHook,
    upsertCodexCommandHook,
    upsertCodexHooksFeature,
} from './HookConfig.js';
import {
    getBinDir,
    getClaudeHookWrapperPath,
    getClaudeNotificationHookWrapperPath,
    getClaudeSettingsPath,
    getCodexConfigPath,
    getCodexHookWrapperPath,
    getCodexHooksPath,
    getCodexLegacyNotifyPath,
    getCodexPermissionHookWrapperPath,
    getCodexStopHookWrapperPath,
    getConfigDir,
    getHookInstallStatePath,
    getHooksDir,
    getHooksWrapperLogPath,
    getInstallManifestPath,
    getLogsDir,
    getShimPath,
} from '../utils/paths.js';

const BASH_PATH = '/bin/bash';
const WRAPPER_VERSION = 3;

export interface HookInstallResult {
    readonly manifest: InstallManifest;
    readonly warnings: string[];
}

export interface HookUninstallResult {
    readonly restoredCodexNotify: boolean;
    readonly restoredCodexHooksFeature: boolean;
    readonly removedCodexHooks: boolean;
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
        const existingManifest = await this.loadManifest();
        const managedNotifyArgs = this.getManagedCodexNotifyArgs();
        const rawCodexConfig = await readFileIfExists(getCodexConfigPath()) ?? '';
        const codexInspection = inspectCodexNotifyConfig(rawCodexConfig);
        const codexHooksFeatureStateBeforeInstall = inspectCodexHooksFeature(rawCodexConfig);
        const currentNotifyIsManaged = codexInspection.state === 'supported'
            && arraysEqual(codexInspection.notifyArgs, managedNotifyArgs);

        const codexOriginalNotify = currentNotifyIsManaged
            ? existingManifest?.codexOriginalNotify
            : (codexInspection.state === 'supported' ? codexInspection.notifyArgs ?? undefined : undefined);

        let nextCodexConfig = upsertCodexHooksFeature(rawCodexConfig, true);
        if (currentNotifyIsManaged) {
            nextCodexConfig = restoreCodexNotify(nextCodexConfig, managedNotifyArgs, existingManifest?.codexOriginalNotify);
        }

        const rawCodexHooks = await readFileIfExists(getCodexHooksPath()) ?? '{}';
        const parsedCodexHooks = parseCodexHooksSettings(rawCodexHooks);
        const codexStopCommand = this.getCodexStopHookCommand();
        const codexPermissionCommand = this.getCodexPermissionHookCommand();
        const nextCodexHooks = upsertCodexCommandHook(
            upsertCodexCommandHook(parsedCodexHooks, 'Stop', codexStopCommand),
            'PermissionRequest',
            codexPermissionCommand,
            { statusMessage: 'Checking approval request' },
        );

        const rawClaudeSettings = await readFileIfExists(getClaudeSettingsPath()) ?? '{}';
        const parsedClaudeSettings = parseClaudeSettings(rawClaudeSettings);
        const claudeStopCommand = this.getClaudeStopHookCommand();
        const claudePermissionPromptCommand = this.getClaudeNotificationHookCommand();
        const claudeStopCounts = countClaudeStopHooks(parsedClaudeSettings, claudeStopCommand);
        const claudePermissionPromptCounts = countClaudePermissionPromptHooks(
            parsedClaudeSettings,
            claudePermissionPromptCommand,
        );
        const nextClaudeSettings = upsertClaudePermissionPromptHook(
            upsertClaudeStopHook(parsedClaudeSettings, claudeStopCommand),
            claudePermissionPromptCommand,
        );

        const manifest: InstallManifest = {
            schemaVersion: 3,
            installedAt: new Date().toISOString(),
            codexRuntimeMode: 'hooks-first',
            codexHooksFeatureStateBeforeInstall,
            shimPath: getShimPath(),
            runtime,
            codexStopCommand,
            codexPermissionCommand,
            claudeStopCommand,
            claudePermissionPromptCommand,
            detectedOtherClaudeStopHooksAtInstall: claudeStopCounts.other,
            detectedOtherClaudePermissionPromptHooksAtInstall: claudePermissionPromptCounts.other,
            wrapperVersion: WRAPPER_VERSION,
            ...(codexOriginalNotify ? { codexOriginalNotify } : {}),
        };

        await this.writeManifest(manifest);
        await this.writeShim();
        await this.writeCodexLegacyWrapper(codexOriginalNotify);
        await this.writeCodexNotifyWrapper();
        await this.writeCodexStopWrapper();
        await this.writeCodexPermissionWrapper();
        await this.writeClaudeStopWrapper();
        await this.writeClaudeNotificationWrapper();

        await fs.mkdir(path.dirname(getCodexConfigPath()), { recursive: true });
        await fs.writeFile(getCodexConfigPath(), nextCodexConfig, 'utf8');

        await fs.mkdir(path.dirname(getCodexHooksPath()), { recursive: true });
        await fs.writeFile(getCodexHooksPath(), serializeCodexHooksSettings(nextCodexHooks), 'utf8');

        await fs.mkdir(path.dirname(getClaudeSettingsPath()), { recursive: true });
        await fs.writeFile(getClaudeSettingsPath(), serializeClaudeSettings(nextClaudeSettings), 'utf8');

        await fs.rm(getHookInstallStatePath(), { force: true });

        const warnings: string[] = [];
        if (codexInspection.state === 'supported' && !currentNotifyIsManaged) {
            warnings.push('Existing Codex notify command was left untouched and may still produce extra desktop notifications.');
        }
        if (codexInspection.state === 'unsupported') {
            warnings.push('Codex notify config uses an unsupported format and was left untouched.');
        }
        if (claudeStopCounts.other > 0) {
            warnings.push(`Detected ${claudeStopCounts.other} other Claude Stop hook(s); completion timing becomes best-effort when multiple Stop hooks coexist.`);
        }
        if (claudePermissionPromptCounts.other > 0) {
            warnings.push(`Detected ${claudePermissionPromptCounts.other} other Claude permission_prompt Notification hook(s); duplicate approval notifications are possible.`);
        }

        return { manifest, warnings };
    }

    async uninstall(): Promise<HookUninstallResult> {
        const manifest = await this.loadManifest();
        const legacyState = manifest ? null : await this.loadLegacyState();
        const managedNotifyArgs = this.getManagedCodexNotifyArgs();
        const rawCodexConfig = await readFileIfExists(getCodexConfigPath());

        let restoredCodexNotify = false;
        let restoredCodexHooksFeature = false;
        if (rawCodexConfig !== null) {
            let nextConfig = restoreCodexNotify(
                rawCodexConfig,
                managedNotifyArgs,
                manifest?.codexOriginalNotify ?? legacyState?.codexOriginalNotify,
            );
            restoredCodexNotify = nextConfig !== rawCodexConfig;

            if (manifest?.codexHooksFeatureStateBeforeInstall) {
                const restoredFeatureConfig = restoreCodexHooksFeature(
                    nextConfig,
                    manifest.codexHooksFeatureStateBeforeInstall,
                );
                restoredCodexHooksFeature = restoredFeatureConfig !== nextConfig;
                nextConfig = restoredFeatureConfig;
            }

            await fs.writeFile(getCodexConfigPath(), nextConfig, 'utf8');
        }

        let removedCodexHooks = false;
        const rawCodexHooks = await readFileIfExists(getCodexHooksPath());
        if (rawCodexHooks !== null) {
            const parsedCodexHooks = parseCodexHooksSettings(rawCodexHooks);
            const nextCodexHooks = removeCodexCommandHook(
                removeCodexCommandHook(
                    parsedCodexHooks,
                    'Stop',
                    manifest?.codexStopCommand ?? this.getCodexStopHookCommand(),
                ),
                'PermissionRequest',
                manifest?.codexPermissionCommand ?? this.getCodexPermissionHookCommand(),
            );
            removedCodexHooks = JSON.stringify(nextCodexHooks) !== JSON.stringify(parsedCodexHooks);
            if (hasConfiguredCodexHooks(nextCodexHooks)) {
                await fs.writeFile(getCodexHooksPath(), serializeCodexHooksSettings(nextCodexHooks), 'utf8');
            } else {
                await fs.rm(getCodexHooksPath(), { force: true });
            }
        }

        const rawClaudeSettings = await readFileIfExists(getClaudeSettingsPath());
        if (rawClaudeSettings !== null) {
            const parsed = parseClaudeSettings(rawClaudeSettings);
            const nextSettings = removeClaudePermissionPromptHook(
                removeClaudeStopHook(
                    parsed,
                    manifest?.claudeStopCommand ?? this.getClaudeStopHookCommand(),
                ),
                manifest?.claudePermissionPromptCommand ?? this.getClaudeNotificationHookCommand(),
            );
            await fs.writeFile(getClaudeSettingsPath(), serializeClaudeSettings(nextSettings), 'utf8');
        }

        await this.cleanupManagedScripts();
        await fs.rm(getInstallManifestPath(), { force: true });
        await fs.rm(getHookInstallStatePath(), { force: true });

        return {
            restoredCodexNotify,
            restoredCodexHooksFeature,
            removedCodexHooks,
            removedManifest: true,
        };
    }

    async getStatus(): Promise<HookStatus> {
        const manifest = await this.loadManifest();
        const managedCodexNotify = this.getManagedCodexNotifyArgs();
        const codexConfig = await readFileIfExists(getCodexConfigPath());
        const codexInspection = inspectCodexNotifyConfig(codexConfig ?? '');
        const codexHooksFeatureEnabled = inspectCodexHooksFeature(codexConfig ?? '') === 'enabled';
        const legacyManagedNotifyConfigured = codexInspection.state === 'supported'
            && arraysEqual(codexInspection.notifyArgs, managedCodexNotify);
        const externalCodexNotifyConfigured = codexInspection.state === 'unsupported'
            || (codexInspection.state === 'supported' && !legacyManagedNotifyConfigured);

        const codexHooksRaw = await readFileIfExists(getCodexHooksPath());
        let codexStopConfigured = false;
        let codexPermissionConfigured = false;
        if (codexHooksRaw) {
            try {
                const parsedHooks = parseCodexHooksSettings(codexHooksRaw);
                codexStopConfigured = hasCodexCommandHook(
                    parsedHooks,
                    'Stop',
                    manifest?.codexStopCommand ?? this.getCodexStopHookCommand(),
                );
                codexPermissionConfigured = hasCodexCommandHook(
                    parsedHooks,
                    'PermissionRequest',
                    manifest?.codexPermissionCommand ?? this.getCodexPermissionHookCommand(),
                );
            } catch {
                codexStopConfigured = false;
                codexPermissionConfigured = false;
            }
        }

        const claudeSettingsRaw = await readFileIfExists(getClaudeSettingsPath());
        const claudeStopCommand = manifest?.claudeStopCommand ?? this.getClaudeStopHookCommand();
        const claudePermissionPromptCommand = manifest?.claudePermissionPromptCommand ?? this.getClaudeNotificationHookCommand();

        let claudeCompletionConfigured = false;
        let claudeApprovalConfigured = false;
        let otherClaudeStopHooks = 0;
        let otherClaudePermissionPromptHooks = 0;
        if (claudeSettingsRaw) {
            try {
                const parsedSettings = parseClaudeSettings(claudeSettingsRaw);
                claudeCompletionConfigured = hasClaudeStopHook(parsedSettings, claudeStopCommand);
                claudeApprovalConfigured = hasClaudePermissionPromptHook(parsedSettings, claudePermissionPromptCommand);
                otherClaudeStopHooks = countClaudeStopHooks(parsedSettings, claudeStopCommand).other;
                otherClaudePermissionPromptHooks = countClaudePermissionPromptHooks(
                    parsedSettings,
                    claudePermissionPromptCommand,
                ).other;
            } catch {
                claudeCompletionConfigured = false;
                claudeApprovalConfigured = false;
            }
        }

        const staleWrapperVersionDetected = await this.hasStaleWrapperVersion();
        const codexRuntimeMode = codexHooksFeatureEnabled && (codexStopConfigured || codexPermissionConfigured)
            ? (legacyManagedNotifyConfigured ? 'hybrid' : 'hooks-first')
            : (legacyManagedNotifyConfigured ? 'notify-fallback' : undefined);

        return {
            codexCompletionConfigured: (codexHooksFeatureEnabled && codexStopConfigured) || legacyManagedNotifyConfigured,
            codexApprovalConfigured: codexHooksFeatureEnabled && codexPermissionConfigured,
            claudeCompletionConfigured,
            claudeApprovalConfigured,
            codexHooksFeatureEnabled,
            externalCodexNotifyConfigured,
            otherClaudeStopHooks,
            otherClaudePermissionPromptHooks,
            manifestPresent: manifest !== null,
            staleWrapperVersionDetected,
            ...(codexRuntimeMode ? { codexRuntimeMode } : {}),
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
            if (record.schemaVersion === 3) {
                return readManifestV3(record);
            }

            if (record.schemaVersion === 2) {
                return readManifestV2(record);
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
        await fs.rm(getClaudeNotificationHookWrapperPath(), { force: true });
        await fs.rm(getCodexHookWrapperPath(), { force: true });
        await fs.rm(getCodexStopHookWrapperPath(), { force: true });
        await fs.rm(getCodexPermissionHookWrapperPath(), { force: true });
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

    private async writeCodexNotifyWrapper(): Promise<void> {
        const script = `#!/bin/bash
# agent-notifier-managed wrapper-version=${WRAPPER_VERSION} provider=codex-notify
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
  printf '%s provider=codex-notify wrapper-version=${WRAPPER_VERSION} stage=%s exit_code=%s stderr=%s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$stage" "$exit_code" "$stderr" >> "$LOG_PATH"
}

if ! output="$("$SHIM" hook codex-notify "$PAYLOAD" 2>&1)"; then
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

    private async writeCodexStopWrapper(): Promise<void> {
        const script = `#!/bin/bash
# agent-notifier-managed wrapper-version=${WRAPPER_VERSION} provider=codex-stop
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
  printf '%s provider=codex-stop wrapper-version=${WRAPPER_VERSION} stage=%s exit_code=%s stderr=%s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$stage" "$exit_code" "$stderr" >> "$LOG_PATH"
}

if ! output="$(printf '%s' "$PAYLOAD" | "$SHIM" hook codex-stop 2>&1)"; then
  code=$?
  log_wrapper_failure "shim" "$code" "$output"
fi

exit 0
`;
        await fs.writeFile(getCodexStopHookWrapperPath(), script, 'utf8');
        await fs.chmod(getCodexStopHookWrapperPath(), 0o755);
    }

    private async writeCodexPermissionWrapper(): Promise<void> {
        const script = `#!/bin/bash
# agent-notifier-managed wrapper-version=${WRAPPER_VERSION} provider=codex-permission-request
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
  printf '%s provider=codex-permission-request wrapper-version=${WRAPPER_VERSION} stage=%s exit_code=%s stderr=%s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$stage" "$exit_code" "$stderr" >> "$LOG_PATH"
}

if ! output="$(printf '%s' "$PAYLOAD" | "$SHIM" hook codex-permission-request 2>&1)"; then
  code=$?
  log_wrapper_failure "shim" "$code" "$output"
fi

exit 0
`;
        await fs.writeFile(getCodexPermissionHookWrapperPath(), script, 'utf8');
        await fs.chmod(getCodexPermissionHookWrapperPath(), 0o755);
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

    private async writeClaudeStopWrapper(): Promise<void> {
        const script = `#!/bin/bash
# agent-notifier-managed wrapper-version=${WRAPPER_VERSION} provider=claude-stop
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
  printf '%s provider=claude-stop wrapper-version=${WRAPPER_VERSION} stage=%s exit_code=%s stderr=%s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$stage" "$exit_code" "$stderr" >> "$LOG_PATH"
}

if ! output="$(printf '%s' "$PAYLOAD" | "$SHIM" hook claude-stop 2>&1)"; then
  code=$?
  log_wrapper_failure "shim" "$code" "$output"
fi

exit 0
`;
        await fs.writeFile(getClaudeHookWrapperPath(), script, 'utf8');
        await fs.chmod(getClaudeHookWrapperPath(), 0o755);
    }

    private async writeClaudeNotificationWrapper(): Promise<void> {
        const script = `#!/bin/bash
# agent-notifier-managed wrapper-version=${WRAPPER_VERSION} provider=claude-notification
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
  printf '%s provider=claude-notification wrapper-version=${WRAPPER_VERSION} stage=%s exit_code=%s stderr=%s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$stage" "$exit_code" "$stderr" >> "$LOG_PATH"
}

if ! output="$(printf '%s' "$PAYLOAD" | "$SHIM" hook claude-notification 2>&1)"; then
  code=$?
  log_wrapper_failure "shim" "$code" "$output"
fi

exit 0
`;
        await fs.writeFile(getClaudeNotificationHookWrapperPath(), script, 'utf8');
        await fs.chmod(getClaudeNotificationHookWrapperPath(), 0o755);
    }

    private async hasStaleWrapperVersion(): Promise<boolean> {
        const expectedHeaders = new Map<string, string>([
            [getCodexHookWrapperPath(), `# agent-notifier-managed wrapper-version=${WRAPPER_VERSION} provider=codex-notify`],
            [getCodexStopHookWrapperPath(), `# agent-notifier-managed wrapper-version=${WRAPPER_VERSION} provider=codex-stop`],
            [getCodexPermissionHookWrapperPath(), `# agent-notifier-managed wrapper-version=${WRAPPER_VERSION} provider=codex-permission-request`],
            [getClaudeHookWrapperPath(), `# agent-notifier-managed wrapper-version=${WRAPPER_VERSION} provider=claude-stop`],
            [getClaudeNotificationHookWrapperPath(), `# agent-notifier-managed wrapper-version=${WRAPPER_VERSION} provider=claude-notification`],
        ]);

        const headers = await Promise.all(
            [...expectedHeaders.keys()].map(async filePath => [filePath, await readHeaderIfExists(filePath)] as const),
        );

        return headers.some(([filePath, header]) => header !== expectedHeaders.get(filePath));
    }

    private getManagedCodexNotifyArgs(): string[] {
        return [BASH_PATH, getCodexHookWrapperPath()];
    }

    private getCodexStopHookCommand(): string {
        return shellJoinArgs([BASH_PATH, getCodexStopHookWrapperPath()]);
    }

    private getCodexPermissionHookCommand(): string {
        return shellJoinArgs([BASH_PATH, getCodexPermissionHookWrapperPath()]);
    }

    private getClaudeStopHookCommand(): string {
        return shellJoinArgs([BASH_PATH, getClaudeHookWrapperPath()]);
    }

    private getClaudeNotificationHookCommand(): string {
        return shellJoinArgs([BASH_PATH, getClaudeNotificationHookWrapperPath()]);
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

function readManifestV3(record: Record<string, unknown>): InstallManifest | null {
    const runtime = readRuntime(record.runtime);
    const codexOriginalNotify = readStringArray(record.codexOriginalNotify);
    const codexHooksFeatureStateBeforeInstall = readCodexHooksFeatureState(record.codexHooksFeatureStateBeforeInstall);
    const codexStopCommand = readOptionalString(record.codexStopCommand);
    const codexPermissionCommand = readOptionalString(record.codexPermissionCommand);
    const claudePermissionPromptCommand = readOptionalString(record.claudePermissionPromptCommand);

    if (
        !runtime
        || (record.codexRuntimeMode !== 'hooks-first' && record.codexRuntimeMode !== 'notify-fallback' && record.codexRuntimeMode !== 'hybrid')
        || typeof record.installedAt !== 'string'
        || typeof record.shimPath !== 'string'
        || typeof record.claudeStopCommand !== 'string'
        || typeof record.detectedOtherClaudeStopHooksAtInstall !== 'number'
        || typeof record.detectedOtherClaudePermissionPromptHooksAtInstall !== 'number'
        || typeof record.wrapperVersion !== 'number'
    ) {
        return null;
    }

    return {
        schemaVersion: 3,
        installedAt: record.installedAt,
        codexRuntimeMode: record.codexRuntimeMode,
        shimPath: record.shimPath,
        runtime,
        claudeStopCommand: record.claudeStopCommand,
        detectedOtherClaudeStopHooksAtInstall: record.detectedOtherClaudeStopHooksAtInstall,
        detectedOtherClaudePermissionPromptHooksAtInstall: record.detectedOtherClaudePermissionPromptHooksAtInstall,
        wrapperVersion: record.wrapperVersion,
        ...(codexOriginalNotify ? { codexOriginalNotify } : {}),
        ...(codexHooksFeatureStateBeforeInstall ? { codexHooksFeatureStateBeforeInstall } : {}),
        ...(codexStopCommand ? { codexStopCommand } : {}),
        ...(codexPermissionCommand ? { codexPermissionCommand } : {}),
        ...(claudePermissionPromptCommand ? { claudePermissionPromptCommand } : {}),
    };
}

function readManifestV2(record: Record<string, unknown>): InstallManifest | null {
    const runtime = readRuntime(record.runtime);
    const codexOriginalNotify = readStringArray(record.codexOriginalNotify);

    if (
        !runtime
        || (record.codexManagedMode !== 'chain-existing' && record.codexManagedMode !== 'exclusive-managed')
        || typeof record.installedAt !== 'string'
        || typeof record.shimPath !== 'string'
        || typeof record.claudeManagedCommand !== 'string'
        || typeof record.detectedOtherClaudeStopHooksAtInstall !== 'number'
        || typeof record.wrapperVersion !== 'number'
    ) {
        return null;
    }

    return {
        schemaVersion: 3,
        installedAt: record.installedAt,
        codexRuntimeMode: 'notify-fallback',
        shimPath: record.shimPath,
        runtime,
        claudeStopCommand: record.claudeManagedCommand,
        detectedOtherClaudeStopHooksAtInstall: record.detectedOtherClaudeStopHooksAtInstall,
        detectedOtherClaudePermissionPromptHooksAtInstall: 0,
        wrapperVersion: record.wrapperVersion,
        ...(codexOriginalNotify ? { codexOriginalNotify } : {}),
    };
}

function readRuntime(value: unknown): InstallManifest['runtime'] | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const runtime = value as Record<string, unknown>;
    if (runtime.kind === 'binary' && typeof runtime.command === 'string') {
        return {
            kind: 'binary',
            command: runtime.command,
        };
    }

    if (
        runtime.kind === 'node'
        && typeof runtime.nodePath === 'string'
        && typeof runtime.entryPath === 'string'
    ) {
        return {
            kind: 'node',
            nodePath: runtime.nodePath,
            entryPath: runtime.entryPath,
        };
    }

    return null;
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

function readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readCodexHooksFeatureState(value: unknown): 'enabled' | 'disabled' | 'missing' | undefined {
    return value === 'enabled' || value === 'disabled' || value === 'missing'
        ? value
        : undefined;
}

function hasConfiguredCodexHooks(settings: { hooks?: Record<string, unknown> }): boolean {
    return Object.keys(settings.hooks ?? {}).length > 0;
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
    return lines[1] ?? null;
}
