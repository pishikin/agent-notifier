// --- Infra interfaces (DI contracts) ---

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export interface ICommandExecutor {
    exec(command: string, args: string[], options?: { timeout?: number }): Promise<ExecResult>;
    execSync(command: string, args: string[]): Buffer | null;
}

export interface ILogger {
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
    close(): void;
}

// --- Domain types ---

export interface ProcessInfo {
    pid: number;
    ppid: number;
    uid: number;
    /** Short process name — truncated to 15 chars on macOS by the kernel */
    comm: string;
    /** Full command line */
    command: string;
}

export type AgentType = 'claude' | 'codex';
export type SessionState = 'running' | 'completed' | 'notified';
export type HookSource =
    | 'codex-notify'
    | 'claude-stop'
    | 'claude-stop-failure'
    | 'legacy-process-exit';
export type TurnOutcome = 'completed' | 'failed';

export interface NotificationTarget {
    readonly agentType: AgentType;
    readonly workspacePath: string;
    readonly projectName: string;
    readonly gitBranch?: string;
    readonly windowId: string;
}

export interface ProviderEventDetails {
    readonly hookEventName?: 'Stop' | 'StopFailure';
    readonly codexTurnId?: string;
    readonly codexThreadId?: string;
    readonly claudeStopHookActive?: boolean;
    readonly transcriptPath?: string;
    readonly transcriptStat?: {
        readonly size: number;
        readonly mtimeMs: number;
    };
    readonly failureType?: string;
}

/**
 * Immutable value object representing one LLM agent session.
 * State transitions create new objects via spread — never mutate.
 *
 * Dates are ISO 8601 strings, NOT Date objects:
 * JSON.stringify(Date) → string, but JSON.parse does NOT restore Date back.
 * Using strings keeps in-memory and on-disk representations identical.
 */
export interface AgentSession extends NotificationTarget {
    readonly pid: number;
    readonly agentType: AgentType;
    /** VSCODE_IPC_HOOK_CLI env var — identifies the Cursor window */
    readonly ipcSocketPath: string;
    /** ISO 8601 string */
    readonly discoveredAt: string;
    /** ISO 8601 string */
    readonly completedAt?: string;
    readonly state: SessionState;
    /**
     * Stable window identifier = sha256(workspacePath).slice(0,12).
     * IPC socket path changes on every Cursor restart — workspace path is stable.
     */
    readonly windowId: string;
}

export interface AgentTurnEvent extends NotificationTarget {
    readonly eventId: string;
    readonly source: HookSource;
    readonly outcome: TurnOutcome;
    readonly providerSessionId?: string;
    readonly summary?: string;
    readonly completedAt: string;
    readonly state: 'completed';
    readonly providerEvent?: ProviderEventDetails;
}

export type TurnCompletionEvent = AgentTurnEvent;

export interface HookEventCandidate {
    readonly agentType: AgentType;
    readonly source: HookSource;
    readonly dedupeKeyHint: string;
    readonly workspacePath: string;
    readonly providerSessionId?: string;
    readonly summary?: string;
    readonly transcriptPath?: string;
    readonly outcome?: TurnOutcome;
    readonly providerEvent?: ProviderEventDetails;
}

export type NotificationBackend = 'terminal-notifier' | 'osascript' | 'none';
export type NotificationOutcomeKind =
    | 'backend-accepted'
    | 'fallback-accepted'
    | 'backend-failed';

export interface NotificationSendResult {
    readonly outcome: NotificationOutcomeKind;
    readonly backend: NotificationBackend;
    readonly fallbackUsed: boolean;
    readonly primaryExitCode?: number;
    readonly fallbackExitCode?: number;
    readonly stderr?: string;
    readonly title: string;
    readonly message: string;
    readonly groupId?: string;
    readonly clickActionEnabled: boolean;
}

export type EventProcessingState =
    | 'reserved'
    | 'backend-accepted'
    | 'fallback-accepted'
    | 'backend-failed';

export interface EventMarker {
    readonly schemaVersion: 2;
    readonly eventId: string;
    readonly eventIdHash: string;
    readonly source: HookSource;
    readonly agentType: AgentType;
    readonly outcome: TurnOutcome;
    readonly workspacePath: string;
    readonly projectName: string;
    readonly gitBranch?: string;
    readonly windowId: string;
    readonly providerSessionId?: string;
    readonly summary?: string;
    readonly completedAt: string;
    readonly providerEvent?: ProviderEventDetails;
    readonly processingState: EventProcessingState;
    readonly reservedAt: string;
    readonly updatedAt: string;
    readonly finalizedAt?: string;
    readonly reservationOwnerPid?: number;
    readonly reservationOwnerHostname?: string;
    readonly notification?: NotificationSendResult;
}

export type ReservationResult =
    | { readonly kind: 'owned'; readonly markerPath: string }
    | { readonly kind: 'duplicate'; readonly existing: EventMarker }
    | { readonly kind: 'inflight'; readonly existing: EventMarker }
    | { readonly kind: 'corrupt-retried'; readonly markerPath: string };

export interface EventLedgerMaintenanceState {
    readonly schemaVersion: 1;
    readonly lastCleanupAt?: string;
}

export interface HookInstallState {
    readonly codexOriginalNotify?: string[];
}

export interface InstallManifest {
    readonly schemaVersion: 2;
    readonly installedAt: string;
    readonly codexOriginalNotify?: string[];
    readonly codexManagedMode: 'chain-existing' | 'exclusive-managed';
    readonly shimPath: string;
    readonly runtime:
        | { readonly kind: 'binary'; readonly command: string }
        | { readonly kind: 'node'; readonly nodePath: string; readonly entryPath: string };
    readonly claudeManagedCommand: string;
    readonly detectedOtherClaudeStopHooksAtInstall: number;
    readonly wrapperVersion: 2;
}

export interface HookStatus {
    readonly codexConfigured: boolean;
    readonly claudeConfigured: boolean;
    readonly codexManagedMode?: 'chain-existing' | 'exclusive-managed';
    readonly otherClaudeStopHooks: number;
    readonly manifestPresent: boolean;
    readonly staleWrapperVersionDetected: boolean;
}

// --- Service interfaces (DI contracts) ---

export interface INotificationService {
    send(target: AgentTurnEvent): Promise<NotificationSendResult>;
}

export interface ISessionRegistry {
    add(session: AgentSession): void;
    has(pid: number): boolean;
    getActivePids(): Set<number>;
    detectCompletions(livePids: Set<number>): AgentSession[];
    getActive(): AgentSession[];
    getHistory(): AgentSession[];
    /** Write active sessions to disk for the status CLI command (separate process). */
    persistActive(): void;
}

// --- Config ---

export interface AppConfig {
    watchProcesses: string[];
    scanIntervalMs: number;
    notificationSound: string;
    showGitBranch: boolean;
    historySize: number;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    logMaxSizeMb: number;
}
