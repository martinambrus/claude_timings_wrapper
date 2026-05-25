#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook for timing wrapper.
# Writes a millisecond timestamp to a temp file so the PTY wrapper
# knows when the user submitted a prompt.

# If not running inside the timing wrapper, exit silently.
if [ -z "$CLAUDE_TIMING_SESSION" ]; then
  exit 0
fi

# Honour TMPDIR (set by macOS by default) so the path matches what the
# wrapper watches via os.tmpdir() in Node.
TMPBASE="${TMPDIR:-/tmp}"
# Strip any trailing slash from TMPDIR.
TMPBASE="${TMPBASE%/}"
TMPFILE="${TMPBASE}/claude_timing_start_${CLAUDE_TIMING_SESSION}"
PROMPTFILE="${TMPBASE}/claude_timing_prompt_${CLAUDE_TIMING_SESSION}"

# Opt-in: when prompt capture is enabled, save the raw UserPromptSubmit payload
# (JSON on stdin: prompt text + session id), capped at 16KB, BEFORE writing the
# timestamp so the wrapper sees it on the same fs.watch event. The wrapper (Node)
# parses it — no jq dependency here. Long prompts that exceed the cap simply fail
# to parse and fall back to Claude's transcript at report time.
if [ -n "$CLAUDE_TIMING_CAPTURE" ]; then
  head -c 16384 > "$PROMPTFILE" 2>/dev/null
fi

# Get current epoch milliseconds. GNU date supports %N; BSD date (macOS)
# does not, so fall back to perl which ships with macOS by default.
TS=$(date +%s%3N 2>/dev/null)
case "$TS" in
  *N*|"") TS=$(perl -MTime::HiRes -e 'printf "%d", Time::HiRes::time() * 1000') ;;
esac
echo "$TS" > "$TMPFILE"
