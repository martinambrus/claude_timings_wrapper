import * as pty from 'node-pty';
import { watch, existsSync, readFileSync, unlinkSync, readdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { STATE } from './constants.mjs';
import { createSession, appendEntry, endSession } from './timing-log.mjs';
import { startTitleBar, stopTitleBar } from './title-bar.mjs';

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
    const tmpFiles = readdirSync('/tmp').filter(f => f.startsWith('claude_timing_'));
    for (const f of tmpFiles) {
      try { unlinkSync(`/tmp/${f}`); } catch {}
    }
  } catch {}
}

export function startWrapper(claudeArgs) {
  const sessionId = randomUUID();
  const shortId = sessionId.slice(0, 8);
  const tmpFile = `/tmp/claude_timing_${sessionId}`;

  cleanStaleTmpFiles();

  const sessionFilePath = createSession(sessionId);
  console.log(`Session: ${shortId} — logging to ${sessionFilePath}`);

  let state = STATE.INITIAL;
  let phaseStart = Date.now();
  let promptCount = 0;
  let typingStartTime = null;

  // Accumulated totals
  let totalIdleMs = 0;
  let totalTypingMs = 0;
  let totalAgentMs = 0;

  function getState() { return state; }
  function getPhaseStart() { return phaseStart; }

  function transitionTo(newState) {
    state = newState;
    phaseStart = Date.now();
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

  // Watch for Stop hook temp file
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

      transitionTo(STATE.IDLE);
    }
  }

  // Use fs.watch on /tmp directory for the file
  try {
    watcher = watch('/tmp', (eventType, filename) => {
      if (filename === `claude_timing_${sessionId}`) {
        handleStopHook();
      }
    });
  } catch {
    // Fallback: poll every 500ms
    setInterval(handleStopHook, 500);
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

    // Check for bare Enter (submit)
    if (buf.length === 1 && buf[0] === 0x0d) {
      if ((state === STATE.INITIAL || state === STATE.USER_TYPING) && typingStartTime !== null) {
        const typingMs = Date.now() - typingStartTime;
        totalTypingMs += typingMs;

        appendEntry(sessionFilePath, {
          event: 'prompt_submit',
          prompt: promptCount + 1,
          typing_ms: typingMs,
          idle_ms: (state === STATE.INITIAL && promptCount === 0) ? null : undefined,
        });

        typingStartTime = null;
        transitionTo(STATE.AGENT_WORKING);
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

        appendEntry(sessionFilePath, {
          event: 'typing_start',
          prompt: promptCount + 1,
          idle_ms: idleMs,
        });

        typingStartTime = Date.now();
        transitionTo(STATE.USER_TYPING);
      } else if (state === STATE.USER_TYPING && typingStartTime === null) {
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

    endSession(sessionFilePath, {
      total_user_ms: totalIdleMs + totalTypingMs,
      total_idle_ms: totalIdleMs,
      total_typing_ms: totalTypingMs,
      total_agent_ms: totalAgentMs,
      prompts: promptCount,
    });

    // Clean up temp file
    try { unlinkSync(tmpFile); } catch {}

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
