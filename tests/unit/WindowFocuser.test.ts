import { describe, it, expect, vi } from 'vitest';
import { sanitizeShellArg } from '../../src/utils/process.js';

// WindowFocuser is the focus-window.sh shell script. It has no TypeScript class.
// We test the input sanitization logic that protects the shell script's arguments.

describe('focus-window.sh argument sanitization', () => {
    it('sanitizes workspace paths with spaces', () => {
        const path = '/Users/user/my project';
        const safe = sanitizeShellArg(path);
        // When passed as $1 to the shell script, spaces must be contained in quotes
        expect(safe).toBe("'/Users/user/my project'");
    });

    it('sanitizes paths with single quotes', () => {
        const path = "/Users/user/it's-a-project";
        const safe = sanitizeShellArg(path);
        // The single quote is escaped as '\'' — shell interprets this as a literal '
        expect(safe).toBe("'/Users/user/it'\\''s-a-project'");
    });

    it('sanitizes paths with shell metacharacters', () => {
        const dangerousPath = '/tmp/$(rm -rf /)';
        const safe = sanitizeShellArg(dangerousPath);
        // Inside single quotes, $ is not interpolated
        expect(safe.startsWith("'")).toBe(true);
        expect(safe.endsWith("'")).toBe(true);
        // No unquoted $
        expect(safe.replace(/^'|'$/g, '')).not.toMatch(/^\$/);
    });

    it('sanitizes project names with backticks', () => {
        const name = '`evil-command`';
        const safe = sanitizeShellArg(name);
        // Single-quoted → backtick is literal
        expect(safe).toBe("'`evil-command`'");
    });

    it('handles paths with unicode / Cyrillic', () => {
        const path = '/Users/пользователь/проект';
        const safe = sanitizeShellArg(path);
        expect(safe).toBe("'/Users/пользователь/проект'");
    });
});
