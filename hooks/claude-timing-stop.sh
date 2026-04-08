#!/usr/bin/env bash
# Claude Code Stop hook for timing wrapper.
# Writes a millisecond timestamp to a temp file so the PTY wrapper
# knows exactly when the agent finished.

# If not running inside the timing wrapper, exit silently.
if [ -z "$CLAUDE_TIMING_SESSION" ]; then
  exit 0
fi

# Honour TMPDIR (set by macOS by default) so the path matches what the
# wrapper watches via os.tmpdir() in Node.
TMPFILE="${TMPDIR:-/tmp}"
# Strip any trailing slash from TMPDIR.
TMPFILE="${TMPFILE%/}/claude_timing_${CLAUDE_TIMING_SESSION}"

# Get current epoch milliseconds. GNU date supports %N; BSD date (macOS)
# does not, so fall back to perl which ships with macOS by default.
TS=$(date +%s%3N 2>/dev/null)
case "$TS" in
  *N*|"") TS=$(perl -MTime::HiRes -e 'printf "%d", Time::HiRes::time() * 1000') ;;
esac
echo "$TS" > "$TMPFILE"
