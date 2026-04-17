import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
    AgentTurnEvent,
    AppConfig,
    EventLedgerMaintenanceState,
    EventMarker,
    EventProcessingState,
    ILogger,
    NotificationSendResult,
    ReservationResult,
} from '../types.js';
import {
    getEventMaintenanceStatePath,
    getEventMarkersDir,
    getEventTmpDir,
} from '../utils/paths.js';

const RESERVATION_TTL_MS = 120_000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BACKUP_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

interface EventLedgerPaths {
    readonly markersDir: string;
    readonly tmpDir: string;
    readonly maintenanceStatePath: string;
}

export interface EventLedgerStats {
    readonly finalizedCount: number;
    readonly reservedCount: number;
    readonly backupCount: number;
    readonly lastFinalized: EventMarker | null;
}

export class EventLedger {
    private readonly paths: EventLedgerPaths;

    constructor(
        private readonly config: AppConfig,
        private readonly logger: ILogger,
        paths?: Partial<EventLedgerPaths>,
    ) {
        this.paths = {
            markersDir: paths?.markersDir ?? getEventMarkersDir(),
            tmpDir: paths?.tmpDir ?? getEventTmpDir(),
            maintenanceStatePath: paths?.maintenanceStatePath ?? getEventMaintenanceStatePath(),
        };
    }

    async reserve(event: AgentTurnEvent): Promise<ReservationResult> {
        await this.ensureDirectories();
        return this.reserveInternal(event, false);
    }

    async finalize(eventId: string, result: NotificationSendResult): Promise<void> {
        await this.ensureDirectories();
        const markerPath = this.getMarkerPath(eventId);
        const marker = await this.readMarkerFile(markerPath);
        if (!marker || marker.processingState !== 'reserved') {
            throw new Error(`Cannot finalize marker for event ${eventId}`);
        }

        const finalizedAt = new Date().toISOString();
        const nextMarker: EventMarker = {
            ...marker,
            processingState: mapNotificationOutcome(result),
            updatedAt: finalizedAt,
            finalizedAt,
            notification: result,
        };

        const tmpPath = path.join(
            this.paths.tmpDir,
            `${marker.eventIdHash}.${Date.now()}.${process.pid}.tmp`,
        );
        await fs.writeFile(tmpPath, JSON.stringify(nextMarker, null, 2), 'utf8');
        await fs.rename(tmpPath, markerPath);
        await this.cleanupIfNeeded().catch(error => {
            this.logger.debug('ledger:cleanup-skipped', { error: String(error) });
        });
    }

    async listRecent(limit: number): Promise<EventMarker[]> {
        const markers = await this.readAllPrimaryMarkers();
        const finalized = markers
            .filter(marker => marker.processingState !== 'reserved')
            .sort((left, right) => {
                const leftTime = left.finalizedAt ?? left.updatedAt;
                const rightTime = right.finalizedAt ?? right.updatedAt;
                return rightTime.localeCompare(leftTime);
            });

        return finalized.slice(0, Math.max(limit, 0));
    }

    async getMarker(eventId: string): Promise<EventMarker | null> {
        return this.readMarkerFile(this.getMarkerPath(eventId));
    }

    async getStats(): Promise<EventLedgerStats> {
        const markers = await this.readAllPrimaryMarkers();
        const backups = await this.readBackupEntries();
        const finalized = markers
            .filter(marker => marker.processingState !== 'reserved')
            .sort((left, right) => {
                const leftTime = left.finalizedAt ?? left.updatedAt;
                const rightTime = right.finalizedAt ?? right.updatedAt;
                return rightTime.localeCompare(leftTime);
            });

        return {
            finalizedCount: finalized.length,
            reservedCount: markers.length - finalized.length,
            backupCount: backups.length,
            lastFinalized: finalized[0] ?? null,
        };
    }

    async cleanupIfNeeded(): Promise<void> {
        await this.ensureDirectories();
        const maintenanceState = await this.readMaintenanceState();
        const lastCleanupAt = maintenanceState.lastCleanupAt
            ? Date.parse(maintenanceState.lastCleanupAt)
            : Number.NaN;
        if (!Number.isNaN(lastCleanupAt) && (Date.now() - lastCleanupAt) < CLEANUP_INTERVAL_MS) {
            return;
        }

        const primaryEntries = await this.readPrimaryMarkerEntries();
        const finalizedEntries = primaryEntries
            .filter(entry => entry.marker?.processingState !== 'reserved')
            .sort((left, right) => {
                const leftTime = left.marker?.finalizedAt ?? left.marker?.updatedAt ?? '';
                const rightTime = right.marker?.finalizedAt ?? right.marker?.updatedAt ?? '';
                return rightTime.localeCompare(leftTime);
            });

        const retentionLimit = Math.max(this.config.historySize * 20, 500);
        for (const entry of finalizedEntries.slice(retentionLimit)) {
            await fs.rm(entry.path, { force: true });
        }

        const now = Date.now();
        for (const backup of await this.readBackupEntries()) {
            if ((now - backup.mtimeMs) > BACKUP_RETENTION_MS) {
                await fs.rm(backup.path, { force: true });
            }
        }

        const nextState: EventLedgerMaintenanceState = {
            schemaVersion: 1,
            lastCleanupAt: new Date().toISOString(),
        };
        await fs.writeFile(
            this.paths.maintenanceStatePath,
            JSON.stringify(nextState, null, 2),
            'utf8',
        );
    }

