# `/loop` — fresh-session recurring tasks

Local prototype for Pi. Automatically discovered from `~/.pi/agent/extensions/loop/index.ts`.
Run `/reload` in an existing Pi session, or restart Pi. No dependency installation is needed.

```text
/loop 5m check whether CI passed for PR 123 and summarize failures
/loop check the staging deployment at https://example.com/health
/loop 30s inspect build.log and summarize any new errors
/loop status
/loop stop
```

The task must be self-contained: each iteration has **no conversation history**, including
no memory of previous iterations. Use explicit PR numbers, URLs, paths, and instructions.
For comparisons between runs, explicitly ask the task to read/write a checkpoint file.

## Commands

| Command | Behavior |
| --- | --- |
| `/loop [interval] <task>` | Start one recurring task. Default: **5 minutes**. |
| `/loop default` | Show the default interval. |
| `/loop default 10m` | Change the default for future loops in this extension runtime. |
| `/loop status` | Show task, cadence, next eligible run, run count, last error, and last run directory. |
| `/loop stop` | Cancel the timer and terminate an active iteration. Safe to repeat. |
| `/loop` or `/loop help` | Show help. Does not start work. |
| `/loop -- <task>` | Force task-only parsing, e.g. `/loop -- stop the test server if it is unhealthy`. |

Intervals use `s`, `m`, `h`, or `d`, case-insensitively. Fractions such as `1.5m` work.
Range: 1 second–7 days. Very short intervals can be expensive.
An explicit interval must be followed by a task. Natural-language intervals, compound
intervals, cron expressions, and direct slash-command/skill dispatch are not implemented.
Tasks are natural-language instructions, not shell commands.

Only one loop can run in the originating session. Stop it before scheduling another.
Defaults and schedules are in memory, not saved across reloads or restarts.

## Execution and lifecycle

- The **first run waits one interval**. After each run finishes or fails, the scheduler
  waits another full interval. This is fixed-delay scheduling, not wall-clock cron.
- A run starts only when the originating Pi session is idle with no queued messages.
  Busy periods and sleep/wake coalesce into one run, never a backlog of missed runs.
- Every run launches a **fresh Node-hosted Pi CLI process and persisted session**.
  No `--continue`, `--resume`, `--fork`, or parent transcript is supplied.
  The active interactive session is never replaced. No subagent package is needed.
- The working directory, provider/model, thinking level, and project-trust decision
  are captured when the loop is created. Later `/model` changes do not change it.
- Children load the normal on-disk Pi configuration, instructions, extensions, skills,
  and MCP servers. Parent-only CLI overrides, unsaved settings, dynamic tool selections,
  and runtime-only provider registrations are **not** cloned.
- Results are shown as custom messages without triggering a model response in the parent.
  The result excerpt is capped at about 4 KB; full stdout/stderr and the session are saved.
  If you resumed chatting during a run, delivery waits for a safe transcript boundary.
- Runs never overlap each other. However, a run already in progress can continue if you
  begin chatting again. All runs share your working files; this is **not a sandbox or worktree**.
- Each run has a **10-minute timeout**. Failures are reported and retried after the regular
  interval. There is no automatic success detection, failure limit, or expiry yet.
- `/loop stop`, session replacement, `/reload`, and normal exit cancel the timer and active
  child. Unix cancellation kills the child's process group, escalating to SIGKILL; Windows
  only guarantees termination of the direct child. Force-killing the parent or a crash
  cannot guarantee child cleanup. Schedules do not resume automatically.
- A child receives `PI_LOOP_WORKER=1`, disabling this extension there to prevent nested loops.
- Starting a loop requires interactive or RPC mode. Print/JSON invocations cannot keep one alive.

**Permissions:** children have normal Pi tool access and your OS permissions. They are
unattended: approval-dependent tools may fail without UI. Keep instructions narrow,
prefer read-only monitoring, and do not assume permission to push, delete, or deploy.

## Saved runs

```text
~/.pi/agent/loop-runs/<loop-id>/0001/
  <Pi session file>.jsonl
  stdout.txt
  stderr.txt
```

`PI_CODING_AGENT_DIR` is respected. Run directories/logs are created with restrictive
permissions. Files are not automatically deleted; logs may contain sensitive information.
Use `/loop status` for the last path. You can open a saved session with
`pi --session /absolute/path/to/session.jsonl` from the original working directory.
Stopping a loop does not remove its logs.

This prototype targets the installed Node-based Pi CLI (including its bundled JS entry point),
not a standalone native executable. It resolves the CLI from Pi's published package manifest.

## Validation

```sh
node --test agent/extensions/loop/tests/loop.test.mjs
```

Tests use the installed Pi package (or `PI_PACKAGE_DIR`), a fake clock, temporary
directories, real subprocesses running a fake CLI, and the published Pi CLI's RPC loader.
They **never call a model**. Paid end-to-end model execution must be tested manually.

## Possible next features

Based on [Claude Code's session-scoped scheduling](https://code.claude.com/docs/en/scheduled-tasks):

1. **Self-paced intervals:** let a run request its next delay based on observed progress,
   rather than always using a fixed default. Require validated, bounded structured output.
2. **Stop conditions and budgets:** stop when CI passes, after N runs, on repeated failures,
   at an expiry time, or at a token/cost ceiling. Claude's recurring tasks expire after seven days.
3. **Multiple named tasks:** IDs, listing, cancel-by-ID, pause/resume, and a shared concurrency limit.
4. **One-shot reminders and cron:** run once after a delay, at a local time, or on weekdays;
   optionally add bounded jitter. Keep fixed-delay scheduling available without cron rounding.
5. **Durable schedules:** explicitly opt in to restoring schedules on resume; never catch up
   every missed run. Truly unattended execution needs an external service, not an open terminal.
6. **Default `loop.md`:** a project/user default task for bare `/loop`, re-read each iteration.
7. **Safer fresh-session continuity:** a small explicit checkpoint/summary instead of inheriting
   the entire parent conversation. Add read-only tool profiles or per-run worktrees.
8. **Less polling/noise:** notifications only when something changes, event-driven CI/webhook
   wakeups, per-loop model selection, and output/log retention controls.

Claude's scheduler generally injects scheduled prompts into its ongoing session; this extension
intentionally uses a separate fresh session each time. Adaptive scheduling and persistence are
future options here, not features of this prototype.
