import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_DIR = path.join(os.homedir(), '.agent-notifier');
const LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const EVENTS_DIR = path.join(CONFIG_DIR, 'events');

export function getConfigDir(): string {
    return CONFIG_DIR;
}

export function getConfigPath(): string {
    return path.join(CONFIG_DIR, 'config.json');
}

export function getHistoryPath(): string {
    return path.join(CONFIG_DIR, 'history.json');
}

export function getProcessedEventsPath(): string {
    return path.join(CONFIG_DIR, 'processed-events.json');
}

export function getEventsDir(): string {
    return EVENTS_DIR;
}

export function getEventMarkersDir(): string {
    return path.join(EVENTS_DIR, 'markers');
}

export function getEventTmpDir(): string {
    return path.join(EVENTS_DIR, 'tmp');
}

export function getEventMaintenanceStatePath(): string {
    return path.join(EVENTS_DIR, 'maintenance.json');
}

export function getActivePath(): string {
    return path.join(CONFIG_DIR, 'active-sessions.json');
}

export function getPidFilePath(): string {
    return path.join(CONFIG_DIR, 'daemon.pid');
}

export function getLogPath(): string {
    return path.join(LOGS_DIR, 'daemon.log');
}

export function getErrorLogPath(): string {
    return path.join(LOGS_DIR, 'daemon.error.log');
}

export function getLogsDir(): string {
    return LOGS_DIR;
}

export function getHooksLogPath(): string {
    return path.join(LOGS_DIR, 'hooks.log');
}

export function getHooksWrapperLogPath(): string {
    return path.join(LOGS_DIR, 'hooks-wrapper.log');
}

export function getBinDir(): string {
    return path.join(CONFIG_DIR, 'bin');
}

export function getShimPath(): string {
    return path.join(getBinDir(), 'agent-notifier-shim');
}

export function getHooksDir(): string {
    return path.join(CONFIG_DIR, 'hooks');
}

export function getCodexHookWrapperPath(): string {
    return path.join(getHooksDir(), 'codex-notify.sh');
}

export function getCodexStopHookWrapperPath(): string {
    return path.join(getHooksDir(), 'codex-stop.sh');
}

export function getCodexPermissionHookWrapperPath(): string {
    return path.join(getHooksDir(), 'codex-permission-request.sh');
}

export function getCodexLegacyNotifyPath(): string {
    return path.join(getHooksDir(), 'codex-legacy-notify.sh');
}

export function getClaudeHookWrapperPath(): string {
    return path.join(getHooksDir(), 'claude-stop.sh');
}

export function getClaudeNotificationHookWrapperPath(): string {
    return path.join(getHooksDir(), 'claude-notification.sh');
}

export function getHookInstallStatePath(): string {
    return path.join(CONFIG_DIR, 'hook-install-state.json');
}

export function getInstallManifestPath(): string {
    return path.join(CONFIG_DIR, 'install-manifest.json');
}

export function getCodexConfigPath(): string {
    return path.join(os.homedir(), '.codex', 'config.toml');
}

export function getCodexHooksPath(): string {
    return path.join(os.homedir(), '.codex', 'hooks.json');
}

export function getCodexTuiLogPath(): string {
    return path.join(os.homedir(), '.codex', 'log', 'codex-tui.log');
}

export function getClaudeSettingsPath(): string {
    return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * Path to focus-window.sh, resolved relative to this package's installation.
 * Works for both `npm install -g` (dist/) and local dev (src/).
 */
export function getFocusScriptPath(): string {
    const thisFile = fileURLToPath(import.meta.url);
    // In dist/utils/paths.js → go up two levels to reach package root
    const packageRoot = path.resolve(path.dirname(thisFile), '..', '..');
    return path.join(packageRoot, 'scripts', 'focus-window.sh');
}
