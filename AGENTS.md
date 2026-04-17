# claude-timed

CLI wrapper that instruments Claude Code sessions with timing data.

## Versioning

This project uses semantic versioning. The version in `package.json` is the source of truth and is read at runtime by `lib/update-checker.mjs`.

On every bug fix or new feature, you MUST:

1. Bump the version in `package.json` (patch for fixes, minor for features).
2. Add a corresponding entry to `updates.json` with:
   - `version`: the new version string
   - `notes`: short description of what changed
   - `steps`: array of commands the user must run to update. Always include `"git pull"`. Add `"npm install"` if dependencies changed, `"claude-timed --install-hook"` if hooks changed. Custom steps can be appended.
