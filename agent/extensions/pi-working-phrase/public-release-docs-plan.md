# pi-working-phrase Public Release Docs and Quality Plan

## Goal

Prepare `pi-working-phrase` for public release as a small Pi extension that customizes the active working status with shuffled phrases, a configurable spinner color, and an animated shine gradient.

The public docs should make the extension easy to install, easy to customize, and easy to maintain without expanding the feature scope beyond custom working statuses.

---

## Recommended Documentation Set

### Required for first public release

```txt
README.md
LICENSE
CHANGELOG.md
CONTRIBUTING.md
docs/configuration.md
docs/release-checklist.md
```

### Nice-to-have after first release

```txt
docs/development.md
docs/troubleshooting.md
docs/examples.md
.github/ISSUE_TEMPLATE/bug_report.yml
.github/ISSUE_TEMPLATE/feature_request.yml
.github/pull_request_template.md
.github/workflows/ci.yml
```

---

## README.md Plan

### 1. Title and one-line pitch

Recommended opening:

```md
# pi-working-phrase

A tiny Pi extension that replaces Pi's working status with shuffled phrases, a colored spinner, and an animated shine gradient.
```

Include badges only if backed by real automation:

- CI status
- npm version, if published to npm
- license

Avoid placeholder badges.

### 2. Preview

Show the behavior before installation details.

Recommended content:

- Short animated GIF or terminal recording showing:
  - Working phrase changing
  - Shine animation sweeping over the text
  - Colored spinner
- Plain text fallback for environments where images do not render:

```md
⠋ Reticulating splines...
⠙ Consulting sacred texts...
⠹ Downloading RAM...
```

Note that ANSI shine is visual in Pi's TUI and may not render in markdown.

### 3. Features

Keep this scoped to the implemented feature set:

- Shuffled working phrases while Pi is responding
- Configurable phrase shuffle speed
- Animated shine gradient on the working message
- Single configurable base color for the shine effect
- Configurable spinner color
- Configurable shine animation speed
- No runtime dependencies
- Restores Pi defaults when the agent finishes or the session shuts down

Do not advertise commands, settings UI, persisted settings, themes, widgets, or external config unless those features are intentionally added later.

### 4. Requirements

Document expected runtime:

- Pi coding agent installed
- Node.js version supported by the current Pi release
- Extension installed in a Pi auto-discovery location

Example:

```md
Requires Pi with extension auto-discovery support. This extension is written in TypeScript and is loaded by Pi directly; no build step is required for local use.
```

### 5. Installation

Cover the expected public install paths.

#### Option A: Local user extension install

```bash
mkdir -p ~/.pi/agent/extensions
cp -R pi-working-phrase ~/.pi/agent/extensions/pi-working-phrase
```

Then:

```txt
/reload
```

#### Option B: Git clone install

If released as a standalone repo:

```bash
git clone https://github.com/<owner>/pi-working-phrase.git ~/.pi/agent/extensions/pi-working-phrase
```

#### Option C: Pi package install

Only include this if package metadata is added and tested:

```bash
pi install git:github.com/<owner>/pi-working-phrase
```

or:

```bash
pi install npm:pi-working-phrase
```

Add this section only after verifying Pi package discovery works for the chosen package layout.

### 6. Usage

Explain that no commands are needed:

```md
Start using Pi normally. When Pi begins responding, `pi-working-phrase` sets a custom working message and spinner. When the response completes, the extension restores Pi's defaults.
```

Mention reload:

```md
After editing config or phrases, run `/reload` in Pi.
```

### 7. Configuration quick start

Point users to the two intended customization files:

```txt
config.ts
phrases.ts
```

Show the minimal examples.

#### Change phrases

```ts
export const workingPhrases = [
  "Reticulating splines",
  "Consulting sacred texts",
  "Shipping bugs",
] as const;
```

#### Change phrase shuffle speed

```ts
phrasesShuffleMs: 5000,
```

#### Change shine color

```ts
baseColor: "#8b5cf6",
```

#### Change spinner color

```ts
spinnerColor: "#22c55e",
```

#### Change shine speed

```ts
shineFrameMs: 40,
```

### 8. Full configuration table

Include a table matching `config.ts`.

| Option | Default | Description |
| --- | ---: | --- |
| `phrasesShuffleMs` | `8000` | Milliseconds between phrase changes. |
| `shineFrameMs` | `60` | Milliseconds between shine animation frames. Lower is faster. |
| `shinePauseMs` | `900` | Pause duration after a shine sweep finishes. |
| `shineTrailRadius` | `3` | Number of characters affected around the shine peak. |
| `shineStep` | `1` | Number of character positions advanced per frame. |
| `baseColor` | `"#9776c7"` | Base text color used to derive the shine gradient. |
| `spinnerColor` | `"#50fa7b"` | ANSI foreground color for spinner frames. |
| `appendEllipsis` | `true` | Whether to append a suffix to phrases. |
| `messageSuffix` | `"..."` | Suffix appended when `appendEllipsis` is enabled. |
| `spinnerFrameMs` | `80` | Milliseconds between spinner animation frames. |

