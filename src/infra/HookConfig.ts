const NOTIFY_LINE_PATTERN = /^notify\s*=\s*(\[[^\n]*\])\s*$/m;
const SECTION_HEADER_PATTERN = /^\s*\[([^[\]]+)\]\s*$/;
const CODEX_HOOKS_FEATURE_PATTERN = /^(\s*codex_hooks\s*=\s*)(true|false)(\s*(#.*)?)$/;

export interface ClaudeHookHandler {
    type?: string;
    command?: string;
    statusMessage?: string;
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

export interface CodexHookHandler {
    type?: string;
    command?: string;
    statusMessage?: string;
    timeout?: number;
    timeoutSec?: number;
    [key: string]: unknown;
}

export interface CodexHookGroup {
    matcher?: string;
    hooks?: CodexHookHandler[];
    [key: string]: unknown;
}

export interface CodexHooksSettings {
    hooks?: Record<string, CodexHookGroup[]>;
    [key: string]: unknown;
}

export type CodexNotifyConfigState = 'missing' | 'supported' | 'unsupported';
export type CodexHooksFeatureState = 'enabled' | 'disabled' | 'missing';

type ClaudeHookEventName = 'Stop' | 'Notification';
type CodexHookEventName = 'Stop' | 'PermissionRequest';

interface HookCount {
    readonly managed: number;
    readonly other: number;
    readonly total: number;
}

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

export function inspectCodexHooksFeature(content: string): CodexHooksFeatureState {
    const range = findSectionRange(content.split('\n'), 'features');
    if (!range) {
        return 'missing';
    }

    for (let index = range.start; index < range.end; index++) {
        const line = range.lines[index] ?? '';
        const match = line.match(CODEX_HOOKS_FEATURE_PATTERN);
        if (!match?.[2]) {
            continue;
        }
        return match[2] === 'true' ? 'enabled' : 'disabled';
    }

    return 'missing';
}

export function upsertCodexHooksFeature(content: string, enabled: boolean): string {
    const lines = content.split('\n');
    const range = findSectionRange(lines, 'features');
    const nextLine = `codex_hooks = ${enabled ? 'true' : 'false'}`;

    if (range) {
        for (let index = range.start; index < range.end; index++) {
            const line = lines[index] ?? '';
            if (CODEX_HOOKS_FEATURE_PATTERN.test(line)) {
                lines[index] = line.replace(CODEX_HOOKS_FEATURE_PATTERN, `$1${enabled ? 'true' : 'false'}$3`);
                return lines.join('\n');
            }
        }

        lines.splice(range.end, 0, nextLine);
        return lines.join('\n');
    }

    if (content.trim().length === 0) {
        return ['[features]', nextLine, ''].join('\n');
    }

    const suffix = content.endsWith('\n') ? '' : '\n';
    return `${content}${suffix}\n[features]\n${nextLine}\n`;
}

export function restoreCodexHooksFeature(
    content: string,
    originalState: CodexHooksFeatureState,
): string {
    switch (originalState) {
        case 'enabled':
            return upsertCodexHooksFeature(content, true);
        case 'disabled':
            return upsertCodexHooksFeature(content, false);
        case 'missing':
            return removeCodexHooksFeature(content);
    }
}

export function parseCodexHooksSettings(content: string): CodexHooksSettings {
    if (!content.trim()) {
        return {};
    }

    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Codex hooks settings must be a JSON object');
    }
    return parsed as CodexHooksSettings;
}

export function serializeCodexHooksSettings(settings: CodexHooksSettings): string {
    return `${JSON.stringify(settings, null, 2)}\n`;
}

export function countCodexCommandHooks(
    settings: CodexHooksSettings,
    eventName: CodexHookEventName,
    managedCommand: string,
    matcher?: string,
): HookCount {
    return countCommandHooks(settings.hooks?.[eventName], managedCommand, matcher);
}

export function hasCodexCommandHook(
    settings: CodexHooksSettings,
    eventName: CodexHookEventName,
    managedCommand: string,
    matcher?: string,
): boolean {
    return countCodexCommandHooks(settings, eventName, managedCommand, matcher).managed > 0;
}

export function upsertCodexCommandHook(
    settings: CodexHooksSettings,
    eventName: CodexHookEventName,
    command: string,
    options?: {
        readonly matcher?: string;
        readonly statusMessage?: string;
        readonly timeout?: number;
    },
): CodexHooksSettings {
    const matcher = normalizeMatcher(options?.matcher);
    const nextGroup: CodexHookGroup = {
        ...(matcher ? { matcher } : {}),
        hooks: [{
            type: 'command',
            command,
            ...(options?.statusMessage ? { statusMessage: options.statusMessage } : {}),
            ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
        }],
    };

    return upsertCommandHook(settings, eventName, command, matcher, nextGroup);
}

export function removeCodexCommandHook(
    settings: CodexHooksSettings,
    eventName: CodexHookEventName,
    command: string,
    matcher?: string,
): CodexHooksSettings {
    return removeCommandHook(settings, eventName, command, matcher);
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
): HookCount {
    return countClaudeCommandHooks(settings, 'Stop', managedCommand);
}

export function upsertClaudeStopHook(settings: ClaudeSettings, command: string): ClaudeSettings {
    const nextGroup: ClaudeHookGroup = {
        hooks: [{ type: 'command', command }],
    };
    return upsertCommandHook(settings, 'Stop', command, '', nextGroup);
}

export function removeClaudeStopHook(settings: ClaudeSettings, command: string): ClaudeSettings {
    return removeCommandHook(settings, 'Stop', command);
}

export function hasClaudePermissionPromptHook(settings: ClaudeSettings, command: string): boolean {
    return countClaudePermissionPromptHooks(settings, command).managed > 0;
}

export function countClaudePermissionPromptHooks(
    settings: ClaudeSettings,
    managedCommand: string,
): HookCount {
    return countClaudeCommandHooks(settings, 'Notification', managedCommand, 'permission_prompt');
}

export function upsertClaudePermissionPromptHook(settings: ClaudeSettings, command: string): ClaudeSettings {
    const nextGroup: ClaudeHookGroup = {
        matcher: 'permission_prompt',
        hooks: [{ type: 'command', command }],
    };
    return upsertCommandHook(settings, 'Notification', command, 'permission_prompt', nextGroup);
}

export function removeClaudePermissionPromptHook(settings: ClaudeSettings, command: string): ClaudeSettings {
    return removeCommandHook(settings, 'Notification', command, 'permission_prompt');
}

function countClaudeCommandHooks(
    settings: ClaudeSettings,
    eventName: ClaudeHookEventName,
    managedCommand: string,
    matcher?: string,
): HookCount {
    return countCommandHooks(settings.hooks?.[eventName], managedCommand, matcher);
}

function countCommandHooks<T extends { matcher?: string; hooks?: Array<{ type?: string; command?: string }> }>(
    groups: T[] | undefined,
    managedCommand: string,
    matcher?: string,
): HookCount {
    let managed = 0;
    let other = 0;
    const normalizedMatcher = normalizeMatcher(matcher);

    for (const group of groups ?? []) {
        if (matcher !== undefined && normalizeMatcher(group.matcher) !== normalizedMatcher) {
            continue;
        }

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

function upsertCommandHook<
    TSettings extends { hooks?: Record<string, TGroup[]>; [key: string]: unknown },
    TGroup extends { matcher?: string; hooks?: Array<{ type?: string; command?: string }>; [key: string]: unknown },
>(
    settings: TSettings,
    eventName: string,
    command: string,
    matcher: string,
    nextGroup: TGroup,
): TSettings {
    const hooks = settings.hooks ?? {};
    const groups = hooks[eventName] ?? [];
    if (countCommandHooks(groups, command, matcher).managed > 0) {
        return settings;
    }

    return {
        ...settings,
        hooks: {
            ...hooks,
            [eventName]: [...groups, nextGroup],
        },
    };
}

function removeCommandHook<
    TSettings extends { hooks?: Record<string, TGroup[]>; [key: string]: unknown },
    TGroup extends { matcher?: string; hooks?: Array<{ type?: string; command?: string }>; [key: string]: unknown },
>(
    settings: TSettings,
    eventName: string,
    command: string,
    matcher?: string,
): TSettings {
    const hooks = settings.hooks ?? {};
    const groups = hooks[eventName] ?? [];
    const normalizedMatcher = normalizeMatcher(matcher);
    const nextGroups: TGroup[] = [];

    for (const group of groups) {
        if (matcher !== undefined && normalizeMatcher(group.matcher) !== normalizedMatcher) {
            nextGroups.push(group);
            continue;
        }

        const nextHooks = (group.hooks ?? []).filter(hook => {
            return !(hook.type === 'command' && hook.command === command);
        });
        if (nextHooks.length === 0) {
            continue;
        }

        nextGroups.push({
            ...group,
            hooks: nextHooks,
        });
    }

    if (nextGroups.length === 0) {
        const { [eventName]: _removed, ...restHooks } = hooks;
        if (Object.keys(restHooks).length === 0) {
            const { hooks: _hooks, ...restSettings } = settings;
            return restSettings as TSettings;
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
            [eventName]: nextGroups,
        },
    };
}

function normalizeMatcher(matcher: string | undefined): string {
    return matcher ?? '';
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

function removeCodexHooksFeature(content: string): string {
    const lines = content.split('\n');
    const range = findSectionRange(lines, 'features');
    if (!range) {
        return content;
    }

    const nextLines = lines.filter((line, index) => {
        if (index < range.start || index >= range.end) {
            return true;
        }
        return !CODEX_HOOKS_FEATURE_PATTERN.test(line);
    });

    return cleanupEmptyFeaturesSection(nextLines).join('\n');
}

function cleanupEmptyFeaturesSection(lines: string[]): string[] {
    const range = findSectionRange(lines, 'features');
    if (!range) {
        return lines;
    }

    const hasContent = range.lines
        .slice(range.start, range.end)
        .some(line => {
            const trimmed = line.trim();
            return trimmed.length > 0 && !trimmed.startsWith('#');
        });

    if (hasContent) {
        return lines;
    }

    const nextLines = [...lines];
    nextLines.splice(range.headerIndex, range.end - range.headerIndex);

    while (
        range.headerIndex < nextLines.length
        && (nextLines[range.headerIndex] ?? '').trim() === ''
    ) {
        nextLines.splice(range.headerIndex, 1);
    }

    return nextLines;
}

function findSectionRange(lines: string[], sectionName: string): {
    readonly lines: string[];
    readonly headerIndex: number;
    readonly start: number;
    readonly end: number;
} | null {
    let headerIndex = -1;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? '';
        const match = line.match(SECTION_HEADER_PATTERN);
        if (!match?.[1]) {
            continue;
        }
        if (match[1] === sectionName) {
            headerIndex = index;
            break;
        }
    }

    if (headerIndex === -1) {
        return null;
    }

    let end = lines.length;
    for (let index = headerIndex + 1; index < lines.length; index++) {
        const line = lines[index] ?? '';
        if (SECTION_HEADER_PATTERN.test(line)) {
            end = index;
            break;
        }
    }

    return {
        lines,
        headerIndex,
        start: headerIndex + 1,
        end,
    };
}
