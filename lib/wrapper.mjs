import * as pty from 'node-pty';
import { watch, existsSync, readFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { homedir, tmpdir } from 'os';
import { join, basename } from 'path';
import { STATE } from './constants.mjs';
import { createSession, appendEntry, endSession } from './timing-log.mjs';
import { startTitleBar, stopTitleBar } from './title-bar.mjs';
import { playCompletionSound } from './sound.mjs';

const TMP_DIR = tmpdir();
const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');

function isPidAlive(pid) {
  if ( !pid || typeof pid !== 'number' ) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return err && err.code === 'EPERM';
  }
}

/**
 * Find overlapping Claude sessions by scanning ~/.claude/sessions/*.json.
 * Returns array of Claude session IDs that overlap with this wrapper's lifetime.
 *
 * Overlap rule: another session is parallel if it was alive at any point
 * between our wrapper start and `now`. Self-exclusion is by the spawned
 * claude PID (claudePid).
 */
function detectParallelSessions(sessionStartTime, claudePid) {
  const parallel = [];
  const now = Date.now();
  const startMs = sessionStartTime instanceof Date ? sessionStartTime.getTime() : sessionStartTime;

  try {
    if ( !existsSync(SESSIONS_DIR) ) return parallel;
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const fullPath = join(SESSIONS_DIR, file);
        const data = JSON.parse(readFileSync(fullPath, 'utf8'));

        // Self-exclusion: skip the session record for the claude process we spawned.
        if ( claudePid && data.pid === claudePid ) continue;

        const sid = data.session_id || data.sessionId || basename(file, '.json');

        // When did this session start?
        let oStartMs = null;
        if ( typeof data.startedAt === 'number' ) {
          oStartMs = data.startedAt;
        } else if ( data.start ) {
          oStartMs = new Date(data.start).getTime();
        } else if ( data.startedAt ) {
          oStartMs = new Date(data.startedAt).getTime();
        }
        if ( oStartMs == null || isNaN(oStartMs) ) continue;

        // When was this session last seen?
        // Prefer an explicit last_seen field; otherwise treat live PIDs as
        // "still alive now", and dead PIDs as "last seen at file mtime".
        let oLastMs;
        if ( data.last_seen ) {
          oLastMs = new Date(data.last_seen).getTime();
        } else if ( isPidAlive(data.pid) ) {
          oLastMs = now;
        } else {
          try {
            oLastMs = statSync(fullPath).mtimeMs;
          } catch {
            oLastMs = oStartMs;
          }
        }

        // Overlap: other session started before now AND was last seen after our start.
        if ( (oStartMs <= now) && (oLastMs >= startMs) ) {
          parallel.push(sid);
        }
      } catch {}
    }
  } catch {}

  return parallel;
}

function isTypingKeystroke(data) {
  const buf = Buffer.from(data);
  // Escape sequences (arrows, function keys, Alt+key, etc.)
  if (buf[0] === 0x1b) return false;
  // Control characters (Ctrl+key, Tab, Backspace, Enter, etc.)
  if (buf[0] < 32) return false;
  // DEL / Backspace
  if (buf[0] === 127) return false;
  // Printable ASCII (32-126) or UTF-8 multi-byte (>= 0xC0) or paste
  return true;
}

function cleanStaleTmpFiles() {
  try {
    const tmpFiles = readdirSync(TMP_DIR).filter(f => f.startsWith('claude_timing_'));
    for (const f of tmpFiles) {
      try { unlinkSync(join(TMP_DIR, f)); } catch {}
    }
  } catch {}
}

