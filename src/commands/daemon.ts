import fs from 'node:fs';
import { loadConfig } from '../infra/Config.js';
import { CommandExecutor } from '../infra/CommandExecutor.js';
import { Logger } from '../infra/Logger.js';
import { EnvReader } from '../core/EnvReader.js';
import { ProcessScanner } from '../core/ProcessScanner.js';
import { SessionRegistry } from '../core/SessionRegistry.js';
import { NotificationService } from '../core/NotificationService.js';
import { DaemonOrchestrator } from '../core/DaemonOrchestrator.js';
import {
    getLogPath,
    getHistoryPath,
    getActivePath,
    getConfigDir,
    getFocusScriptPath,
    getLogsDir,
} from '../utils/paths.js';
import { writePidFile, removePidFile } from '../utils/process.js';

export async function daemonCommand(options: { scanInterval?: string }): Promise<void> {
    const config = loadConfig();

    // CLI --scan-interval flag overrides config
    const overriddenInterval = Number(options.scanInterval);
    if (overriddenInterval >= 500) {
        config.scanIntervalMs = overriddenInterval;
    }

    // Ensure all necessary directories exist before creating the logger
    fs.mkdirSync(getConfigDir(), { recursive: true });
    fs.mkdirSync(getLogsDir(), { recursive: true });

    // --- Composition Root ---
    // All concrete class instantiations happen here. The rest of the code uses interfaces.
    const logger = new Logger(
        getLogPath(),
        config.logLevel,
        config.logMaxSizeMb * 1024 * 1024,
    );
    const executor = new CommandExecutor();
    const envReader = new EnvReader(executor);
    envReader.logDebug = (msg: string) => logger.debug(msg);
    const scanner = new ProcessScanner(executor, envReader, config, logger);
    const registry = new SessionRegistry(config, logger, getHistoryPath(), getActivePath());
    const notifier = new NotificationService(executor, logger, getFocusScriptPath(), config.notificationSound);
    const orchestrator = new DaemonOrchestrator(scanner, registry, notifier, logger, config);

    // --- Graceful shutdown via AbortController ---
    const abortController = new AbortController();
    const shutdown = (signal: string): void => {
        logger.info(`Received ${signal}, shutting down`);
        abortController.abort();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    writePidFile();
    logger.info('Daemon started', { pid: process.pid, scanIntervalMs: config.scanIntervalMs });

    await orchestrator.runLoop(abortController.signal);

    // Cleanup: clear active sessions (daemon is stopped), close logger, remove PID file
    registry.persistActive();
    removePidFile();
    logger.info('Daemon stopped');
    logger.close();
}
