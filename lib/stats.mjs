import { listSessionFiles, readSessionSummary, getCurrentSessionPath } from './timing-log.mjs';
import { basename } from 'path';

function formatMs(ms) {
  if (ms == null || ms === 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function padRight(str, len) {
  return str.padEnd(len);
}

function bar(fraction, width = 20) {
  const filled = Math.round(fraction * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

function parseDateArg(arg) {
  // Returns YYYY-MM-DD string
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  return null;
}

function getDateRange(args) {
  if (args.length === 0) {
    // Current/most recent session
    return { mode: 'current' };
  }

  const arg = args[0];

  if (arg === 'all') {
    return { mode: 'range', start: null, end: null, label: 'All time' };
  }

  if (arg === 'today') {
    const today = new Date().toISOString().slice(0, 10);
    return { mode: 'range', start: today, end: today, label: `Today (${today})` };
  }

  if (arg === 'week') {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const start = weekAgo.toISOString().slice(0, 10);
    const end = now.toISOString().slice(0, 10);
    return { mode: 'range', start, end, label: `Last 7 days (${start} to ${end})` };
  }

  if (arg === 'month') {
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const start = monthAgo.toISOString().slice(0, 10);
    const end = now.toISOString().slice(0, 10);
    return { mode: 'range', start, end, label: `Last 30 days (${start} to ${end})` };
  }

  const startDate = parseDateArg(arg);
  if (startDate) {
    if (args.length >= 2) {
      const endDate = parseDateArg(args[1]);
      if (endDate) {
        return { mode: 'range', start: startDate, end: endDate, label: `${startDate} to ${endDate}` };
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    return { mode: 'range', start: startDate, end: today, label: `${startDate} to ${today}` };
  }

  console.error(`Unknown stats argument: ${arg}`);
  console.error('Usage: claude-timed --stats [today|week|month|all|YYYY-MM-DD [YYYY-MM-DD]]');
  process.exit(1);
}

export function showStats(args) {
  const range = getDateRange(args);

  if (range.mode === 'current') {
    // Try the current/last session first
    const currentPath = getCurrentSessionPath();
    if (currentPath) {
      const summary = readSessionSummary(currentPath);
      if (summary && summary.prompts > 0) {
        console.log('=== Claude Code Timing Stats ===');
        console.log(`Session: ${basename(currentPath)}`);
        if (summary.incomplete) console.log('(Session still in progress or ended abruptly)');
        console.log();
        printSummary([summary]);
        return;
      }
    }

    // Fall back to the most recent session that has data
    const files = listSessionFiles(null, null);
    for (let i = files.length - 1; i >= 0; i--) {
      const summary = readSessionSummary(files[i]);
      if (summary && summary.prompts > 0) {
        console.log('=== Claude Code Timing Stats ===');
        console.log(`Session: ${files[i]}`);
        if (summary.incomplete) console.log('(Session still in progress or ended abruptly)');
        console.log();
        printSummary([summary]);
        return;
      }
    }

    console.log('No session data found.');
    return;
  }

  const files = listSessionFiles(range.start, range.end);

  if (files.length === 0) {
    console.log(`No sessions found for: ${range.label}`);
    return;
  }

  const summaries = files
    .map(f => readSessionSummary(f))
    .filter(Boolean);

  if (summaries.length === 0) {
    console.log(`No valid session data for: ${range.label}`);
    return;
  }

  console.log('=== Claude Code Timing Stats ===');
  console.log(`Period: ${range.label}`);
  console.log(`Sessions: ${summaries.length} | Prompts: ${summaries.reduce((a, s) => a + (s.prompts || 0), 0)}`);
  console.log();

  printSummary(summaries);
}

function printSummary(summaries) {
  let totalIdleMs = 0;
  let totalTypingMs = 0;
  let totalAgentMs = 0;
  let totalPrompts = 0;

  for (const s of summaries) {
    totalIdleMs += s.total_idle_ms || 0;
    totalTypingMs += s.total_typing_ms || 0;
    totalAgentMs += s.total_agent_ms || 0;
    totalPrompts += s.prompts || 0;
  }

  const totalUserMs = totalIdleMs + totalTypingMs;
  const totalMs = totalUserMs + totalAgentMs;

  const avgPrompt = totalPrompts > 0 ? totalPrompts : 1;

  console.log('             Total        Average/prompt');
  console.log(`  User:      ${padRight(formatMs(totalUserMs), 13)}${formatMs(totalUserMs / avgPrompt)}`);
  console.log(`    Idle:    ${padRight(formatMs(totalIdleMs), 13)}${formatMs(totalIdleMs / avgPrompt)}`);
  console.log(`    Typing:  ${padRight(formatMs(totalTypingMs), 13)}${formatMs(totalTypingMs / avgPrompt)}`);
  console.log(`  Agent:     ${padRight(formatMs(totalAgentMs), 13)}${formatMs(totalAgentMs / avgPrompt)}`);

  if (totalMs > 0) {
    const userFrac = totalUserMs / totalMs;
    const agentFrac = totalAgentMs / totalMs;

    console.log();
    console.log('Time distribution:');
    console.log(`  User:  ${(userFrac * 100).toFixed(1)}%  ${bar(userFrac)}`);
    console.log(`  Agent: ${(agentFrac * 100).toFixed(1)}%  ${bar(agentFrac)}`);
  }
}
