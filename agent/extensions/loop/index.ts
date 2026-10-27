import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir, getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_INTERVAL_MS, formatInterval, LoopScheduler, parseCommand } from "./core.ts";
import { resolveCliPath, runFreshSession } from "./worker.ts";

const HELP = [
	"/loop [interval] <task> — schedule a task in a fresh Pi session each run",
	"/loop 30s check whether CI passed",
	"/loop check the deployment — uses the default interval (5m initially)",
	"/loop default [interval] — show/change the default for this runtime",
	"/loop status — show the current loop and last run directory",
	"/loop stop — cancel the schedule and terminate a running iteration",
	"/loop -- <task> — task-only syntax, bypassing reserved words/interval parsing",
	"Intervals: s, m, h, d (1 second–7 days). First run waits one interval.",
	"One loop per session; stops on session switch, /reload, or exit.",
].join("\n");

export default function loopExtension(pi: ExtensionAPI) {
	// Children still load normal configured resources, but cannot recursively register /loop.
	if (process.env.PI_LOOP_WORKER === "1") return;

	let defaultIntervalMs = DEFAULT_INTERVAL_MS;
	let scheduler: LoopScheduler | undefined;
	let lastRunDir: string | undefined;

	pi.on("session_shutdown", async (_event, ctx) => {
		await scheduler?.stop();
		scheduler = undefined;
		ctx.ui.setStatus("loop", undefined);
	});

	pi.registerCommand("loop", {
		description: "Repeat a task in fresh sessions: /loop [5m] <task> | status | stop | default",
		getArgumentCompletions: (prefix) => {
			const choices = ["help", "status", "stop", "default", "30s", "5m", "1h"];
			return choices.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			try {
				const command = parseCommand(args, defaultIntervalMs);
				if (command.type === "help") {
					ctx.ui.notify(HELP, "info");
					return;
				}
				if (command.type === "default") {
					if (command.intervalMs !== undefined) defaultIntervalMs = command.intervalMs;
					ctx.ui.notify(`Loop default: ${formatInterval(defaultIntervalMs)}. Active loops are unchanged.`, "info");
					return;
				}
				if (command.type === "stop") {
					await scheduler?.stop();
					ctx.ui.notify("Loop stopped. Saved runs are kept.", "info");
					return;
				}
				if (command.type === "status") {
					const state = scheduler?.snapshot;
					const lines = state ? [
						`Task: ${state.task}`,
						`Interval: ${formatInterval(state.intervalMs)} after completion; ${state.runs} run(s) started`,
						state.running ? "Running in a fresh Pi session" : `Next: ${new Date(state.nextRunAt!).toLocaleString()} (when Pi is idle)`,
						...(state.lastError ? [`Last error: ${state.lastError}`] : []),
					] : ["No active loop."];
					if (lastRunDir) lines.push(`Last run: ${lastRunDir}`);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				if (command.type !== "start") return;
				if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
					throw new Error("/loop requires an interactive or RPC session that stays open.");
				}
				if (scheduler?.isActive) throw new Error("A loop is already active or stopping. Use /loop stop and wait for it to finish.");
				if (!ctx.model) throw new Error("Select a model before starting a loop.");

				const id = randomUUID().slice(0, 8);
				// Snapshot plain configuration; model changes in the parent do not alter this loop.
				const config = {
					cwd: ctx.cwd,
					provider: ctx.model.provider,
					model: ctx.model.id,
					thinking: pi.getThinkingLevel(),
					trusted: ctx.isProjectTrusted(),
					cliPath: resolveCliPath(getPackageDir()),
				};
				scheduler = new LoopScheduler({
					canRun: () => ctx.isIdle() && !ctx.hasPendingMessages(),
					onChange: (state) => ctx.ui.setStatus("loop", state
						? `loop ${formatInterval(state.intervalMs)} · ${state.running ? `running #${state.runs}` : "waiting"}`
						: undefined),
					run: async (iteration, signal) => {
						const runDir = join(getAgentDir(), "loop-runs", id, String(iteration).padStart(4, "0"));
						lastRunDir = runDir;
						ctx.ui.notify(`Loop ${id}: starting run #${iteration}`, "info");
						try {
							const result = await runFreshSession({
								...config, runDir, signal, name: `loop-${id}-${iteration}`,
								prompt: [
									"Perform one iteration of the following user-scheduled task in this fresh session.",
									"You have no history from previous iterations or the originating conversation.",
									"Do the task once, report the result concisely, then finish. Do not schedule further runs.",
									"Task:", command.task,
								].join("\n\n"),
							});
							if (signal.aborted) return;
							pi.sendMessage({
								customType: "loop-result", display: true,
								content: `### Loop ${id} · run ${iteration}\n\n${result.output}\n\nSaved session and logs: ${runDir}`,
								details: { id, iteration, task: command.task, runDir },
							}, { triggerTurn: false });
						} catch (error) {
							if (signal.aborted) return;
							const message = error instanceof Error ? error.message : String(error);
							pi.sendMessage({
								customType: "loop-result", display: true,
								content: `Loop ${id} run ${iteration} failed: ${message}\n\nLogs: ${runDir}\n\nThe loop will retry after ${formatInterval(command.intervalMs)}. Use /loop stop to cancel.`,
								details: { id, iteration, runDir, error: message },
							}, { triggerTurn: false });
							throw error;
						}
					},
				});
				scheduler.start(command.task, command.intervalMs);
				ctx.ui.notify(
					`Loop ${id} scheduled. First run in ${formatInterval(command.intervalMs)}, then ${formatInterval(command.intervalMs)} after each completion.\nFresh sessions use ${config.provider}/${config.model} in ${config.cwd}.\nRuns have normal tool access; this is not a sandbox. /loop stop cancels.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
