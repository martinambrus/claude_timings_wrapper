#!/usr/bin/env node

const args = process.argv.slice(2);

// Handle wrapper-specific flags
if (args[0] === '--install-hook') {
  const { install } = await import('../lib/hook-installer.mjs');
  install();
  process.exit(0);
}

if (args[0] === '--uninstall-hook') {
  const { uninstall } = await import('../lib/hook-installer.mjs');
  uninstall();
  process.exit(0);
}

if (args[0] === '--version') {
  const { getVersion } = await import('../lib/update-checker.mjs');
  console.log(`claude-timed v${getVersion()}`);
  process.exit(0);
}

if (args[0] === '--check-update') {
  const { checkForUpdate, formatUpdateNotice, getVersion } = await import('../lib/update-checker.mjs');
  const info = await checkForUpdate({ force: true });
  if (info) {
    console.log(formatUpdateNotice(info));
  } else {
    console.log(`claude-timed v${getVersion()} is up to date.`);
  }
  process.exit(0);
}

if (args[0] === '--stats') {
  const { showStats } = await import('../lib/stats.mjs');
  showStats(args.slice(1));
  process.exit(0);
}

if (args[0] === '--timing-help') {
  const { getVersion } = await import('../lib/update-checker.mjs');
  console.log(`claude-timed v${getVersion()} — Claude Code session timing wrapper

Usage:
  claude-timed [claude args...]       Start Claude with timing
  claude-timed --install-hook         Install the Stop hook in Claude settings
  claude-timed --uninstall-hook       Remove the Stop hook
  claude-timed --stats                Show current/most recent session stats
  claude-timed --stats today          Today's sessions
  claude-timed --stats week           Last 7 days
  claude-timed --stats month          Last 30 days
  claude-timed --stats YYYY-MM-DD     Since a specific date
  claude-timed --stats DATE1 DATE2    Custom date range
  claude-timed --stats all            All sessions
  claude-timed --stats [range] --project NAME   Filter by project name
  claude-timed --stats [range] --no-noop        Exclude noop pauses (>1h30m idle/typing)
  claude-timed --stats [range] --noop-threshold 45m  Custom noop threshold (e.g. 1h30m, 2h, 1d)
  claude-timed --version              Show version
  claude-timed --check-update         Check for updates
  claude-timed --timing-help          Show this help`);
  process.exit(0);
}

// Auto update check (cached, at most once per 24h)
try {
  const { checkForUpdate, formatUpdateNotice } = await import('../lib/update-checker.mjs');
  const updateInfo = await checkForUpdate();
  if (updateInfo) {
    process.stderr.write(formatUpdateNotice(updateInfo));
  }
} catch {
  // Never let update check prevent normal operation
}

// Default: launch the wrapper with all args passed to claude
const { startWrapper } = await import('../lib/wrapper.mjs');
startWrapper(args);
