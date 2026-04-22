import type { AgentSession, AppConfig, ILogger, INotificationService, ISessionRegistry } from '../types.js';
import type { ProcessScanner } from './ProcessScanner.js';
import { sleep } from '../utils/process.js';

export class DaemonOrchestrator {
    constructor(
        private readonly scanner: ProcessScanner,
        private readonly registry: ISessionRegistry,
        private readonly notifier: INotificationService,
        private readonly logger: ILogger,
        private readonly config: AppConfig,
    ) {}

    async tick(): Promise<void> {
        const processes = await this.scanner.scan();
        const livePids = new Set(processes.map(p => p.pid));

        this.logger.debug('tick', { totalProcesses: processes.length, activeSessions: this.registry.getActivePids().size });

        // 1. Detect completions BEFORE discovering new sessions.
        //    A process that appeared and vanished in the same tick is handled correctly.
        const completed = this.registry.detectCompletions(livePids);
        for (const session of completed) {
            try {
                await this.notifier.send(toLegacyTurnEvent(session));
            } catch (error) {
                // One notification failure must not block others
                this.logger.error('notification failed', { pid: session.pid, error: String(error) });
            }
            this.logger.info('session:completed', {
                pid: session.pid,
                project: session.projectName,
                branch: session.gitBranch,
            });
        }

        // 2. Discover new sessions. knownPids passed as parameter — no Registry dependency in Scanner.
        const knownPids = this.registry.getActivePids();
        const discovered = await this.scanner.discoverNewSessions(processes, knownPids);
        for (const session of discovered) {
            this.registry.add(session);
            this.logger.info('session:discovered', {
                pid: session.pid,
                project: session.projectName,
                branch: session.gitBranch,
            });
        }

        // 3. Write active sessions to disk for the `status` command (separate process).
        this.registry.persistActive();
    }

    async runLoop(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            try {
                await this.tick();
            } catch (error) {
                // Single tick failure must not crash the daemon
                this.logger.error('tick failed', { error: String(error) });
            }
            // sleep rejects on abort — catch to exit the loop cleanly
            await sleep(this.config.scanIntervalMs, { signal }).catch(() => {});
        }
    }
}

function toLegacyTurnEvent(session: AgentSession) {
    return {
        eventId: `legacy-process-exit:${session.pid}:${session.completedAt ?? session.discoveredAt}`,
        source: 'legacy-process-exit' as const,
        kind: 'turn-complete' as const,
        agentType: session.agentType,
        workspacePath: session.workspacePath,
        projectName: session.projectName,
        windowId: session.windowId,
        occurredAt: session.completedAt ?? new Date().toISOString(),
        ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
    };
}
