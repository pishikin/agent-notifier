import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '../../src/infra/Logger.js';

describe('Logger', () => {
    let tmpDir: string;
    let logPath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
        logPath = path.join(tmpDir, 'test.log');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes structured JSON lines', () => {
        const logger = new Logger(logPath, 'debug', 1024 * 1024);
        logger.info('hello', { key: 'value' });
        logger.close();

        const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(1);
        const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
        expect(entry['level']).toBe('info');
        expect(entry['msg']).toBe('hello');
        expect(entry['key']).toBe('value');
        expect(typeof entry['ts']).toBe('string');
    });

    it('filters out messages below configured level', () => {
        const logger = new Logger(logPath, 'warn', 1024 * 1024);
        logger.debug('debug msg');
        logger.info('info msg');
        logger.warn('warn msg');
        logger.error('error msg');
        logger.close();

        const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(l => l.length > 0);
        expect(lines).toHaveLength(2);

        const levels = lines.map(l => (JSON.parse(l) as Record<string, unknown>)['level']);
        expect(levels).toContain('warn');
        expect(levels).toContain('error');
        expect(levels).not.toContain('debug');
        expect(levels).not.toContain('info');
    });

    it('creates parent directory if missing', () => {
        const nestedPath = path.join(tmpDir, 'deep', 'dir', 'app.log');
        const logger = new Logger(nestedPath, 'info', 1024 * 1024);
        logger.info('test');
        logger.close();
        expect(fs.existsSync(nestedPath)).toBe(true);
    });

    it('rotates log when maxSizeBytes is exceeded', () => {
        const maxSize = 200;
        const logger = new Logger(logPath, 'info', maxSize);

        // Write enough to exceed the limit
        for (let i = 0; i < 10; i++) {
            logger.info('this is a reasonably long log message to fill up the buffer quickly');
        }
        logger.close();

        const rotatedPath = `${logPath}.1`;
        expect(fs.existsSync(rotatedPath)).toBe(true);
        expect(fs.existsSync(logPath)).toBe(true);
        // New log file should be smaller than the original
        expect(fs.statSync(logPath).size).toBeLessThan(fs.statSync(rotatedPath).size);
    });

    it('close() is safe to call multiple times', () => {
        const logger = new Logger(logPath, 'info', 1024 * 1024);
        logger.info('test');
        expect(() => {
            logger.close();
            logger.close();
        }).not.toThrow();
    });

    it('writes each log level', () => {
        const logger = new Logger(logPath, 'debug', 1024 * 1024);
        logger.debug('d');
        logger.info('i');
        logger.warn('w');
        logger.error('e');
        logger.close();

        const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
        const levels = lines.map(l => (JSON.parse(l) as Record<string, unknown>)['level']);
        expect(levels).toEqual(['debug', 'info', 'warn', 'error']);
    });
});
