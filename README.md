# claude-timed

Track how time is spent during Claude Code sessions: how long you're idle after the agent finishes, how long you spend typing, and how long the agent works.

## How it works

`claude-timed` is a Node.js PTY wrapper that sits between your terminal and the `claude` process. It uses two mechanisms to track timing:

1. **Keystroke interception** — The wrapper intercepts stdin in raw mode to detect when you start typing (only real text input — arrow keys, Ctrl combos, Tab, etc. are ignored).
2. **Claude Code hooks** — Four [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) drive transitions:
   - **UserPromptSubmit** — Fires when the user actually submits a prompt. Writes a timestamp to a temp file so the wrapper knows when the agent started working.
   - **Stop** — Fires when the agent finishes responding. Writes a timestamp so the wrapper knows when the agent completed.
   - **Notification** (`elicitation_dialog` matcher) — Fires when the agent enters plan mode and asks the user to confirm/adjust. The Stop hook doesn't fire in this case, so this ensures the wrapper correctly transitions to IDLE.
   - **PreToolUse** (`AskUserQuestion` matcher) — Fires when the agent asks the user a question, treating it as a stop point similar to Stop.

These signals drive a state machine:

```
INITIAL  --(first keystroke)---------> typing started
         --(UserPromptSubmit hook)---> AGENT_WORKING

AGENT_WORKING --(Stop/Notification/PreToolUse hook)--> IDLE
              --(Ctrl+C)-----------------------------> IDLE (agent_interrupt)

IDLE --(first keystroke)--------------> USER_TYPING
     --(Stop hook, no prior submit)---> IDLE (background_agent_stop, time counted as agent work)

USER_TYPING --(UserPromptSubmit hook)-> AGENT_WORKING
            --(Ctrl+C)----------------> IDLE (typing discarded)

AGENT_WORKING + typing --(UserPromptSubmit)-> steering_submit logged, stays in AGENT_WORKING

IDLE --(120 min no activity)----------> PAUSED (session_paused; stops accruing idle/typing time)
PAUSED --(keystroke or hook)----------> resumes prior flow (session_resumed)

USER_TYPING --(5 min no keystroke)----> IDLE (typing_idle; partial typing flushed)
AGENT_WORKING --(rate-limit notice)---> agent timer stops (extra_usage_limit)
```

Additional behaviors:

- **Shift+Enter** (multi-line input) is handled correctly: the `UserPromptSubmit` hook only fires on actual prompt submission, not on newline insertion.
- **Mid-agent steering**: If you type and submit while the agent is working, your typing time is tracked separately as a `steering_submit` event without interrupting the agent timer.
- **Ctrl+C**: Pressing Ctrl+C while the agent is working properly ends the agent phase (logged as `agent_interrupt`) and transitions to IDLE, since the Stop hook does not fire on user interrupts.
- **Background agents**: When the agent spawns background sub-agents and waits for them, the stop signals arrive without a preceding UserPromptSubmit. This wait time is correctly attributed to agent work rather than idle time.
- **Typing idle timeout**: If you start typing then walk away, typing time stops accruing after 5 minutes with no further keystrokes (`typing_idle`) instead of counting the whole gap as typing.
- **Long idle pause**: After 120 minutes with no activity the session enters a PAUSED state (`session_paused`) and stops accruing time. The next keystroke or hook resumes it (`session_resumed`) without recording the gap.
- **Rate-limit detection**: The wrapper scans Claude Code's output for rate-limit notices ("out of extra usage", `/rate-limit-options`) and stops the agent timer immediately (`extra_usage_limit`), rather than waiting for the 2-hour stall timeout. Hooks cannot detect this — no Stop/PreToolUse event fires when Claude Code enters the rate-limit state.

Each transition is logged to a per-session JSONL file in `~/.claude/timings/`.

## Requirements

- **Node.js** >= 18
- **Claude Code** CLI (`claude`) installed and on your PATH
- A C/C++ toolchain for compiling `node-pty` (build-essential / Xcode CLI tools)

## Installation

```bash
git clone <this-repo>
cd claude_timings_wrapper
npm install
```

### Install the hooks

This adds Stop, UserPromptSubmit, Notification, and PreToolUse hook entries to `~/.claude/settings.json` and copies the hook scripts to `~/.claude/hooks/`. Your existing settings (other hooks, plugins, statusLine, etc.) are preserved. A `.timing-bak` backup is created before any modification.

```bash
node bin/claude-timed.mjs --install-hook
```

### Optional: make it globally available

```bash
npm link
```

Then you can use `claude-timed` from anywhere instead of `node bin/claude-timed.mjs`.

## Usage

### Start a timed session

```bash
claude-timed
# or with arguments passed through to claude:
claude-timed --model sonnet
```

