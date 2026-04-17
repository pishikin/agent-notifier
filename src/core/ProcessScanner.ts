import path from 'node:path';
import type { AgentSession, AgentType, AppConfig, ICommandExecutor, ILogger, ProcessInfo } from '../types.js';
import type { EnvReader } from './EnvReader.js';
import { getGitBranch } from '../utils/git.js';
import { buildWindowId } from '../utils/identity.js';

/**
 * Scans running processes every N seconds to discover new LLM agent sessions
 * and build the live PID set for completion detection.
 *
 * Does NOT depend on SessionRegistry — receives knownPids as a parameter
 * from DaemonOrchestrator. This eliminates the circular dependency
 * Scanner ↔ Registry.
 */
export class ProcessScanner {
    constructor(
        private readonly executor: ICommandExecutor,
        private readonly envReader: EnvReader,
        private readonly config: AppConfig,
        private readonly logger: ILogger,
    ) {}

    async scan(): Promise<ProcessInfo[]> {
        const { stdout, exitCode } = await this.executor.exec('ps', ['-eo', 'pid,ppid,uid,comm,command']);
        if (exitCode !== 0) {
            this.logger.warn('ps scan failed', { exitCode });
            return [];
        }
        return this.parsePsOutput(stdout);
    }

    /**
     * Finds agent processes that are:
     * 1. Not already tracked (not in knownPids)
     * 2. Descendants of a Cursor process
     * 3. Have a readable working directory
     */
    async discoverNewSessions(
        processes: ProcessInfo[],
        knownPids: Set<number>,
    ): Promise<AgentSession[]> {
        const sessions: AgentSession[] = [];
        // O(1) lookup for parent chain traversal
        const processMap = new Map(processes.map(p => [p.pid, p]));

        for (const proc of processes) {
            if (!this.matchesAgentName(proc.command)) continue;

            if (knownPids.has(proc.pid)) continue;

            const hasCursorAncestor = this.hasAncestor(proc.pid, processMap, isCursorProcess);
            this.logger.debug('agent candidate', {
                pid: proc.pid,
                command: proc.command.slice(0, 80),
                hasCursorAncestor,
            });
            if (!hasCursorAncestor) continue;

            const session = await this.buildSession(proc);
            if (session) {
                sessions.push(session);
            } else {
                this.logger.debug('session build failed (no CWD)', { pid: proc.pid });
            }
        }

        return sessions;
    }

    parsePsOutput(stdout: string): ProcessInfo[] {
        const lines = stdout.trim().split('\n');
        // Skip header line
        return lines.slice(1).reduce<ProcessInfo[]>((acc, line) => {
            const trimmed = line.trim();
            // Format: PID PPID UID COMM COMMAND (COMMAND may contain spaces)
            const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
            if (match) {
                acc.push({
                    pid: Number(match[1]),
                    ppid: Number(match[2]),
                    uid: Number(match[3]),
                    comm: match[4] ?? '',
                    command: match[5] ?? '',
                });
            }
            return acc;
        }, []);
    }

    /**
     * Checks whether `command` contains an exact segment matching one of watchProcesses.
     * Splits on spaces and slashes so `/usr/bin/claude` matches `claude`,
     * but `claude-config` does NOT match `claude`.
     */
    private matchesAgentName(command: string): boolean {
        return this.config.watchProcesses.some(name => {
            const segments = command.split(/[\s/]/);
            return segments.some(seg => seg === name);
        });
    }

    /**
     * Walks the parent chain of `pid` using O(1) Map lookups.
     * A visited Set prevents infinite loops from anomalous cyclic PPIDs.
     */
    private hasAncestor(
        pid: number,
        processMap: Map<number, ProcessInfo>,
        predicate: (proc: ProcessInfo) => boolean,
    ): boolean {
        let current = processMap.get(pid);
        const visited = new Set<number>();

        while (current && current.pid > 1) {
            if (visited.has(current.pid)) break; // cycle guard
            visited.add(current.pid);
            if (predicate(current)) return true;
            current = processMap.get(current.ppid);
        }

        return false;
    }

    private async buildSession(proc: ProcessInfo): Promise<AgentSession | null> {
        // Get workspace path via lsof (replaces sysctl kern.procargs2 which is
        // blocked on macOS 15 Sequoia)
        const workspacePath = await this.envReader.readCwd(proc.pid);
        if (!workspacePath) {
            this.logger.debug('Could not read CWD for process', { pid: proc.pid });
            return null;
        }

        const gitBranch = this.config.showGitBranch
            ? await getGitBranch(workspacePath, this.executor)
            : undefined;

        const session: AgentSession = {
            pid: proc.pid,
            agentType: this.detectAgentType(proc.command),
            ipcSocketPath: '',
            workspacePath,
            projectName: path.basename(workspacePath),
            discoveredAt: new Date().toISOString(),
            state: 'running',
            windowId: buildWindowId(workspacePath),
        };

        // Only include gitBranch if we have a value (exactOptionalPropertyTypes compliance)
        if (gitBranch !== undefined) {
            return { ...session, gitBranch };
        }
        return session;
    }

    private detectAgentType(command: string): AgentType {
        if (command.includes('codex')) return 'codex';
        return 'claude';
    }
}

export function isCursorProcess(proc: ProcessInfo): boolean {
    return proc.command.includes('Cursor.app')
        || proc.command.includes('Cursor Helper')
        || proc.comm === 'Cursor';
}
