import { spawnSync } from 'child_process';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { listSessionFiles, readSessionEntries } from './timing-log.mjs';
import {
  recomputeForDateRange, formatMs, padRight, projectName,
  matchesProject, extractFlags, getDateRange, formatThreshold,
} from './stats.mjs';
import { resolvePromptText } from './prompt-source.mjs';
import { attributeOrphansLLM } from './llm-attribute.mjs';

const STANDALONE_GROUP_GAP_MS = 15 * 60 * 1000; // 15 minutes
const STANDALONE_MAX_LOOKBACK_MS = 2 * 60 * 60 * 1000; // 2 hours max lookback for standalone task start
const SESSION_BACKTRACK_GAP_MS = 60 * 60 * 1000; // 1 hour — max idle gap when backtracking from commit to session start
const PARALLEL_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes — tasks with commit windows this close are considered parallel

const DISCLAIMER = 'Note: Task timings are estimates based on git history correlation. Interleaved\nwork, branch switching, and non-commit activity may cause inaccuracies.';

// ─── Git utilities ───────────────────────────────────────────────────────────

function getGitRoot(dir) {
  if (!dir) return null;

  // If the directory exists, ask git directly
  if (existsSync(dir)) {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir, encoding: 'utf8', timeout: 5000,
    });
    if (result.status === 0) return result.stdout.trim();
  }

  // Directory doesn't exist (e.g. cleaned-up worktree).
  // Try to infer the parent repo by progressively stripping suffixes.
  // Worktree paths follow patterns like:
  //   /home/user/repo-feature/branch-name
  //   /home/user/repo-feature-branch-name
  //   /home/user/repo-worktree-TASK-123
  const basename = dir.split('/').pop() || '';
  const parentDir = dir.slice(0, dir.length - basename.length - 1);

  // Try stripping at each hyphen from right to left
  const parts = basename.split('-');
  for (let i = parts.length - 1; i >= 1; i--) {
    const candidate = parentDir + '/' + parts.slice(0, i).join('-');
    if (existsSync(candidate)) {
      const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: candidate, encoding: 'utf8', timeout: 5000,
      });
      if (result.status === 0) return result.stdout.trim();
    }
  }

  // If the parent directory itself doesn't exist (e.g. /home/user/repo-feature/branch),
  // try resolving the parent dir as a worktree path too by stripping its hyphens.
  if (!existsSync(parentDir)) {
    const parentBasename = parentDir.split('/').pop() || '';
    const grandparentDir = parentDir.slice(0, parentDir.length - parentBasename.length - 1);
    const parentParts = parentBasename.split('-');
    for (let i = parentParts.length - 1; i >= 1; i--) {
      const candidate = grandparentDir + '/' + parentParts.slice(0, i).join('-');
      if (existsSync(candidate)) {
        const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
          cwd: candidate, encoding: 'utf8', timeout: 5000,
        });
        if (result.status === 0) return result.stdout.trim();
      }
    }
  }

  return null;
}

function detectMainBranch(gitRoot) {
  // 1. Use the currently checked-out branch — this is where the user is working.
  //    HEAD is the most reliable indicator of the active integration branch,
  //    especially in repos where master/main is a release branch and dev is the
  //    working branch.
  let r = spawnSync('git', ['branch', '--show-current'], {
    cwd: gitRoot, encoding: 'utf8', timeout: 5000,
  });
  if (r.status === 0 && r.stdout.trim()) {
    return r.stdout.trim();
  }

  // 2. Detached HEAD — try symbolic-ref for remote default
  r = spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
    cwd: gitRoot, encoding: 'utf8', timeout: 5000,
  });
  if (r.status === 0) {
    return r.stdout.trim().split('/').pop();
  }

  // 3. Probe common local branch names
  for (const name of ['main', 'master', 'develop', 'trunk']) {
    r = spawnSync('git', ['rev-parse', '--verify', name], {
      cwd: gitRoot, encoding: 'utf8', timeout: 5000,
    });
    if (r.status === 0) return name;
  }

  // 4. Scan remote branches
  r = spawnSync('git', ['branch', '-r'], { cwd: gitRoot, encoding: 'utf8', timeout: 5000 });
  if (r.status === 0) {
    for (const line of r.stdout.split('\n')) {
      const trimmed = line.trim();
      for (const name of ['main', 'master', 'develop', 'trunk']) {
        if (trimmed === `origin/${name}`) return name;
      }
    }
  }

  return 'main';
}

