import { homedir } from 'os';
import { join } from 'path';

export const TIMINGS_DIR = join(homedir(), '.claude', 'timings');
export const CURRENT_SESSION_FILE = join(TIMINGS_DIR, '.current-session');
export const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
export const HOOK_INSTALL_DIR = join(homedir(), '.claude', 'hooks');
export const HOOK_SCRIPT_NAME = 'claude-timing-stop.sh';
export const START_HOOK_SCRIPT_NAME = 'claude-timing-start.sh';

export const STATE = {
  INITIAL: 'INITIAL',
  AGENT_WORKING: 'AGENT_WORKING',
  IDLE: 'IDLE',
  USER_TYPING: 'USER_TYPING',
};
