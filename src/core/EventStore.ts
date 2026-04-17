import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, HookSource, ILogger, TurnCompletionEvent } from '../types.js';
import { buildWindowId } from '../utils/identity.js';

export class EventStore {
    private history: TurnCompletionEvent[] = [];
    private processedEventIds: string[] = [];
    private processedSet = new Set<string>();

    constructor(
        private readonly config: AppConfig,
        private readonly logger: ILogger,
        private readonly historyPath: string,
        private readonly processedEventsPath: string,
    ) {
        this.loadHistory();
        this.loadProcessedEventIds();
    }

    hasProcessed(eventId: string): boolean {
        return this.processedSet.has(eventId);
    }

    record(event: TurnCompletionEvent): boolean {
        if (this.processedSet.has(event.eventId)) {
            return false;
        }

        this.processedEventIds.unshift(event.eventId);
        this.processedSet.add(event.eventId);
        this.trimProcessedEventIds();

        this.history.unshift(event);
        if (this.history.length > this.config.historySize) {
            this.history = this.history.slice(0, this.config.historySize);
        }

        this.persistHistory();
        this.persistProcessedEventIds();
        return true;
    }

    getHistory(): TurnCompletionEvent[] {
        return [...this.history];
    }

    private trimProcessedEventIds(): void {
        const maxProcessedEvents = Math.max(this.config.historySize * 10, 100);
        if (this.processedEventIds.length <= maxProcessedEvents) {
            return;
        }

        this.processedEventIds = this.processedEventIds.slice(0, maxProcessedEvents);
        this.processedSet = new Set(this.processedEventIds);
    }

    private persistHistory(): void {
        try {
            fs.writeFileSync(this.historyPath, JSON.stringify(this.history, null, 2));
        } catch (error) {
            this.logger.warn('Failed to persist hook history', { error: String(error) });
        }
    }

    private persistProcessedEventIds(): void {
        try {
            fs.writeFileSync(this.processedEventsPath, JSON.stringify(this.processedEventIds, null, 2));
        } catch (error) {
            this.logger.warn('Failed to persist processed event IDs', { error: String(error) });
        }
    }

    private loadHistory(): void {
        try {
            const raw = fs.readFileSync(this.historyPath, 'utf8');
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                this.history = [];
                return;
            }

            this.history = parsed
                .map(entry => coerceTurnCompletionEvent(entry))
                .filter((entry): entry is TurnCompletionEvent => entry !== null)
                .slice(0, this.config.historySize);
        } catch {
            this.history = [];
        }
    }

    private loadProcessedEventIds(): void {
        try {
            const raw = fs.readFileSync(this.processedEventsPath, 'utf8');
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                return;
            }

            this.processedEventIds = parsed.filter((entry): entry is string => typeof entry === 'string');
            this.trimProcessedEventIds();
        } catch {
            this.processedEventIds = [];
        }

        this.processedSet = new Set(this.processedEventIds);
    }
}

function coerceTurnCompletionEvent(value: unknown): TurnCompletionEvent | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const record = value as Record<string, unknown>;
    const agentType = getAgentType(record.agentType);
    const workspacePath = getString(record.workspacePath);
    const completedAt = getString(record.completedAt) ?? getString(record.discoveredAt);
    if (!agentType || !workspacePath || !completedAt) {
        return null;
    }

    const projectName = getString(record.projectName) ?? path.basename(workspacePath);
    const eventId = getString(record.eventId)
        ?? `legacy:${getString(record.pid) ?? 'unknown'}:${completedAt}`;
    const source = getHookSource(record.source);
    const windowId = getString(record.windowId) ?? buildWindowId(workspacePath);

    const event: TurnCompletionEvent = {
        eventId,
        source,
        outcome: 'completed',
        agentType,
        workspacePath,
        projectName,
        completedAt,
        state: 'completed',
        windowId,
    };

    const gitBranch = getString(record.gitBranch);
    if (gitBranch !== undefined) {
        return { ...event, gitBranch };
    }

    const providerSessionId = getString(record.providerSessionId);
    const summary = getString(record.summary);

    let nextEvent = event;
    if (providerSessionId !== undefined) {
        nextEvent = { ...nextEvent, providerSessionId };
    }
    if (summary !== undefined) {
        nextEvent = { ...nextEvent, summary };
    }
    return nextEvent;
}

function getAgentType(value: unknown): 'claude' | 'codex' | null {
    if (value === 'claude' || value === 'codex') {
        return value;
    }
    return null;
}

function getHookSource(value: unknown): HookSource {
    if (
        value === 'codex-notify'
        || value === 'claude-stop'
        || value === 'claude-stop-failure'
        || value === 'legacy-process-exit'
    ) {
        return value;
    }
    return 'legacy-process-exit';
}

function getString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
