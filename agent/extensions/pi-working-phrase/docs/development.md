# Development

## Local setup

```bash
git clone https://github.com/brandonmathis/pi-working-phrase.git
cd pi-working-phrase
npm install
```

Run checks:

```bash
npm run format:check
npm run typecheck
npm test
npm run smoke:load
npm run pack:check
```

Install locally for Pi testing:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD" ~/.pi/agent/extensions/pi-working-phrase
```

Then run `/reload` in Pi.

## Architecture

- `src/index.ts`: Pi lifecycle hook registration only.
- `src/timers.ts`: Pi UI/timer coordination.
- `src/phrases-rotator.ts`: pure phrase normalization, shuffling, and repeat avoidance.
- `src/shine.ts`: shine animation state and rendering.
- `src/colors.ts`: ANSI and hex color helpers.
- `src/config.ts`: user-editable animation and color settings.
- `src/phrases.ts`: user-editable phrase list.

## Testing strategy

- Unit tests cover pure modules (`src/phrases-rotator.ts`, `src/colors.ts`, and `src/shine.ts`).
- Fake timers and a fake `ExtensionContext` cover timer/controller behavior.
- `scripts/smoke-load.mjs` loads `src/index.ts` through Jiti and simulates Pi lifecycle events.

## Manual test checklist

- [ ] Load Pi with the extension installed.
- [ ] Trigger an agent response.
- [ ] Confirm custom spinner appears.
- [ ] Confirm phrase appears immediately.
- [ ] Confirm shine animation moves.
- [ ] Wait for phrase shuffle.
- [ ] Confirm defaults restore when response ends.
- [ ] Run `/reload`.
- [ ] Confirm no duplicate timers or duplicate statuses appear.

## Scope boundaries

Keep the extension small and readable. Avoid runtime dependencies, unrelated UI features, settings panels, slash commands, persisted settings, widgets, and footer customization unless the project scope intentionally changes.