### 9. How phrase rotation works

Briefly explain behavior so users know what to expect:

- Phrases are trimmed
- Empty phrases are ignored
- Trailing `...` or `…` is removed before formatting
- Phrases are shuffled
- Immediate repeats are avoided when possible

### 10. Project structure

Document the current architecture:

```txt
pi-working-phrase/
├── index.ts             # Pi lifecycle hooks only
├── config.ts            # User-editable settings
├── phrases.ts           # User-editable phrase list
├── colors.ts            # ANSI and hex color helpers
├── shine.ts             # Shine animation state/rendering
├── phrases-rotator.ts   # Phrase normalization and shuffling
└── timers.ts            # Timer lifecycle and Pi UI updates
```

### 11. Troubleshooting summary

README should include a short troubleshooting section and link to `docs/troubleshooting.md` if that file exists.

Common issues:

- Extension did not load: verify path and run `/reload`
- Duplicate working messages: remove older working-status extensions
- Colors look wrong: terminal/theme may handle ANSI differently
- No visible changes in non-interactive mode: extension only updates UI when `ctx.hasUI` is true

### 12. Compatibility and scope

Be explicit:

```md
This extension intentionally does not provide slash commands, persisted settings, widgets, external config files, settings panels, or multiple themes. Configuration is done by editing `config.ts` and `phrases.ts`.
```

### 13. Contributing link

Link to `CONTRIBUTING.md` and summarize acceptable changes:

- Bug fixes
- Compatibility fixes
- Documentation improvements
- Tests and CI improvements
- Small internal refactors

Discourage scope creep:

- No settings UI
- No command layer
- No package dependencies unless clearly justified
- No unrelated footer/widget features

### 14. License

Link to the license file and make sure the chosen license is present before publishing.

---

## `docs/configuration.md` Plan

Purpose: Give more detailed customization guidance than the README.

Recommended sections:

1. **Configuration overview**
   - Users edit `config.ts` and `phrases.ts`
   - Run `/reload` after changes

2. **Phrase customization**
   - Plain strings only
   - Empty phrases are ignored
   - Trailing ellipses are normalized
   - Examples of short, long, and themed phrase sets

3. **Timing settings**
   - `phrasesShuffleMs`
   - `shineFrameMs`
   - `shinePauseMs`
   - `spinnerFrameMs`
   - Suggested ranges:
     - Phrase shuffle: `3000`-`15000`
     - Shine frame: `30`-`120`
     - Spinner frame: `60`-`150`

4. **Color settings**
   - Hex color format examples
   - Explain that shine derives highlights from `baseColor`
   - Good starter palettes:

```ts
baseColor: "#9776c7",
spinnerColor: "#50fa7b",
```

```ts
baseColor: "#8b5cf6",
spinnerColor: "#22c55e",
```

```ts
baseColor: "#38bdf8",
spinnerColor: "#facc15",
```

5. **Ellipsis settings**
   - `appendEllipsis`
   - `messageSuffix`
   - Examples for `"..."`, `"…"`, and `""`

6. **Performance notes**
   - Very low `shineFrameMs` values can cause frequent UI updates
   - Longer phrase lists are fine because only one shuffled queue is held in memory

---

## `docs/troubleshooting.md` Plan

Purpose: Keep README concise while offering practical fixes.

Recommended sections:

1. **Extension does not load**
   - Confirm path:

```txt
~/.pi/agent/extensions/pi-working-phrase/index.ts
```

   - Run `/reload`
   - Restart Pi if reload is not enough

2. **Duplicate or conflicting status messages**
   - Remove older local extensions that call:
     - `ctx.ui.setWorkingMessage()`
     - `ctx.ui.setWorkingIndicator()`
   - Specifically mention old local files if this repo migrates from them:
     - `working-verbs.ts`
     - `working-shine.ts`

3. **Colors do not display correctly**
   - Check terminal truecolor support
   - Check theme contrast
   - Try a brighter `baseColor`

4. **Phrases are not changing**
   - Confirm `phrasesShuffleMs` is not too high
   - Confirm phrase list has more than one non-empty phrase

5. **No changes in print or JSON mode**
   - Explain `ctx.hasUI` guard

---

## `docs/development.md` Plan

