import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const DEFAULT_TOLERANCE_MS = 2000;

/**
 * Claude Code encodes a session's cwd into its transcript directory name by
 * replacing every non-alphanumeric character with a dash, e.g.
 *   /home/u/elmont_rs            -> -home-u-elmont-rs
 *   /home/u/repo/.claude/wt/X-1  -> -home-u-repo--claude-wt-X-1
 */
function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function parseTsMs(s) {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Read user prompts from a set of transcript files, keeping only real
 * string-content user messages whose `cwd` matches the requested one.
 * Returns [{ ts, text, branch }] sorted ascending by ts.
 */
function readTranscriptFiles(files, cwd) {
  const msgs = [];
  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== 'user') continue;
      if (o.cwd !== cwd) continue;
      const text = o.message && typeof o.message.content === 'string' ? o.message.content : null;
      if (!text) continue;
      const ts = parseTsMs(o.timestamp);
      if (ts == null) continue;
      msgs.push({ ts, text, branch: o.gitBranch || null });
    }
  }
  msgs.sort((a, b) => a.ts - b.ts);
  return msgs;
}

/**
 * Load (and cache) all transcript user messages for a given cwd. Tries the
 * encoded directory first; falls back to scanning every project directory and
 * filtering by the `cwd` field (handles symlinked / unexpectedly-encoded paths).
 */
export function loadTranscriptMessages(cwd, cache) {
  if (cache && cache.has(cwd)) return cache.get(cwd);

  let msgs = [];
  const encodedDir = join(PROJECTS_DIR, encodeCwd(cwd));
  if (existsSync(encodedDir)) {
    try {
      const files = readdirSync(encodedDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => join(encodedDir, f));
      msgs = readTranscriptFiles(files, cwd);
    } catch {
      msgs = [];
    }
  }

  // Fallback: the encoded dir was missing or yielded nothing — scan everything.
  if (msgs.length === 0 && existsSync(PROJECTS_DIR)) {
    try {
      const allFiles = [];
      for (const dir of readdirSync(PROJECTS_DIR)) {
        const full = join(PROJECTS_DIR, dir);
        let inner;
        try {
          inner = readdirSync(full);
        } catch {
          continue;
        }
        for (const f of inner) {
          if (f.endsWith('.jsonl')) allFiles.push(join(full, f));
        }
      }
      msgs = readTranscriptFiles(allFiles, cwd);
    } catch {
      msgs = [];
    }
  }

  if (cache) cache.set(cwd, msgs);
  return msgs;
}

/**
 * Find the transcript message whose timestamp is closest to `ts`, within
 * `toleranceMs`. Returns the message ({ ts, text, branch }) or null.
 */
export function matchByNearestTimestamp(msgs, ts, toleranceMs = DEFAULT_TOLERANCE_MS) {
  if (!msgs || msgs.length === 0) return null;

  // Binary search for the insertion point.
  let lo = 0;
  let hi = msgs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (msgs[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }

  let best = null;
  let bestDiff = Infinity;
  for (const j of [lo - 1, lo]) {
    if (j < 0 || j >= msgs.length) continue;
    const diff = Math.abs(msgs[j].ts - ts);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = msgs[j];
    }
  }

  return best && bestDiff <= toleranceMs ? best : null;
}

/**
 * Resolve a prompt's text for an orphan prompt.
 * Order: self-contained log field -> Claude transcript -> "(unavailable)".
 * Returns { text, branch, source } where source is 'log' | 'transcript' | 'none'.
 */
export function resolvePromptText(orphan, cache) {
  if (orphan.entry && typeof orphan.entry.prompt_text === 'string' && orphan.entry.prompt_text) {
    return { text: orphan.entry.prompt_text, branch: null, source: 'log' };
  }

  const msgs = loadTranscriptMessages(orphan.cwd, cache);
  const match = matchByNearestTimestamp(msgs, orphan.ts);
  if (match) {
    return { text: match.text, branch: match.branch, source: 'transcript' };
  }

  return { text: '(unavailable)', branch: null, source: 'none' };
}