function parseFirstParentLog(gitRoot, mainBranch, sinceMs) {
  const sinceDate = new Date(sinceMs - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = spawnSync('git', [
    'log', '--format=%H%x00%P%x00%aI%x00%s',
    '--first-parent',
    `--after=${sinceDate}`,
    mainBranch,
  ], { cwd: gitRoot, encoding: 'utf8', timeout: 30000 });

  if (result.status !== 0) return [];

  const output = (result.stdout || '').trim();
  if (!output) return [];

  return output.split('\n').filter(Boolean).map(line => {
    const parts = line.split('\x00');
    const hash = parts[0];
    const parentsStr = parts[1] || '';
    const dateStr = parts[2] || '';
    const subject = parts.slice(3).join('\x00');
    const parents = parentsStr.trim().split(/\s+/).filter(Boolean);
    return {
      hash,
      parents,
      date: new Date(dateStr),
      subject,
      isMerge: parents.length >= 2,
    };
  });
}

function getBranchCommits(gitRoot, parentHash, mergeHash) {
  const result = spawnSync('git', [
    'log', '--format=%H%x00%aI%x00%s',
    `${parentHash}..${mergeHash}`,
    '--reverse',
  ], { cwd: gitRoot, encoding: 'utf8', timeout: 15000 });

  if (result.status !== 0) return [];

  const output = (result.stdout || '').trim();
  if (!output) return [];

  return output.split('\n').filter(Boolean).map(line => {
    const parts = line.split('\x00');
    return {
      hash: parts[0],
      date: new Date(parts[1] || ''),
      subject: parts.slice(2).join('\x00'),
    };
  });
}

// ─── Task window building ────────────────────────────────────────────────────

function buildTaskWindows(commits, gitRoot) {
  if (commits.length === 0) return [];

  // Work oldest-first
  const ordered = [...commits].reverse();
  const tasks = [];
  let i = 0;

  while (i < ordered.length) {
    const commit = ordered[i];

    if (commit.isMerge) {
      const branchCommits = getBranchCommits(gitRoot, commit.parents[0], commit.hash);
      // Filter out the merge commit itself from branch commits (git log parent..merge includes it)
      const filtered = branchCommits.filter(c => c.hash !== commit.hash);

      let windowStart;
      if (filtered.length > 0) {
        windowStart = new Date(Math.min(...filtered.map(c => c.date.getTime())));
      } else {
        // No branch commits found (squash-like or empty merge)
        windowStart = commit.date;
      }

      tasks.push({
        label: commit.subject,
        windowStart,
        windowEnd: commit.date,
        commits: [commit, ...filtered],
        type: 'merge',
        branchCommitCount: filtered.length,
      });
      i++;
    } else {
      // Group consecutive standalone commits with gap <= 15m
      const group = [commit];
      let j = i + 1;
      while (j < ordered.length && !ordered[j].isMerge) {
        const gap = ordered[j].date.getTime() - ordered[j - 1].date.getTime();
        if (gap <= STANDALONE_GROUP_GAP_MS) {
          group.push(ordered[j]);
          j++;
        } else {
          break;
        }
      }

      // Window start: use the previous commit's date as the lower boundary,
      // but cap at STANDALONE_MAX_LOOKBACK_MS before the first commit in the group
      // to avoid spanning overnight gaps or multi-day idle periods.
      let windowStart;
      const firstCommitMs = group[0].date.getTime();
      const maxLookbackMs = firstCommitMs - STANDALONE_MAX_LOOKBACK_MS;
      if (i > 0) {
        const prevMs = ordered[i - 1].date.getTime();
        windowStart = new Date(Math.max(prevMs, maxLookbackMs));
      } else {
        windowStart = group[0].date;
      }
      const windowEnd = group[group.length - 1].date;

      const label = group.length === 1
        ? group[0].subject
        : group.map(c => c.subject).join('; ');

      tasks.push({
        label,
        windowStart,
        windowEnd,
        commits: group,
        type: 'standalone',
        branchCommitCount: 0,
      });
      i = j;
    }
  }

  // Return newest-first for display
  return tasks.reverse();
}

// ─── Parallel group detection ────────────────────────────────────────────────

/**
 * Detect tasks whose original git commit windows overlap or are very close
 * (within PARALLEL_THRESHOLD_MS). These tasks were worked on together and
 * should be allowed to share session time without boundary capping.
 *
 * Assigns a `parallelGroup` number to each task. Tasks in the same group
 * have overlapping commit windows.
 */
function detectParallelGroups(taskWindows) {
  // Work oldest-first
  const tasks = [...taskWindows].reverse().filter(t => t.type !== 'unattributed');
  let groupId = 0;

  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].parallelGroup != null) continue;
    tasks[i].parallelGroup = groupId;

    // Check subsequent tasks for overlap with any task in this group
    const groupTasks = [tasks[i]];
    for (let j = i + 1; j < tasks.length; j++) {
      if (tasks[j].parallelGroup != null) continue;

      // Check if task j's commit window overlaps with any task in the group
      const jStart = Math.min(...tasks[j].commits.map(c => c.date.getTime()));
      const jEnd = Math.max(...tasks[j].commits.map(c => c.date.getTime()));

      for (const gt of groupTasks) {
        const gStart = Math.min(...gt.commits.map(c => c.date.getTime()));
        const gEnd = Math.max(...gt.commits.map(c => c.date.getTime()));

        // Overlap or within threshold
        if (jStart <= gEnd + PARALLEL_THRESHOLD_MS && jEnd >= gStart - PARALLEL_THRESHOLD_MS) {
          tasks[j].parallelGroup = groupId;
          groupTasks.push(tasks[j]);
          break;
        }
      }
    }
    groupId++;
  }
}

// ─── Session-based window extension ──────────────────────────────────────────

/**
 * Backtrack from each task's first commit through session events to find
 * the real work start. Extends window to session_start unless a >1h idle
 * gap is found. Boundaries are enforced between different parallel groups
 * but not within the same group (parallel tasks share session time).
 */
function extendWindowsFromSessions(taskWindows, sessions) {
  if (taskWindows.length === 0 || sessions.length === 0) return;

  // Tasks are newest-first; work oldest-first for boundary checking
  const tasks = [...taskWindows].reverse();

  for (let t = 0; t < tasks.length; t++) {
    const task = tasks[t];
    if (task.type === 'unattributed') continue;

    const earliestCommitMs = Math.min(...task.commits.map(c => c.date.getTime()));
    let bestStart = task.windowStart.getTime();

    for (const { entries } of sessions) {
      const sessionStartEntry = entries.find(e => e.event === 'session_start');
      const sessionEndEntry = [...entries].reverse().find(e => e.ts);
      if (!sessionStartEntry || !sessionEndEntry) continue;

      const sessionStartMs = new Date(sessionStartEntry.ts).getTime();
      const sessionEndMs = new Date(sessionEndEntry.ts).getTime();

      if (earliestCommitMs < sessionStartMs || earliestCommitMs > sessionEndMs) continue;

      const eventsBefore = entries
        .filter(e => e.ts && new Date(e.ts).getTime() < earliestCommitMs)
        .map(e => ({ ts: new Date(e.ts).getTime(), idle_ms: e.idle_ms || 0 }))
        .sort((a, b) => b.ts - a.ts);

      let candidateStart = sessionStartMs;

      for (const evt of eventsBefore) {
        if (evt.idle_ms > SESSION_BACKTRACK_GAP_MS) {
          candidateStart = evt.ts;
          break;
        }
      }

      if (candidateStart === sessionStartMs && eventsBefore.length > 0) {
        let prevMs = earliestCommitMs;
        for (const evt of eventsBefore) {
          const gap = prevMs - evt.ts;
          if (gap > SESSION_BACKTRACK_GAP_MS) {
            candidateStart = prevMs;
            break;
          }
          prevMs = evt.ts;
        }
      }

      if (candidateStart < bestStart) {
        bestStart = candidateStart;
      }
    }

    // Only enforce boundary against previous task if it's in a DIFFERENT parallel group
    if (t > 0 && tasks[t - 1].parallelGroup !== task.parallelGroup) {
      const prevEnd = tasks[t - 1].windowEnd.getTime();
      if (bestStart < prevEnd) {
        bestStart = prevEnd;
      }
    }

    task.windowStart = new Date(bestStart);
  }
}

// ─── Wall-clock deduplication ────────────────────────────────────────────────

/**
 * Compute wall-clock totals by merging overlapping task windows, so parallel
 * tasks aren't double-counted. Returns { wallClockAgent, wallClockUser, overlapMs }.
 */
