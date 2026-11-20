---
name: update-models
description: Refresh this Pi configuration project's Codex and Anthropic models, synchronize the saved default, and verify Command hotkeys and subscription fallback. Use when new models are released or asked to update model defaults or shortcuts.
---

# Update Pi model preferences

This is a maintenance skill for this configuration repository, not a model-provider implementation task.

## Shared source of truth

Resolve paths relative to this skill directory:

- `../../../agent/model-preferences/README.md`: read first for policy and commands.
- `../../../agent/model-preferences/models.json`: shared families, startup aliases, and hotkey bindings.
- `../../../agent/model-preferences/index.mjs`: shared latest-stable resolver.
- `../../../agent/model-preferences/sync.mjs`: catalog preview and saved-default synchronization.
- `../../../agent/settings.json`: Pi's generated concrete startup model fields.

The repository root is `../../..` relative to this directory. Run the commands below from that root. If `PI_CODING_AGENT_DIR` is set, check that it points to the intended installation before changing anything; stop and clarify a mismatch rather than updating another agent directory.

## Workflow

1. Read the shared README and config, `AGENTS.md`, and the relevant installed Pi documentation (`models.md`, `settings.md`; also `extensions.md` and relevant examples if code changes are needed). Inspect `git status` and any existing `agent/plan-default.json` model pins. Preserve unrelated local changes. Never read or print credentials.
2. Refresh only model catalogs with `pi update --models`. Do **not** run bare `pi update`, upgrade packages, modify Pi source, or edit installed `node_modules`. If refreshing fails, report the failure and distinguish cached catalog results from verified fresh results; do not claim the models are current.
3. Run `pi --list-models` and `node agent/model-preferences/sync.mjs` to preview actual available Codex and Anthropic IDs. Use Pi's authenticated catalog as the availability source, not guessed names or a web announcement alone. If a release was requested but is missing, consult current official provider/Pi documentation using web tools when available. Report that it is not yet selectable instead of registering invented models or metadata.
4. Keep existing family roles and keys unless the user explicitly asks to change them: ⌘1/Ctrl+Alt+1 = Astra, ⌘2/Ctrl+Alt+2 = Sol, ⌘3/Ctrl+Alt+3 = Luna; startup = Codex Sol; subscription fallback = Anthropic Opus. Report Sonnet and Haiku updates too. Resolve each family independently; no 6.2 Luna is assumed just because 6.2 Sol exists. Stable versions only; never substitute the paid `openai` API for `openai-codex`.
5. Usually no policy/code edits are needed: the resolver selects the latest stable release automatically. If a family is renamed or the ID format changes, verify official names and actual catalog entries first, then make targeted changes in the shared config/resolver and add regression tests. Do not duplicate model versions in the hotkey or startup extensions. Do not silently remove explicit pins in `plan-default.json`; explain their effect and ask before changing intentional pins.
6. Run `node agent/model-preferences/sync.mjs --write`, then `node agent/model-preferences/sync.mjs --check`. This only synchronizes `defaultProvider` and `defaultModel`; preserve thinking levels, packages, credentials, quota thresholds, and credit policy. Stop on missing families/authentication rather than downgrading providers.
7. Verify:

   ```sh
   node --test agent/extensions/tests/model-preferences.test.mjs \
     agent/extensions/tests/pi-control-hotkeys.test.mjs \
     agent/extensions/tests/plan-default*.test.mjs
   git diff --check
   git diff --stat
   ```

   Also inspect the final diff for accidental scope changes. Tests must use mocked usage/authentication, not paid model prompts. Do not rewrite historical sessions or test fixtures merely because they contain older model IDs: old IDs are important regression cases for upgrades and session preservation.
8. Summarize the resolved default, fallback, and each existing hotkey's exact model ID, plus changed files and test results. Tell the operator to use `/reload` to refresh the active runtime. Reload preserves the selected model; ⌘2 or `/plan-model` selects the refreshed preference now. New sessions use the new default; resumed/forked sessions retain their recorded choices. Do not claim a live session or terminal shortcut was exercised unless it actually was.
