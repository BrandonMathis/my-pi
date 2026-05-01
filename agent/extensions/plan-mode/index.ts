import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.js";

const PLAN_ONLY_TOOL_NAMES = ["read", "bash", "grep", "find", "ls"] as const;
const FALLBACK_RESTORE_TOOLS = ["read", "bash", "edit", "write"];
const STATE_ENTRY = "plan-mode-state";
const EXECUTION_MARKER_ENTRY = "plan-mode-execute";
const PLAN_CONTEXT_TYPES = new Set(["plan-mode-context", "plan-execution-context", "plan-mode-execute"]);

type PlanModeState = {
	version: 1;
	enabled: boolean;
	executing: boolean;
	todos: TodoItem[];
	restoreTools: string[];
	anchorEntryId: string | null;
};

type SessionEntryLike = {
	id?: string;
	parentId?: string | null;
	type: string;
	customType?: string;
	data?: unknown;
	message?: AgentMessage;
};

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function normalizeToolNames(candidate: string[], allToolNames: string[]): string[] {
	const seen = new Set<string>();
	return candidate.filter((tool) => {
		if (!allToolNames.includes(tool)) return false;
		if (seen.has(tool)) return false;
		seen.add(tool);
		return true;
	});
}

function getLatestState(entries: SessionEntryLike[]): PlanModeState | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
		return entry.data as PlanModeState | undefined;
	}
	return undefined;
}