Purpose: Help contributors and maintainers work on the extension safely.

Recommended sections:

1. **Local setup**
   - Clone repo
   - Install dev dependencies, if a package is added
   - Symlink or copy into `~/.pi/agent/extensions/pi-working-phrase`

2. **Architecture**
   - `index.ts`: Pi lifecycle only
   - `timers.ts`: Pi UI/timer coordination
   - `phrases-rotator.ts`: pure phrase logic
   - `shine.ts`: pure-ish animation renderer
   - `colors.ts`: pure ANSI/color helpers

3. **Testing strategy**
   - Unit tests for pure modules
   - Fake `ExtensionContext` for timer/controller behavior
   - Jiti smoke test for loading `.ts` files the way Pi does

4. **Manual test checklist**
   - Load Pi
   - Trigger agent response
   - Confirm custom spinner appears
   - Confirm phrase appears immediately
   - Confirm shine animation moves
   - Wait for phrase shuffle
   - Confirm defaults restore when response ends
   - Run `/reload`
   - Confirm no duplicate timers or duplicate statuses

5. **Scope boundaries**
   - Keep extension small
   - Avoid runtime dependencies
   - Avoid unrelated UI features

---

## `docs/examples.md` Plan

Purpose: Give copy-paste customization examples without bloating the README.

Recommended examples:

1. **Minimal phrase list**
2. **Fast animation preset**
3. **Low-motion preset**
4. **High-contrast colors**
5. **No ellipsis**
6. **Single phrase mode**

Example low-motion preset:

```ts
export const config = {
  phrasesShuffleMs: 12000,
  shineFrameMs: 120,
  shinePauseMs: 1500,
  shineTrailRadius: 2,
  shineStep: 1,
  baseColor: "#9776c7",
  spinnerColor: "#50fa7b",
  appendEllipsis: true,
  messageSuffix: "...",
  spinnerFrameMs: 120,
} as const;
```

---

## `CONTRIBUTING.md` Plan

Recommended sections:

1. **Thanks and project scope**
2. **Development setup**
3. **Code style**
4. **Testing requirements**
5. **Pull request checklist**
6. **Feature boundaries**
7. **Release process link**

Suggested PR checklist:

```md
- [ ] I kept the extension focused on working status customization.
- [ ] I added or updated tests for logic changes.
- [ ] I updated docs for user-facing changes.
- [ ] I manually tested `/reload` in Pi when changing extension loading behavior.
- [ ] I verified no duplicate timers continue after `agent_end` or `session_shutdown`.
```

---

## `CHANGELOG.md` Plan

Use Keep a Changelog style.

Initial version:

```md
# Changelog

## [0.1.0] - YYYY-MM-DD

### Added
- Shuffled working phrases.
- Configurable phrase shuffle speed.
- Animated shine gradient.
- Configurable shine base color.
- Configurable spinner color.
- Configurable shine and spinner animation speeds.
```

---

## `docs/release-checklist.md` Plan

Recommended checklist:

```md
# Release Checklist

- [ ] README installation instructions match the actual package layout.
- [ ] `LICENSE` exists.
- [ ] `CHANGELOG.md` has the new version and date.
- [ ] TypeScript check passes.
- [ ] Unit tests pass.
- [ ] Jiti/Pi load smoke test passes.
- [ ] Manual Pi `/reload` test passes.
- [ ] Old duplicate local extensions are not included in packaged output.
- [ ] `npm pack --dry-run` output contains only intended files, if publishing to npm.
- [ ] GitHub release notes summarize user-facing changes.
```

---

## Low-Hanging Quality Checks Before Public Release

### 1. Add a minimal `package.json`

Even if the extension has no runtime dependencies, a package file gives maintainers scripts and metadata.

Recommended scripts:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "smoke:load": "node scripts/smoke-load.mjs",
    "pack:check": "npm pack --dry-run"
  }
}
```

If publishing as a Pi package, include the correct `pi` metadata only after testing it:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

### 2. Add `tsconfig.json`

Use strict TypeScript checks across extension files.

Recommended characteristics:

- `strict: true`
- `noEmit: true`
- `target: ES2022` or current Pi-compatible target
- `moduleResolution: Bundler`
- `skipLibCheck: true`

### 3. Add unit tests for pure modules

High-value tests:

#### `phrases-rotator.test.ts`

- Trims phrases
- Removes empty phrases
- Removes trailing `...` and `…`
- Appends suffix exactly once
- Avoids immediate repeats when possible
- Handles empty phrase list with `Working...`

#### `colors.test.ts`

- Accepts `#rrggbb`
- Accepts short `#rgb`, if supported
- Produces ANSI truecolor escape sequences
- Falls back safely for invalid colors
- Shine color for distance `0` is brighter than base color