function computeWallClock(results, sessions, noopThresholdMs, rangeStartMs = 0, rangeEndMs = Infinity) {
  // Collect all task windows (excluding unattributed)
  const windows = results
    .filter(r => r.type !== 'unattributed' && r.windowStart && r.windowEnd)
    .map(r => ({ start: r.windowStart.getTime(), end: r.windowEnd.getTime() }))
    .sort((a, b) => a.start - b.start);

  if (windows.length === 0) return null;

  // Merge overlapping windows
  const merged = [{ ...windows[0] }];
  for (let i = 1; i < windows.length; i++) {
    const last = merged[merged.length - 1];
    if (windows[i].start <= last.end) {
      last.end = Math.max(last.end, windows[i].end);
    } else {
      merged.push({ ...windows[i] });
    }
  }

  // Compute time within merged windows using recomputeForDateRange
  let wallAgent = 0;
  let wallUser = 0;
  let wallPrompts = 0;
  for (const win of merged) {
    const ws = Math.max(win.start, rangeStartMs);
    const we = Math.min(win.end, rangeEndMs);
    if (we <= ws) continue;
    for (const { entries } of sessions) {
      const summary = recomputeForDateRange(entries, ws, we, noopThresholdMs || null);
      wallAgent += summary.total_agent_ms || 0;
      wallUser += (summary.total_idle_ms || 0) + (summary.total_typing_ms || 0);
      wallPrompts += summary.prompts || 0;
    }
  }

  const taskSum = results.reduce((a, r) => a + r.totalMs, 0);
  const wallTotal = wallAgent + wallUser;
  const unattr = results.find(r => r.type === 'unattributed');
  const unattrMs = unattr ? unattr.totalMs : 0;
  const taskSumExclUnattr = taskSum - unattrMs;
  const overlapMs = Math.max(0, taskSumExclUnattr - wallTotal);

  return { wallAgent, wallUser, wallPrompts, wallTotal, overlapMs };
}

/**
 * Build combined results for parallel groups — merge parallel tasks into
 * single rows for the wall-clock view.
 */
function buildCombinedResults(results) {
  const combined = [];
  const seen = new Set();

  for (const r of results) {
    if (r.type === 'unattributed') {
      combined.push(r);
      continue;
    }
    if (seen.has(r.parallelGroup)) continue;

    // Find all tasks in this parallel group
    const group = results.filter(t => t.parallelGroup === r.parallelGroup && t.type !== 'unattributed');
    seen.add(r.parallelGroup);

    if (group.length === 1) {
      combined.push(group[0]);
    } else {
      // Merge into a single entry
      const labels = group.map(t => t.label);
      const allCommits = group.flatMap(t => t.commits);
      const windowStart = new Date(Math.min(...group.map(t => t.windowStart.getTime())));
      const windowEnd = new Date(Math.max(...group.map(t => t.windowEnd.getTime())));

      combined.push({
        label: labels.join(' + '),
        windowStart,
        windowEnd,
        commits: allCommits,
        type: 'parallel-combined',
        branchCommitCount: allCommits.length,
        // These will be recomputed — use placeholder 0s
        agentMs: 0, userMs: 0, idleMs: 0, typingMs: 0, totalMs: 0,
        prompts: 0, sessionCount: 0,
        parallelGroup: r.parallelGroup,
        combinedFrom: group,
      });
    }
  }
  return combined;
}

// ─── Attribution ─────────────────────────────────────────────────────────────

function attributeTime(taskWindows, sessionsByRoot, gitRoot, noopThresholdMs, rangeStartMs = 0, rangeEndMs = Infinity) {
  const sessions = sessionsByRoot.get(gitRoot) || [];
  const results = [];
  let totalAttributedAgent = 0;
  let totalAttributedUser = 0;
  let totalAttributedIdle = 0;
  let totalAttributedTyping = 0;
  let totalAttributedPrompts = 0;

  for (const task of taskWindows) {
    const startMs = Math.max(task.windowStart.getTime(), rangeStartMs);
    const endMs = Math.min(task.windowEnd.getTime(), rangeEndMs);
    let agentMs = 0;
    let userMs = 0;
    let idleMs = 0;
    let typingMs = 0;
    let prompts = 0;
    let sessionCount = 0;

    for (const { entries } of sessions) {
      const summary = recomputeForDateRange(entries, startMs, endMs, noopThresholdMs || null);
      const sAgent = summary.total_agent_ms || 0;
      const sUser = (summary.total_idle_ms || 0) + (summary.total_typing_ms || 0);
      if (sAgent > 0 || sUser > 0 || (summary.prompts || 0) > 0) {
        agentMs += sAgent;
        idleMs += summary.total_idle_ms || 0;
        typingMs += summary.total_typing_ms || 0;
        userMs += sUser;
        prompts += summary.prompts || 0;
        sessionCount++;
      }
    }

    totalAttributedAgent += agentMs;
    totalAttributedUser += userMs;
    totalAttributedIdle += idleMs;
    totalAttributedTyping += typingMs;
    totalAttributedPrompts += prompts;

    results.push({
      ...task,
      agentMs,
      userMs,
      idleMs,
      typingMs,
      totalMs: agentMs + userMs,
      prompts,
      sessionCount,
    });
  }

  // Compute total time across all sessions for this project
  let projectAgentMs = 0;
  let projectUserMs = 0;
  let projectIdleMs = 0;
  let projectTypingMs = 0;
  let projectPrompts = 0;
  for (const { entries } of sessions) {
    // Project total is clipped to the requested date range (not the full
    // session), so e.g. `--tasks today` does not count time from sessions that
    // merely overlap the ±3-day file window but ran on other days.
    const summary = recomputeForDateRange(entries, rangeStartMs, rangeEndMs, noopThresholdMs || null);
    projectAgentMs += summary.total_agent_ms || 0;
    projectUserMs += (summary.total_idle_ms || 0) + (summary.total_typing_ms || 0);
    projectIdleMs += summary.total_idle_ms || 0;
    projectTypingMs += summary.total_typing_ms || 0;
    projectPrompts += summary.prompts || 0;
  }

  // Unattributed remainder
  const unattributedAgent = Math.max(0, projectAgentMs - totalAttributedAgent);
  const unattributedUser = Math.max(0, projectUserMs - totalAttributedUser);
  const unattributedIdle = Math.max(0, (totalAttributedIdle != null ? projectIdleMs - totalAttributedIdle : 0));
  const unattributedTyping = Math.max(0, (totalAttributedTyping != null ? projectTypingMs - totalAttributedTyping : 0));
  const unattributedPrompts = Math.max(0, projectPrompts - totalAttributedPrompts);

  if (unattributedAgent > 0 || unattributedUser > 0 || unattributedPrompts > 0) {
    results.push({
      label: '[unattributed]',
      windowStart: null,
      windowEnd: null,
      commits: [],
      type: 'unattributed',
      branchCommitCount: 0,
      agentMs: unattributedAgent,
      userMs: unattributedUser,
      idleMs: unattributedIdle,
      typingMs: unattributedTyping,
      totalMs: unattributedAgent + unattributedUser,
      prompts: unattributedPrompts,
      sessionCount: 0,
    });
  }

  return results;
}

// ─── Orphan prompts (unattributed) ───────────────────────────────────────────

/**
 * Find prompts whose timestamp falls inside NO task window. These are the
 * individual prompts that make up the `[unattributed]` residual.
 *
 * Membership mirrors recomputeForDateRange's prompt counting: a prompt at ts is
 * "in" a window iff windowStart <= ts < windowEnd (half-open). `.some()` means a
 * prompt inside any (incl. overlapping/parallel) window is not an orphan.
 *
 * IMPORTANT: callers pass rangeStartMs=0, rangeEndMs=Infinity so the orphan set
 * matches the residual's baseline — attributeTime computes project totals over
 * full (unclipped) session ranges, so the residual includes out-of-report-range
 * prompts too. Clipping orphans to the report range would desync the two.
 */
