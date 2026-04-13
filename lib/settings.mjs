import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, sep } from 'path';
import { fileURLToPath } from 'url';
import * as readline from 'readline/promises';
import { TIMINGS_DIR } from './constants.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

function isGlobalInstall() {
  return PROJECT_ROOT.split(sep).includes('node_modules');
}

export function getSettingsPath() {
  if (isGlobalInstall()) {
    return join(TIMINGS_DIR, 'settings.json');
  }
  return join(PROJECT_ROOT, 'settings.json');
}

export function loadSettings() {
  const path = getSettingsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  const path = getSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
}

async function promptYesNo(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim();
    if (answer === '') return true;
    return /^y(es)?$/i.test(answer);
  } finally {
    rl.close();
  }
}

export async function ensureUpdateCheckSetting() {
  const settings = loadSettings();
  if (typeof settings.checkForUpdates === 'boolean') {
    return settings.checkForUpdates;
  }

  const answer = await promptYesNo(
    'claude-timed: check for new versions on startup? [Y/n] '
  );

  if (answer === null) {
    // Non-interactive: skip check this run, do not persist.
    return false;
  }

  settings.checkForUpdates = answer;
  saveSettings(settings);

  const where = getSettingsPath();
  process.stdout.write(
    `claude-timed: update checks ${answer ? 'enabled' : 'disabled'}. ` +
    `Edit ${where} to change.\n`
  );

  return answer;
}
