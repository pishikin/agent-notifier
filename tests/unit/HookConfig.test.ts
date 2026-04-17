import { describe, expect, it } from 'vitest';
import {
    extractCodexNotifyArgs,
    parseClaudeSettings,
    removeClaudeStopHook,
    restoreCodexNotify,
    serializeClaudeSettings,
    upsertClaudeStopHook,
    upsertCodexNotify,
} from '../../src/infra/HookConfig.js';

describe('Codex notify config helpers', () => {
    it('extracts notify args from TOML', () => {
        const content = 'notify = ["/bin/bash", "/tmp/codex.sh"]\nmodel = "gpt-5.4"\n';
        expect(extractCodexNotifyArgs(content)).toEqual(['/bin/bash', '/tmp/codex.sh']);
    });

    it('upserts notify line into config', () => {
        const content = 'model = "gpt-5.4"\n';
        const next = upsertCodexNotify(content, ['/bin/bash', '/tmp/codex.sh']);
        expect(next).toContain('notify = ["/bin/bash","/tmp/codex.sh"]');
    });

    it('restores original notify args on uninstall', () => {
        const managed = ['/bin/bash', '/tmp/managed.sh'];
        const original = ['/bin/bash', '/tmp/original.sh'];
        const content = 'notify = ["/bin/bash","/tmp/managed.sh"]\nmodel = "gpt-5.4"\n';

        const restored = restoreCodexNotify(content, managed, original);

        expect(restored).toContain('notify = ["/bin/bash","/tmp/original.sh"]');
    });
});

describe('Claude hook config helpers', () => {
    it('adds a Stop hook command without removing existing hooks', () => {
        const settings = parseClaudeSettings(JSON.stringify({
            hooks: {
                Stop: [
                    {
                        hooks: [{ type: 'command', command: 'afplay bell.aiff' }],
                    },
                ],
            },
            model: 'opus',
        }));

        const next = upsertClaudeStopHook(settings, '/bin/bash /tmp/claude-stop.sh');
        const serialized = serializeClaudeSettings(next);

        expect(serialized).toContain('afplay bell.aiff');
        expect(serialized).toContain('/tmp/claude-stop.sh');
    });

    it('removes only the managed Stop hook command', () => {
        const settings = parseClaudeSettings(JSON.stringify({
            hooks: {
                Stop: [
                    {
                        hooks: [{ type: 'command', command: 'afplay bell.aiff' }],
                    },
                    {
                        matcher: '',
                        hooks: [{ type: 'command', command: '/bin/bash /tmp/claude-stop.sh' }],
                    },
                ],
            },
        }));

        const next = removeClaudeStopHook(settings, '/bin/bash /tmp/claude-stop.sh');
        const serialized = serializeClaudeSettings(next);

        expect(serialized).toContain('afplay bell.aiff');
        expect(serialized).not.toContain('/tmp/claude-stop.sh');
    });
});
