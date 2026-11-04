# Cursor mode toggle

Run `/reload` once after installing `cursor-mode.ts`, then:

| Command | Result |
| --- | --- |
| `/cursor` | Toggle between the two modes |
| `/cursor hardware` | Pi hardware cursor; custom focus extension disabled |
| `/cursor drawn` | Pi drawn cursor; custom focus extension enabled |
| `/cursor status` | Show the current Pi cursor setting without changing anything |

Changes are saved globally in Pi's agent-directory `settings.json`, then applied
with the supported reload flow. No restart or second `/reload` is needed. Other
running Pi instances pick up the settings on their next reload or restart.
The command waits for the agent to finish before changing settings or reloading.

`cursor-mode.ts` stays loaded in both modes; it controls `showHardwareCursor` and
the exact inclusion/exclusion of `extensions/focus-cursor.ts`. The focus extension
itself is unchanged and cleans up its renderer patch and listeners when unloaded.
Drawn mode uses `+extensions/focus-cursor.ts`; hardware mode uses the matching `-`
entry. Other settings and extension filters are preserved.

Project settings can override global preferences. A conflicting project
`showHardwareCursor` override causes the command to warn without making changes;
remove that override first. Project extension filters or explicit CLI extension
options can also override which extensions load.

For tmux focus tracking in drawn mode, keep `set -g focus-events on` in tmux config.

## Tests

From `~/.pi`, using the managed Pi installation:

```sh
version=$(cat "$HOME/.pi/agent/install/current-version")
export PI_PACKAGE_DIR="$HOME/.pi/agent/install/releases/$version/node_modules/@earendil-works/pi-coding-agent"
node --test agent/extensions/tests/cursor-mode.test.mjs
```
