# agent-notifier

macOS CLI tool that sends native notifications when Claude or Codex either finishes a reply turn or asks the user for approval inside Cursor.

The current runtime is hook-first:
- Codex `Stop` / `PermissionRequest` hooks -> managed wrappers -> stable shim -> `agent-notifier hook ...`
- Claude `Stop` / `StopFailure` / `Notification(permission_prompt)` hooks -> managed wrappers -> stable shim -> `agent-notifier hook ...`
- Hook runtime -> parser -> event ledger -> notification backend

Legacy Codex `notify` remains only as a compatibility fallback and is no longer the primary completion signal.

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

`agent-notifier install` configures the managed Codex and Claude hooks, enables Codex hooks support, and writes the local shim/wrapper files under `~/.agent-notifier/`.

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
- Claude completion reliability is best when no other `Stop` hooks compete with the managed hook.
- Claude approval reliability is best when no other `Notification(permission_prompt)` hooks compete with the managed hook.
