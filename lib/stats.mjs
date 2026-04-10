import { listSessionFiles, readSessionSummary, readSessionEntries, getCurrentSessionPath } from './timing-log.mjs';
import { basename } from 'path';

/**
 * Parse a human-friendly duration string into milliseconds.
 * Supports: 1d2h30m, 2h, 45m, 1h30m, 90m, 1d, etc.
 * Returns null if the string is not a valid duration.
 */
function parseDuration(str) {
  if (!str || typeof str !== 'string') return null;
  const pattern = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/;
  const match = str.match(pattern);
  if (!match) return null;
  const [, days, hours, minutes] = match;
  if (!days && !hours && !minutes) return null;
  const ms = ((parseInt(days || '0', 10) * 24 * 60)
    + (parseInt(hours || '0', 10) * 60)
    + parseInt(minutes || '0', 10)) * 60 * 1000;
  return ms > 0 ? ms : null;
}

/**
 * Recompute a session summary from raw events, capping any single
 * idle_ms or typing_ms value that exceeds the noop threshold.
 */
function recomputeWithNoopFilter(entries, thresholdMs) {
  let totalIdleMs = 0;
  let totalTypingMs = 0;
  let totalAgentMs = 0;
  let prompts = 0;
  let noopIdleMs = 0;
  let noopTypingMs = 0;
  let cwd = null;
  let parallel_with = null;
  let incomplete = false;

  // Track whether the most recent idle period was excluded as noop.
  // If so, background_agent_stop corrections should target noopIdleMs
  // instead of totalIdleMs.
  let lastIdleWasNoop = false;

  for (const entry of entries) {
    if (entry.event === 'session_start') {
      cwd = entry.cwd || null;
    }

    if (entry.event === 'prompt_submit') {
      prompts++;
      if (entry.typing_ms) {
        if (entry.typing_ms > thresholdMs) {
          noopTypingMs += entry.typing_ms;
        } else {
          totalTypingMs += entry.typing_ms;
        }
      }
    }

    if (entry.event === 'steering_submit') {
      if (entry.typing_ms) {
        if (entry.typing_ms > thresholdMs) {
          noopTypingMs += entry.typing_ms;
        } else {
          totalTypingMs += entry.typing_ms;
        }
      }
    }

    if (entry.event === 'typing_start' && entry.idle_ms) {
      if (entry.idle_ms > thresholdMs) {
        noopIdleMs += entry.idle_ms;
        lastIdleWasNoop = true;
      } else {
        totalIdleMs += entry.idle_ms;
        lastIdleWasNoop = false;
      }
    }

    if ((entry.event === 'agent_stop' || entry.event === 'agent_interrupt') && entry.agent_work_ms) {
      totalAgentMs += entry.agent_work_ms;
    }

    if (entry.event === 'background_agent_stop') {
      if (entry.agent_work_ms) totalAgentMs += entry.agent_work_ms;
      if (entry.idle_correction_ms) {
        if (lastIdleWasNoop) {
          noopIdleMs -= entry.idle_correction_ms;
        } else {
          totalIdleMs -= entry.idle_correction_ms;
        }
      }
    }

    if (entry.event === 'session_end') {
      // Use session_end's stored idle/typing but subtract any noop gaps
      // we detected from events. Also capture parallel_with from session_end.
      if (entry.parallel_with) parallel_with = entry.parallel_with;

      // For sessions that completed normally, session_end includes final
      // partial phase time that isn't in individual events. Compute the
      // delta and add it (applying the threshold to the final idle chunk).
      const storedIdle = entry.total_idle_ms || 0;
      const storedTyping = entry.total_typing_ms || 0;
      const storedAgent = entry.total_agent_ms || 0;

      // The event-level sums above don't include the final partial phase
      // that cleanup() adds at session end. Derive it from the stored totals.
      const eventIdleSum = totalIdleMs + noopIdleMs;
      const eventTypingSum = totalTypingMs + noopTypingMs;

      const residualIdle = Math.max(0, storedIdle - eventIdleSum);
      const residualTyping = Math.max(0, storedTyping - eventTypingSum);
      const residualAgent = Math.max(0, storedAgent - totalAgentMs);

      if (residualIdle > thresholdMs) {
        noopIdleMs += residualIdle;
      } else {
        totalIdleMs += residualIdle;
      }

      if (residualTyping > thresholdMs) {
        noopTypingMs += residualTyping;
      } else {
        totalTypingMs += residualTyping;
      }

      totalAgentMs += residualAgent;
    }
  }

  // Check if session_end was found
  const hasEnd = entries.some(e => e.event === 'session_end');
  if (!hasEnd) incomplete = true;

  const result = {
    event: 'session_end',
    total_user_ms: totalIdleMs + totalTypingMs,
    total_idle_ms: totalIdleMs,
    total_typing_ms: totalTypingMs,
    total_agent_ms: totalAgentMs,
    prompts,
    cwd,
    noop_idle_ms: noopIdleMs,
    noop_typing_ms: noopTypingMs,
  };
  if (parallel_with) result.parallel_with = parallel_with;
  if (incomplete) result.incomplete = true;
  return result;
}