function findOrphanPrompts(taskWindows, sessions, rangeStartMs, rangeEndMs) {
  const wins = taskWindows
    .filter(w => w.type !== 'unattributed' && w.windowStart && w.windowEnd)
    .map(w => [w.windowStart.getTime(), w.windowEnd.getTime()]);

  const orphans = [];
  for (const { file, entries, cwd } of sessions) {
    for (const e of entries) {
      if (e.event !== 'prompt_submit' || !e.ts) continue;
      const ms = new Date(e.ts).getTime();
      if (ms < rangeStartMs || ms >= rangeEndMs) continue;
      if (wins.some(([s, en]) => ms >= s && ms < en)) continue;
      orphans.push({
        ts: ms,
        sessionFile: file,
        cwd,
        entry: e,
        claudeSession: e.claude_session ?? null,
      });
    }
  }
  orphans.sort((a, b) => a.ts - b.ts);
  return orphans;
}

/**
 * Merge a list of [start,end] windows into non-overlapping ascending spans.
 */
function mergeWindows(wins) {
  const sorted = wins.filter(w => w[1] > w[0]).sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) return [];
  const merged = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1]) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      merged.push([sorted[i][0], sorted[i][1]]);
    }
  }
  return merged;
}

/**
 * Portion of [a,b] that lies OUTSIDE all merged windows.
 */
function outsideMs(a, b, mergedWins) {
  if (b <= a) return 0;
  let overlap = 0;
  for (const [s, e] of mergedWins) {
    overlap += Math.max(0, Math.min(b, e) - Math.max(a, s));
  }
  return Math.max(0, (b - a) - overlap);
}

/**
 * Best-effort per-prompt time attribution for a single session, mirroring the
 * phase logic of recomputeForDateRange but keyed to the owning prompt. Every
 * span is clipped to time OUTSIDE all task windows so sums are comparable to the
 * residual `[unattributed]` bucket. The residual stays authoritative; this is an
 * illustrative breakdown (deltas are expected — see renderUnattributedPrompts).
 *
 * Returns Map<promptNumber, { agentMs, idleMs, typingMs }>.
 */
function bucketSessionByPrompt(entries, mergedWins) {
  const map = new Map();
  const get = n => {
    if (!map.has(n)) map.set(n, { agentMs: 0, idleMs: 0, typingMs: 0 });
    return map.get(n);
  };
  let currentPrompt = null;

  for (const e of entries) {
    if (!e.ts) continue;
    const ms = new Date(e.ts).getTime();

    if (e.event === 'typing_start' && e.idle_ms) {
      // Idle preceding a prompt is keyed by the prompt number it carries.
      get(e.prompt).idleMs += outsideMs(ms - e.idle_ms, ms, mergedWins);
    } else if (e.event === 'prompt_submit') {
      if (e.typing_ms) get(e.prompt).typingMs += outsideMs(ms - e.typing_ms, ms, mergedWins);
      currentPrompt = e.prompt;
    } else if (e.event === 'steering_submit') {
      if (currentPrompt != null && e.typing_ms) {
        get(currentPrompt).typingMs += outsideMs(ms - e.typing_ms, ms, mergedWins);
      }
    } else if (e.event === 'agent_stop' || e.event === 'agent_interrupt') {
      if (currentPrompt != null && e.agent_work_ms) {
        get(currentPrompt).agentMs += outsideMs(ms - e.agent_work_ms, ms, mergedWins);
      }
    } else if (e.event === 'agent_stall') {
      if (currentPrompt != null && e.agent_work_ms) {
        const ws = ms - (e.stall_elapsed_ms || 0);
        get(currentPrompt).agentMs += outsideMs(ws, ws + e.agent_work_ms, mergedWins);
      }
    } else if (e.event === 'background_agent_stop') {
      if (currentPrompt != null) {
        if (e.idle_correction_ms && e.idle_correction_ms > 0) {
          // Reclassify idle->agent for the current prompt (best effort).
          const b = get(currentPrompt);
          const mv = Math.min(b.idleMs, e.idle_correction_ms);
          b.idleMs -= mv;
          b.agentMs += mv;
        } else if (e.agent_work_ms) {
          get(currentPrompt).agentMs += outsideMs(ms - e.agent_work_ms, ms, mergedWins);
        }
      }
    }
  }
  return map;
}

// ─── Per-project analysis ────────────────────────────────────────────────────

/**
 * Run the full per-project pipeline: parse git history, build/extend task
 * windows, attribute time, compute wall-clock dedup, and find orphan prompts.
 * Returns everything the renderers need.
 */
function buildProjectAnalysis(gitRoot, sessionsByRoot, opts) {
  const { earliestMs, startDate, endDate, noopThresholdMs } = opts;

  const mainBranch = detectMainBranch(gitRoot);
  const commits = parseFirstParentLog(gitRoot, mainBranch, earliestMs);

  // Date range in ms (whole UTC days). Used to clip commits AND session time.
  const rangeStartMs = startDate ? new Date(startDate + 'T00:00:00Z').getTime() : 0;
  const rangeEndMs = endDate ? new Date(endDate + 'T00:00:00Z').getTime() + 24 * 60 * 60 * 1000 : Infinity;

  // Filter commits to the date range if applicable
  let filteredCommits = commits;
  if (startDate || endDate) {
    filteredCommits = commits.filter(c => {
      const ms = c.date.getTime();
      return ms >= rangeStartMs && ms < rangeEndMs;
    });
  }

  const taskWindows = buildTaskWindows(filteredCommits, gitRoot);
  const sessions = sessionsByRoot.get(gitRoot) || [];
  detectParallelGroups(taskWindows);
  extendWindowsFromSessions(taskWindows, sessions);
  const results = attributeTime(taskWindows, sessionsByRoot, gitRoot, noopThresholdMs, rangeStartMs, rangeEndMs);

  // Compute wall-clock totals and detect overlap
  const wallClock = computeWallClock(results, sessions, noopThresholdMs, rangeStartMs, rangeEndMs);

  // Build combined results for the wall-clock view (parallel tasks merged)
  const combinedResults = buildCombinedResults(results);
  // Attribute time for combined parallel entries
  for (const cr of combinedResults) {
    if (cr.type === 'parallel-combined') {
      const startMs = Math.max(cr.windowStart.getTime(), rangeStartMs);
      const endMs = Math.min(cr.windowEnd.getTime(), rangeEndMs);
      let agentMs = 0, userMs = 0, prompts = 0, sessionCount = 0;
      for (const { entries } of sessions) {
        const summary = recomputeForDateRange(entries, startMs, endMs, noopThresholdMs || null);
        const sAgent = summary.total_agent_ms || 0;
        const sUser = (summary.total_idle_ms || 0) + (summary.total_typing_ms || 0);
        if (sAgent > 0 || sUser > 0 || (summary.prompts || 0) > 0) {
          agentMs += sAgent;
          userMs += sUser;
          prompts += summary.prompts || 0;
          sessionCount++;
        }
      }
      cr.agentMs = agentMs;
      cr.userMs = userMs;
      cr.totalMs = agentMs + userMs;
      cr.prompts = prompts;
      cr.sessionCount = sessionCount;
    }
  }

  // Orphan prompts use the same range as the project total so they reconcile
  // with the (range-clipped) residual.
  const orphanPrompts = findOrphanPrompts(taskWindows, sessions, rangeStartMs, rangeEndMs);

  return { taskWindows, results, combinedResults, wallClock, sessions, orphanPrompts };
}

