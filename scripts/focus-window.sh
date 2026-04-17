#!/usr/bin/env bash
# focus-window.sh — best-effort Cursor activation for notification clicks.
# WORKSPACE_PATH is passed through for future exact targeting, but this script
# intentionally matches by project name only in this implementation pass.

set -u

WORKSPACE_PATH="${1:-}"
PROJECT_NAME="${2:-}"
LOG_PATH="${HOME}/.agent-notifier/logs/hooks-wrapper.log"

log_focus_failure() {
    mkdir -p "$(dirname "$LOG_PATH")"
    local stderr="$1"
    stderr="${stderr//$'\n'/\\n}"
    printf '%s provider=focus stage=osascript-failed stderr=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$stderr" >> "$LOG_PATH"
}

if [[ -z "$PROJECT_NAME" ]]; then
    osascript -e 'tell application "Cursor" to activate' >/dev/null 2>&1 || true
    exit 0
fi

if ! output="$(osascript - "$PROJECT_NAME" "$WORKSPACE_PATH" <<'APPLESCRIPT' 2>&1
on run argv
    set projectName to item 1 of argv
    tell application "System Events"
        if not (exists process "Cursor") then
            tell application "Cursor" to activate
            return
        end if

        tell process "Cursor"
            set frontmost to true
            try
                set targetWindow to first window whose name contains projectName
                perform action "AXRaise" of targetWindow
            on error
                tell application "Cursor" to activate
            end try
        end tell
    end tell
end run
APPLESCRIPT
)"; then
    log_focus_failure "$output"
    osascript -e 'tell application "Cursor" to activate' >/dev/null 2>&1 || true
fi

exit 0
