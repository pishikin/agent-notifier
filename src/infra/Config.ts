import fs from 'node:fs';
import { z } from 'zod';
import type { AppConfig } from '../types.js';
import { getConfigPath } from '../utils/paths.js';

const configSchema = z.object({
    watchProcesses: z.array(z.string().min(1)).default(['claude', 'codex']),
    scanIntervalMs: z.number().int().min(500).max(30000).default(2000),
    notificationSound: z.string().default('Glass'),
    showGitBranch: z.boolean().default(true),
    historySize: z.number().int().min(1).max(500).default(50),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    logMaxSizeMb: z.number().min(1).max(100).default(5),
});

export function loadConfig(): AppConfig {
    const configPath = getConfigPath();
    try {
        const raw: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return configSchema.parse(raw);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const issues = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
            console.error(`[agent-notifier] Invalid config (${issues}), using defaults`);
        }
        // Missing file or invalid JSON → full defaults
        return configSchema.parse({});
    }
}

export { configSchema };