The terminal title bar shows a live timer indicating the current phase (Idle, Typing, or Agent).

All Claude Code functionality works exactly as normal — the wrapper is transparent.

### View stats

```bash
claude-timed --stats                          # Current/most recent session
claude-timed --stats today                    # Today's sessions
claude-timed --stats week                     # Last 7 days
claude-timed --stats month                    # Last 30 days
claude-timed --stats 2026-03-01               # Since a specific date
claude-timed --stats 2026-03-01 2026-03-11    # Custom date range
claude-timed --stats all                      # All sessions
claude-timed --stats week --project myapp     # Filter by project name
claude-timed --stats week --no-noop           # Exclude long idle pauses (>1h30m)
claude-timed --stats week --noop-threshold 45m  # Custom noop threshold
```

When viewing time-range stats (anything except a single session), results are grouped by project with a per-project breakdown. The project name is derived from the working directory where each session was started.

Example output (time-range query with per-project breakdown):

```
=== Claude Code Timing Stats ===
Period: Today (2026-03-11)
Sessions: 3 | Prompts: 22

-- myapp (2 sessions, 15 prompts) --
   /home/user/myapp
             Total        Average/prompt
  User:      8m 30s       34.0s
    Idle:    5m 15s       21.0s
    Typing:  3m 15s       13.0s
  Agent:     50m          3m 20s

Time distribution:
  User:  14.5%  ███░░░░░░░░░░░░░░░░░
  Agent: 85.5%  █████████████████░░░

-- other-project (1 session, 7 prompts) --
   /home/user/other-project
             Total        Average/prompt
  User:      4m           34.3s
    Idle:    3m           25.7s
    Typing:  1m           8.6s
  Agent:     15m          2m 8s

Time distribution:
  User:  21.1%  ████░░░░░░░░░░░░░░░░
  Agent: 78.9%  ████████████████░░░░

-- Overall --
             Total        Average/prompt
  User:      12m 30s      34.1s
    Idle:    8m 15s       22.5s
    Typing:  4m 15s       11.6s
  Agent:     1h 5m        2m 58s

Time distribution:
  User:  16.1%  ███░░░░░░░░░░░░░░░░░
  Agent: 83.9%  █████████████████░░░
```

### Per-task time breakdown

Estimate how long each feature or fix took by correlating git commit history with session timing data. Works with both merge-based workflows (feature branches merged into main) and linear histories (direct commits).

```bash
claude-timed --tasks                          # All time, all projects
claude-timed --tasks today                    # Today's tasks
claude-timed --tasks week                     # Last 7 days
claude-timed --tasks month                    # Last 30 days
claude-timed --tasks 2026-04-01 2026-04-10    # Custom date range
claude-timed --tasks week --project myapp     # Filter by project
claude-timed --tasks week --no-noop           # Exclude long pauses
claude-timed --tasks week --export-md FILE    # Export as markdown
claude-timed --tasks week --unattributed-prompts  # List prompts outside all task windows
claude-timed --tasks week --attribute-llm         # LLM-assign unattributed prompts to tasks
```

For merge commits, the task window spans from the earliest branch commit to the merge date. For standalone commits on a linear branch, consecutive commits within 15 minutes of each other are grouped into a single task. User time is split into **Idle** and **Typing** columns; agent time is never noop-filtered. Time that doesn't fall into any task window is shown as `[unattributed]`.

When task windows run in parallel (overlapping commit ranges), each task still reports its own effort and is tagged `parallel with #N`. Two totals are then shown: **Sum of tasks** (per-task effort added up, which double-counts overlap) and **Wall-clock (deduplicated)** (overlapping windows merged, so concurrent work is counted once). The wall-clock row always renders; an overlap subtext appears only when parallel tasks actually overlap.

Example output (two parallel tasks plus unattributed time):

```
=== Claude Code Task Breakdown ===
Period: Last 7 days (2026-04-03 to 2026-04-10)
Project: myapp

Note: Task timings are estimates based on git history correlation. Interleaved
work, branch switching, and non-commit activity may cause inaccuracies.

  #  Task                                      Agent     Idle    Typing      Total   Prompts
  ───────────────────────────────────────────────────────────────────────────────────────────────
   1  Merge ISSUE-42: Add homepage tiles        1h 42m       8m      15m     2h 5m       14
      2026-04-07 → 2026-04-10 | 3 sessions | parallel with #2
   2  fix: correct tile alignment                  52m       6m      12m   1h 10m        7
      2026-04-08 | 2 sessions | parallel with #1
   3  [unattributed]                               34m       7m       5m      46m        5
  ───────────────────────────────────────────────────────────────────────────────────────────────
      Sum of tasks                              3h 8m      21m      32m    4h 1m       26
      Wall-clock (deduplicated)                 2h 6m      11m      22m   2h 39m       21
      (36m overlap from parallel tasks)

Note: Task timings are estimates. See above disclaimer.
```