// ─── Unattributed-prompt detail ──────────────────────────────────────────────

function formatSigned(ms) {
  if (!ms) return '0s';
  return (ms < 0 ? '-' : '+') + formatMs(Math.abs(ms));
}

/**
 * Aggregate LLM-reassigned per-prompt time by target task, attaching the task's
 * representative commit hash. Returns [{ label, hash, agentMs, userMs, count }].
 */
function aggregateReassignments(rows, results) {
  const byTask = new Map();
  for (const r of rows) {
    if (!r.assignedTask || r.assignedTask === 'none') continue;
    if (!byTask.has(r.assignedTask)) {
      const tr = results.find(x => x.type !== 'unattributed' && x.label === r.assignedTask);
      const hash = tr && tr.commits && tr.commits.length ? tr.commits[0].hash.slice(0, 7) : null;
      byTask.set(r.assignedTask, { label: r.assignedTask, hash, agentMs: 0, userMs: 0, count: 0 });
    }
    const a = byTask.get(r.assignedTask);
    a.agentMs += r.bucket.agentMs;
    a.userMs += r.bucket.idleMs + r.bucket.typingMs;
    a.count++;
  }
  return [...byTask.values()];
}

/**
 * Build the per-orphan-prompt detail for one project: resolve each prompt's
 * text, bucket its time (clipped to outside-windows), and optionally run LLM
 * thematic attribution. The residual `[unattributed]` row stays authoritative;
 * per-prompt sums are illustrative (see the reconciliation line in renderers).
 */
function buildOrphanDetail(projData, cache, opts) {
  const { taskWindows, results, orphanPrompts, sessions } = projData;
  const residual = results.find(r => r.type === 'unattributed')
    || { agentMs: 0, idleMs: 0, typingMs: 0, prompts: 0 };

  const wins = taskWindows
    .filter(w => w.type !== 'unattributed' && w.windowStart && w.windowEnd)
    .map(w => [w.windowStart.getTime(), w.windowEnd.getTime()]);
  const mergedWins = mergeWindows(wins);

  const bucketsByFile = new Map();
  for (const s of sessions) {
    bucketsByFile.set(s.file, bucketSessionByPrompt(s.entries, mergedWins));
  }

  const rows = [];
  for (const o of orphanPrompts) {
    const resolved = resolvePromptText(o, cache);
    const bmap = bucketsByFile.get(o.sessionFile);
    const bucket = (bmap && bmap.get(o.entry.prompt)) || { agentMs: 0, idleMs: 0, typingMs: 0 };
    rows.push({
      ts: o.ts,
      sessionFile: o.sessionFile,
      claudeSession: o.claudeSession,
      text: resolved.text,
      branch: resolved.branch,
      source: resolved.source,
      bucket,
      assignedTask: 'none',
    });
  }

  const perPrompt = rows.reduce((a, r) => ({
    agentMs: a.agentMs + r.bucket.agentMs,
    idleMs: a.idleMs + r.bucket.idleMs,
    typingMs: a.typingMs + r.bucket.typingMs,
  }), { agentMs: 0, idleMs: 0, typingMs: 0 });

  let llm = null;
  if (opts.attributeLlm) {
    const totalOrphans = rows.length;
    const unavailableCount = rows.filter(r => r.source === 'none').length;
    const withTextCount = totalOrphans - unavailableCount;

    if (totalOrphans === 0) {
      llm = {
        ok: false, reason: 'no unattributed prompts to attribute',
        model: opts.model || 'haiku', assignedCount: 0, consideredCount: 0,
        totalOrphans, unavailableCount, withTextCount, matchedTasks: [],
      };
    } else {
      const taskLabels = results.filter(r => r.type !== 'unattributed').map(r => r.label);
      const out = attributeOrphansLLM(
        rows.map(r => ({ ts: r.ts, text: r.text })),
        taskLabels,
        { model: opts.model, maxBudgetUsd: opts.maxBudgetUsd, debug: opts.debug, timeoutMs: opts.timeoutMs }
      );
      for (const r of rows) r.assignedTask = out.mapping.get(r.ts) || 'none';
      llm = {
        ok: out.ok, reason: out.reason,
        model: out.model || opts.model || 'haiku',
        assignedCount: out.assignedCount || 0,
        consideredCount: out.consideredCount || withTextCount,
        totalOrphans, unavailableCount, withTextCount,
        matchedTasks: aggregateReassignments(rows, results),
      };
    }
  }

  return { rows, residual, perPrompt, llm };
}

function renderOrphanSectionTerminal(detail, attributeLlm) {
  const { rows, residual, perPrompt, llm } = detail;
  console.log();
  console.log(`  -- Unattributed prompts (${rows.length}) --`);
  if (rows.length === 0) {
    console.log('     (none)');
    return;
  }

  // Prominent LLM status, right under the header so it isn't buried by the list.
  if (attributeLlm) renderLlmStatusTerminal(llm);

  const SEP = '  ' + '─'.repeat(95);
  console.log('   #  When (UTC)         Session     Agent      User   Prompt');
  console.log(SEP);
  let i = 0;
  for (const r of rows) {
    i++;
    const when = new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ');
    const sess = r.sessionFile.slice(-13, -6);
    const agent = formatMs(r.bucket.agentMs).padStart(8);
    const user = formatMs(r.bucket.idleMs + r.bucket.typingMs).padStart(8);
    const text = truncate((r.text || '').replace(/\s+/g, ' ').trim(), 46);
    console.log(`  ${String(i).padStart(2)}  ${when}  ${padRight(sess, 9)} ${agent}  ${user}  ${text}`);
    const tags = [];
    if (r.branch) tags.push(`[${r.branch}]`);
    if (attributeLlm) tags.push(r.assignedTask !== 'none' ? `→ ${truncate(r.assignedTask, 50)}` : '→ (none)');
    if (r.source === 'none') tags.push('(text unavailable — outside transcript retention)');
    if (tags.length) console.log(`      ${tags.join('  ')}`);
  }
  console.log(SEP);

  const ppUser = perPrompt.idleMs + perPrompt.typingMs;
  const resUser = (residual.idleMs || 0) + (residual.typingMs || 0);
  console.log(`      Per-prompt sum:    Agent ${formatMs(perPrompt.agentMs)} | User ${formatMs(ppUser)}  (${rows.length} prompts)`);
  console.log(`      [unattributed]:    Agent ${formatMs(residual.agentMs || 0)} | User ${formatMs(resUser)}  (${residual.prompts || 0} netted)`);
  console.log(`      Delta (resid−pp):  Agent ${formatSigned((residual.agentMs || 0) - perPrompt.agentMs)} | User ${formatSigned(resUser - ppUser)}`);
  console.log('      (residual is netted across overlapping windows & floored; per-prompt counts each orphan once,');
  console.log('       outside all windows — so per-prompt can exceed the residual when parallel tasks overlap)');

  // Detailed per-task/commit breakdown of what the LLM matched.
  if (attributeLlm && llm && llm.ok && llm.matchedTasks.length > 0) {
    console.log();
    console.log('      Matched unattributed time → tasks/commits:');
    let remA = perPrompt.agentMs, remU = ppUser;
    for (const t of llm.matchedTasks) {
      const h = t.hash ? ` (${t.hash})` : '';
      console.log(`        → ${truncate(t.label, 46)}${h}: +Agent ${formatMs(t.agentMs)} +User ${formatMs(t.userMs)} (${t.count} prompt${t.count === 1 ? '' : 's'})`);
      remA -= t.agentMs; remU -= t.userMs;
    }
    console.log(`        Still unattributed after LLM: Agent ${formatMs(Math.max(0, remA))} | User ${formatMs(Math.max(0, remU))}`);
  }
}

