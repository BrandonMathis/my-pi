# Examples

Copy these examples into `src/config.ts` or `src/phrases.ts`, then run `/reload` in Pi.

## Minimal phrase list

```ts
export const workingPhrases = ["Thinking", "Reading", "Writing"] as const;
```

## Fast animation preset

```ts
export const config = {
	phrasesShuffleMs: 3000,
	shineFrameMs: 35,
	shinePauseMs: 500,
	shineTrailRadius: 4,
	shineStep: 1,
	baseColor: "#8b5cf6",
	spinnerColor: "#22c55e",
	appendEllipsis: true,
	messageSuffix: "...",
	spinnerFrameMs: 60,
} as const;
```

## Low-motion preset

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

## High-contrast colors

```ts
baseColor: "#38bdf8",
spinnerColor: "#facc15",
```

## No ellipsis

```ts
appendEllipsis: false,
messageSuffix: "",
```

## Single phrase mode

```ts
export const workingPhrases = ["Working locally"] as const;
```

The phrase will stay the same, while the shine animation and spinner continue to animate during agent responses.
