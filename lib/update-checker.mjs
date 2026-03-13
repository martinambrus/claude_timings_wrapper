import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { TIMINGS_DIR } from './constants.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const UPDATE_CHECK_FILE = join(TIMINGS_DIR, '.update-check');
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/martinambrus/claude_timings_wrapper/main';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// Canonical step order — custom steps are appended after these
const STEP_ORDER = ['git pull', 'npm install', 'claude-timed --install-hook'];

export function getVersion() {
  return JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).version;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function readCheckCache() {
  if (!existsSync(UPDATE_CHECK_FILE)) return null;
  try {
    return JSON.parse(readFileSync(UPDATE_CHECK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeCheckCache(data) {
  mkdirSync(TIMINGS_DIR, { recursive: true });
  writeFileSync(UPDATE_CHECK_FILE, JSON.stringify(data) + '\n');
}

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function buildResult(localVersion, latestVersion, updateSteps, notes) {
  if (compareVersions(latestVersion, localVersion) > 0) {
    return { current: localVersion, latest: latestVersion, updateSteps, notes };
  }
  return null;
}

export async function checkForUpdate({ force = false } = {}) {
  const localVersion = getVersion();

  // Return cached result if still fresh
  if (!force) {
    const cache = readCheckCache();
    if (cache?.lastCheck) {
      const elapsed = Date.now() - new Date(cache.lastCheck).getTime();
      if (elapsed < CHECK_INTERVAL_MS) {
        return buildResult(localVersion, cache.latestVersion || localVersion,
          cache.updateSteps || [], cache.notes || []);
      }
    }
  }

  try {
    const remotePkg = await fetchJSON(`${GITHUB_RAW_BASE}/package.json`);
    const latestVersion = remotePkg.version;

    let updateSteps = ['git pull'];
    let notes = [];

    if (compareVersions(latestVersion, localVersion) > 0) {
      try {
        const updates = await fetchJSON(`${GITHUB_RAW_BASE}/updates.json`);
        const relevant = (updates.versions || [])
          .filter(v => compareVersions(v.version, localVersion) > 0
                    && compareVersions(v.version, latestVersion) <= 0)
          .sort((a, b) => compareVersions(a.version, b.version));

        const allSteps = new Set();
        for (const v of relevant) {
          for (const step of (v.steps || [])) allSteps.add(step);
          if (v.notes) notes.push({ version: v.version, notes: v.notes });
        }

        // Canonical steps first, then any custom ones
        updateSteps = STEP_ORDER.filter(s => allSteps.has(s));
        for (const s of allSteps) {
          if (!STEP_ORDER.includes(s)) updateSteps.push(s);
        }
      } catch {
        // updates.json unavailable — fall back to just "git pull"
      }
    }

    writeCheckCache({
      lastCheck: new Date().toISOString(),
      latestVersion,
      updateSteps: compareVersions(latestVersion, localVersion) > 0 ? updateSteps : [],
      notes: compareVersions(latestVersion, localVersion) > 0 ? notes : [],
    });

    return buildResult(localVersion, latestVersion, updateSteps, notes);
  } catch {
    // Network error — silently skip
    return null;
  }
}

export function formatUpdateNotice(info) {
  if (!info) return '';

  let msg = `\n${YELLOW}  ┌─ Update available: ${BOLD}v${info.current} → v${info.latest}${RESET}${YELLOW}\n`;

  if (info.notes?.length) {
    msg += '  │\n';
    for (const n of info.notes) {
      msg += `  │  v${n.version}: ${n.notes}\n`;
    }
  }

  msg += '  │\n  │  To update:\n';
  msg += `  │    cd ${PROJECT_ROOT}\n`;
  for (const step of info.updateSteps) {
    msg += `  │    ${step}\n`;
  }
  msg += `  └─${RESET}\n`;

  return msg;
}
