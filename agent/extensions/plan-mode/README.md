# Plan Mode Extension

Adds a Claude Code-style planning workflow to pi.

## Commands

- `/plan` — toggle plan mode
- `/plan on` — enable read-only planning mode
- `/plan off` — disable plan mode
- `/plan execute` — rewind to the pre-plan branch point and execute the saved plan on a fresh execution branch
- `/plan status` — show saved plan progress
- `/plan reset` — clear saved plan state
- `/todos` — show the current saved plan

## Behavior

When plan mode is enabled:

- active tools are restricted to read-only built-ins: `read`, `bash`, `grep`, `find`, `ls`
- bash is further restricted to a read-only allowlist
- the current session leaf is recorded as the pre-plan branch point
- pi is instructed to analyze first and respond with a numbered `Plan:` section
- plans are extracted and saved automatically

When execution starts:

- pi navigates back to the pre-plan branch point
- a fresh execution branch is created from there so planning-only conversation does not carry over
- the previous tool set is restored
- the saved plan is injected back into context
- pi is told to emit `[DONE:n]` markers as each step finishes
- a progress widget is shown in the UI

## Install / reload

This extension is auto-discovered from `~/.pi/agent/extensions/plan-mode/index.ts`.

Run `/reload` inside pi to load it.

## Shortcut

- `Ctrl+Alt+P` — toggle plan mode
