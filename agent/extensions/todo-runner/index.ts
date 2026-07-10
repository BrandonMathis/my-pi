import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const STORE_RELATIVE_PATH = ".pi/todo-queue.json";
const STATUS_KEY = "todo-runner";

type TodoStatus = "incomplete" | "in_progress" | "complete";

interface TodoItem {
	id: number;
	text: string;
	status: TodoStatus;
	createdAt: string;
	updatedAt: string;
	sessionFile?: string;
}

interface TodoStore {
	version: 1;
	nextId: number;
	todos: TodoItem[];
}

type RunnerContext = ExtensionCommandContext & {
	sendUserMessage?: (content: string) => Promise<void>;
};

function nowIso(): string {
	return new Date().toISOString();
}

function storePath(cwd: string): string {
	return join(cwd, STORE_RELATIVE_PATH);
}

function emptyStore(): TodoStore {
	return { version: 1, nextId: 1, todos: [] };
}

function normalizeStore(store: TodoStore): TodoStore {
	store.todos.forEach((todo, index) => {
		todo.id = index + 1;
	});
	store.nextId = store.todos.length + 1;
	return store;
}

async function loadStore(cwd: string): Promise<TodoStore> {
	try {
		const raw = await readFile(storePath(cwd), "utf8");
		const parsed = JSON.parse(raw) as Partial<TodoStore>;
		return normalizeStore({
			version: 1,
			nextId: typeof parsed.nextId === "number" ? parsed.nextId : 1,
			todos: Array.isArray(parsed.todos) ? (parsed.todos as TodoItem[]) : [],
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
		throw error;
	}
}

async function saveStore(cwd: string, store: TodoStore): Promise<void> {
	const path = storePath(cwd);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(normalizeStore(store), null, 2)}\n`, "utf8");
}

function summarizeTodos(store: TodoStore): string {
	if (store.todos.length === 0) return "No todos yet.";

	const counts = {
		incomplete: store.todos.filter((todo) => todo.status === "incomplete").length,
		in_progress: store.todos.filter((todo) => todo.status === "in_progress").length,
		complete: store.todos.filter((todo) => todo.status === "complete").length,
	};

	const lines = [
		`${store.todos.length} todo(s): ${counts.incomplete} incomplete, ${counts.in_progress} in progress, ${counts.complete} complete`,
		"",
	];

	for (const todo of store.todos) {
		const icon = todo.status === "complete" ? "✓" : todo.status === "in_progress" ? "●" : "○";
		const firstLine = todo.text.trim().split(/\r?\n/, 1)[0] || "Untitled todo";
		lines.push(`${icon} #${todo.id} [${todo.status}] ${firstLine}`);
	}

	return lines.join("\n");
}

function todoLabel(todo: TodoItem): string {
	const icon = todo.status === "complete" ? "✓" : todo.status === "in_progress" ? "●" : "○";
	const firstLine = todo.text.trim().split(/\r?\n/, 1)[0] || "Untitled todo";
	return `${icon} #${todo.id} ${firstLine}`;
}

async function addTodo(ctx: ExtensionCommandContext): Promise<void> {
	const text = await ctx.ui.editor("Add todo", "");
	const trimmed = text?.trim();
	if (!trimmed) {
		ctx.ui.notify("Todo not added", "info");
		return;
	}

	const store = await loadStore(ctx.cwd);
	const timestamp = nowIso();
	store.todos.push({
		id: store.todos.length + 1,
		text: trimmed,
		status: "incomplete",
		createdAt: timestamp,
		updatedAt: timestamp,
	});
	await saveStore(ctx.cwd, store);
	ctx.ui.notify("Todo added", "info");
}

async function editTodo(ctx: ExtensionCommandContext): Promise<void> {
	const store = await loadStore(ctx.cwd);
	if (store.todos.length === 0) {
		ctx.ui.notify("No todos to edit", "info");
		return;
	}

	const labels = store.todos.map(todoLabel);
	const choice = await ctx.ui.select("Edit which todo?", [...labels, "Cancel"]);
	if (!choice || choice === "Cancel") return;

	const index = labels.indexOf(choice);
	if (index < 0) return;

	const todo = store.todos[index];
	const text = await ctx.ui.editor(`Edit todo #${todo.id}`, todo.text);
	const trimmed = text?.trim();
	if (!trimmed) {
		ctx.ui.notify("Todo not changed", "info");
		return;
	}

	todo.text = trimmed;
	todo.updatedAt = nowIso();
	await saveStore(ctx.cwd, store);
	ctx.ui.notify(`Edited todo #${todo.id}`, "info");
}

