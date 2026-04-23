import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { HookEventCandidate, ILogger } from '../types.js';
import { getCodexTuiLogPath } from '../utils/paths.js';

const INITIAL_TAIL_BYTES = 256 * 1024;
const EXEC_COMMAND_PREFIX = 'ToolCall: exec_command ';
const EXEC_APPROVAL_MARKER = 'otel.name="op.dispatch.exec_approval"';

interface ThreadState {
    pendingApproval: PendingApproval | null;
}

interface PendingApproval {
    readonly threadId: string;
    readonly turnId: string;
    readonly workspacePath: string;
    readonly emitted: boolean;
    readonly toolCommand?: string;
    readonly toolDescription?: string;
}

interface ParsedExecCommandToolCall {
    readonly threadId: string;
    readonly turnId: string;
    readonly workspacePath: string;
    readonly requiresApproval: boolean;
    readonly hasPrefixRule: boolean;
    readonly toolCommand?: string;
    readonly toolDescription?: string;
}

interface ParsedExecApprovalDispatch {
    readonly threadId: string;
}

export class CodexApprovalLogMonitor {
    private offset = 0;
    private buffer = '';
    private initialized = false;
    private readonly threads = new Map<string, ThreadState>();

    constructor(
        private readonly logger: ILogger,
        private readonly logPath: string = getCodexTuiLogPath(),
    ) {}

    async poll(): Promise<HookEventCandidate[]> {
        if (!this.initialized) {
            await this.initialize();
        }

        const chunk = await this.readAppendedChunk();
        if (!chunk) {
            return [];
        }

        return this.consumeChunk(chunk, true);
    }

    private async initialize(): Promise<void> {
        const stat = await safeStat(this.logPath);
        if (!stat) {
            this.initialized = true;
            return;
        }

        const start = Math.max(0, stat.size - INITIAL_TAIL_BYTES);
        const seed = await readFileRange(this.logPath, start, stat.size - start);
        this.consumeChunk(seed, false);
        this.offset = stat.size;
        this.initialized = true;
    }

    private async readAppendedChunk(): Promise<string> {
        const stat = await safeStat(this.logPath);
        if (!stat) {
            return '';
        }

        if (stat.size < this.offset) {
            this.logger.warn('codex-approval-monitor:log-rotated', {
                previousOffset: this.offset,
                nextSize: stat.size,
            });
            this.resetState();
            await this.initialize();
            return '';
        }

        if (stat.size === this.offset) {
            return '';
        }

        const chunk = await readFileRange(this.logPath, this.offset, stat.size - this.offset);
        this.offset = stat.size;
        return chunk;
    }

    private consumeChunk(chunk: string, emitEvents: boolean): HookEventCandidate[] {
        const text = `${this.buffer}${chunk}`;
        const lines = text.split(/\r?\n/);
        this.buffer = lines.pop() ?? '';

        const candidates: HookEventCandidate[] = [];
        for (const line of lines) {
            const candidate = this.consumeLine(line, emitEvents);
            if (candidate) {
                candidates.push(candidate);
            }
        }

        return candidates;
    }

    private consumeLine(line: string, emitEvents: boolean): HookEventCandidate | null {
        const toolCall = parseExecCommandToolCall(line);
        if (toolCall) {
            return this.applyToolCall(toolCall, emitEvents);
        }

        const approvalDispatch = parseExecApprovalDispatch(line);
        if (!approvalDispatch) {
            return null;
        }

        const candidate = this.buildCandidate(approvalDispatch.threadId);
        if (!candidate && emitEvents) {
            this.logger.debug('codex-approval-monitor:approval-without-pending-toolcall', {
                threadId: approvalDispatch.threadId,
            });
        }
        return emitEvents ? candidate : null;
    }

    private applyToolCall(toolCall: ParsedExecCommandToolCall, emitEvents: boolean): HookEventCandidate | null {
        const state = this.getThreadState(toolCall.threadId);

        if (!toolCall.requiresApproval) {
            state.pendingApproval = null;
            return null;
        }

        const pendingApproval: PendingApproval = {
            threadId: toolCall.threadId,
            turnId: toolCall.turnId,
            workspacePath: toolCall.workspacePath,
            emitted: !toolCall.hasPrefixRule,
            ...(toolCall.toolCommand ? { toolCommand: toolCall.toolCommand } : {}),
            ...(toolCall.toolDescription ? { toolDescription: toolCall.toolDescription } : {}),
        };
        state.pendingApproval = pendingApproval;

        if (!emitEvents || toolCall.hasPrefixRule) {
            return null;
        }

        return this.buildCandidateFromPending(pendingApproval);
    }

