# Subscription-aware startup defaults

Automatically loaded from `~/.pi/agent/extensions/plan-default/index.ts`.

For a fresh Pi session (including `/new`):

1. Use **openai-codex/gpt-6.1-sol** if its subscription usage windows have capacity.
2. Otherwise use **anthropic/claude-opus-5-5** if its applicable subscription windows have capacity. If Codex is confirmed exhausted but Anthropic's usage endpoint fails (including HTTP 429), try Anthropic with a usage-unknown warning instead of assuming its plan is exhausted.
3. If both plans are confirmed exhausted, select **openai-codex/gpt-6.1-sol** as a last resort, with a warning. If neither plan's usage can be checked, retain Codex as the preferred unverified subscription.

The final fallback is the **same Codex subscription**, not the paid `openai` API provider. It cannot bypass a subscription limit. Unknown/unreachable usage is not treated as confirmed capacity. Capacity remaining is not a guarantee that a particular large request will fit.

Both providers must be connected through Pi's `/login` subscription flow. The extension resolves credentials through Pi (including token refresh); it does not read, copy, or log tokens. It queries the providers' usage endpoints without sending a model prompt. It does not intentionally enable extra-usage billing or count paid extra usage as subscription capacity; existing provider billing settings remain your responsibility.

## Controls

- `/plan-model`: recheck usage and apply the selection now (also useful after `/reload`).
- `pi --no-plan-default`: skip automatic selection for this invocation.
- Explicit `--model`, `-m`, or `--provider` arguments take precedence.
- Resumed/continued sessions (`--session`, `--continue`, `/resume`), forks, and `/reload` retain their selected model, even when the saved session has no conversation messages.
- Manual `/model` choices are left alone until a new session or `/plan-model`.
- This extension checks at startup, not on every prompt, and does not automatically retry a failed generation on another provider.

## Configuration

Optional `~/.pi/agent/plan-default.json` (or under `PI_CODING_AGENT_DIR`):

```json
{
  "codexModel": "gpt-6.1-sol",
  "anthropicModel": "claude-opus-5-5",
  "minimumRemainingPercent": 0,
  "timeoutMs": 5000
}
```

These model defaults match this installation. Change them to model IDs listed in `/model` if needed. Each applicable window must have **more than** `minimumRemainingPercent` left; set it to `5` for a small reserve. `timeoutMs` bounds each usage HTTP request (100–30000 ms); Pi handles OAuth refresh separately. Checks run concurrently.

Codex primary/secondary windows and exact-matching model-specific limits are checked. Anthropic shared, OAuth-app, and matching model-family weekly windows are checked. Unrelated model-specific limits are ignored. The usage endpoints are provider implementation details, so availability checks may need updating if their response formats change.

## Tests

From `~/.pi`:

```sh
node --test agent/extensions/tests/plan-default*.test.mjs
```

Tests mock HTTP/authentication and never send model requests or use real credentials. End-to-end tests launch the installed Pi CLI, verify automatic extension discovery and fresh-start routing with the Anthropic usage-endpoint 429 regression, and verify saved-model preservation for `--session` and `--continue`.