#### `shine.test.ts`

- Renders ANSI-colored output
- Preserves spaces
- Handles empty messages
- Advances forward and reverse without throwing
- Resets when message changes

#### `timers.test.ts`

Use fake timers and a fake `ExtensionContext`:

- `start()` sets spinner and first message immediately
- `start()` clears previous timers before creating new timers
- `stop()` clears timers
- `stop(ctx)` restores default working message and indicator
- `start(ctx)` does nothing UI-specific when `ctx.hasUI` is false

### 4. Add a Pi/Jiti load smoke test

Create `scripts/smoke-load.mjs` that loads `index.ts` through the same TypeScript runtime style Pi uses, then asserts:

- Default export is a function
- It registers `agent_start`, `agent_end`, and `session_shutdown`
- Simulated lifecycle calls do not throw

This catches broken imports and extension entrypoint mistakes quickly.

### 5. Add GitHub Actions CI

Minimum CI jobs:

- Install dependencies
- Run format check
- Run typecheck
- Run unit tests
- Run smoke load test
- Run package dry-run, if publishing

Use a Node.js version matching Pi's supported runtime. Add a matrix only if compatibility across multiple Node versions matters.

### 6. Add formatter and linting

Low-friction options:

- Prettier for formatting
- ESLint or Biome for linting, if the repo already uses one

Keep lint rules practical. Avoid spending release time on a large ruleset.

### 7. Add `.editorconfig`

Small maintainer QoL improvement:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = tab
indent_size = 2

[*.md]
indent_style = space
indent_size = 2
```

Adjust indentation rules to match the final code style.

### 8. Add issue and PR templates

Useful templates:

- Bug report
- Documentation issue
- Feature request with a scope reminder
- Pull request template with test checklist

For feature requests, explicitly ask whether the requested change fits working-status customization.

### 9. Add a release checklist

Make releases repeatable and reduce accidental broken package uploads.

Include:

- Version bump
- Changelog update
- CI green
- Manual `/reload` test
- Package contents check
- Git tag
- Release notes

### 10. Add package contents controls

If publishing to npm, avoid shipping local scratch files.

Use one of:

- `files` field in `package.json`
- `.npmignore`

Recommended package contents:

```txt
index.ts
config.ts
phrases.ts
colors.ts
shine.ts
phrases-rotator.ts
timers.ts
README.md
LICENSE
CHANGELOG.md
docs/
```

Exclude:

```txt
public-release-docs-plan.md
coverage/
node_modules/
*.log
```

### 11. Add screenshots or terminal recording

A visual preview will help public users understand the extension instantly.

Recommended artifacts:

- `docs/assets/demo.gif`
- `docs/assets/screenshot.png`

Keep image sizes reasonable.

### 12. Add compatibility notes

Document:

- Tested Pi version
- Tested terminal environment
- Expected truecolor behavior
- Non-interactive mode behavior

### 13. Add dependency update automation only if dependencies are added

If the package remains dependency-free at runtime, Dependabot/Renovate is mostly useful for dev dependencies and GitHub Actions versions.

### 14. Add CODEOWNERS if maintaining with multiple people

Useful once there is more than one maintainer:

```txt
* @owner
```

### 15. Add a small manual QA script

A simple markdown checklist is enough. Do not over-engineer.

Manual QA should verify:

- Fresh install
- `/reload`
- First render appears immediately
- Phrase shuffles
- Shine animates
- Spinner is colored
- Defaults restore after agent completes
- Session shutdown does not leave timers running

---

## Recommended Pre-Release Implementation Tasks

Prioritize in this order:

1. Add `README.md` with install, usage, configuration, and troubleshooting basics.
2. Add `LICENSE`.
3. Add `CHANGELOG.md` with initial version.
4. Add `tsconfig.json` and `npm run typecheck`.
5. Add unit tests for `phrases-rotator.ts`, `colors.ts`, and `shine.ts`.
6. Add fake-timer tests for `timers.ts`.
7. Add Jiti/Pi load smoke test.
8. Add GitHub Actions CI.
9. Add `CONTRIBUTING.md` and PR template.
10. Add `docs/configuration.md` for deeper customization guidance.
11. Add a demo GIF or screenshot.
12. Add release checklist and package dry-run check.

---

## Scope Guardrails for Public Release

These additions are useful but should stay out of the first public release unless there is a strong reason:

- Slash commands
- Runtime settings mutation
- Persisted user settings
- External config files
- Settings panels
- Multiple theme systems
- Widgets or footer customization
- Random color modes
- New runtime dependencies

The extension's public value is that it is small, readable, local, and easy to edit.
