# Shared model preferences

Edit **`models.json`** here to change preferred families, startup roles, or model hotkeys. It is the single shared policy used by:

- `../extensions/pi-control-hotkeys.ts`: newest authenticated model in each shortcut's family.
- `../extensions/plan-default/index.ts`: newest catalog Codex/Anthropic models for subscription-aware startup routing.
- `sync.mjs`: resolves the same policy and updates Pi's concrete `defaultProvider`/`defaultModel` in `../settings.json`.

There are no version numbers to bump in extension code. `index.mjs` compares release versions numerically and ignores preview/experimental suffixes. Anthropic dated snapshots do not outrank newer semantic releases; an undated alias wins a same-version tie. If providers change their naming conventions, update this resolver and its tests rather than guessing IDs.

## Current controls

| Action | Model preference |
| --- | --- |
| ⌘1 / Ctrl+Alt+1 | Latest Codex Astra |
| ⌘2 / Ctrl+Alt+2 | Latest Codex Sol |
| ⌘3 / Ctrl+Alt+3 | Latest Codex Luna |
| Fresh startup, preferred | Latest Codex Sol |
| Subscription fallback | Latest Anthropic Opus |

Sonnet and Haiku are included for update reporting and future reuse, but have no new hotkeys. Families advance independently: a new Sol release does not imply a matching Luna release exists. Ctrl+Alt alternatives work through tmux, which does not preserve Super/Command. Ctrl+Shift+Tab still cycles thinking backward.

## Refresh models

In this repository, run **`/skill:update-models`** after `/reload` (needed once to discover the new skill).

Or run manually, from the repository root:

```sh
pi update --models
node agent/model-preferences/sync.mjs         # preview; no settings writes
node agent/model-preferences/sync.mjs --write # sync the concrete startup setting
node agent/model-preferences/sync.mjs --check # nonzero if settings need sync
```

The script uses the public `pi --list-models` catalog and does not send model prompts. It fails before writing if any configured family is unavailable; check `/login` rather than substituting a paid API provider. Existing settings are preserved apart from the two startup model fields. `PI_CODING_AGENT_DIR` overrides the agent directory for the script and extensions.

After catalog refresh, `/reload` refreshes the active runtime. Hotkeys resolve on every press; shortcut binding changes require `/reload`. Fresh sessions and `/plan-model` resolve the shared startup preferences. `/reload` alone does not replace the active model; use ⌘2 or `/plan-model` when you want to switch now. Explicit CLI choices, resumes, and forks remain respected.

Pi's settings require an exact model ID, so `settings.json` is a generated projection, not another policy source. Run the sync script after refreshing catalogs, especially if using `--no-plan-default`. Existing explicit `codexModel`/`anthropicModel` pins in `plan-default.json` still override the shared startup families; remove those pins to follow updates automatically. Quota thresholds, timeouts, and credit policy remain in `plan-default.json`.

## Tests

```sh
node --test agent/extensions/tests/model-preferences.test.mjs \
  agent/extensions/tests/pi-control-hotkeys.test.mjs \
  agent/extensions/tests/plan-default*.test.mjs
```

Tests use synthetic catalogs and mocked usage/authentication. They do not issue model requests.
