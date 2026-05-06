# pi-working-phrase

A tiny Pi extension that replaces Pi's working status with shuffled phrases, a colored spinner, and an animated shine gradient.

## Preview

When Pi is responding, the standard working line is replaced with messages like:

```txt
⠋ Reticulating splines...
⠙ Consulting sacred texts...
⠹ Downloading RAM...
```

The spinner is colorized, and the phrase text gets an ANSI shine sweep in Pi's TUI. Markdown previews cannot reliably show that animation, so the snippet above is a plain-text fallback.

## Features

- Shuffled working phrases while Pi is responding.
- Configurable phrase shuffle speed.
- Animated shine gradient on the working message.
- Single configurable base color for the shine effect.
- Configurable spinner color.
- Configurable shine animation speed.
- No runtime dependencies.
- Restores Pi defaults when the agent finishes or the session shuts down.

## Requirements

- Pi coding agent installed.
- Node.js compatible with your installed Pi release.
- Extension installed in a Pi auto-discovery location.

Requires Pi with extension auto-discovery support. This extension is written in TypeScript and is loaded by Pi directly; no build step is required for local use.

## Installation

> Extensions run with your local system permissions. Review the source before installing any extension.

### Option A: Local user extension install

From the parent directory that contains `pi-working-phrase`:

```bash
mkdir -p ~/.pi/agent/extensions
cp -R pi-working-phrase ~/.pi/agent/extensions/pi-working-phrase
```

Then run in Pi:

```txt
/reload
```

### Option B: Git clone install

After this project is published as a standalone repository:

```bash
git clone https://github.com/brandonmathis/pi-working-phrase.git ~/.pi/agent/extensions/pi-working-phrase
```

Then run `/reload` in Pi.

### Option C: Pi package install

This repository includes Pi package metadata. After the repository is published, install with:

```bash
pi install git:github.com/brandonmathis/pi-working-phrase
```

For local package testing, use an absolute or relative path:

```bash
pi install /path/to/pi-working-phrase
```

## Usage

Start using Pi normally. When Pi begins responding, `pi-working-phrase` sets a custom working message and spinner. When the response completes, the extension restores Pi's defaults.

No slash commands are added by this extension.

After editing config or phrases, run `/reload` in Pi.

## Configuration quick start

Customize the extension by editing these files:

```txt
src/config.ts
src/phrases.ts
```

### Change phrases

```ts
export const workingPhrases = ["Reticulating splines", "Consulting sacred texts", "Shipping bugs"] as const;
```

### Change phrase shuffle speed

```ts
phrasesShuffleMs: 5000,
```

### Change shine color

```ts
baseColor: "#8b5cf6",
```

### Change spinner color

```ts
spinnerColor: "#22c55e",
```

### Change shine speed

```ts
shineFrameMs: 40,
```

See [`docs/configuration.md`](docs/configuration.md) for detailed guidance and examples.

## Full configuration table

| Option             |     Default | Description                                                   |
| ------------------ | ----------: | ------------------------------------------------------------- |
| `phrasesShuffleMs` |      `8000` | Milliseconds between phrase changes.                          |
| `shineFrameMs`     |        `60` | Milliseconds between shine animation frames. Lower is faster. |
| `shinePauseMs`     |       `900` | Pause duration after a shine sweep finishes.                  |
| `shineTrailRadius` |         `3` | Number of characters affected around the shine peak.          |
| `shineStep`        |         `1` | Number of character positions advanced per frame.             |
| `baseColor`        | `"#9776c7"` | Base text color used to derive the shine gradient.            |
| `spinnerColor`     | `"#50fa7b"` | ANSI foreground color for spinner frames.                     |
| `appendEllipsis`   |      `true` | Whether to append a suffix to phrases.                        |
| `messageSuffix`    |     `"..."` | Suffix appended when `appendEllipsis` is enabled.             |
| `spinnerFrameMs`   |        `80` | Milliseconds between spinner animation frames.                |

## How phrase rotation works

- Phrases are trimmed.
- Empty phrases are ignored.
- Trailing `...` or `…` is removed before formatting.
- Phrases are shuffled.
- Immediate repeats are avoided when possible.

## Project structure

```txt
pi-working-phrase/
├── src/
│   ├── index.ts             # Pi lifecycle hooks only
│   ├── config.ts            # User-editable settings
│   ├── phrases.ts           # User-editable phrase list
│   ├── colors.ts            # ANSI and hex color helpers
│   ├── shine.ts             # Shine animation state/rendering
│   ├── phrases-rotator.ts   # Phrase normalization and shuffling
│   └── timers.ts            # Timer lifecycle and Pi UI updates
├── tests/
├── scripts/
└── docs/
```

## Troubleshooting summary

- Extension did not load: verify the install path and run `/reload`.
- Duplicate working messages: remove older working-status extensions.
- Colors look wrong: your terminal or theme may handle ANSI colors differently.
- No visible changes in print or JSON mode: this extension only updates UI when `ctx.hasUI` is true.

See [`docs/troubleshooting.md`](docs/troubleshooting.md) for practical fixes.

## Compatibility and scope

This extension intentionally does not provide slash commands, persisted settings, widgets, external config files, settings panels, or multiple themes. Configuration is done by editing `src/config.ts` and `src/phrases.ts`.

Tested during release preparation with Pi `0.72.1` and Node.js `24.4.1` on macOS. Truecolor appearance depends on your terminal and Pi theme.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

Good contributions include bug fixes, compatibility fixes, documentation improvements, tests, CI improvements, and small internal refactors. Please avoid scope creep such as settings UIs, command layers, package dependencies, or unrelated footer/widget features.

## License

[MIT](LICENSE)
