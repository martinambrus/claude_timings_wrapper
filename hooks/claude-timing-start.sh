#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook for timing wrapper.
# Writes a millisecond timestamp to a temp file so the PTY wrapper
# knows when the user submitted a prompt.

# If not running inside the timing wrapper, exit silently.
if [ -z "$CLAUDE_TIMING_SESSION" ]; then
  exit 0
fi

TMPFILE="/tmp/claude_timing_start_${CLAUDE_TIMING_SESSION}"

# Write current epoch milliseconds
date +%s%3N > "$TMPFILE"