function getFirstUserEntryId(entries: SessionEntryLike[]): string | null {
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.id || !entry.message) continue;
		if (entry.message.role === "user") return entry.id;
	}
	return null;
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let restoreTools: string[] = [];
	let planAnchorEntryId: string | null = null;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function getAllToolNames(): string[] {
		return pi.getAllTools().map((tool) => tool.name);
	}

	function getPlanModeTools(): string[] {
		return normalizeToolNames([...PLAN_ONLY_TOOL_NAMES], getAllToolNames());
	}

	function getRestoreTools(): string[] {
		const allToolNames = getAllToolNames();
		const saved = normalizeToolNames(restoreTools, allToolNames);
		if (saved.length > 0) return saved;

		const active = normalizeToolNames(pi.getActiveTools(), allToolNames);
		if (active.length > 0) return active;

		return normalizeToolNames(FALLBACK_RESTORE_TOOLS, allToolNames);
	}

	function persistState(): void {
		pi.appendEntry<PlanModeState>(STATE_ENTRY, {
			version: 1,
			enabled: planModeEnabled,
			executing: executionMode,
			todos: todoItems.map((item) => ({ ...item })),
			restoreTools: [...restoreTools],
			anchorEntryId: planAnchorEntryId,
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((todo) => todo.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") +
						ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.step}. ${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function applyPlanModeTools(): void {
		const tools = getPlanModeTools();
		if (tools.length > 0) {
			pi.setActiveTools(tools);
		}
	}

	function applyRestoreTools(): void {
		const tools = getRestoreTools();
		if (tools.length > 0) {
			pi.setActiveTools(tools);
		}
	}

	function enablePlanMode(ctx: ExtensionContext): void {
		if (!planModeEnabled) {
			restoreTools = getRestoreTools();
			planAnchorEntryId = ctx.sessionManager.getLeafId();
		}
		planModeEnabled = true;
		executionMode = false;
		todoItems = [];
		applyPlanModeTools();
		persistState();
		updateStatus(ctx);
		ctx.ui.notify("Plan mode enabled. Pi is now in read-only planning mode.", "success");
	}

	function disablePlanMode(ctx: ExtensionContext, options?: { preserveTodos?: boolean }): void {
		planModeEnabled = false;
		executionMode = false;
		if (!options?.preserveTodos) {
			todoItems = [];
			planAnchorEntryId = null;
		}
		applyRestoreTools();
		persistState();
		updateStatus(ctx);
		ctx.ui.notify("Plan mode disabled. Normal tool access restored.", "info");
	}

	function showTodoList(ctx: ExtensionContext): void {
		if (todoItems.length === 0) {
			ctx.ui.notify("No saved plan yet. Ask pi to create a plan first.", "info");
			return;
		}

		const list = todoItems.map((item) => `${item.step}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
		ctx.ui.notify(`Plan Progress:\n${list}`, "info");
	}

	function buildExecutionMessage(): string {
		if (todoItems.length === 0) {
			return "Exit planning mode and start implementing the approved plan. If anything is ambiguous, call it out before making risky changes.";
		}

		const remaining = todoItems.filter((item) => !item.completed);
		const first = remaining[0] ?? todoItems[0];
		return `Execute the approved plan step by step. Start with step ${first.step}: ${first.text}`;
	}

	function beginExecution(ctx: ExtensionContext): void {
		planModeEnabled = false;
		executionMode = true;
		applyRestoreTools();
		pi.appendEntry(EXECUTION_MARKER_ENTRY, {
			startedAt: new Date().toISOString(),
			anchorEntryId: planAnchorEntryId,
			todos: todoItems.map((item) => ({ ...item })),
		});
		persistState();
		updateStatus(ctx);
	}

	function getExecutionTargetId(ctx: ExtensionContext): string | null {
		if (planAnchorEntryId) return planAnchorEntryId;
		const branchEntries = ctx.sessionManager.getBranch() as SessionEntryLike[];
		return getFirstUserEntryId(branchEntries);
	}

	async function executeSavedPlan(ctx: ExtensionCommandContext): Promise<void> {
		const savedRestoreTools = getRestoreTools();
		const savedTodos = todoItems.map((item) => ({ ...item }));
		const savedAnchorEntryId = planAnchorEntryId;
		const targetId = getExecutionTargetId(ctx);

		if (targetId) {
			const result = await ctx.navigateTree(targetId, { summarize: false });
			if (result.cancelled) return;
		}

		restoreTools = savedRestoreTools;
		todoItems = savedTodos;
		planAnchorEntryId = savedAnchorEntryId;
		beginExecution(ctx);
		pi.sendUserMessage(buildExecutionMessage());
	}

	function restoreFromSession(ctx: ExtensionContext): void {
		const branchEntries = ctx.sessionManager.getBranch() as SessionEntryLike[];
		const state = getLatestState(branchEntries);

		planModeEnabled = pi.getFlag("plan") === true;
		executionMode = false;
		todoItems = [];
		restoreTools = normalizeToolNames(pi.getActiveTools(), getAllToolNames());
		planAnchorEntryId = null;

		if (state) {
			planModeEnabled = state.enabled;
			executionMode = state.executing;
			todoItems = state.todos ?? [];
			restoreTools = normalizeToolNames(state.restoreTools ?? [], getAllToolNames());
			planAnchorEntryId = state.anchorEntryId ?? null;
		}

		if (executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
				const entry = branchEntries[index];
				if (entry.type === "custom" && entry.customType === EXECUTION_MARKER_ENTRY) {
					executeIndex = index;
					break;
				}
			}

			const assistantMessages = branchEntries
				.slice(executeIndex + 1)
				.filter((entry) => entry.type === "message" && entry.message && isAssistantMessage(entry.message))
				.map((entry) => entry.message as AssistantMessage);
			const combinedText = assistantMessages.map(getTextContent).join("\n\n");
			markCompletedSteps(combinedText, todoItems);
		}

		if (planModeEnabled) {
			applyPlanModeTools();
		} else if (executionMode) {
			applyRestoreTools();
		}

		updateStatus(ctx);
	}

	pi.registerCommand("plan", {
		description: "Plan mode: /plan, /plan on, /plan off, /plan execute (clean execution branch), /plan status",
		getArgumentCompletions(prefix) {
			const items = ["on", "off", "execute", "status", "toggle", "reset"];
			const filtered = items.filter((item) => item.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered.map((item) => ({ value: item, label: item })) : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			if (!command || command === "toggle") {
				if (planModeEnabled) disablePlanMode(ctx);
				else enablePlanMode(ctx);
				return;
			}

			switch (command) {
				case "on":
					enablePlanMode(ctx);
					return;
				case "off":
					disablePlanMode(ctx);
					return;
				case "execute":
					await executeSavedPlan(ctx);
					return;
				case "status":
					showTodoList(ctx);
					return;
				case "reset":
					planModeEnabled = false;
					executionMode = false;
					todoItems = [];
					planAnchorEntryId = null;
					applyRestoreTools();
					persistState();
					updateStatus(ctx);
					ctx.ui.notify("Plan state reset.", "success");
					return;
				default:
					ctx.ui.notify(`Unknown /plan subcommand: ${command}`, "error");
			}
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current saved plan and completion state",
		handler: async (_args, ctx) => {
			showTodoList(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			if (planModeEnabled) disablePlanMode(ctx);
			else enablePlanMode(ctx);
		},
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		const allowedTools = new Set(getPlanModeTools());
		if (!allowedTools.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode only allows: ${Array.from(allowedTools).join(", ")}. Disable plan mode before making changes.`,
			};
		}

		if (event.toolName === "bash") {
			const command = typeof event.input.command === "string" ? event.input.command : "";
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode blocked non-read-only bash command: ${command}`,
				};
			}
		}
	});

	pi.on("context", async (event) => {
		if (planModeEnabled || executionMode) return;

		return {
			messages: event.messages.filter((message) => {
				const maybeCustom = message as AgentMessage & { customType?: string };
				return !maybeCustom.customType || !PLAN_CONTEXT_TYPES.has(maybeCustom.customType);
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]\nYou are in read-only planning mode.\n\nRules:\n- You may inspect files and code, but do not make changes.\n- Only use read-only tools and safe read-only bash commands.\n- Ask clarifying questions if requirements are ambiguous.\n- When ready, produce a concrete numbered plan under a \"Plan:\" heading.\n- Do not implement the plan yet.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((item) => !item.completed);
			const remainingText = remaining.map((item) => `${item.step}. ${item.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING SAVED PLAN]\nFinish the remaining plan steps in order.\n\nRemaining steps:\n${remainingText}\n\nAfter you fully complete a numbered step, include [DONE:n] in your response for that exact step number.`,
					display: false,
				},
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		const changed = markCompletedSteps(text, todoItems);
		if (changed > 0) {
			persistState();
			updateStatus(ctx);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((item) => item.completed)) {
				executionMode = false;
				planAnchorEntryId = null;
				pi.sendMessage(
					{
						customType: "plan-complete",
						content: `✅ Plan complete.\n\n${todoItems.map((item) => `- ${item.text}`).join("\n")}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				todoItems = [];
				persistState();
				updateStatus(ctx);
			}
			return;
		}

		if (!planModeEnabled) return;

		const lastAssistant = [...event.messages].reverse().find((message): message is AssistantMessage => {
			return isAssistantMessage(message as AgentMessage);
		});
		if (!lastAssistant) return;

		const extracted = extractTodoItems(getTextContent(lastAssistant));
		if (extracted.length === 0) return;

		todoItems = extracted;
		persistState();
		updateStatus(ctx);

		pi.sendMessage(
			{
				customType: "plan-todo-list",
				content: `**Saved plan (${todoItems.length} steps):**\n\n${todoItems.map((item) => `${item.step}. ☐ ${item.text}`).join("\n")}`,
				display: true,
			},
			{ triggerTurn: false },
		);

		if (!ctx.hasUI) return;

		const choice = await ctx.ui.select("Plan ready — what next?", [
			"Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
			"Disable plan mode",
		]);

		if (choice === "Execute the plan") {
			// Session navigation APIs are only available from command handlers,
			// so stage the command for the user instead of executing inline here.
			ctx.ui.setEditorText("/plan execute");
			ctx.ui.notify("Press Enter to execute the saved plan from a clean execution branch.", "info");
			return;
		}

		if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("How should pi refine the plan?", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
			return;
		}

		if (choice === "Disable plan mode") {
			disablePlanMode(ctx, { preserveTodos: true });
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreFromSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromSession(ctx);
	});
}