    private async reserveInternal(event: AgentTurnEvent, allowRetryAfterCorruption: boolean): Promise<ReservationResult> {
        const markerPath = this.getMarkerPath(event.eventId);
        const reservedAt = new Date().toISOString();
        const marker = buildReservedMarker(event, reservedAt);

        try {
            const handle = await fs.open(markerPath, 'wx');
            try {
                await handle.writeFile(JSON.stringify(marker, null, 2), 'utf8');
            } finally {
                await handle.close();
            }
            return { kind: allowRetryAfterCorruption ? 'corrupt-retried' : 'owned', markerPath };
        } catch (error) {
            if (!isFileExistsError(error)) {
                throw error;
            }
        }

        const existing = await this.readMarkerFile(markerPath);
        if (!existing) {
            if (allowRetryAfterCorruption) {
                return this.reserveInternal(event, false);
            }

            await this.quarantineMarker(markerPath, 'corrupt');
            return this.reserveInternal(event, true);
        }

        if (existing.processingState !== 'reserved') {
            return { kind: 'duplicate', existing };
        }

        const reservationTime = Date.parse(existing.updatedAt || existing.reservedAt);
        if (!Number.isNaN(reservationTime) && (Date.now() - reservationTime) < RESERVATION_TTL_MS) {
            return { kind: 'inflight', existing };
        }

        const renamed = await this.tryRenameStaleMarker(markerPath);
        if (!renamed) {
            const latest = await this.readMarkerFile(markerPath);
            if (latest && latest.processingState === 'reserved') {
                return { kind: 'inflight', existing: latest };
            }
            if (latest) {
                return { kind: 'duplicate', existing: latest };
            }
            return this.reserveInternal(event, false);
        }

        return this.reserveInternal(event, false);
    }

    private async tryRenameStaleMarker(markerPath: string): Promise<boolean> {
        const stalePath = this.buildBackupPath(markerPath, 'stale');
        try {
            await fs.rename(markerPath, stalePath);
            return true;
        } catch {
            return false;
        }
    }

    private async quarantineMarker(markerPath: string, suffix: 'corrupt' | 'stale'): Promise<void> {
        const backupPath = this.buildBackupPath(markerPath, suffix);
        await fs.rename(markerPath, backupPath);
    }

    private buildBackupPath(markerPath: string, suffix: 'corrupt' | 'stale'): string {
        const base = markerPath.replace(/\.json$/, '');
        return `${base}.${suffix}.${Date.now()}.${process.pid}.json`;
    }

    private async ensureDirectories(): Promise<void> {
        await fs.mkdir(this.paths.markersDir, { recursive: true });
        await fs.mkdir(this.paths.tmpDir, { recursive: true });
    }

    private getMarkerPath(eventId: string): string {
        return path.join(this.paths.markersDir, `${buildEventIdHash(eventId)}.json`);
    }

    private async readMarkerFile(markerPath: string): Promise<EventMarker | null> {
        try {
            const raw = await fs.readFile(markerPath, 'utf8');
            return parseEventMarker(raw);
        } catch {
            return null;
        }
    }

    private async readAllPrimaryMarkers(): Promise<EventMarker[]> {
        const entries = await this.readPrimaryMarkerEntries();
        return entries
            .map(entry => entry.marker)
            .filter((marker): marker is EventMarker => marker !== null);
    }

    private async readPrimaryMarkerEntries(): Promise<Array<{ path: string; marker: EventMarker | null }>> {
        try {
            const names = await fs.readdir(this.paths.markersDir);
            const primaryNames = names.filter(name => /^[a-f0-9]{40}\.json$/.test(name));
            const entries = await Promise.all(primaryNames.map(async name => {
                const markerPath = path.join(this.paths.markersDir, name);
                return {
                    path: markerPath,
                    marker: await this.readMarkerFile(markerPath),
                };
            }));
            return entries;
        } catch {
            return [];
        }
    }

