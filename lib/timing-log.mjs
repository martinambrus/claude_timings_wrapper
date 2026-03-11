import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { TIMINGS_DIR, CURRENT_SESSION_FILE } from './constants.mjs';

export function ensureTimingsDir() {
  mkdirSync(TIMINGS_DIR, { recursive: true });
}

export function sessionFilename(sessionId) {
  const now = new Date();
  const datePart = now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
  const shortId = sessionId.slice(0, 8);
  return `${datePart}_${shortId}.jsonl`;
}

export function createSession(sessionId) {
  ensureTimingsDir();
  const filename = sessionFilename(sessionId);
  const filePath = join(TIMINGS_DIR, filename);
  const entry = {
    ts: new Date().toISOString(),
    event: 'session_start',
    session: sessionId,
    cwd: process.cwd(),
  };
  writeFileSync(filePath, JSON.stringify(entry) + '\n');
  writeFileSync(CURRENT_SESSION_FILE, filePath);
  return filePath;
}

export function appendEntry(filePath, entry) {
  entry.ts = new Date().toISOString();
  appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

export function endSession(filePath, totals) {
  appendEntry(filePath, {
    event: 'session_end',
    ...totals,
  });
}

export function listSessionFiles(startDate, endDate) {
  ensureTimingsDir();
  const files = readdirSync(TIMINGS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .sort();

  if (!startDate && !endDate) return files;

  return files.filter(f => {
    // Extract date from filename: 2026-03-11T10-30-00_a1b2c3.jsonl
    const dateStr = f.slice(0, 10); // YYYY-MM-DD
    if (startDate && dateStr < startDate) return false;
    if (endDate && dateStr > endDate) return false;
    return true;
  });
}

export function readSessionSummary(filePath) {
  const fullPath = filePath.startsWith('/') ? filePath : join(TIMINGS_DIR, filePath);
  if (!existsSync(fullPath)) return null;
  const content = readFileSync(fullPath, 'utf8').trim();
  const lines = content.split('\n');

  // Extract cwd from session_start (first line)
  let cwd = null;
  try {
    const start = JSON.parse(lines[0]);
    if (start.event === 'session_start') cwd = start.cwd || null;
  } catch {}

  // Try to find session_end entry (last line)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.event === 'session_end') {
        if (!entry.cwd) entry.cwd = cwd;
        return entry;
      }
    } catch {}
  }
  // No session_end — recompute from events
  const summary = recomputeSummary(lines);
  summary.cwd = cwd;
  return summary;
}

function recomputeSummary(lines) {
  let totalUserMs = 0;
  let totalIdleMs = 0;
  let totalTypingMs = 0;
  let totalAgentMs = 0;
  let prompts = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.event === 'prompt_submit') {
        prompts++;
        if (entry.typing_ms) totalTypingMs += entry.typing_ms;
      }
      if (entry.event === 'steering_submit') {
        if (entry.typing_ms) totalTypingMs += entry.typing_ms;
      }
      if (entry.event === 'typing_start' && entry.idle_ms) {
        totalIdleMs += entry.idle_ms;
      }
      if ((entry.event === 'agent_stop' || entry.event === 'agent_interrupt') && entry.agent_work_ms) {
        totalAgentMs += entry.agent_work_ms;
      }
    } catch {}
  }
  totalUserMs = totalIdleMs + totalTypingMs;
  return {
    event: 'session_end',
    total_user_ms: totalUserMs,
    total_idle_ms: totalIdleMs,
    total_typing_ms: totalTypingMs,
    total_agent_ms: totalAgentMs,
    prompts,
    incomplete: true,
  };
}

export function readSessionEntries(filePath) {
  const fullPath = filePath.startsWith('/') ? filePath : join(TIMINGS_DIR, filePath);
  if (!existsSync(fullPath)) return [];
  const content = readFileSync(fullPath, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export function getCurrentSessionPath() {
  if (!existsSync(CURRENT_SESSION_FILE)) return null;
  const path = readFileSync(CURRENT_SESSION_FILE, 'utf8').trim();
  if (!existsSync(path)) return null;
  return path;
}