#### Inspecting unattributed time

The `[unattributed]` bucket is whatever timing falls outside every task window. Two opt-in flags make it inspectable (both extend `--tasks`; agent time is never noop-filtered):

```bash
claude-timed --tasks week --unattributed-prompts   # List each orphan prompt with agent/user time + branch
claude-timed --tasks week --attribute-llm          # Map those prompts to tasks/commits (implies --unattributed-prompts)
```

`--unattributed-prompts` lists every prompt that fell outside all task windows with its per-prompt agent/user time and a reconciliation line comparing the per-prompt sum against the residual `[unattributed]` total.

`--attribute-llm` sends those prompts to a headless `claude -p` call that thematically assigns each to the most likely task or commit. It defaults to the haiku model, is OAuth-aware, and is tunable:

```bash
claude-timed --tasks week --attribute-llm --attribute-model sonnet   # Override the attribution model (default: haiku)
claude-timed --tasks week --attribute-llm --max-budget-usd 0.50      # Cap estimated spend
claude-timed --tasks week --attribute-llm --attribute-debug          # Print subprocess timing + claude --debug trace to stderr
claude-timed --tasks week --attribute-llm --attribute-timeout 120    # Per-call timeout in seconds
```

Prompt text is resolved from self-contained capture when available, otherwise from Claude Code transcripts (which may have aged out of retention). To guarantee the text is available, enable prompt capture (below).

#### Prompt capture

Prompt text is **not** recorded by default. Opt in when you want `--unattributed-prompts` / `--attribute-llm` to show real prompt text:

```bash
claude-timed --capture-prompts [claude args...]   # Record prompt text for this run only
claude-timed --enable-prompt-capture              # Persist capture ON for future sessions
claude-timed --disable-prompt-capture             # Persist capture OFF
```

While capture is active a privacy reminder is printed each session. Captured text is stored alongside your timing logs in `~/.claude/timings/`.

### Repair old sessions

Early versions could record multi-hour `idle_ms` / `typing_ms` gaps (e.g. leaving a session open overnight) before the PAUSED state existed. `--repair` scans every session file, caps oversized idle/typing values and `background_agent_stop` / `session_end` agent residuals, inserts synthetic `session_paused` / `session_resumed` events, and recomputes `session_end` totals. Originals are backed up to `.bak` before any change.

```bash
claude-timed --repair             # Repair in place (backs up originals to .bak)
claude-timed --repair --dry-run   # Preview repairs without modifying files
```

### Uninstall the hooks

Removes all timing hooks (Stop, UserPromptSubmit, Notification, PreToolUse) from settings and deletes the hook scripts. Other settings are untouched.

```bash
claude-timed --uninstall-hook
```

### Help

```bash
claude-timed --timing-help
```

### Version and updates

```bash
claude-timed --version        # Print the installed version
claude-timed --check-update   # Check GitHub for a newer version now
```

Automatic update checks are **opt-in**. On first run the wrapper asks once (saving your answer to `settings.json`) whether to enable them. If enabled, it checks GitHub at most once per 24h and prints a notice when a newer version exists. The check runs in the background and never blocks or delays normal startup.

## Completion sound (optional)

When the agent finishes and is waiting for your input, `claude-timed` can play a short notification sound (`complete.mp3` in the project root). This is entirely optional — if the sound file is missing or no supported player is installed, no sound plays and no errors are shown.

### Native Linux

Install any one of the following MP3-capable players:

| Player | Install (Debian/Ubuntu) | Install (Fedora) | Install (Arch) |
|--------|------------------------|-------------------|-----------------|
| `mpv` (recommended) | `sudo apt install mpv` | `sudo dnf install mpv` | `sudo pacman -S mpv` |
| `mpg123` | `sudo apt install mpg123` | `sudo dnf install mpg123` | `sudo pacman -S mpg123` |
| `mpg321` | `sudo apt install mpg321` | — | — |
| `ffplay` (part of ffmpeg) | `sudo apt install ffmpeg` | `sudo dnf install ffmpeg` | `sudo pacman -S ffmpeg` |

The first available player from the list above is used. Detection happens once on the first agent completion.

### WSL2

If none of the native Linux players above are installed, the wrapper falls back to PowerShell's `System.Windows.Media.MediaPlayer`, which is available out of the box on any WSL2 system with access to `powershell.exe`. No additional Windows-side installation is required.

