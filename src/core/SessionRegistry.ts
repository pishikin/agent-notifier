import fs from 'node:fs';
import type { AgentSession, AppConfig, ILogger, ISessionRegistry } from '../types.js';

export class SessionRegistry implements ISessionRegistry {
    private active = new Map<number, AgentSession>();
    private history: AgentSession[] = [];

    constructor(
        private readonly config: AppConfig,
        private readonly logger: ILogger,
        private readonly historyPath: string,
        private readonly activePath: string,
    ) {
        this.loadHistory();
    }

    add(session: AgentSession): void {
        this.active.set(session.pid, session);
    }

    has(pid: number): boolean {
        return this.active.has(pid);
    }

    getActivePids(): Set<number> {
        return new Set(this.active.keys());
    }

    /**
     * Finds sessions whose PIDs have disappeared from the live process list.
     * Creates new immutable objects (never mutates the stored session).
     * Removes completed sessions from active map and adds them to history.
     */
    detectCompletions(livePids: Set<number>): AgentSession[] {
        const completed: AgentSession[] = [];

        for (const [pid, session] of this.active) {
            if (!livePids.has(pid)) {
                const completedSession: AgentSession = {
                    ...session,
                    state: 'completed',
                    completedAt: new Date().toISOString(),
                };
                completed.push(completedSession);
                this.active.delete(pid);
                this.addToHistory(completedSession);
            }
        }

        return completed;
    }

    getActive(): AgentSession[] {
        return [...this.active.values()];
    }

    getHistory(): AgentSession[] {
        return [...this.history];
    }

    /**
     * Writes active sessions to disk so the `status` CLI command (separate process)
     * can read them. Called on every orchestrator tick — staleness is at most 2s.
     */
    persistActive(): void {
        try {
            fs.writeFileSync(
                this.activePath,
                JSON.stringify([...this.active.values()], null, 2),
            );
        } catch (error) {
            this.logger.warn('Failed to persist active sessions', { error: String(error) });
        }
    }

    private addToHistory(session: AgentSession): void {
        this.history.unshift(session);
        if (this.history.length > this.config.historySize) {
            this.history = this.history.slice(0, this.config.historySize);
        }
        this.persistHistory();
    }

    private persistHistory(): void {
        try {
            fs.writeFileSync(this.historyPath, JSON.stringify(this.history, null, 2));
        } catch (error) {
            this.logger.warn('Failed to persist history', { error: String(error) });
        }
    }

    private loadHistory(): void {
        try {
            const data = fs.readFileSync(this.historyPath, 'utf8');
            const parsed: unknown = JSON.parse(data);
            if (Array.isArray(parsed)) {
                this.history = parsed as AgentSession[];
            }
        } catch {
            this.history = [];
        }
    }
}
