# Contributing

Thanks for helping improve `pi-working-phrase`.

This extension is intentionally small: it customizes Pi's active working status with shuffled phrases, a colored spinner, and a shine animation. Contributions should keep that scope clear and avoid turning the extension into a general settings, command, widget, or theme framework.

## Development setup

```bash
git clone https://github.com/brandonmathis/pi-working-phrase.git
cd pi-working-phrase
npm install
npm test
npm run typecheck
npm run smoke:load
```

For local Pi testing, symlink or copy the checkout into Pi's extension directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD" ~/.pi/agent/extensions/pi-working-phrase
```

Then run `/reload` in Pi.

## Code style

- Keep runtime code dependency-free unless a dependency has a clear, release-blocking benefit.
- Prefer pure helpers for phrase, color, and shine logic so they stay easy to test.
- Keep `src/index.ts` limited to lifecycle hook registration.
- Use `ctx.hasUI` before making UI-specific updates.
- Restore Pi's default working message and indicator when the agent ends or the session shuts down.

## Testing requirements

Before opening a pull request, run:

```bash
npm run format:check
npm run typecheck
npm test
npm run smoke:load
npm run pack:check
```

For changes that affect loading or timers, also test manually in Pi:

1. Start Pi with the extension installed.
2. Send a prompt and confirm the custom spinner appears immediately.
3. Confirm the working phrase is visible and the shine animation moves.
4. Wait long enough to confirm phrase rotation.
5. Confirm the default working message and indicator restore after the agent finishes.
6. Run `/reload` and confirm no duplicate timers or duplicate statuses remain.

## Pull request checklist

- [ ] I kept the extension focused on working status customization.
- [ ] I added or updated tests for logic changes.
- [ ] I updated docs for user-facing changes.
- [ ] I manually tested `/reload` in Pi when changing extension loading behavior.
- [ ] I verified no duplicate timers continue after `agent_end` or `session_shutdown`.

## Feature boundaries

Good fits:

- Bug fixes.
- Compatibility fixes for Pi lifecycle or UI API changes.
- Documentation improvements.
- Tests and CI improvements.
- Small internal refactors.

Please avoid:

- Slash commands.
- Runtime settings mutation.
- Persisted user settings.
- Settings panels.
- Multiple theme systems.
- Widgets or footer customization.
- Random color modes.
- New runtime dependencies unless clearly justified.

## Release process

See [`docs/release-checklist.md`](docs/release-checklist.md).
