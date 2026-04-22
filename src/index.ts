#!/usr/bin/env node
import { program } from 'commander';
import { installCommand } from './commands/install.js';
import { uninstallCommand } from './commands/uninstall.js';
import { statusCommand } from './commands/status.js';
import { daemonCommand } from './commands/daemon.js';
import { logsCommand } from './commands/logs.js';
import { hookCommand } from './commands/hook.js';
import { doctorCommand } from './commands/doctor.js';

program
    .name('agent-notifier')
    .version('1.0.0')
    .description('macOS notifier for Codex/Claude terminal completions and approvals inside Cursor');

program
    .command('install')
    .description('Configure Codex/Claude hooks and enable notifications')
    .action(() => void installCommand());

program
    .command('uninstall')
    .description('Remove managed hooks and stop the legacy daemon')
    .action(() => void uninstallCommand());

program
    .command('status')
    .description('Show hook status and recent attention events')
    .action(() => void statusCommand());

program
    .command('doctor')
    .description('Run runtime and installation health checks')
    .action(() => void doctorCommand());

program
    .command('daemon')
    .description('Run the daemon (called by launchd — not for direct use)')
    .option('--scan-interval <ms>', 'Scan interval in milliseconds', '2000')
    .addHelpText('after', '\nThis command is managed by launchd. Use `install` instead.')
    .action((options: { scanInterval?: string }) => void daemonCommand(options));

program
    .command('logs')
    .description('Show recent hook log entries')
    .option('-n <lines>', 'Number of lines to show', '50')
    .option('--daemon', 'Show legacy daemon log instead of hooks log')
    .option('--wrappers', 'Show hooks wrapper/shim log')
    .option('--error', 'Show legacy daemon error log')
    .action((options: { n?: string; daemon?: boolean; wrappers?: boolean; error?: boolean }) => logsCommand(options));

program
    .command('hook <agent> [payload]')
    .description('Handle Codex/Claude hook events')
    .action((agent: string, payload?: string) => {
        const options = payload === undefined ? { agent } : { agent, payload };
        void hookCommand(options);
    });

program.parse();