export function startWrapper(claudeArgs) {
  const sessionId = randomUUID();
  const shortId = sessionId.slice(0, 8);
  const tmpFile = join(TMP_DIR, `claude_timing_${sessionId}`);
  const startTmpFile = join(TMP_DIR, `claude_timing_start_${sessionId}`);
  const wrapperStartTime = Date.now();

  cleanStaleTmpFiles();

  const sessionFilePath = createSession(sessionId);
  console.log(`Session: ${shortId} — logging to ${sessionFilePath}`);

  // Warn about Claude sessions already running before this wrapper started.
  // claudePid is unknown at this point (we haven't spawned yet), so no
  // self-exclusion is needed — anything we find belongs to another claude.
  const preExisting = detectParallelSessions(wrapperStartTime, null);
  if ( preExisting.length > 0 ) {
    const shortIds = preExisting.map(id => id.slice(0, 8)).join(', ');
    console.log(
      `Note: ${preExisting.length} other Claude session(s) already running ` +
      `(${shortIds}). Stats may overlap.`
    );
  }

  let state = STATE.INITIAL;
  let phaseStart = Date.now();
  let promptCount = 0;
  let typingStartTime = null;

  // Accumulated totals
  let totalIdleMs = 0;
  let totalTypingMs = 0;
  let totalAgentMs = 0;

  // Tracks idle_ms from the most recent IDLE→USER_TYPING transition.
  // If a background agent Stop fires during USER_TYPING, this amount
  // is retroactively moved from idle to agent time.
  let lastPendingIdleMs = 0;

  function getState() { return state; }
  function getPhaseStart() { return phaseStart; }

  function transitionTo(newState, timestamp) {
    state = newState;
    phaseStart = timestamp || Date.now();
  }

  // Spawn claude in a PTY
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const child = pty.spawn('claude', claudeArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_TIMING_SESSION: sessionId,
    },
  });

  // Pipe PTY output to stdout
  child.onData((data) => {
    process.stdout.write(data);
  });

  // Handle resize
  process.stdout.on('resize', () => {
    child.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  });

  // Start title bar
  startTitleBar(getState, getPhaseStart);

  // Watch for hook temp files (UserPromptSubmit start, Stop)
  let watcher = null;
  function handleStopHook() {
    if (!existsSync(tmpFile)) return;

    let stopTimestamp;
    try {
      const content = readFileSync(tmpFile, 'utf8').trim();
      // fs.watch fires on file creation before content is written;
      // retry shortly if the file is still empty.
      if (!content) {
        setTimeout(handleStopHook, 50);
        return;
      }
      stopTimestamp = parseInt(content, 10);
      if (isNaN(stopTimestamp)) {
        try { unlinkSync(tmpFile); } catch {}
        return;
      }
      unlinkSync(tmpFile);
    } catch {
      return;
    }

    if (state === STATE.AGENT_WORKING) {
      const agentMs = Math.max(0, stopTimestamp - phaseStart);
      totalAgentMs += agentMs;
      promptCount++;

      appendEntry(sessionFilePath, {
        event: 'agent_stop',
        prompt: promptCount,
        agent_work_ms: agentMs,
      });

      lastPendingIdleMs = 0;
      transitionTo(STATE.IDLE);
      playCompletionSound();
    } else if (state === STATE.IDLE) {
      // Stop fired without UserPromptSubmit → background agent completed.
      // The time since entering IDLE was spent waiting for the background
      // agent, so count it as agent work rather than idle.
      const backgroundMs = Math.max(0, stopTimestamp - phaseStart);
      totalAgentMs += backgroundMs;

      appendEntry(sessionFilePath, {
        event: 'background_agent_stop',
        agent_work_ms: backgroundMs,
      });

      lastPendingIdleMs = 0;
      transitionTo(STATE.IDLE, stopTimestamp);
      playCompletionSound();
    } else if (state === STATE.USER_TYPING) {
      // Background agent completed while user was typing.
      // The idle_ms logged at the IDLE→USER_TYPING transition was actually
      // time spent waiting for the background agent, not true idle time.
      // Retroactively correct the totals.
      const correctionMs = lastPendingIdleMs;
      if (correctionMs > 0) {
        totalIdleMs -= correctionMs;
        totalAgentMs += correctionMs;
        lastPendingIdleMs = 0;
      }

      appendEntry(sessionFilePath, {
        event: 'background_agent_stop',
        agent_work_ms: correctionMs,
        idle_correction_ms: correctionMs,
      });

      playCompletionSound();
      // Stay in USER_TYPING — user is still composing their prompt
    }
  }

  function handleStartHook() {
    if (!existsSync(startTmpFile)) return;

    let startTimestamp;
    try {
      const content = readFileSync(startTmpFile, 'utf8').trim();
      if (!content) {
        setTimeout(handleStartHook, 50);
        return;
      }
      startTimestamp = parseInt(content, 10);
      if (isNaN(startTimestamp)) {
        try { unlinkSync(startTmpFile); } catch {}
        return;
      }
      unlinkSync(startTmpFile);
    } catch {
      return;
    }

    // Steering: user submitted while agent was working
    if (state === STATE.AGENT_WORKING) {
      if (typingStartTime !== null) {
        const typingMs = Math.max(0, startTimestamp - typingStartTime);
        totalTypingMs += typingMs;
        typingStartTime = null;

        appendEntry(sessionFilePath, {
          event: 'steering_submit',
          typing_ms: typingMs,
        });
      }
      return;
    }

    // Normal prompt submission from INITIAL, USER_TYPING, or IDLE
    let typingMs = 0;
    if (typingStartTime !== null) {
      typingMs = Math.max(0, startTimestamp - typingStartTime);
      totalTypingMs += typingMs;
      typingStartTime = null;
    }

    if (state === STATE.IDLE) {
      const idleMs = Math.max(0, startTimestamp - phaseStart);
      totalIdleMs += idleMs;

      appendEntry(sessionFilePath, {
        event: 'typing_start',
        prompt: promptCount + 1,
        idle_ms: idleMs,
      });
    }

    appendEntry(sessionFilePath, {
      event: 'prompt_submit',
      prompt: promptCount + 1,
      typing_ms: typingMs,
    });

    lastPendingIdleMs = 0;
    transitionTo(STATE.AGENT_WORKING, startTimestamp);
  }

  // Use fs.watch on the temp directory for hook files
  try {
    watcher = watch(TMP_DIR, (_eventType, filename) => {
      if (filename === `claude_timing_start_${sessionId}`) {
        handleStartHook();
      } else if (filename === `claude_timing_${sessionId}`) {
        handleStopHook();
      }
    });
  } catch {
    // Fallback: poll every 500ms (start before stop to ensure correct ordering)
    setInterval(() => {
      handleStartHook();
      handleStopHook();
    }, 500);
  }

  // Enter raw mode and forward keystrokes
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  process.stdin.on('data', (data) => {
    // Forward everything to the PTY
    child.write(data);

    const buf = Buffer.from(data);

    // Check for Ctrl+C (0x03) — user interrupt
    if (buf.length === 1 && buf[0] === 0x03) {
      if (state === STATE.AGENT_WORKING) {
        const agentMs = Date.now() - phaseStart;
        totalAgentMs += agentMs;
        promptCount++;

        // Discard any in-progress steering typing
        typingStartTime = null;

        appendEntry(sessionFilePath, {
          event: 'agent_interrupt',
          prompt: promptCount,
          agent_work_ms: agentMs,
        });

        lastPendingIdleMs = 0;
        transitionTo(STATE.IDLE);
        playCompletionSound();
      } else if (state === STATE.USER_TYPING) {
        // User cancelled their input — discard partial typing
        typingStartTime = null;
        lastPendingIdleMs = 0;
        transitionTo(STATE.IDLE);
      }
      return;
    }

    // Check for typing keystroke
    if (isTypingKeystroke(data)) {
      if (state === STATE.INITIAL && typingStartTime === null) {
        typingStartTime = Date.now();
      } else if (state === STATE.IDLE) {
        const idleMs = Date.now() - phaseStart;
        totalIdleMs += idleMs;
        lastPendingIdleMs = idleMs;

        appendEntry(sessionFilePath, {
          event: 'typing_start',
          prompt: promptCount + 1,
          idle_ms: idleMs,
        });

        typingStartTime = Date.now();
        transitionTo(STATE.USER_TYPING);
      } else if (state === STATE.USER_TYPING && typingStartTime === null) {
        typingStartTime = Date.now();
      } else if (state === STATE.AGENT_WORKING && typingStartTime === null) {
        // User starts typing while agent is still working (steering).
        // Begin tracking typing time without interrupting the agent timer.
        typingStartTime = Date.now();
      }
    }
  });

  // Handle exit
  function cleanup(exitCode) {
    stopTitleBar();

    if (watcher) {
      try { watcher.close(); } catch {}
    }

    // If agent was still working, record partial time
    if (state === STATE.AGENT_WORKING) {
      const partialAgent = Date.now() - phaseStart;
      totalAgentMs += partialAgent;
    } else if (state === STATE.IDLE) {
      const partialIdle = Date.now() - phaseStart;
      totalIdleMs += partialIdle;
    } else if (state === STATE.USER_TYPING && typingStartTime) {
      const partialTyping = Date.now() - typingStartTime;
      totalTypingMs += partialTyping;
    }

    // Detect Claude sessions that overlapped with this wrapper's lifetime.
    const parallelIds = detectParallelSessions(wrapperStartTime, child.pid);

    const endData = {
      total_user_ms: totalIdleMs + totalTypingMs,
      total_idle_ms: totalIdleMs,
      total_typing_ms: totalTypingMs,
      total_agent_ms: totalAgentMs,
      prompts: promptCount,
      cwd: process.cwd(),
    };
    if ( parallelIds.length > 0 ) {
      endData.parallel_with = parallelIds;
    }

    endSession(sessionFilePath, endData);

    // Surface overlap to the user so they know stats from this window
    // were not from a single focused session.
    if ( parallelIds.length > 0 ) {
      const shortIds = parallelIds.map(id => id.slice(0, 8)).join(', ');
      process.stderr.write(
        `\nNote: this session overlapped with ${parallelIds.length} other ` +
        `Claude session(s) (${shortIds}).\n`
      );
    }

    // Clean up temp files
    try { unlinkSync(tmpFile); } catch {}
    try { unlinkSync(startTmpFile); } catch {}

    // Restore terminal
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }

    process.exit(exitCode ?? 0);
  }

  child.onExit(({ exitCode }) => {
    cleanup(exitCode);
  });

  process.on('SIGINT', () => {
    // Forward to child; PTY will handle it
  });

  process.on('SIGTERM', () => {
    child.kill();
  });
}
