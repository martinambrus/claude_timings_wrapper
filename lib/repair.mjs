import { copyFileSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { TIMINGS_DIR } from './constants.mjs';

const DEFAULT_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2h
const CAP_TYPING_MS = 5 * 60 * 1000; // 5 min cap for oversized typing
const RESUME_IDLE_MS = 10 * 1000; // 10s idle assigned to typing_start after pause/resume

function formatMs(ms) {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function recomputeSummary(entries) {
  let totalIdleMs = 0;
  let totalTypingMs = 0;
  let totalAgentMs = 0;
  let prompts = 0;
  let cwd = null;
  let parallel_with = null;

  for (const entry of entries) {
    if (entry.event === 'session_start') {
      cwd = entry.cwd || null;
    }
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
    if ((entry.event === 'agent_stop' || entry.event === 'agent_interrupt' || entry.event === 'agent_stall') && entry.agent_work_ms) {
      totalAgentMs += entry.agent_work_ms;
    }
    if (entry.event === 'extra_usage_limit' && entry.agent_work_ms) {
      totalAgentMs += entry.agent_work_ms;
      prompts++;
    }
    if (entry.event === 'typing_stall' && entry.typing_ms) {
      totalTypingMs += entry.typing_ms;
    }
    if (entry.event === 'typing_idle' && entry.typing_ms) {
      totalTypingMs += entry.typing_ms;
    }
    if (entry.event === 'background_agent_stop') {
      if (entry.agent_work_ms) totalAgentMs += entry.agent_work_ms;
      if (entry.idle_correction_ms) totalIdleMs -= entry.idle_correction_ms;
    }
    if (entry.event === 'session_paused' && entry.idle_before_pause_ms) {
      totalIdleMs += entry.idle_before_pause_ms;
    }
    if (entry.event === 'session_end') {
      if (entry.parallel_with) parallel_with = entry.parallel_with;
    }
  }

  const result = {
    event: 'session_end',
    total_user_ms: totalIdleMs + totalTypingMs,
    total_idle_ms: totalIdleMs,
    total_typing_ms: totalTypingMs,
    total_agent_ms: totalAgentMs,
    prompts,
  };
  if (cwd) result.cwd = cwd;
  if (parallel_with) result.parallel_with = parallel_with;
  return result;
}

function repairEntries(entries, thresholdMs) {
  const repaired = [];
  let changed = false;
  const fixes = [];

  for (const entry of entries) {
    if (entry.event === 'session_end') {
      // Skip old session_end — will be recomputed
      continue;
    }

    if (entry.event === 'typing_start' && entry.idle_ms && entry.idle_ms > thresholdMs) {
      const eventMs = new Date(entry.ts).getTime();
      // Insert synthetic session_paused 5 min after previous activity
      const pauseTs = new Date(eventMs - entry.idle_ms + (5 * 60 * 1000)).toISOString();
      repaired.push({ event: 'session_paused', idle_before_pause_ms: 0, ts: pauseTs });

      // Insert synthetic session_resumed 5 min before user returned
      const resumeTs = new Date(eventMs - (5 * 60 * 1000)).toISOString();
      repaired.push({ event: 'session_resumed', ts: resumeTs });

      // Cap idle_ms to small reasonable value
      fixes.push(`typing_start.idle_ms: ${formatMs(entry.idle_ms)} → ${formatMs(RESUME_IDLE_MS)}`);
      entry.idle_ms = RESUME_IDLE_MS;
      changed = true;
    }

    if ((entry.event === 'prompt_submit' || entry.event === 'steering_submit') && entry.typing_ms && entry.typing_ms > thresholdMs) {
      fixes.push(`${entry.event}.typing_ms: ${formatMs(entry.typing_ms)} → ${formatMs(CAP_TYPING_MS)}`);
      entry.typing_ms = CAP_TYPING_MS;
      changed = true;
    }

    if (entry.event === 'typing_stall' && entry.typing_ms && entry.typing_ms > thresholdMs) {
      fixes.push(`typing_stall.typing_ms: ${formatMs(entry.typing_ms)} → ${formatMs(CAP_TYPING_MS)}`);
      entry.typing_ms = CAP_TYPING_MS;
      changed = true;
    }

    repaired.push(entry);
  }

  return { repaired, changed, fixes };
}

export function repairSessions(options = {}) {
  const thresholdMs = options.thresholdMs || DEFAULT_THRESHOLD_MS;
  const dryRun = options.dryRun || false;

  const files = readdirSync(TIMINGS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .sort();

  let totalScanned = 0;
  let totalRepaired = 0;
  const details = [];

  for (const file of files) {
    const filePath = join(TIMINGS_DIR, file);
    totalScanned++;

    const content = readFileSync(filePath, 'utf8').trim();
    if (!content) continue;

    const entries = content.split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    if (entries.length === 0) continue;

    const { repaired, changed, fixes } = repairEntries(entries, thresholdMs);
    if (!changed) continue;

    totalRepaired++;
    details.push({ file, fixes });

    if (dryRun) {
      console.log(`[DRY RUN] ${file}:`);
      for (const fix of fixes) {
        console.log(`  ${fix}`);
      }
      continue;
    }

    // Back up original
    const backupPath = filePath + '.bak';
    if (!existsSync(backupPath)) {
      copyFileSync(filePath, backupPath);
    }

    // Recompute session_end
    const endEntry = recomputeSummary(repaired);
    endEntry.ts = repaired[repaired.length - 1].ts || new Date().toISOString();
    repaired.push(endEntry);

    // Write repaired file
    const lines = repaired.map(e => JSON.stringify(e));
    writeFileSync(filePath, lines.join('\n') + '\n');

    console.log(`${file}: ${fixes.length} fix(es)`);
    for (const fix of fixes) {
      console.log(`  ${fix}`);
    }
  }

  console.log();
  console.log(`Scanned: ${totalScanned}, Repaired: ${totalRepaired}`);
  if (dryRun) {
    console.log('(dry run — no files modified)');
  } else if (totalRepaired > 0) {
    console.log(`Backups saved as .bak files in ${TIMINGS_DIR}`);
  }
}
