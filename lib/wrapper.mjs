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
const STALL_TIMEOUT_MS = 120 * 60 * 1000; // 120 min with no PTY output = stall
const TYPING_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min with no keystrokes = stop typing
const STALL_RECHECK_INTERVAL_MS = 30 * 60 * 1000; // Re-check alive every 30 min
const MAX_STALL_RECHECKS = 4;

// Strip ANSI escape sequences so we can match plain text from PTY output.
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\[.*?[a-zA-Z]/g;
function stripAnsi(s) { return s.replace(ANSI_RE, ''); }

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

export function startWrapper(claudeArgs, opts = {}) {
  const capturePrompts = opts.capturePrompts === true;
  const sessionId = randomUUID();
  const shortId = sessionId.slice(0, 8);
  const tmpFile = join(TMP_DIR, `claude_timing_${sessionId}`);
  const startTmpFile = join(TMP_DIR, `claude_timing_start_${sessionId}`);
  const promptFile = join(TMP_DIR, `claude_timing_prompt_${sessionId}`);
  const wrapperStartTime = Date.now();

  cleanStaleTmpFiles();

  const sessionFilePath = createSession(sessionId);
  console.log(`Session: ${shortId} — logging to ${sessionFilePath}`);
  if (capturePrompts) {
    console.log('⚠  Prompt capture is ON — your full prompt text is saved to the timing log.');
    console.log('   Disable anytime with: claude-timed --disable-prompt-capture');
  }

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

  // Stall detection: if no PTY output or hook activity for STALL_TIMEOUT_MS,
  // the agent is assumed stalled (e.g. budget limit). Work is counted only
  // up to the last observed activity.
  let lastActivityTime = Date.now();
  let stallTimer = null;
  let typingIdleTimer = null;
  let idleStallTimer = null;
  let stallRecheckCount = 0;

  function getState() { return state; }
  function getPhaseStart() { return phaseStart; }

  function markActivity() {
    lastActivityTime = Date.now();
  }

  function clearStallTimer() {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  }

  function armStallTimer() {
    if (!stallTimer) {
      stallTimer = setTimeout(handleStall, STALL_TIMEOUT_MS);
    }
  }

  function clearTypingIdleTimer() {
    if (typingIdleTimer) {
      clearTimeout(typingIdleTimer);
      typingIdleTimer = null;
    }
  }

  function armTypingIdleTimer() {
    clearTypingIdleTimer();
    typingIdleTimer = setTimeout(handleTypingIdle, TYPING_IDLE_TIMEOUT_MS);
  }

  function clearIdleStallTimer() {
    if (idleStallTimer) {
      clearTimeout(idleStallTimer);
      idleStallTimer = null;
    }
  }

  function armIdleStallTimer() {
    clearIdleStallTimer();
    idleStallTimer = setTimeout(handleIdleStall, STALL_TIMEOUT_MS);
  }

  function handleIdleStall() {
    idleStallTimer = null;
    if (state !== STATE.IDLE) return;

    // Flush idle time up to lastActivityTime, not now
    const idleMs = Math.max(0, lastActivityTime - phaseStart);
    totalIdleMs += idleMs;

    appendEntry(sessionFilePath, {
      event: 'session_paused',
      idle_before_pause_ms: idleMs,
    });

    transitionTo(STATE.PAUSED);
  }

  function handleTypingIdle() {
    typingIdleTimer = null;

    // AGENT_WORKING + steering: discard partial typing, don't change state
    if (state === STATE.AGENT_WORKING) {
      if (typingStartTime !== null) {
        typingStartTime = null;
      }
      return;
    }

    if (state !== STATE.USER_TYPING && state !== STATE.INITIAL) return;

    // Flush typing time capped at last keystroke, not now
    let typingMs = 0;
    if (typingStartTime !== null) {
      typingMs = Math.max(0, lastActivityTime - typingStartTime);
      totalTypingMs += typingMs;
      typingStartTime = null;
    }
    lastPendingIdleMs = 0;

    appendEntry(sessionFilePath, {
      event: 'typing_idle',
      typing_ms: typingMs,
    });

    transitionTo(STATE.IDLE);
  }

  function handleStall() {
    stallTimer = null;
    const now = Date.now();
    const timeSinceActivity = now - lastActivityTime;

    // If activity happened recently, the timer was stale — re-arm
    if (timeSinceActivity < STALL_TIMEOUT_MS) {
      stallTimer = setTimeout(handleStall, STALL_TIMEOUT_MS - timeSinceActivity);
      return;
    }

    if (state === STATE.AGENT_WORKING) {
      // Check if child process is still alive before declaring stall
      if (isPidAlive(child.pid) && stallRecheckCount < MAX_STALL_RECHECKS) {
        stallRecheckCount++;
        appendEntry(sessionFilePath, {
          event: 'agent_silence_check',
          silent_elapsed_ms: now - phaseStart,
        });
        stallTimer = setTimeout(handleStall, STALL_RECHECK_INTERVAL_MS);
        return;
      }

      // Process dead or max rechecks hit — true stall
      const agentMs = Math.max(0, lastActivityTime - phaseStart);

      totalAgentMs += agentMs;
      typingStartTime = null;
      lastPendingIdleMs = 0;

      appendEntry(sessionFilePath, {
        event: 'agent_stall',
        prompt: promptCount + 1,
        agent_work_ms: agentMs,
        stall_elapsed_ms: now - phaseStart,
      });

      transitionTo(STATE.PAUSED);
    } else if (state === STATE.USER_TYPING) {
      let typingMs = 0;
      if (typingStartTime !== null) {
        typingMs = Math.max(0, lastActivityTime - typingStartTime);
        totalTypingMs += typingMs;
        typingStartTime = null;
      }
      lastPendingIdleMs = 0;

      appendEntry(sessionFilePath, {
        event: 'typing_stall',
        typing_ms: typingMs,
        stall_elapsed_ms: now - phaseStart,
      });

      transitionTo(STATE.IDLE);
    }
  }

  function transitionTo(newState, timestamp) {
    state = newState;
    phaseStart = timestamp || Date.now();

    if (newState === STATE.AGENT_WORKING || newState === STATE.USER_TYPING) {
      markActivity();
      armStallTimer();
      clearIdleStallTimer();
      if (newState === STATE.AGENT_WORKING) stallRecheckCount = 0;
    } else if (newState === STATE.IDLE) {
      clearStallTimer();
      clearTypingIdleTimer();
      armIdleStallTimer();
    } else if (newState === STATE.PAUSED) {
      clearStallTimer();
      clearTypingIdleTimer();
      clearIdleStallTimer();
    } else {
      clearStallTimer();
      clearTypingIdleTimer();
      clearIdleStallTimer();
    }
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
      ...(capturePrompts ? { CLAUDE_TIMING_CAPTURE: '1' } : {}),
    },
  });

  // Detect extra usage / rate limit from Claude Code PTY output.
  // Uses a rolling buffer of stripped text so patterns split across
  // chunks or polluted with ANSI codes are still matched.
  const RATE_LIMIT_PATTERNS = [
    /out of extra usage/i,
    /\/rate-limit-options/,
  ];
  const outputBuffer = { text: '', maxLen: 600 };
  let rateLimitDetected = false;

  function checkRateLimit(data) {
    if (rateLimitDetected) return;
    const plain = stripAnsi(data);
    outputBuffer.text = (outputBuffer.text + plain).slice(-outputBuffer.maxLen);
    if (!RATE_LIMIT_PATTERNS.some(p => p.test(outputBuffer.text))) return;
    rateLimitDetected = true;

    if (state === STATE.AGENT_WORKING) {
      const agentMs = Math.max(0, lastActivityTime - phaseStart);
      totalAgentMs += agentMs;
      promptCount++;

      appendEntry(sessionFilePath, {
        event: 'extra_usage_limit',
        prompt: promptCount,
        agent_work_ms: agentMs,
      });

      lastPendingIdleMs = 0;
      transitionTo(STATE.IDLE);
      playCompletionSound();
    }
  }

  // Pipe PTY output to stdout
  child.onData((data) => {
    process.stdout.write(data);
    markActivity();
    checkRateLimit(data);
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

    if (state === STATE.PAUSED) {
      // Background agent completing after pause — resume to IDLE
      appendEntry(sessionFilePath, { event: 'session_resumed' });
      transitionTo(STATE.IDLE);
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

  // Read the opt-in captured prompt payload (raw UserPromptSubmit JSON) written
  // by the start hook. Always consume (unlink) it so a stale file can't attach to
  // a later prompt. Returns { text, session } or null.
  function readCapturedPrompt() {
    if (!capturePrompts) return null;
    try {
      if (!existsSync(promptFile)) return null;
      const raw = readFileSync(promptFile, 'utf8');
      try { unlinkSync(promptFile); } catch {}
      if (!raw.trim()) return null;
      const payload = JSON.parse(raw);
      return {
        text: typeof payload.prompt === 'string' ? payload.prompt : null,
        session: payload.session_id || payload.sessionId || null,
      };
    } catch {
      return null;
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

    const captured = readCapturedPrompt();

    // Resume from PAUSED — session_resumed, then fall through to normal handling
    if (state === STATE.PAUSED) {
      appendEntry(sessionFilePath, { event: 'session_resumed' });
    }

    // Steering: user submitted while agent was working
    if (state === STATE.AGENT_WORKING) {
      if (typingStartTime !== null) {
        const typingMs = Math.max(0, startTimestamp - typingStartTime);
        totalTypingMs += typingMs;
        typingStartTime = null;
        clearTypingIdleTimer();

        appendEntry(sessionFilePath, {
          event: 'steering_submit',
          typing_ms: typingMs,
          ...(captured && captured.text ? { prompt_text: captured.text } : {}),
          ...(captured && captured.session ? { claude_session: captured.session } : {}),
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
      clearTypingIdleTimer();
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
      ...(captured && captured.text ? { prompt_text: captured.text } : {}),
      ...(captured && captured.session ? { claude_session: captured.session } : {}),
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

    // Resume from PAUSED on any keystroke — don't record gap as idle
    if (state === STATE.PAUSED) {
      if (isTypingKeystroke(data)) {
        typingStartTime = Date.now();
        appendEntry(sessionFilePath, { event: 'session_resumed' });
        transitionTo(STATE.USER_TYPING);
        armTypingIdleTimer();
      }
      return;
    }

    // Check for Ctrl+C (0x03) — user interrupt
    if (buf.length === 1 && buf[0] === 0x03) {
      if (state === STATE.AGENT_WORKING) {
        const agentMs = Date.now() - phaseStart;
        totalAgentMs += agentMs;
        promptCount++;

        // Discard any in-progress steering typing
        typingStartTime = null;
        clearTypingIdleTimer();

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
        clearTypingIdleTimer();
        lastPendingIdleMs = 0;
        transitionTo(STATE.IDLE);
      }
      return;
    }

    // Check for typing keystroke
    if (isTypingKeystroke(data)) {
      if (state === STATE.INITIAL && typingStartTime === null) {
        typingStartTime = Date.now();
        armTypingIdleTimer();
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
        armTypingIdleTimer();
      } else if (state === STATE.USER_TYPING && typingStartTime === null) {
        typingStartTime = Date.now();
        armTypingIdleTimer();
      } else if (state === STATE.AGENT_WORKING && typingStartTime === null) {
        // User starts typing while agent is still working (steering).
        // Begin tracking typing time without interrupting the agent timer.
        typingStartTime = Date.now();
        armTypingIdleTimer();
      } else if (state === STATE.USER_TYPING) {
        // Still typing — reset idle timer on every keystroke
        armTypingIdleTimer();
      }
    }
  });

  // Handle exit
  function cleanup(exitCode) {
    clearStallTimer();
    clearTypingIdleTimer();
    clearIdleStallTimer();
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
    try { unlinkSync(promptFile); } catch {}

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
