import { STATE } from './constants.mjs';

let interval = null;
let stateRef = null;
let startTimeRef = null;

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function update() {
  if (!stateRef) return;
  const state = stateRef();
  const elapsed = Date.now() - (startTimeRef() || Date.now());

  let label;
  switch (state) {
    case STATE.INITIAL:
      label = 'Ready';
      break;
    case STATE.AGENT_WORKING:
      label = `Agent: ${formatDuration(elapsed)}`;
      break;
    case STATE.IDLE:
      label = `Idle: ${formatDuration(elapsed)}`;
      break;
    case STATE.USER_TYPING:
      label = `Typing: ${formatDuration(elapsed)}`;
      break;
    case STATE.PAUSED:
      label = 'Paused';
      break;
    default:
      label = state;
  }

  process.stdout.write(`\x1b]0;claude-timed | ${label}\x07`);
}

export function startTitleBar(getState, getPhaseStart) {
  stateRef = getState;
  startTimeRef = getPhaseStart;
  interval = setInterval(update, 1000);
  update();
}

export function stopTitleBar() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  // Clear title
  process.stdout.write('\x1b]0;\x07');
}
