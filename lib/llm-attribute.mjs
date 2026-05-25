import { spawnSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PROMPT_TEXT_CAP = 600; // chars per prompt sent to the model
const DEFAULT_MODEL = 'haiku'; // fast/cheap; classification doesn't need a bigger model
const BATCH_SIZE = 60; // prompts per headless call — bounds per-call latency on large windows

const SYSTEM_RULES = [
  'You map developer prompts to the software task each one belongs to.',
  'You are given a numbered list of TASKS and a list of PROMPTS.',
  'For each prompt, pick the single task whose theme best matches it, or "none"',
  'if it does not clearly belong to any listed task.',
  'Respond with ONLY a JSON array of objects: {"id": <prompt id>, "task": <exact task label or "none">}.',
  'Copy task labels verbatim from the TASKS list. No prose, no markdown, no code fences.',
].join(' ');

/**
 * Extract a JSON array from a model response that may include prose or fences.
 */
function parseJsonArray(str) {
  if (typeof str !== 'string') return null;

  // Models often wrap the answer in ```json fences and/or add prose. Be robust.
  const s = str.replace(/```+\s*(?:json|JSON)?/g, ' ');

  const coerce = (v) => {
    if (Array.isArray(v)) return v;
    // Tolerate an object wrapper like { "assignments": [...] }.
    if (v && typeof v === 'object') {
      for (const key of Object.keys(v)) {
        if (Array.isArray(v[key])) return v[key];
      }
    }
    return null;
  };
  const tryParse = (t) => { try { return coerce(JSON.parse(t)); } catch { return null; } };

  // 1) Whole string (handles clean output and "[]").
  const whole = tryParse(s.trim());
  if (whole) return whole;

  // 2) Scan for a balanced [ ... ] region (string-aware) and parse the first
  //    candidate that yields an array of objects — skips stray brackets in prose.
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '[') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === '[') {
        depth++;
      } else if (c === ']') {
        depth--;
        if (depth === 0) {
          const arr = tryParse(s.slice(i, j + 1));
          if (arr && arr.length > 0 && typeof arr[0] === 'object') return arr;
          break; // not the array we want; advance to the next '['
        }
      }
    }
  }
  return null;
}

/**
 * Ask a headless `claude -p` to assign each orphan prompt to one of the given
 * task labels (closed vocabulary) or "none".
 *
 * @param {Array<{ts:number, text:string}>} orphans  resolved prompts
 * @param {string[]} taskLabels  candidate task labels (the closed vocabulary)
 * @param {{model?:string, maxBudgetUsd?:number}} [opts]
 * @returns {{ mapping: Map<number,string>, ok: boolean, reason?: string }}
 *          mapping: orphan.ts -> task label or 'none'. Always returns a mapping
 *          (all 'none' on failure); never throws.
 */
export function attributeOrphansLLM(orphans, taskLabels, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const mapping = new Map();
  for (const o of orphans) mapping.set(o.ts, 'none');

  // Only send prompts that actually have text.
  const items = orphans
    .filter(o => o.text && o.text !== '(unavailable)')
    .map((o, i) => ({ id: i, ts: o.ts, text: o.text.slice(0, PROMPT_TEXT_CAP).replace(/\s+/g, ' ').trim() }));

  if (items.length === 0) {
    return { mapping, ok: false, reason: 'no resolvable prompt text to attribute' };
  }
  if (!taskLabels || taskLabels.length === 0) {
    return { mapping, ok: false, reason: 'no candidate tasks' };
  }

  const labelSet = new Set(taskLabels);
  const tasksBlock = 'TASKS:\n' + taskLabels.map(l => `- ${l}`).join('\n');

  const baseArgs = [
    '-p', '--output-format', 'json', '--model', model,
    '--append-system-prompt', SYSTEM_RULES,
    // Classification needs no tools — skip the user's MCP servers and session
    // persistence so a slow/hanging MCP server can't stall headless startup.
    '--strict-mcp-config',
    '--no-session-persistence',
  ];
  if (opts.maxBudgetUsd) baseArgs.push('--max-budget-usd', String(opts.maxBudgetUsd));

  const debug = !!opts.debug;
  const dbg = (line) => { if (debug) process.stderr.write(`[attribute-llm] ${line}\n`); };
  const TIMEOUT_MS = opts.timeoutMs || 240000;
  // Synchronous sleep (no subprocess) for back-off between batch retries.
  const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

  const parseEnvelope = (r) => {
    if (!r || !r.stdout) return null;
    try { return JSON.parse(r.stdout); } catch { return null; }
  };
  const isAuthError = (r, env) => {
    if (env && env.api_error_status === 401) return true;
    const blob = `${env && typeof env.result === 'string' ? env.result : ''} ${r && r.stderr ? r.stderr : ''}`.toLowerCase();
    return /invalid api key|unauthorized|authentication_error|\b401\b/.test(blob);
  };

  // One headless call. `label` is for debug only.
  const runOnce = (content, stripApiKey, label) => {
    const env = { ...process.env };
    if (stripApiKey) delete env.ANTHROPIC_API_KEY;
    const args = [...baseArgs];
    let debugFile = null;
    if (debug) { debugFile = join(tmpdir(), `claude_attr_${Date.now()}_${String(label).replace(/[^\w.-]/g, '-')}.log`); args.push('--debug-file', debugFile); }
    const t0 = Date.now();
    const r = spawnSync('claude', args, {
      input: content, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env,
    });
    dbg(`batch ${label} invoke(stripKey=${stripApiKey}) elapsed=${Date.now() - t0}ms status=${r.status} signal=${r.signal || '-'} err=${r.error ? r.error.code : '-'} stdoutLen=${(r.stdout || '').length}`);
    if (debug && debugFile) {
      // Dump claude's own trace when the call failed or produced no output.
      if (r.error || !r.stdout || r.stdout.length < 50) {
        try { dbg(`batch ${label} claude --debug-file (tail):\n${readFileSync(debugFile, 'utf8').slice(-2000)}`); } catch {}
      }
      try { unlinkSync(debugFile); } catch {}
    }
    return r;
  };

  // Split prompts into batches so a large window can't blow the per-call timeout.
  const batches = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) batches.push(items.slice(i, i + BATCH_SIZE));

  if (debug) {
    dbg(`prompts=${items.length} tasks=${taskLabels.length} model=${model} timeout=${TIMEOUT_MS}ms batches=${batches.length}x<=${BATCH_SIZE}`);
    dbg(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? 'set(len=' + process.env.ANTHROPIC_API_KEY.length + ')' : 'unset'} ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL || 'unset'}`);
  }

  let stripKey = false;     // flipped once if a stale key shadows OAuth, then reused
  let assigned = 0;
  let okBatches = 0;
  let firstReason = null;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const label = `${b + 1}/${batches.length}`;
    const content = `${tasksBlock}\n\nPROMPTS:\n` + batch.map(it => `#${it.id}: ${it.text}`).join('\n\n');

    let r, env;
    for (let attempt = 0; ; attempt++) {
      r = runOnce(content, stripKey, attempt ? `${label}#${attempt + 1}` : label);
      env = parseEnvelope(r);

      // Auth retry — flip stripKey once; reused for subsequent batches.
      if (!stripKey && !r.error && process.env.ANTHROPIC_API_KEY && isAuthError(r, env)) {
        stripKey = true;
        r = runOnce(content, true, `${label}r`);
        env = parseEnvelope(r);
      }

      // Transient spawn failure (seen intermittently after a long call) — back off and retry.
      if (r.error && (r.error.code === 'ENOENT' || r.error.code === 'EAGAIN') && attempt < 2) {
        dbg(`batch ${label} transient ${r.error.code}; retrying after backoff`);
        sleepSync(750);
        continue;
      }
      break;
    }

    if (r.error) {
      let hint = '';
      if (r.error.code === 'ENOENT') hint = ' (claude CLI not found on PATH)';
      else if (r.error.code === 'ETIMEDOUT') hint = ` (batch timed out after ${Math.round(TIMEOUT_MS / 1000)}s)`;
      firstReason = firstReason || `claude not runnable: ${r.error.message}${hint}`;
      continue;
    }
    if (env && (env.is_error || env.api_error_status)) {
      const code = env.api_error_status ? ` ${env.api_error_status}` : '';
      const msg = typeof env.result === 'string' ? env.result : '';
      const h = env.api_error_status === 401
        ? ' — check `claude` auth: a stale/placeholder ANTHROPIC_API_KEY can shadow OAuth (unset it)'
        : '';
      firstReason = firstReason || `claude API error${code}: ${msg}${h}`.trim();
      continue;
    }

    const resultStr = env && typeof env.result === 'string' ? env.result : r.stdout;
    const arr = parseJsonArray(resultStr);
    if (!arr) {
      firstReason = firstReason || 'could not parse model response as JSON';
      continue;
    }

    for (const row of arr) {
      if (!row || typeof row.id !== 'number') continue;
      const item = items.find(it => it.id === row.id);
      if (!item) continue;
      const task = typeof row.task === 'string' && labelSet.has(row.task) ? row.task : 'none';
      mapping.set(item.ts, task);
      if (task !== 'none') assigned++;
    }
    okBatches++;
  }

  if (okBatches === 0) {
    return { mapping, ok: false, reason: firstReason || 'attribution failed', model };
  }
  return {
    mapping, ok: true, assignedCount: assigned, consideredCount: items.length, model,
    reason: okBatches < batches.length
      ? `partial — ${okBatches}/${batches.length} batches succeeded (${firstReason})`
      : undefined,
  };
}
