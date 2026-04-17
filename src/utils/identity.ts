import { createHash } from 'node:crypto';

export function buildWindowId(workspacePath: string): string {
    return createHash('sha256').update(workspacePath).digest('hex').slice(0, 12);
}