function projectName(cwd) {
  if (!cwd) return 'unknown';
  return basename(cwd);
}

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

function printParallelLine(summary) {
  if ( !summary || !Array.isArray(summary.parallel_with) || summary.parallel_with.length === 0 ) return;
  const ids = summary.parallel_with;
  const shortIds = ids.slice(0, 3).map(id => id.slice(0, 8)).join(', ');
  const more = ids.length > 3 ? `, +${ids.length - 3} more` : '';
  console.log(`Parallel: ran alongside ${ids.length} other Claude session(s) (${shortIds}${more})`);
}

function bar(fraction, width = 20) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
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
  console.error('Usage: claude-timed --stats [today|week|month|all|YYYY-MM-DD [YYYY-MM-DD]] [--project NAME]');
  process.exit(1);
}

function matchesProject(cwd, filter) {
  if (!filter) return true;
  const name = projectName(cwd);
  return name.toLowerCase() === filter.toLowerCase();
}

function extractFlags(args) {
  let projectFilter = null;
  let noNoop = false;
  let noopThresholdMs = null;
  const remaining = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && i + 1 < args.length) {
      projectFilter = args[i + 1];
      i++;
    } else if (args[i] === '--no-noop') {
      noNoop = true;
    } else if (args[i] === '--noop-threshold' && i + 1 < args.length) {
      const parsed = parseDuration(args[i + 1]);
      if (parsed) {
        noNoop = true;
        noopThresholdMs = parsed;
      } else {
        console.error(`Invalid duration: ${args[i + 1]}`);
        console.error('Expected format: 1h30m, 2h, 45m, 1d, etc.');
        process.exit(1);
      }
      i++;
    } else {
      remaining.push(args[i]);
    }
  }
  const DEFAULT_NOOP_THRESHOLD_MS = 90 * 60 * 1000; // 1h30m
  if (noNoop && !noopThresholdMs) {
    noopThresholdMs = DEFAULT_NOOP_THRESHOLD_MS;
  }
  return { projectFilter, noNoop, noopThresholdMs, remaining };
}

function getSummary(filePath, noopThresholdMs) {
  if (noopThresholdMs) {
    const entries = readSessionEntries(filePath);
    if (entries.length === 0) return null;
    return recomputeWithNoopFilter(entries, noopThresholdMs);
  }
  return readSessionSummary(filePath);
}

