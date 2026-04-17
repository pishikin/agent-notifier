# agent-notifier

macOS CLI tool that sends native notifications when Claude or Codex finishes a reply turn inside Cursor.

The current runtime is hook-first:
- Codex `notify` hook -> managed wrapper -> stable shim -> `agent-notifier hook codex`
- Claude `Stop` / `StopFailure` hook -> managed wrapper -> stable shim -> `agent-notifier hook claude`
- Hook runtime -> parser -> event ledger -> notification backend

## Requirements

- macOS
- Node.js 22+
- Homebrew
- `terminal-notifier` for native notifications

## Install For Local Development

```bash
npm install
npm run build
npm link
agent-notifier install
agent-notifier doctor
```

`agent-notifier install` configures the managed Codex and Claude hooks and writes the local shim/wrapper files under `~/.agent-notifier/`.

## Main Commands

```bash
agent-notifier install
agent-notifier status
agent-notifier doctor
agent-notifier logs
```

`agent-notifier daemon` still exists for backward compatibility, but it is legacy-only and not the primary runtime path anymore.

## Development

```bash
npm run build
npm test
```

## Project Structure

```text
src/
  commands/   CLI commands
  core/       event parsing, ledger, notifications, orchestration
  infra/      shell/process/config/install integrations
  utils/      pure helpers
tests/unit/   unit tests
scripts/      shell helpers
```

## Notes

- Notifications are grouped per event, not per workspace.
- Click-to-focus is best-effort and may require macOS Accessibility or other privacy permissions.
- Claude reliability is best when no other `Stop` hooks compete with the managed hook.
