import { existsSync } from 'fs';
import { execFile, execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOUND_FILE = join(__dirname, '..', 'complete.mp3');

// Native Linux players, in preference order
const LINUX_PLAYERS = [
  { cmd: 'mpv',    args: ['--no-video', '--really-quiet'] },
  { cmd: 'mpg123', args: ['-q'] },
  { cmd: 'mpg321', args: ['-q'] },
  { cmd: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet'] },
];

let resolvedPlayer = undefined; // undefined = not yet probed

function isWSL() {
  try {
    const uname = execFileSync('uname', ['-r'], { encoding: 'utf8', timeout: 2000 });
    return /microsoft/i.test(uname);
  } catch {
    return false;
  }
}

function whichSync(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function wslpath(linuxPath) {
  try {
    return execFileSync('wslpath', ['-w', linuxPath], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    return null;
  }
}

/**
 * Probe for an available player once. Returns a player object or null.
 */
function probePlayer() {
  // macOS: use built-in afplay
  if (process.platform === 'darwin') {
    return { type: 'macos', cmd: 'afplay', args: [] };
  }

  // Try native Linux players first
  for (const player of LINUX_PLAYERS) {
    if (whichSync(player.cmd)) {
      return { type: 'linux', cmd: player.cmd, args: player.args };
    }
  }

  // On WSL2, fall back to PowerShell MediaPlayer
  if (isWSL() && whichSync('powershell.exe')) {
    const winPath = wslpath(SOUND_FILE);
    if (winPath) {
      return { type: 'wsl', winPath };
    }
  }

  return null;
}

/**
 * Play the completion sound. Fire-and-forget, never throws.
 */
export function playCompletionSound() {
  try {
    if (!existsSync(SOUND_FILE)) return;

    // Probe player on first call
    if (resolvedPlayer === undefined) {
      resolvedPlayer = probePlayer();
    }
    if (!resolvedPlayer) return;

    if (resolvedPlayer.type === 'macos') {
      const proc = execFile(
        resolvedPlayer.cmd,
        [...resolvedPlayer.args, SOUND_FILE],
        { stdio: 'ignore', timeout: 10000 },
      );
      proc.unref();
      proc.on('error', () => {});
    } else if (resolvedPlayer.type === 'linux') {
      const proc = execFile(
        resolvedPlayer.cmd,
        [...resolvedPlayer.args, SOUND_FILE],
        { stdio: 'ignore', timeout: 10000 },
      );
      proc.unref();
      proc.on('error', () => {});
    } else if (resolvedPlayer.type === 'wsl') {
      const psScript = `
Add-Type -AssemblyName presentationCore
$p = New-Object System.Windows.Media.MediaPlayer
$p.Open([Uri]"${resolvedPlayer.winPath}")
$p.Play()
Start-Sleep -Milliseconds 3000
$p.Close()
`;
      const proc = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { stdio: 'ignore', timeout: 10000 },
      );
      proc.unref();
      proc.on('error', () => {});
    }
  } catch {
    // Silently ignore all errors
  }
}
