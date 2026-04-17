import fs from 'node:fs';
import { getErrorLogPath, getHooksLogPath, getHooksWrapperLogPath, getLogPath } from '../utils/paths.js';

export function logsCommand(options: { n?: string; daemon?: boolean; wrappers?: boolean; error?: boolean }): void {
    const lines = Number(options.n) || 50;
    const logPath = resolveLogPath(options);

    if (!fs.existsSync(logPath)) {
        console.log('No log file found for the selected runtime.');
        console.log(`Expected: ${logPath}`);
        return;
    }

    const content = fs.readFileSync(logPath, 'utf8');
    const allLines = content.trim().split('\n').filter(line => line.length > 0);
    const tail = allLines.slice(-lines);

    for (const line of tail) {
        try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            const { ts, level, msg, ...meta } = entry;
            const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
            console.log(`${String(ts)} [${String(level)}] ${String(msg)}${metaStr}`);
        } catch {
            console.log(line);
        }
    }
}

function resolveLogPath(options: { daemon?: boolean; wrappers?: boolean; error?: boolean }): string {
    if (options.error) {
        return getErrorLogPath();
    }
    if (options.daemon) {
        return getLogPath();
    }
    if (options.wrappers) {
        return getHooksWrapperLogPath();
    }
    return getHooksLogPath();
}