    private async readBackupEntries(): Promise<Array<{ path: string; mtimeMs: number }>> {
        try {
            const names = await fs.readdir(this.paths.markersDir);
            const backupNames = names.filter(name => /\.(stale|corrupt)\.\d+\.\d+\.json$/.test(name));
            return Promise.all(backupNames.map(async name => {
                const backupPath = path.join(this.paths.markersDir, name);
                const stat = await fs.stat(backupPath);
                return { path: backupPath, mtimeMs: stat.mtimeMs };
            }));
        } catch {
            return [];
        }
    }

    private async readMaintenanceState(): Promise<EventLedgerMaintenanceState> {
        try {
            const raw = await fs.readFile(this.paths.maintenanceStatePath, 'utf8');
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return { schemaVersion: 1 };
            }
            const record = parsed as Record<string, unknown>;
            const lastCleanupAt = typeof record.lastCleanupAt === 'string'
                ? record.lastCleanupAt
                : undefined;
            return {
                schemaVersion: 1,
                ...(lastCleanupAt ? { lastCleanupAt } : {}),
            };
        } catch {
            return { schemaVersion: 1 };
        }
    }
}

export function buildEventIdHash(eventId: string): string {
    return createHash('sha256').update(eventId).digest('hex').slice(0, 40);
}

function buildReservedMarker(event: AgentTurnEvent, reservedAt: string): EventMarker {
    return {
        schemaVersion: 2,
        eventId: event.eventId,
        eventIdHash: buildEventIdHash(event.eventId),
        source: event.source,
        agentType: event.agentType,
        outcome: event.outcome,
        workspacePath: event.workspacePath,
        projectName: event.projectName,
        windowId: event.windowId,
        completedAt: event.completedAt,
        processingState: 'reserved',
        reservedAt,
        updatedAt: reservedAt,
        reservationOwnerPid: process.pid,
        reservationOwnerHostname: os.hostname(),
        ...(event.gitBranch ? { gitBranch: event.gitBranch } : {}),
        ...(event.providerSessionId ? { providerSessionId: event.providerSessionId } : {}),
        ...(event.summary ? { summary: event.summary } : {}),
        ...(event.providerEvent ? { providerEvent: event.providerEvent } : {}),
    };
}

function parseEventMarker(raw: string): EventMarker | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        const record = parsed as Record<string, unknown>;
        const schemaVersion = record.schemaVersion;
        const eventId = readString(record.eventId);
        const eventIdHash = readString(record.eventIdHash);
        const source = readHookSource(record.source);
        const agentType = readAgentType(record.agentType);
        const outcome = readOutcome(record.outcome);
        const workspacePath = readString(record.workspacePath);
        const projectName = readString(record.projectName);
        const windowId = readString(record.windowId);
        const completedAt = readString(record.completedAt);
        const processingState = readProcessingState(record.processingState);
        const reservedAt = readString(record.reservedAt);
        const updatedAt = readString(record.updatedAt);

        if (
            schemaVersion !== 2
            || !eventId
            || !eventIdHash
            || !source
            || !agentType
            || !outcome
            || !workspacePath
            || !projectName
            || !windowId
            || !completedAt
            || !processingState
            || !reservedAt
            || !updatedAt
        ) {
            return null;
        }

        const marker: EventMarker = {
            schemaVersion: 2,
            eventId,
            eventIdHash,
            source,
            agentType,
            outcome,
            workspacePath,
            projectName,
            windowId,
            completedAt,
            processingState,
            reservedAt,
            updatedAt,
        };

        return {
            ...marker,
            ...readOptionalMarkerFields(record),
        };
    } catch {
        return null;
    }
}

function readOptionalMarkerFields(record: Record<string, unknown>): Partial<EventMarker> {
    const gitBranch = readString(record.gitBranch);
    const providerSessionId = readString(record.providerSessionId);
    const summary = readString(record.summary);
    const finalizedAt = readString(record.finalizedAt);
    const reservationOwnerPid = typeof record.reservationOwnerPid === 'number'
        ? record.reservationOwnerPid
        : undefined;
    const reservationOwnerHostname = readString(record.reservationOwnerHostname);
    const providerEvent = readProviderEvent(record.providerEvent);
    const notification = readNotificationResult(record.notification);

    return {
        ...(gitBranch ? { gitBranch } : {}),
        ...(providerSessionId ? { providerSessionId } : {}),
        ...(summary ? { summary } : {}),
        ...(finalizedAt ? { finalizedAt } : {}),
        ...(reservationOwnerPid !== undefined ? { reservationOwnerPid } : {}),
        ...(reservationOwnerHostname ? { reservationOwnerHostname } : {}),
        ...(providerEvent ? { providerEvent } : {}),
        ...(notification ? { notification } : {}),
    };
}

