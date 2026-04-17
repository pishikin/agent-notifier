const NOTIFY_LINE_PATTERN = /^notify\s*=\s*(\[[^\n]*\])\s*$/m;

export interface ClaudeHookHandler {
    type?: string;
    command?: string;
    [key: string]: unknown;
}

export interface ClaudeHookGroup {
    matcher?: string;
    hooks?: ClaudeHookHandler[];
    [key: string]: unknown;
}

export interface ClaudeSettings {
    hooks?: Record<string, ClaudeHookGroup[]>;
    [key: string]: unknown;
}

export type CodexNotifyConfigState = 'missing' | 'supported' | 'unsupported';

export function inspectCodexNotifyConfig(content: string): {
    readonly state: CodexNotifyConfigState;
    readonly notifyArgs: string[] | null;
} {
    const notifyArgs = extractCodexNotifyArgs(content);
    if (notifyArgs) {
        return { state: 'supported', notifyArgs };
    }

    const containsNotify = content
        .split('\n')
        .some(line => line.trimStart().startsWith('notify'));

    return {
        state: containsNotify ? 'unsupported' : 'missing',
        notifyArgs: null,
    };
}

export function extractCodexNotifyArgs(content: string): string[] | null {
    const match = content.match(NOTIFY_LINE_PATTERN);
    if (!match?.[1]) {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(match[1]);
        if (Array.isArray(parsed) && parsed.every(entry => typeof entry === 'string')) {
            return parsed;
        }
    } catch {
        return null;
    }

    return null;
}

export function upsertCodexNotify(content: string, notifyArgs: string[]): string {
    const inspection = inspectCodexNotifyConfig(content);
    if (inspection.state === 'unsupported') {
        throw new Error('Unsupported Codex notify format. Only single-line notify = [...] is supported for safe automatic mutation.');
    }

    const nextLine = buildCodexNotifyLine(notifyArgs);
    if (inspection.state === 'supported') {
        return content.replace(NOTIFY_LINE_PATTERN, nextLine);
    }

    const lines = content.split('\n');
    let insertIndex = 0;
    while (insertIndex < lines.length) {
        const line = lines[insertIndex]?.trim() ?? '';
        if (line === '' || line.startsWith('#')) {
            insertIndex++;
            continue;
        }
        break;
    }

    lines.splice(insertIndex, 0, nextLine);
    return lines.join('\n');
}

export function restoreCodexNotify(
    content: string,
    managedNotifyArgs: string[],
    originalNotifyArgs?: string[],
): string {
    const inspection = inspectCodexNotifyConfig(content);
    if (inspection.state !== 'supported') {
        return content;
    }

    if (!arraysEqual(inspection.notifyArgs, managedNotifyArgs)) {
        return content;
    }

    if (!originalNotifyArgs || originalNotifyArgs.length === 0) {
        return removeCodexNotifyLine(content);
    }

    return content.replace(buildCodexNotifyLine(managedNotifyArgs), buildCodexNotifyLine(originalNotifyArgs));
}

export function buildCodexNotifyLine(notifyArgs: string[]): string {
    return `notify = ${JSON.stringify(notifyArgs)}`;
}

export function parseClaudeSettings(content: string): ClaudeSettings {
    if (!content.trim()) {
        return {};
    }

    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Claude settings must be a JSON object');
    }
    return parsed as ClaudeSettings;
}

export function serializeClaudeSettings(settings: ClaudeSettings): string {
    return `${JSON.stringify(settings, null, 2)}\n`;
}

export function hasClaudeStopHook(settings: ClaudeSettings, command: string): boolean {
    return countClaudeStopHooks(settings, command).managed > 0;
}

export function countClaudeStopHooks(
    settings: ClaudeSettings,
    managedCommand: string,
): {
    readonly managed: number;
    readonly other: number;
    readonly total: number;
} {
    let managed = 0;
    let other = 0;

    for (const group of settings.hooks?.Stop ?? []) {
        for (const hook of group.hooks ?? []) {
            if (hook.type !== 'command' || typeof hook.command !== 'string') {
                continue;
            }
            if (hook.command === managedCommand) {
                managed++;
            } else {
                other++;
            }
        }
    }

    return {
        managed,
        other,
        total: managed + other,
    };
}

export function getOtherClaudeStopHooks(settings: ClaudeSettings, managedCommand: string): ClaudeHookHandler[] {
    const otherHooks: ClaudeHookHandler[] = [];
    for (const group of settings.hooks?.Stop ?? []) {
        for (const hook of group.hooks ?? []) {
            if (hook.type === 'command' && hook.command === managedCommand) {
                continue;
            }
            otherHooks.push(hook);
        }
    }
    return otherHooks;
}

export function upsertClaudeStopHook(settings: ClaudeSettings, command: string): ClaudeSettings {
    if (hasClaudeStopHook(settings, command)) {
        return settings;
    }

    const hooks = settings.hooks ?? {};
    const stopGroups = hooks.Stop ?? [];
    stopGroups.push({
        matcher: '',
        hooks: [{ type: 'command', command }],
    });

    return {
        ...settings,
        hooks: {
            ...hooks,
            Stop: stopGroups,
        },
    };
}

export function removeClaudeStopHook(settings: ClaudeSettings, command: string): ClaudeSettings {
    const hooks = settings.hooks ?? {};
    const stopGroups = hooks.Stop ?? [];
    const nextStopGroups: ClaudeHookGroup[] = [];

    for (const group of stopGroups) {
        const nextHooks = (group.hooks ?? []).filter(hook => {
            return !(hook.type === 'command' && hook.command === command);
        });
        if (nextHooks.length === 0) {
            continue;
        }

        nextStopGroups.push({
            ...group,
            hooks: nextHooks,
        });
    }

    if (nextStopGroups.length === 0) {
        const { Stop: _removed, ...restHooks } = hooks;
        if (Object.keys(restHooks).length === 0) {
            const { hooks: _hooks, ...restSettings } = settings;
            return restSettings;
        }
        return {
            ...settings,
            hooks: restHooks,
        };
    }

    return {
        ...settings,
        hooks: {
            ...hooks,
            Stop: nextStopGroups,
        },
    };
}

function arraysEqual(left: string[] | null | undefined, right: string[] | null | undefined): boolean {
    if (!left || !right || left.length !== right.length) {
        return false;
    }

    return left.every((value, index) => value === right[index]);
}

function removeCodexNotifyLine(content: string): string {
    const lines = content.split('\n').filter(line => !NOTIFY_LINE_PATTERN.test(line));
    return lines.join('\n');
}