    private buildCandidate(threadId: string): HookEventCandidate | null {
        const state = this.threads.get(threadId);
        if (!state?.pendingApproval) {
            return null;
        }

        const pending = state.pendingApproval;
        state.pendingApproval = null;

        if (pending.emitted) {
            return null;
        }

        return this.buildCandidateFromPending(pending);
    }

    private buildCandidateFromPending(pending: PendingApproval): HookEventCandidate {
        const toolName = 'Bash';
        const dedupeKeyHint = sha256(JSON.stringify({
            turnId: pending.turnId,
            workspacePath: pending.workspacePath,
            toolName,
            toolCommand: pending.toolCommand,
            toolDescription: pending.toolDescription,
        }));

        return {
            agentType: 'codex',
            source: 'codex-log-exec-approval',
            kind: 'approval-request',
            dedupeKeyHint,
            workspacePath: pending.workspacePath,
            providerSessionId: pending.threadId,
            providerEvent: {
                codexTurnId: pending.turnId,
                toolName,
                ...(pending.toolCommand ? { toolCommand: pending.toolCommand } : {}),
                ...(pending.toolDescription ? { toolDescription: pending.toolDescription } : {}),
            },
        };
    }

    private getThreadState(threadId: string): ThreadState {
        const existing = this.threads.get(threadId);
        if (existing) {
            return existing;
        }

        const nextState: ThreadState = { pendingApproval: null };
        this.threads.set(threadId, nextState);
        return nextState;
    }

    private resetState(): void {
        this.offset = 0;
        this.buffer = '';
        this.initialized = false;
        this.threads.clear();
    }
}

function parseExecCommandToolCall(line: string): ParsedExecCommandToolCall | null {
    const prefixIndex = line.indexOf(EXEC_COMMAND_PREFIX);
    if (prefixIndex === -1) {
        return null;
    }

    const threadId = readThreadId(line);
    const turnId = readTurnId(line);
    const jsonEnd = line.lastIndexOf(' thread_id=');
    if (!threadId || !turnId || jsonEnd === -1) {
        return null;
    }

    const payloadText = line.slice(prefixIndex + EXEC_COMMAND_PREFIX.length, jsonEnd);
    let parsed: unknown;
    try {
        parsed = JSON.parse(payloadText);
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }

    const payload = parsed as Record<string, unknown>;
    const workspacePath = readString(payload.workdir);
    if (!workspacePath) {
        return null;
    }

    const hasPrefixRule = readPrefixRulePresence(payload.prefix_rule);
    const toolCommand = readString(payload.cmd);
    const toolDescription = readString(payload.justification);

    return {
        threadId,
        turnId,
        workspacePath,
        requiresApproval: payload.sandbox_permissions === 'require_escalated',
        hasPrefixRule,
        ...(toolCommand ? { toolCommand } : {}),
        ...(toolDescription ? { toolDescription } : {}),
    };
}

function parseExecApprovalDispatch(line: string): ParsedExecApprovalDispatch | null {
    if (!line.includes(EXEC_APPROVAL_MARKER)) {
        return null;
    }

    const threadId = readThreadId(line);
    if (!threadId) {
        return null;
    }

    return { threadId };
}

function readThreadId(line: string): string | null {
    const match = line.match(/session_loop\{thread_id=([^}]+)\}/);
    return match?.[1] ?? null;
}

function readTurnId(line: string): string | null {
    const match = line.match(/turn\.id=([^ ]+)/);
    return match?.[1] ?? null;
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readPrefixRulePresence(value: unknown): boolean {
    if (typeof value === 'string') {
        return value.length > 0;
    }

    if (Array.isArray(value)) {
        return value.length > 0;
    }

    return false;
}

async function safeStat(targetPath: string): Promise<{ size: number } | null> {
    try {
        const stat = await fs.stat(targetPath);
        return { size: stat.size };
    } catch {
        return null;
    }
}

async function readFileRange(targetPath: string, start: number, length: number): Promise<string> {
    if (length <= 0) {
        return '';
    }

    const handle = await fs.open(targetPath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        await handle.close();
    }
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}
