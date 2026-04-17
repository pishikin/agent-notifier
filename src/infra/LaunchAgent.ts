import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { escapeXml } from '../utils/process.js';
import { getLogPath, getErrorLogPath } from '../utils/paths.js';
import type { ICommandExecutor } from '../types.js';

const LABEL = 'com.agent-notifier.daemon';

export class LaunchAgent {
    private readonly plistPath = path.join(
        os.homedir(),
        `Library/LaunchAgents/${LABEL}.plist`,
    );

    /** Computed once — used in all launchctl calls */
    private readonly domainTarget = `gui/${process.getuid?.() ?? 501}`;

    constructor(private readonly executor: ICommandExecutor) {}

    async install(): Promise<void> {
        const binPath = await this.resolveCliPath();
        const plist = this.generatePlist(binPath);

        await fs.mkdir(path.dirname(this.plistPath), { recursive: true });
        await fs.writeFile(this.plistPath, plist, 'utf8');

        // bootout first — if already loaded, this removes it. Error is expected if not loaded.
        await this.executor.exec('launchctl', ['bootout', this.domainTarget, this.plistPath]);

        const { exitCode, stderr } = await this.executor.exec('launchctl', [
            'bootstrap', this.domainTarget, this.plistPath,
        ]);

        if (exitCode !== 0) {
            throw new Error(`launchctl bootstrap failed: ${stderr}`);
        }
    }

    async uninstall(): Promise<void> {
        await this.executor.exec('launchctl', ['bootout', this.domainTarget, this.plistPath]);
        await fs.rm(this.plistPath, { force: true });
    }

    async isRunning(): Promise<boolean> {
        const { stdout } = await this.executor.exec('launchctl', [
            'print', `${this.domainTarget}/${LABEL}`,
        ]);
        return stdout.includes('state = running');
    }

    /**
     * Resolves the path to the `agent-notifier` CLI binary.
     * Uses `which` + `realpath` rather than `process.execPath` (which points to node, not the CLI).
     */
    private async resolveCliPath(): Promise<string> {
        const { stdout, exitCode } = await this.executor.exec('which', ['agent-notifier']);
        if (exitCode === 0 && stdout.trim()) {
            try {
                return await fs.realpath(stdout.trim());
            } catch {
                // realpath may fail if the path is already resolved
                return stdout.trim();
            }
        }
        // Fallback: entry point argv[1]
        const argv1 = process.argv[1];
        return argv1 ? path.resolve(argv1) : process.execPath;
    }

    private generatePlist(cliPath: string): string {
        // Standalone binary (pkg/bun compile) doesn't need the node runtime prefix
        const isStandalone = !cliPath.endsWith('.ts') && !cliPath.endsWith('.js');
        const programArgs = isStandalone
            ? [cliPath, 'daemon']
            : [process.execPath, cliPath, 'daemon'];

        const argsXml = programArgs
            .map(a => `            <string>${escapeXml(a)}</string>`)
            .join('\n');

        return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(getLogPath())}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(getErrorLogPath())}</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/usr/sbin:/bin</string>
    </dict>
</dict>
</plist>`;
    }
}