function readProviderEvent(value: unknown): EventMarker['providerEvent'] | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    const transcriptStatValue = record.transcriptStat;
    const transcriptStat = transcriptStatValue && typeof transcriptStatValue === 'object' && !Array.isArray(transcriptStatValue)
        ? {
            ...(typeof (transcriptStatValue as Record<string, unknown>).size === 'number'
                ? { size: (transcriptStatValue as Record<string, unknown>).size as number }
                : {}),
            ...(typeof (transcriptStatValue as Record<string, unknown>).mtimeMs === 'number'
                ? { mtimeMs: (transcriptStatValue as Record<string, unknown>).mtimeMs as number }
                : {}),
        }
        : undefined;

    const hookEventName = readHookEventName(record.hookEventName);
    const codexTurnId = readString(record.codexTurnId);
    const codexThreadId = readString(record.codexThreadId);
    const transcriptPath = readString(record.transcriptPath);
    const failureType = readString(record.failureType);
    const nextValue = {
        ...(hookEventName ? { hookEventName } : {}),
        ...(codexTurnId ? { codexTurnId } : {}),
        ...(codexThreadId ? { codexThreadId } : {}),
        ...(typeof record.claudeStopHookActive === 'boolean'
            ? { claudeStopHookActive: record.claudeStopHookActive }
            : {}),
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(transcriptStat && typeof transcriptStat.size === 'number' && typeof transcriptStat.mtimeMs === 'number'
            ? { transcriptStat: transcriptStat as { size: number; mtimeMs: number } }
            : {}),
        ...(failureType ? { failureType } : {}),
    };
    return Object.keys(nextValue).length > 0 ? nextValue : undefined;
}

function readNotificationResult(value: unknown): NotificationSendResult | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    const record = value as Record<string, unknown>;
    const outcome = record.outcome;
    const backend = record.backend;
    const fallbackUsed = record.fallbackUsed;
    const title = readString(record.title);
    const message = readString(record.message);

    if (
        (outcome !== 'backend-accepted' && outcome !== 'fallback-accepted' && outcome !== 'backend-failed')
        || (backend !== 'terminal-notifier' && backend !== 'osascript' && backend !== 'none')
        || typeof fallbackUsed !== 'boolean'
        || !title
        || !message
    ) {
        return undefined;
    }

    const normalizedOutcome = outcome as NotificationSendResult['outcome'];
    const normalizedBackend = backend as NotificationSendResult['backend'];
    const result = {
        outcome: normalizedOutcome,
        backend: normalizedBackend,
        fallbackUsed,
        title,
        message,
        clickActionEnabled: typeof record.clickActionEnabled === 'boolean'
            ? record.clickActionEnabled
            : false,
    };
    const primaryExitCode = typeof record.primaryExitCode === 'number' ? record.primaryExitCode : undefined;
    const fallbackExitCode = typeof record.fallbackExitCode === 'number' ? record.fallbackExitCode : undefined;
    const stderr = readString(record.stderr);
    const groupId = readString(record.groupId);
    return {
        ...result,
        ...(primaryExitCode !== undefined ? { primaryExitCode } : {}),
        ...(fallbackExitCode !== undefined ? { fallbackExitCode } : {}),
        ...(stderr ? { stderr } : {}),
        ...(groupId ? { groupId } : {}),
    };
}

function mapNotificationOutcome(result: NotificationSendResult): EventProcessingState {
    switch (result.outcome) {
        case 'backend-accepted':
            return 'backend-accepted';
        case 'fallback-accepted':
            return 'fallback-accepted';
        case 'backend-failed':
            return 'backend-failed';
    }
}

function isFileExistsError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === 'EEXIST';
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readHookSource(value: unknown): EventMarker['source'] | null {
    if (
        value === 'codex-notify'
        || value === 'claude-stop'
        || value === 'claude-stop-failure'
        || value === 'legacy-process-exit'
    ) {
        return value;
    }
    return null;
}

function readAgentType(value: unknown): EventMarker['agentType'] | null {
    return value === 'claude' || value === 'codex' ? value : null;
}

function readOutcome(value: unknown): EventMarker['outcome'] | null {
    return value === 'completed' || value === 'failed' ? value : null;
}

function readProcessingState(value: unknown): EventMarker['processingState'] | null {
    if (
        value === 'reserved'
        || value === 'backend-accepted'
        || value === 'fallback-accepted'
        || value === 'backend-failed'
    ) {
        return value;
    }
    return null;
}

function readHookEventName(value: unknown): 'Stop' | 'StopFailure' | undefined {
    return value === 'Stop' || value === 'StopFailure' ? value : undefined;
}
