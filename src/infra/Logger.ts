import fs from 'node:fs';
import path from 'node:path';
import type { ILogger } from '../types.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger implements ILogger {
    private fd: number;
    private currentSize: number;

    constructor(
        private readonly logPath: string,
        private readonly level: LogLevel,
        private readonly maxSizeBytes: number,
    ) {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        this.fd = fs.openSync(logPath, 'a');
        this.currentSize = fs.fstatSync(this.fd).size;
    }

    debug(message: string, meta?: Record<string, unknown>): void {
        this.log('debug', message, meta);
    }

    info(message: string, meta?: Record<string, unknown>): void {
        this.log('info', message, meta);
    }

    warn(message: string, meta?: Record<string, unknown>): void {
        this.log('warn', message, meta);
    }

    error(message: string, meta?: Record<string, unknown>): void {
        this.log('error', message, meta);
    }

    close(): void {
        try {
            fs.closeSync(this.fd);
        } catch {
            // fd may already be closed
        }
    }

    private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
        if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) return;

        const entry: Record<string, unknown> = {
            ts: new Date().toISOString(),
            level,
            msg: message,
        };
        if (meta) {
            Object.assign(entry, meta);
        }

        const line = JSON.stringify(entry) + '\n';

        try {
            fs.writeSync(this.fd, line);
            this.currentSize += Buffer.byteLength(line);

            if (this.currentSize > this.maxSizeBytes) {
                this.rotate();
            }
        } catch {
            // Log write failures are silent — we can't recursively log logging errors
        }
    }

    private rotate(): void {
        try {
            fs.closeSync(this.fd);
            const rotatedPath = `${this.logPath}.1`;
            try { fs.unlinkSync(rotatedPath); } catch { /* no previous rotation file */ }
            fs.renameSync(this.logPath, rotatedPath);
            this.fd = fs.openSync(this.logPath, 'a');
            this.currentSize = 0;
        } catch {
            // If rotation fails, keep writing to the existing fd
        }
    }
}
