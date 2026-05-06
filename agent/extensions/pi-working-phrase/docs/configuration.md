# Configuration

`pi-working-phrase` is configured by editing TypeScript files in the extension directory.

```txt
src/config.ts
src/phrases.ts
```

After changing either file, run `/reload` in Pi.

## Phrase customization

Edit `src/phrases.ts` and replace `workingPhrases` with your preferred messages:

```ts
export const workingPhrases = ["Reticulating splines", "Consulting sacred texts", "Shipping bugs"] as const;
```

Rules:

- Use plain strings.
- Empty strings and whitespace-only strings are ignored.
- Phrases are trimmed before display.
- Trailing `...` and `…` are removed before the configured suffix is applied.
- Longer phrase lists are fine; the extension keeps one shuffled queue in memory.

### Short phrase set

```ts
export const workingPhrases = ["Thinking", "Reading", "Planning", "Building"] as const;
```

### Longer phrase set

```ts
export const workingPhrases = [
	"Reticulating splines",
	"Consulting sacred texts",
	"Resolving GUID conflict",
	"Synthesizing wavelets",
	"Downloading RAM",
] as const;
```

### Themed phrase set

```ts
export const workingPhrases = [
	"Opening dark portal",
	"Performing arcane ritual",
	"Enscribing runes",
	"Consulting sacred texts",
] as const;
```

## Timing settings

Edit `src/config.ts`:

```ts
export const config = {
	phrasesShuffleMs: 8000,
	shineFrameMs: 60,
	shinePauseMs: 900,
	shineTrailRadius: 3,
	shineStep: 1,
	spinnerFrameMs: 80,
	// ...colors and suffix settings
} as const;
```

| Option             | Suggested range | Notes                                                     |
| ------------------ | --------------: | --------------------------------------------------------- |
| `phrasesShuffleMs` |  `3000`-`15000` | Lower values change messages more often.                  |
| `shineFrameMs`     |      `30`-`120` | Lower values animate faster and update the UI more often. |
| `shinePauseMs`     |    `300`-`2000` | Pause after each shine sweep.                             |
| `spinnerFrameMs`   |      `60`-`150` | Spinner animation speed.                                  |

`shineTrailRadius` controls how many characters around the shine peak are highlighted. `shineStep` controls how many character positions the shine advances per frame.

## Color settings

Colors use hex values:

```ts
baseColor: "#9776c7",
spinnerColor: "#50fa7b",
```

Short hex colors like `#abc` are also accepted by the color helper. Invalid colors fall back safely to white.

The shine effect derives brighter highlight colors from `baseColor`. `spinnerColor` is applied directly to every spinner frame.

Starter palettes:

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

If the phrase is hard to read, choose a brighter `baseColor` or increase contrast in your Pi theme.

## Ellipsis settings

```ts
appendEllipsis: true,
messageSuffix: "...",
```

Examples:

```ts
appendEllipsis: true,
messageSuffix: "...",
```

```ts
appendEllipsis: true,
messageSuffix: "…",
```

```ts
appendEllipsis: false,
messageSuffix: "",
```

When `appendEllipsis` is true, trailing ellipses already present in phrases are removed before `messageSuffix` is appended. This avoids doubled suffixes such as `Working......`.

## Performance notes

- Very low `shineFrameMs` values can cause frequent UI updates.
- Longer phrase lists are fine because only one shuffled queue is held in memory.
- The extension does no work in print or JSON modes because `ctx.hasUI` is checked before UI updates.