async function deleteTodo(ctx: ExtensionCommandContext): Promise<void> {
	const store = await loadStore(ctx.cwd);
	if (store.todos.length === 0) {
		ctx.ui.notify("No todos to delete", "info");
		return;
	}

	const labels = store.todos.map(todoLabel);
	const choice = await ctx.ui.select("Delete which todo?", [...labels, "Cancel"]);
	if (!choice || choice === "Cancel") return;

	const index = labels.indexOf(choice);
	if (index < 0) return;

	const [removed] = store.todos.splice(index, 1);
	await saveStore(ctx.cwd, store);
	ctx.ui.notify(`Deleted todo #${removed.id}`, "info");
}

async function resetInProgress(ctx: ExtensionCommandContext): Promise<void> {
	const store = await loadStore(ctx.cwd);
	let changed = 0;
	const timestamp = nowIso();
	for (const todo of store.todos) {
		if (todo.status === "in_progress") {
			todo.status = "incomplete";
			todo.updatedAt = timestamp;
			changed++;
		}
	}
	await saveStore(ctx.cwd, store);
	ctx.ui.notify(`Reset ${changed} todo(s)`, "info");
}

async function updateTodoStatus(
	cwd: string,
	id: number,
	status: TodoStatus,
	sessionFile?: string,
): Promise<TodoStore> {
	const store = await loadStore(cwd);
	const todo = store.todos.find((item) => item.id === id);
	if (!todo) return store;

	todo.status = status;
	todo.updatedAt = nowIso();
	if (sessionFile !== undefined) todo.sessionFile = sessionFile;
	await saveStore(cwd, store);
	return store;
}

async function runQueue(ctx: RunnerContext): Promise<void> {
	const cwd = ctx.cwd;
	const store = await loadStore(cwd);
	const next = store.todos.find((todo) => todo.status === "incomplete");

	if (!next) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify("Todo queue complete", "info");
		return;
	}

	await updateTodoStatus(cwd, next.id, "in_progress");
	ctx.ui.setStatus(STATUS_KEY, `todo #${next.id} running`);
	ctx.ui.notify(`Starting todo #${next.id}`, "info");

	const parentSession = ctx.sessionManager.getSessionFile();
	const prompt = next.text;

	const result = await ctx.newSession({
		parentSession,
		withSession: async (replacementCtx) => {
			replacementCtx.ui.setStatus(STATUS_KEY, `todo #${next.id} running`);
			await updateTodoStatus(cwd, next.id, "in_progress", replacementCtx.sessionManager.getSessionFile());

			try {
				await replacementCtx.sendUserMessage(prompt);
				await replacementCtx.waitForIdle();
				await updateTodoStatus(cwd, next.id, "complete", replacementCtx.sessionManager.getSessionFile());
				replacementCtx.ui.notify(`Completed todo #${next.id}`, "info");
			} catch (error) {
				await updateTodoStatus(cwd, next.id, "incomplete", replacementCtx.sessionManager.getSessionFile());
				replacementCtx.ui.setStatus(STATUS_KEY, undefined);
				replacementCtx.ui.notify(`Todo #${next.id} stopped: ${(error as Error).message}`, "error");
				return;
			}

			await runQueue(replacementCtx as RunnerContext);
		},
	});

	if (result.cancelled) {
		await updateTodoStatus(cwd, next.id, "incomplete");
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify("Todo run cancelled", "info");
	}
}

async function showMenu(ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const store = await loadStore(ctx.cwd);
		const summary = summarizeTodos(store);
		const choice = await ctx.ui.select(`Todo queue\n\n${summary}`, [
			"Add todo",
			"Edit todo",
			"Delete todo",
			"Run incomplete todos",
			"Reset in-progress todos",
			"Exit",
		]);

		if (!choice || choice === "Exit") return;

		if (choice === "Add todo") {
			await addTodo(ctx);
			continue;
		}

		if (choice === "Edit todo") {
			await editTodo(ctx);
			continue;
		}

		if (choice === "Delete todo") {
			await deleteTodo(ctx);
			continue;
		}

		if (choice === "Reset in-progress todos") {
			await resetInProgress(ctx);
			continue;
		}

		if (choice === "Run incomplete todos") {
			await runQueue(ctx as RunnerContext);
			return;
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("todo", {
		description: "Manage and run a project-level todo queue",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				console.log(summarizeTodos(await loadStore(ctx.cwd)));
				return;
			}

			try {
				await showMenu(ctx);
			} catch (error) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify(`Todo error: ${(error as Error).message}`, "error");
			}
		},
	});
}