function renderLlmStatusTerminal(llm) {
  if (!llm) { console.log('  LLM attribution: not run.'); return; }
  if (!llm.ok) {
    console.log(`  LLM attribution: ✗ DID NOT RUN — ${llm.reason || 'unavailable'}`);
    if (llm.unavailableCount) {
      console.log(`     (${llm.unavailableCount} of ${llm.totalOrphans} prompt(s) also had no recoverable text)`);
    }
    return;
  }
  console.log(`  LLM attribution (${llm.model}): ✓ matched ${llm.assignedCount} of ${llm.withTextCount} prompt(s) with text → ${llm.matchedTasks.length} task(s)/commit(s).`);
  if (llm.reason) console.log(`     note: ${llm.reason}`);
  if (llm.unavailableCount) {
    console.log(`     ${llm.unavailableCount} prompt(s) had no recoverable text (not sent to the LLM).`);
  }
  if (llm.assignedCount === 0) {
    console.log('     The model ran but tied none of the prompts to a tracked task/commit.');
  }
}

function renderOrphanSectionMarkdown(detail, attributeLlm) {
  const { rows, residual, perPrompt, llm } = detail;
  const lines = [];
  lines.push(`## Unattributed prompts (${rows.length})`);
  lines.push('');
  if (rows.length === 0) {
    lines.push('_(none)_');
    lines.push('');
    return lines;
  }

  if (attributeLlm) {
    if (!llm || !llm.ok) {
      lines.push(`**LLM attribution: DID NOT RUN** — ${llm ? llm.reason : 'unavailable'}`);
    } else {
      lines.push(`**LLM attribution (${llm.model}):** matched ${llm.assignedCount} of ${llm.withTextCount} prompt(s) with text → ${llm.matchedTasks.length} task(s)/commit(s).`);
      if (llm.reason) lines.push(`- _${llm.reason}_`);
      if (llm.unavailableCount) lines.push(`- ${llm.unavailableCount} prompt(s) had no recoverable text (not sent to the LLM).`);
      if (llm.assignedCount === 0) lines.push('- The model ran but tied none of the prompts to a tracked task/commit.');
    }
    lines.push('');
  }

  const cols = ['#', 'When (UTC)', 'Session', 'Agent', 'User', 'Branch'];
  if (attributeLlm) cols.push('Assigned task');
  cols.push('Prompt');
  lines.push('| ' + cols.join(' | ') + ' |');
  lines.push('|' + cols.map(() => '---').join('|') + '|');

  let i = 0;
  for (const r of rows) {
    i++;
    const when = new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ');
    const sess = r.sessionFile.slice(-13, -6);
    const user = r.bucket.idleMs + r.bucket.typingMs;
    const text = (r.text || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
    const cells = [String(i), when, sess, formatMs(r.bucket.agentMs), formatMs(user), r.branch || ''];
    if (attributeLlm) cells.push(r.assignedTask !== 'none' ? r.assignedTask.replace(/\|/g, '\\|') : '(none)');
    cells.push(truncate(text, 80));
    lines.push('| ' + cells.join(' | ') + ' |');
  }
  lines.push('');

  const ppUser = perPrompt.idleMs + perPrompt.typingMs;
  const resUser = (residual.idleMs || 0) + (residual.typingMs || 0);
  lines.push(`**Per-prompt sum:** Agent ${formatMs(perPrompt.agentMs)} | User ${formatMs(ppUser)} (${rows.length} prompts)`);
  lines.push(`**[unattributed] residual (authoritative):** Agent ${formatMs(residual.agentMs || 0)} | User ${formatMs(resUser)} (${residual.prompts || 0} netted)`);
  lines.push(`**Delta (residual − per-prompt):** Agent ${formatSigned((residual.agentMs || 0) - perPrompt.agentMs)} | User ${formatSigned(resUser - ppUser)} — the residual is netted across overlapping/parallel windows and floored, while per-prompt counts each orphan once outside all windows; per-prompt can exceed the residual when parallel tasks overlap.`);
  lines.push('');

  if (attributeLlm && llm && llm.ok && llm.matchedTasks.length > 0) {
    lines.push('**Matched unattributed time → tasks/commits:**');
    for (const t of llm.matchedTasks) {
      const h = t.hash ? ` (\`${t.hash}\`)` : '';
      lines.push(`- → ${t.label}${h}: +Agent ${formatMs(t.agentMs)} +User ${formatMs(t.userMs)} (${t.count} prompt${t.count === 1 ? '' : 's'})`);
    }
    lines.push('');
  }
  return lines;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function formatDateRange(start, end) {
  if (!start || !end) return '';
  const s = start.toISOString().slice(0, 10);
  const e = end.toISOString().slice(0, 10);
  if (s === e) return s;
  return `${s} \u2192 ${e}`;
}

function formatDateShort(start, end) {
  if (!start || !end) return '\u2014';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const s = start.toISOString().slice(0, 10);
  const e = end.toISOString().slice(0, 10);
  const sMonth = months[start.getUTCMonth()];
  const sDay = start.getUTCDate();
  if (s === e) return `${sMonth} ${sDay}`;
  const eMonth = months[end.getUTCMonth()];
  const eDay = end.getUTCDate();
  if (sMonth === eMonth) return `${sMonth} ${sDay}\u2013${eDay}`;
  return `${sMonth} ${sDay} \u2013 ${eMonth} ${eDay}`;
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

function hasParallelTasks(results) {
  const groups = new Map();
  for (const r of results) {
    if (r.parallelGroup == null || r.type === 'unattributed') continue;
    if (!groups.has(r.parallelGroup)) groups.set(r.parallelGroup, []);
    groups.get(r.parallelGroup).push(r);
  }
  return [...groups.values()].some(g => g.length > 1);
}

function findParallelPeers(r, results) {
  if (r.parallelGroup == null || r.type === 'unattributed') return [];
  return results.filter(t => t !== r && t.parallelGroup === r.parallelGroup && t.type !== 'unattributed');
}

function renderTerminal(resultsByProject, meta) {
  console.log('=== Claude Code Task Breakdown ===');
  if (meta.label) console.log(`Period: ${meta.label}`);
  if (meta.noopThresholdMs) console.log(`Noop filter: pauses > ${formatThreshold(meta.noopThresholdMs)} excluded`);
  if (meta.projectFilter) console.log(`Project: ${meta.projectFilter}`);
  console.log();
  console.log(DISCLAIMER);
  console.log();

  const warnings = [];

  for (const [proj, projData] of resultsByProject) {
    const { results, wallClock } = projData;
    const name = projectName(proj);
    const totalAgent = results.reduce((a, r) => a + r.agentMs, 0);
    const totalUser = results.reduce((a, r) => a + r.userMs, 0);
    const totalIdle = results.reduce((a, r) => a + r.idleMs, 0);
    const totalTyping = results.reduce((a, r) => a + r.typingMs, 0);
    const totalPrompts = results.reduce((a, r) => a + r.prompts, 0);
    const taskCount = results.filter(r => r.type !== 'unattributed').length;
    const hasParallel = hasParallelTasks(results);

    console.log(`-- ${name} (${taskCount} tasks, ${totalPrompts} prompts) --`);
    console.log(`   ${proj}`);
    console.log();

    const SEP = '  ' + '\u2500'.repeat(95);
    console.log('  #  Task                                      Agent     Idle    Typing      Total   Prompts');
    console.log(SEP);

    let idx = 0;
    for (const r of results) {
      idx++;
      const num = r.type === 'unattributed' ? ' ' : String(idx).padStart(2);
      if (r.type === 'unattributed') idx--;

      const label = truncate(r.label, 42);
      const agent = formatMs(r.agentMs).padStart(8);
      const idle = formatMs(r.idleMs).padStart(8);
      const typing = formatMs(r.typingMs).padStart(8);
      const total = formatMs(r.totalMs).padStart(9);
      const prompts = String(r.prompts).padStart(6);

      console.log(`  ${num}  ${padRight(label, 42)} ${agent}  ${idle}  ${typing}  ${total}  ${prompts}`);

      // Detail line
      if (r.type !== 'unattributed') {
        const dateRange = formatDateRange(r.windowStart, r.windowEnd);
        const sessStr = r.sessionCount === 1 ? '1 session' : `${r.sessionCount} sessions`;
        const peers = findParallelPeers(r, results);
        const parallelTag = peers.length > 0
          ? ` | parallel with #${peers.map(p => results.indexOf(p) + 1).join(', #')}`
          : '';
        console.log(`      ${dateRange} | ${sessStr}${parallelTag}`);
      }

      if (r.type !== 'unattributed' && r.sessionCount === 0) {
        warnings.push(`Task "${truncate(r.label, 40)}" had no tracked Claude sessions`);
      }
    }

    console.log(SEP);
    const totalAgentStr = formatMs(totalAgent).padStart(8);
    const totalIdleStr = formatMs(totalIdle).padStart(8);
    const totalTypingStr = formatMs(totalTyping).padStart(8);
    const grandTotal = formatMs(totalAgent + totalUser).padStart(9);
    const totalPromptsStr = String(totalPrompts).padStart(6);
    console.log(`      ${padRight('Sum of tasks', 42)} ${totalAgentStr}  ${totalIdleStr}  ${totalTypingStr}  ${grandTotal}  ${totalPromptsStr}`);

    if (hasParallel && wallClock && wallClock.overlapMs > 0) {
      const wcAgent = formatMs(wallClock.wallAgent).padStart(8);
      const wcTotal = formatMs(wallClock.wallTotal).padStart(9);
      const wcPrompts = String(wallClock.wallPrompts).padStart(6);
      console.log(`      ${padRight('Wall-clock (deduplicated)', 42)} ${wcAgent}          ${wcTotal}  ${wcPrompts}`);
      console.log(`      (${formatMs(wallClock.overlapMs)} overlap from parallel tasks)`);
    }

    if (meta.unattributedPrompts && projData.orphanDetail) {
      renderOrphanSectionTerminal(projData.orphanDetail, meta.attributeLlm);
    }
    console.log();
  }

  if (meta.noGitSessions > 0) {
    warnings.push(`${meta.noGitSessions} session(s) excluded: cwd is not a git repository or no longer exists`);
  }

  if (warnings.length > 0) {
    for (const w of warnings) {
      console.log(`Note: ${w}`);
    }
    console.log();
  }

  console.log(DISCLAIMER);
}

function renderMarkdown(resultsByProject, meta) {
  const lines = [];

  for (const [proj, projData] of resultsByProject) {
    const { results, combinedResults, wallClock } = projData;
    const name = projectName(proj);
    const hasParallel = hasParallelTasks(results);

    // ── Table 1: Per-task effort ──
    const heading = hasParallel ? 'Per-task effort' : 'Task Breakdown';
    lines.push(`# ${heading} \u2014 ${name} \u2014 ${meta.label || 'all time'}`);
    lines.push('');
    lines.push('> **Note:** Task timings are estimates based on git history correlation.');
    lines.push('> Interleaved work, branch switching, and non-commit activity may cause inaccuracies.');
    if (hasParallel) {
      lines.push('>');
      lines.push('> Tasks marked with **[P]** were worked on in parallel. Their times reflect the full effort');
      lines.push('> per task and may overlap \u2014 summing them will exceed wall-clock time.');
    }
    lines.push('');
    lines.push('| # | Task | Agent | Idle | Typing | Total | Prompts | Period |');
    lines.push('|---|------|-------|------|--------|-------|---------|--------|');

    let idx = 0;
    for (const r of results) {
      idx++;
      const num = r.type === 'unattributed' ? '' : String(idx);
      if (r.type === 'unattributed') idx--;

      const period = formatDateShort(r.windowStart, r.windowEnd);
      const peers = findParallelPeers(r, results);
      const pTag = peers.length > 0 ? ' **[P]**' : '';
      lines.push(`| ${num} | ${r.label}${pTag} | ${formatMs(r.agentMs)} | ${formatMs(r.idleMs)} | ${formatMs(r.typingMs)} | ${formatMs(r.totalMs)} | ${r.prompts} | ${period} |`);
    }

    lines.push('');

    const totalAgent = results.reduce((a, r) => a + r.agentMs, 0);
    const totalUser = results.reduce((a, r) => a + r.userMs, 0);
    const totalIdle = results.reduce((a, r) => a + r.idleMs, 0);
    const totalTyping = results.reduce((a, r) => a + r.typingMs, 0);
    const totalPrompts = results.reduce((a, r) => a + r.prompts, 0);
    lines.push(`**Sum of tasks:** Agent ${formatMs(totalAgent)} | Idle ${formatMs(totalIdle)} | Typing ${formatMs(totalTyping)} | Combined ${formatMs(totalAgent + totalUser)} | ${totalPrompts} prompts`);

    if (hasParallel && wallClock && wallClock.overlapMs > 0) {
      lines.push('');
      lines.push(`**Wall-clock (deduplicated):** Agent ${formatMs(wallClock.wallAgent)} | User ${formatMs(wallClock.wallUser)} | Combined ${formatMs(wallClock.wallTotal)} | ${wallClock.wallPrompts} prompts`);
      lines.push(`*(${formatMs(wallClock.overlapMs)} overlap from parallel tasks)*`);
    }
    lines.push('');

    // ── Table 2: Wall-clock allocation (only if there are parallel tasks) ──
    if (hasParallel && combinedResults) {
      lines.push(`## Wall-clock allocation \u2014 ${name}`);
      lines.push('');
      lines.push('> Parallel tasks are combined into single entries. Totals reflect actual elapsed time with no double-counting.');
      lines.push('');
      lines.push('| # | Task | Agent | Idle | Typing | Total | Prompts | Period |');
      lines.push('|---|------|-------|------|--------|-------|---------|--------|');

      let cidx = 0;
      for (const r of combinedResults) {
        cidx++;
        const num = r.type === 'unattributed' ? '' : String(cidx);
        if (r.type === 'unattributed') cidx--;

        const period = formatDateShort(r.windowStart, r.windowEnd);
        lines.push(`| ${num} | ${r.label} | ${formatMs(r.agentMs)} | ${formatMs(r.idleMs)} | ${formatMs(r.typingMs)} | ${formatMs(r.totalMs)} | ${r.prompts} | ${period} |`);
      }

      lines.push('');
      const cTotalAgent = combinedResults.reduce((a, r) => a + r.agentMs, 0);
      const cTotalUser = combinedResults.reduce((a, r) => a + r.userMs, 0);
      const cTotalPrompts = combinedResults.reduce((a, r) => a + r.prompts, 0);
      lines.push(`**Total:** Agent ${formatMs(cTotalAgent)} | User ${formatMs(cTotalUser)} | Combined ${formatMs(cTotalAgent + cTotalUser)} | ${cTotalPrompts} prompts`);
      lines.push('');
    }

    if (meta.unattributedPrompts && projData.orphanDetail) {
      for (const l of renderOrphanSectionMarkdown(projData.orphanDetail, meta.attributeLlm)) lines.push(l);
    }
  }

  lines.push(`Generated by claude-timed v${getVersion()} on ${new Date().toISOString().slice(0, 10)}`);
  return lines.join('\n');
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function showTasks(args) {
  // Extract --export-md before other flag parsing
  let exportMdPath = null;
  const filteredArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--export-md') {
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        exportMdPath = args[i + 1];
        i++;
      } else {
        const today = new Date().toISOString().slice(0, 10);
        exportMdPath = `tasks-${today}.md`;
      }
    } else {
      filteredArgs.push(args[i]);
    }
  }

  const {
    projectFilter, noopThresholdMs, remaining,
    unattributedPrompts, attributeLlm, attributeModel, maxBudgetUsd,
    attributeDebug, attributeTimeoutMs,
  } = extractFlags(filteredArgs);
  const range = getDateRange((projectFilter && remaining.length === 0) ? ['all'] : remaining);

  // Determine date boundaries
  let startDate = range.start || null;
  let endDate = range.end || null;

  if (range.mode === 'current') {
    // Default to all time for tasks
    startDate = null;
    endDate = null;
  }

  // Load sessions
  const expandedStart = startDate ? expandStartDate(startDate, 3) : null;
  const files = listSessionFiles(expandedStart, endDate);

  if (files.length === 0) {
    console.log('No sessions found.');
    return;
  }

  // Read all sessions and group by git root
  const sessionsByRoot = new Map();
  let noGitSessions = 0;

  for (const file of files) {
    const entries = readSessionEntries(file);
    if (entries.length === 0) continue;

    const startEntry = entries.find(e => e.event === 'session_start');
    const cwd = startEntry ? startEntry.cwd : null;
    if (!cwd) continue;

    const gitRoot = getGitRoot(cwd);
    if (!gitRoot) {
      noGitSessions++;
      continue;
    }

    // Filter by project using git root (not session cwd) so worktree sessions match
    if (projectFilter && !matchesProject(gitRoot, projectFilter)) continue;

    if (!sessionsByRoot.has(gitRoot)) sessionsByRoot.set(gitRoot, []);
    sessionsByRoot.get(gitRoot).push({ file, entries, cwd });
  }

  if (sessionsByRoot.size === 0) {
    if (noGitSessions > 0) {
      console.log(`No git repositories found. ${noGitSessions} session(s) had no git repo at their recorded cwd.`);
    } else {
      console.log('No matching sessions found.');
    }
    return;
  }

  // Determine the earliest session timestamp for git log --after
  let earliestMs = Infinity;
  for (const sessions of sessionsByRoot.values()) {
    for (const { entries } of sessions) {
      const first = entries.find(e => e.ts);
      if (first) {
        const ms = new Date(first.ts).getTime();
        if (ms < earliestMs) earliestMs = ms;
      }
    }
  }

  // For each project: parse git, build windows, attribute time, find orphans
  const resultsByProject = new Map();

  for (const [gitRoot] of sessionsByRoot) {
    resultsByProject.set(
      gitRoot,
      buildProjectAnalysis(gitRoot, sessionsByRoot, { earliestMs, startDate, endDate, noopThresholdMs })
    );
  }

  const meta = {
    label: range.label || 'All time',
    projectFilter,
    noopThresholdMs,
    noGitSessions,
    unattributedPrompts,
    attributeLlm,
  };

  // Resolve prompt text + per-prompt buckets (and optional LLM attribution)
  if (unattributedPrompts) {
    const cache = new Map();
    for (const [, projData] of resultsByProject) {
      projData.orphanDetail = buildOrphanDetail(projData, cache, {
        attributeLlm,
        model: attributeModel,
        maxBudgetUsd,
        debug: attributeDebug,
        timeoutMs: attributeTimeoutMs,
      });
    }
  }

  if (exportMdPath) {
    const md = renderMarkdown(resultsByProject, meta);
    writeFileSync(exportMdPath, md + '\n');
    console.log(`Task breakdown exported to: ${exportMdPath}`);
  } else {
    renderTerminal(resultsByProject, meta);
  }
}

// Helper: expand start date by N days (for session overlap)
function expandStartDate(dateStr, days) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
