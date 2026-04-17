import fs from 'node:fs';
import { getPidFilePath } from './paths.js';

/**
 * Shell-safe quoting: wraps value in single quotes, escaping any existing single quotes.
 * Used to prevent shell injection when values are passed to terminal-notifier -execute.
 * terminal-notifier passes the -execute string to /bin/sh -c.
 */
export function sanitizeShellArg(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * XML entity escaping for plist values.
 * Paths with & or < would produce invalid plist XML without this.
 */
export function escapeXml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * AbortSignal-aware sleep.
 * Rejects with AbortError when signal is aborted — caller should `.catch(() => {})` if that's expected.
 */
export function sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void> {
    return new Promise((resolve, reject) => {
        const signal = options?.signal;

        if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }

        let abortHandler: (() => void) | undefined;
        const finish = (): void => {
            if (signal && abortHandler) {
                signal.removeEventListener('abort', abortHandler);
            }
            resolve();
        };

        const timer = setTimeout(finish, ms);

        abortHandler = (): void => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        };

        signal?.addEventListener('abort', abortHandler, { once: true });
    });
}

export function writePidFile(): void {
    fs.writeFileSync(getPidFilePath(), String(process.pid));
}

export function removePidFile(): void {
    try {
        fs.unlinkSync(getPidFilePath());
    } catch {
        // File may not exist if daemon never fully started
    }
}

/**
 * Format a past ISO timestamp as a human-readable "time ago" string.
 */
export function formatTimeAgo(isoString: string): string {
    const diffMs = Date.now() - new Date(isoString).getTime();
    const seconds = Math.round(diffMs / 1000);

    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}
