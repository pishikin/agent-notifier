import { CommandExecutor } from '../infra/CommandExecutor.js';
import { HookInstaller } from '../infra/HookInstaller.js';
import { LaunchAgent } from '../infra/LaunchAgent.js';

export async function uninstallCommand(): Promise<void> {
    const executor = new CommandExecutor();
    const hookInstaller = new HookInstaller(executor);
    const launchAgent = new LaunchAgent(executor);

    console.log('Removing managed Codex/Claude hooks...');
    const uninstallResult = await hookInstaller.uninstall();
    console.log('Stopping and removing legacy LaunchAgent...');
    await launchAgent.uninstall().catch(() => undefined);
    console.log('✓ Agent Notifier uninstalled.');
    console.log(`  Codex notify ${uninstallResult.restoredCodexNotify ? 'was restored from the install manifest.' : 'was left untouched because managed state was not detected.'}`);
    console.log('  Event ledger and logs at ~/.agent-notifier/ were preserved.');
    console.log('  Remove them manually if no longer needed.');
}
