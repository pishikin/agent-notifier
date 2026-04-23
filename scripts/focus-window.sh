#!/usr/bin/env bash
# focus-window.sh — best-effort Cursor activation for notification clicks.
# Prefer targeting the exact workspace first, then fall back to window-title matching.

set -u

WORKSPACE_PATH="${1:-}"
PROJECT_NAME="${2:-}"
LOG_PATH="${HOME}/.agent-notifier/logs/hooks-wrapper.log"
CURSOR_CLI_FALLBACK="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"

log_focus_failure() {
    mkdir -p "$(dirname "$LOG_PATH")"
    local stderr="$1"
    stderr="${stderr//$'\n'/\\n}"
    printf '%s provider=focus stage=osascript-failed stderr=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$stderr" >> "$LOG_PATH"
}

focus_workspace() {
    local workspace_path="$1"

    if [[ -z "$workspace_path" || ! -e "$workspace_path" ]]; then
        return 1
    fi

    if command -v cursor >/dev/null 2>&1; then
        cursor --reuse-window "$workspace_path" >/dev/null 2>&1 && return 0
    fi

    if [[ -x "$CURSOR_CLI_FALLBACK" ]]; then
        "$CURSOR_CLI_FALLBACK" --reuse-window "$workspace_path" >/dev/null 2>&1 && return 0
    fi

    open -a "Cursor" --args --reuse-window "$workspace_path" >/dev/null 2>&1 && return 0
    open -a "Cursor" "$workspace_path" >/dev/null 2>&1 && return 0

    return 1
}

activate_cursor() {
    osascript -e 'tell application "Cursor" to activate' >/dev/null 2>&1 || true
}

if focus_workspace "$WORKSPACE_PATH"; then
    sleep 0.2
    activate_cursor
    exit 0
fi

if [[ -z "$PROJECT_NAME" ]]; then
    activate_cursor
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
    activate_cursor
fi

exit 0