function formatThreshold(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${hr}h${min}m` : `${hr}h`;
}

function printNoopSummary(summaries) {
  let totalNoopIdleMs = 0;
  let totalNoopTypingMs = 0;
  for (const s of summaries) {
    totalNoopIdleMs += s.noop_idle_ms || 0;
    totalNoopTypingMs += s.noop_typing_ms || 0;
  }
  const totalNoopMs = totalNoopIdleMs + totalNoopTypingMs;
  if (totalNoopMs > 0) {
    const parts = [];
    if (totalNoopIdleMs > 0) parts.push(`${formatMs(totalNoopIdleMs)} idle`);
    if (totalNoopTypingMs > 0) parts.push(`${formatMs(totalNoopTypingMs)} typing`);
    console.log(`  Excluded noop pauses: ${formatMs(totalNoopMs)} (${parts.join(', ')})`);
  }
}

export function showStats(args) {
  const { projectFilter, noNoop, noopThresholdMs, remaining } = extractFlags(args);
  // When filtering by project with no date range, default to all-time
  const range = getDateRange((projectFilter && remaining.length === 0) ? ['all'] : remaining);

  if (range.mode === 'current') {
    // Try the current/last session first
    const currentPath = getCurrentSessionPath();
    if (currentPath) {
      const summary = getSummary(currentPath, noopThresholdMs);
      if (summary && summary.prompts > 0) {
        console.log('=== Claude Code Timing Stats ===');
        console.log(`Session: ${basename(currentPath)}`);
        if (noNoop) console.log(`Noop filter: pauses > ${formatThreshold(noopThresholdMs)} excluded`);
        if (summary.cwd) console.log(`Project: ${projectName(summary.cwd)} (${summary.cwd})`);
        printParallelLine(summary);
        if (summary.incomplete) console.log('(Session still in progress or ended abruptly)');
        console.log();
        printSummary([summary]);
        if (noNoop) printNoopSummary([summary]);
        return;
      }
    }

    // Fall back to the most recent session that has data
    const files = listSessionFiles(null, null);
    for (let i = files.length - 1; i >= 0; i--) {
      const summary = getSummary(files[i], noopThresholdMs);
      if (summary && summary.prompts > 0) {
        console.log('=== Claude Code Timing Stats ===');
        console.log(`Session: ${files[i]}`);
        if (noNoop) console.log(`Noop filter: pauses > ${formatThreshold(noopThresholdMs)} excluded`);
        if (summary.cwd) console.log(`Project: ${projectName(summary.cwd)} (${summary.cwd})`);
        printParallelLine(summary);
        if (summary.incomplete) console.log('(Session still in progress or ended abruptly)');
        console.log();
        printSummary([summary]);
        if (noNoop) printNoopSummary([summary]);
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

  let summaries = files
    .map(f => getSummary(f, noopThresholdMs))
    .filter(s => s && s.prompts > 0);

  if (projectFilter) {
    summaries = summaries.filter(s => matchesProject(s.cwd, projectFilter));
  }

  if (summaries.length === 0) {
    const msg = projectFilter
      ? `No sessions found for project "${projectFilter}" in: ${range.label}`
      : `No valid session data for: ${range.label}`;
    console.log(msg);
    return;
  }

  console.log('=== Claude Code Timing Stats ===');
  console.log(`Period: ${range.label}`);
  if (noNoop) console.log(`Noop filter: pauses > ${formatThreshold(noopThresholdMs)} excluded`);
  if (projectFilter) console.log(`Project: ${projectFilter}`);
  console.log(`Sessions: ${summaries.length} | Prompts: ${summaries.reduce((a, s) => a + (s.prompts || 0), 0)}`);
  const overlapped = summaries.filter(s => Array.isArray(s.parallel_with) && s.parallel_with.length > 0).length;
  if ( overlapped > 0 ) {
    console.log(`Parallel runs: ${overlapped} of ${summaries.length} session(s) overlapped with other Claude sessions`);
  }
  console.log();

  // Group by project
  const byProject = new Map();
  for (const s of summaries) {
    const key = s.cwd || 'unknown';
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(s);
  }

  // Sort projects by total time descending
  const sorted = [...byProject.entries()].sort((a, b) => {
    const totalA = a[1].reduce((sum, s) => sum + (s.total_agent_ms || 0) + (s.total_idle_ms || 0) + (s.total_typing_ms || 0), 0);
    const totalB = b[1].reduce((sum, s) => sum + (s.total_agent_ms || 0) + (s.total_idle_ms || 0) + (s.total_typing_ms || 0), 0);
    return totalB - totalA;
  });

  for (const [cwd, projSummaries] of sorted) {
    const prompts = projSummaries.reduce((a, s) => a + (s.prompts || 0), 0);
    const projOverlapped = projSummaries.filter(
      s => Array.isArray(s.parallel_with) && s.parallel_with.length > 0
    ).length;
    const overlapTag = projOverlapped > 0 ? `, ${projOverlapped} parallel` : '';
    console.log(`-- ${projectName(cwd)} (${projSummaries.length} sessions, ${prompts} prompts${overlapTag}) --`);
    console.log(`   ${cwd}`);
    printSummary(projSummaries);
    if (noNoop) printNoopSummary(projSummaries);
    console.log();
  }

  if (byProject.size > 1) {
    console.log('-- Overall --');
    printSummary(summaries);
    if (noNoop) printNoopSummary(summaries);
  }
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