If you prefer lower latency, install one of the native Linux players listed above. With [WSLg](https://github.com/microsoft/wslg) (enabled by default on Windows 11), native Linux audio works transparently inside WSL2.

## Data storage

Session data is stored as JSONL files in `~/.claude/timings/`:

```
~/.claude/timings/
├── 2026-03-11T10-30-00_a1b2c3d4.jsonl
├── 2026-03-11T14-15-22_d4e5f6a7.jsonl
└── ...
```

Each file contains one JSON object per line:

```jsonl
{"ts":"...","event":"session_start","session":"a1b2c3d4"}
{"ts":"...","event":"prompt_submit","prompt":1,"typing_ms":5230}
{"ts":"...","event":"agent_stop","prompt":1,"agent_work_ms":45000}
{"ts":"...","event":"typing_start","prompt":2,"idle_ms":30000}
{"ts":"...","event":"prompt_submit","prompt":2,"typing_ms":10000}
{"ts":"...","event":"steering_submit","typing_ms":2100}
{"ts":"...","event":"agent_stop","prompt":2,"agent_work_ms":35000}
{"ts":"...","event":"background_agent_stop","agent_work_ms":5000}
{"ts":"...","event":"agent_interrupt","prompt":3,"agent_work_ms":12000}
{"ts":"...","event":"session_end","total_user_ms":45230,"total_idle_ms":30000,"total_typing_ms":15230,"total_agent_ms":80000,"prompts":2,"cwd":"/home/user/myapp"}
```

Event types:
- `session_start` / `session_end` — Session lifecycle. The end event includes `cwd` (working directory) for per-project grouping.
- `typing_start` — User started typing after being idle. Records `idle_ms`.
- `prompt_submit` — User submitted a prompt. Records `typing_ms`.
- `agent_stop` — Agent finished working. Records `agent_work_ms`.
- `steering_submit` — User submitted input while the agent was still working (mid-agent steering). Records `typing_ms` without interrupting the agent timer.
- `background_agent_stop` — A background sub-agent completed. The wait time is attributed to agent work. May include `idle_correction_ms` if the user had started typing during the wait.
- `agent_interrupt` — User pressed Ctrl+C to interrupt the agent. Records partial `agent_work_ms`.
- `agent_stall` — Agent produced no PTY output for 2 hours; assumed stalled (e.g. budget limit). Records `agent_work_ms` only up to last observed activity, then enters PAUSED.
- `typing_stall` — User typing phase stalled with no activity for 2 hours.
- `typing_idle` — Typing phase ended after 5 minutes with no keystrokes. Records `typing_ms` up to the last keystroke (prevents one keystroke then walking away from counting as hours of typing).
- `agent_silence_check` — Diagnostic: the agent has been silent for the stall window but its process is still alive, so the stall is deferred and re-checked (up to 4 times, every 30 minutes). Records `silent_elapsed_ms`.
- `session_paused` / `session_resumed` — After 120 minutes idle the session pauses and stops accruing time (`session_paused` records `idle_before_pause_ms`); the next keystroke or hook resumes it (`session_resumed`).
- `extra_usage_limit` — A rate-limit notice was detected in Claude Code's output; the agent timer is stopped immediately. Records partial `agent_work_ms`.

## Project structure

```
claude_timings_wrapper/
├── package.json
├── complete.mp3                   # Optional completion notification sound
├── bin/
│   └── claude-timed.mjs          # Entry point, flag parsing
├── lib/
│   ├── constants.mjs             # Paths and state enum
│   ├── wrapper.mjs               # PTY spawn, state machine, keystroke detection
│   ├── timing-log.mjs            # Per-session JSONL read/write
│   ├── stats.mjs                 # --stats display with date filtering
│   ├── tasks.mjs                 # --tasks per-task breakdown (git-correlated)
│   ├── repair.mjs                # --repair: cap oversized idle/typing gaps in old sessions
│   ├── prompt-source.mjs         # Resolve prompt text (capture or transcripts) for --unattributed-prompts
│   ├── llm-attribute.mjs         # --attribute-llm: map unattributed prompts to tasks via claude -p
│   ├── settings.mjs              # ~/.claude/settings.json read/write (capture + update-check opt-ins)
│   ├── update-checker.mjs        # --version / --check-update + opt-in GitHub update check
│   ├── title-bar.mjs             # Terminal title bar timer
│   ├── sound.mjs                 # Optional completion sound playback
│   └── hook-installer.mjs        # Install/uninstall Claude Code hooks
└── hooks/
    ├── claude-timing-stop.sh     # Stop hook script
    └── claude-timing-start.sh    # UserPromptSubmit hook script
```

## Limitations

- **First prompt idle time**: The very first prompt has no idle time measurement since there's no prior agent completion to measure from.
- **Abrupt termination**: If the process is killed (SIGKILL, power loss), the `session_end` summary won't be written. Stats will recompute totals from individual events in this case.

## License

MIT
