import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CLAUDE_SETTINGS_PATH, HOOK_INSTALL_DIR, HOOK_SCRIPT_NAME, START_HOOK_SCRIPT_NAME } from './constants.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOOKS = [
  {
    event: 'Stop',
    scriptName: HOOK_SCRIPT_NAME,
    source: join(__dirname, '..', 'hooks', HOOK_SCRIPT_NAME),
    dest: join(HOOK_INSTALL_DIR, HOOK_SCRIPT_NAME),
  },
  {
    event: 'UserPromptSubmit',
    scriptName: START_HOOK_SCRIPT_NAME,
    source: join(__dirname, '..', 'hooks', START_HOOK_SCRIPT_NAME),
    dest: join(HOOK_INSTALL_DIR, START_HOOK_SCRIPT_NAME),
  },
];

function readSettings() {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) {
    return {};
  }
  return JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
}

function isEventHookInstalled(settings, event, scriptName) {
  const hooks = settings?.hooks?.[event];
  if (!Array.isArray(hooks)) return false;
  return hooks.some(entry =>
    entry?.hooks?.some(h => h?.command?.includes(scriptName))
  );
}

export function install() {
  mkdirSync(HOOK_INSTALL_DIR, { recursive: true });

  // Copy hook scripts
  for (const hook of HOOKS) {
    copyFileSync(hook.source, hook.dest);
    chmodSync(hook.dest, 0o755);
    console.log(`Hook script copied to ${hook.dest}`);
  }

  const settings = readSettings();
  const allInstalled = HOOKS.every(h => isEventHookInstalled(settings, h.event, h.scriptName));

  if (allInstalled) {
    console.log('All timing hooks already present in settings — skipping.');
    return;
  }

  // Backup
  const backupPath = CLAUDE_SETTINGS_PATH + '.timing-bak';
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    copyFileSync(CLAUDE_SETTINGS_PATH, backupPath);
    console.log(`Settings backed up to ${backupPath}`);
  }

  if (!settings.hooks) settings.hooks = {};

  for (const hook of HOOKS) {
    if (isEventHookInstalled(settings, hook.event, hook.scriptName)) continue;

    if (!Array.isArray(settings.hooks[hook.event])) settings.hooks[hook.event] = [];
    settings.hooks[hook.event].push({
      matcher: "",
      hooks: [{ type: "command", command: hook.dest }],
    });
    console.log(`${hook.event} hook added to Claude settings.`);
  }

  mkdirSync(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

export function uninstall() {
  const settings = readSettings();
  let changed = false;

  // Backup before any changes
  const backupPath = CLAUDE_SETTINGS_PATH + '.timing-bak';
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    copyFileSync(CLAUDE_SETTINGS_PATH, backupPath);
  }

  for (const hook of HOOKS) {
    if (!isEventHookInstalled(settings, hook.event, hook.scriptName)) {
      console.log(`${hook.event} hook not found in settings — nothing to remove.`);
      continue;
    }

    settings.hooks[hook.event] = settings.hooks[hook.event].filter(entry =>
      !entry?.hooks?.some(h => h?.command?.includes(hook.scriptName))
    );

    if (settings.hooks[hook.event].length === 0) delete settings.hooks[hook.event];
    console.log(`${hook.event} hook removed from Claude settings.`);
    changed = true;
  }

  if (changed) {
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  }

  // Remove hook scripts
  for (const hook of HOOKS) {
    if (existsSync(hook.dest)) {
      unlinkSync(hook.dest);
      console.log(`Hook script removed: ${hook.dest}`);
    }
  }
}
