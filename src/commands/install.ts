import fs from 'node:fs/promises';
import { CommandExecutor } from '../infra/CommandExecutor.js';
import { HookInstaller } from '../infra/HookInstaller.js';
import { LaunchAgent } from '../infra/LaunchAgent.js';
import { getConfigDir, getFocusScriptPath } from '../utils/paths.js';

const executor = new CommandExecutor();

async function hasBrew(): Promise<boolean> {
    const { exitCode } = await executor.exec('which', ['brew']);
    return exitCode === 0;
}

async function hasTerminalNotifier(): Promise<boolean> {
    const { exitCode } = await executor.exec('which', ['terminal-notifier']);
    return exitCode === 0;
}

/**
 * Resolves the path to the terminal-notifier.app bundle.
 * macOS Accessibility settings expect a .app, not a raw binary.
 * brew installs it at e.g. /opt/homebrew/Cellar/terminal-notifier/2.0.0/terminal-notifier.app
 */
async function resolveTerminalNotifierAppPath(): Promise<string | null> {
    // brew --prefix terminal-notifier → /opt/homebrew/Cellar/terminal-notifier/2.0.0
    const { stdout, exitCode } = await executor.exec('brew', ['--prefix', 'terminal-notifier']);
    if (exitCode !== 0 || !stdout.trim()) return null;
    return `${stdout.trim()}/terminal-notifier.app`;
}

/**
 * Checks whether terminal-notifier already has Accessibility permission
 * by attempting an AXRaise-equivalent AppleScript call.
 * Returns false if macOS shows the permission prompt or the call is denied.
 */
async function checkAccessibilityPermission(): Promise<boolean> {
    // AXRaise requires Accessibility. This script tries to read a UI attribute
    // that requires the permission — returns non-zero if denied.
    const { exitCode } = await executor.exec('osascript', [
        '-e',
        'tell application "System Events" to tell process "Finder" to get windows',
    ]);
    return exitCode === 0;
}

export async function installCommand(): Promise<void> {
    if (!(await hasBrew())) {
        console.error('Homebrew is not installed. Install it first: https://brew.sh');
        process.exit(1);
    }

    if (!(await hasTerminalNotifier())) {
        console.log('Installing terminal-notifier via brew (may take a minute)...');
        await executor.exec('brew', ['install', 'terminal-notifier'], { timeout: 180_000 });

        if (!(await hasTerminalNotifier())) {
            console.error('terminal-notifier was not found after brew install.');
            console.error('Try installing manually: brew install terminal-notifier');
            console.error('Then re-run: agent-notifier install');
            process.exit(1);
        }
        console.log('terminal-notifier installed.');
    }

    const hasAccess = await checkAccessibilityPermission();
    if (!hasAccess) {
        const appPath = await resolveTerminalNotifierAppPath();
        const displayPath = appPath ?? '/opt/homebrew/Cellar/terminal-notifier/<version>/terminal-notifier.app';

        console.log('');
        console.log('Click-to-focus may require macOS privacy permissions:');
        console.log('');
        console.log('   1. System Settings → Privacy & Security → Accessibility');
        console.log('   2. Click  +  to add an app');
        console.log('   3. In Finder dialog press  Cmd+Shift+G  and paste:');
        console.log(`      ${displayPath}`);
        console.log('   4. Select terminal-notifier.app and confirm');
        console.log('');
        console.log('   Notifications can still appear without this permission.');
        console.log('   Accessibility improves click-to-focus reliability, and');
        console.log('   some setups may still require extra Automation/privacy prompts.');
        console.log('');

        await executor.exec('open', [
            'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
        ]);
        console.log('Opening Accessibility settings...');
        console.log('');
    }

    const focusScript = getFocusScriptPath();
    await executor.exec('chmod', ['+x', focusScript]);

    await fs.mkdir(getConfigDir(), { recursive: true });

    const hookInstaller = new HookInstaller(executor);
    const installResult = await hookInstaller.install();

    const launchAgent = new LaunchAgent(executor);
    await launchAgent.uninstall().catch(() => undefined);

    console.log('✓ Agent Notifier installed in hook-first mode.');
    console.log('  Codex Stop and PermissionRequest hooks were configured through the managed shim.');
    console.log('  Claude Stop and permission_prompt Notification hooks were configured through the managed shim.');
    console.log('  Legacy LaunchAgent was stopped to avoid duplicate completion models.');
    for (const warning of installResult.warnings) {
        console.log(`  Warning: ${warning}`);
    }
}
