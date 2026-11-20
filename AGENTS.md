# Agent instructions

- Never modify Pi's source code directly (including installed package files under `node_modules`). Use a supported extension/API or request an upstream feature instead.
- Model policy is shared in `agent/model-preferences/`. For Codex/Anthropic model refreshes, use this project's `/skill:update-models` (`.pi/skills/update-models/SKILL.md`) instead of hardcoding versions in extensions.
