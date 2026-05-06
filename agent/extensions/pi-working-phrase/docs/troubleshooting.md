# Troubleshooting

## Extension does not load

Confirm the extension is installed at:

```txt
~/.pi/agent/extensions/pi-working-phrase/src/index.ts
```

Then run `/reload` in Pi.

If reload is not enough, restart Pi. Also confirm that the checkout includes all files imported by `src/index.ts`, such as `src/timers.ts`, `src/config.ts`, `src/phrases.ts`, `src/shine.ts`, `src/colors.ts`, and `src/phrases-rotator.ts`.

## Duplicate or conflicting status messages

Remove older local extensions that also call:

- `ctx.ui.setWorkingMessage()`
- `ctx.ui.setWorkingIndicator()`

If this extension was migrated from local experiments, check for old files such as:

- `working-verbs.ts`
- `working-shine.ts`

Only one extension should own the active working status at a time.

## Colors do not display correctly

- Check that your terminal supports truecolor ANSI escapes.
- Check your Pi theme contrast.
- Try a brighter `baseColor` in `src/config.ts`.
- Try a higher-contrast `spinnerColor`.

Markdown, logs, and non-TUI environments may show raw ANSI codes or no animation.

## Phrases are not changing

- Confirm `phrasesShuffleMs` is not set too high.
- Confirm `src/phrases.ts` has more than one non-empty phrase.
- Run `/reload` after editing `src/phrases.ts`.

With a single non-empty phrase, the extension stays in single phrase mode and only the shine animation changes.

## No changes in print or JSON mode

The extension checks `ctx.hasUI` before updating the working message or spinner. Print and JSON modes do not render Pi's interactive TUI working indicator, so there is nothing visible to update.
