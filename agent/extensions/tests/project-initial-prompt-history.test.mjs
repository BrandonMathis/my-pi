// node --test agent/extensions/tests/project-initial-prompt-history.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const packageDir = process.env.PI_PACKAGE_DIR ?? join(
	execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
	"@earendil-works/pi-coding-agent",
);
const requirePi = createRequire(join(packageDir, "package.json"));
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": join(packageDir, "dist/index.js"),
		"@earendil-works/pi-tui": requirePi.resolve("@earendil-works/pi-tui"),
	},
});
const { default: extension, OpeningPromptHistory, openingPrompts } = await jiti.import("../project-initial-prompt-history.ts");
const { default: stylingExtension } = await jiti.import("../custom-input-styling.ts");
const { CustomEditor, SessionManager } = await jiti.import(join(packageDir, "dist/index.js"));
const { KeybindingsManager } = await jiti.import(join(packageDir, "dist/core/keybindings.js"));
const { setKeybindings } = await jiti.import(requirePi.resolve("@earendil-works/pi-tui"));
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const theme = { borderColor: (text) => text, selectList: {} };

function session(id, firstMessage, created, extra = {}) {
	return {
		id, firstMessage, cwd: "/project", path: `/sessions/${id}.jsonl`,
		created: new Date(created), modified: new Date(created), ...extra,
	};
}

test("opening prompts are project-scoped and ordered by creation, not last activity", () => {
	const sessions = [
		session("old", "older opening", "2026-01-01", { modified: new Date("2026-12-01") }),
		session("new", "newer opening", "2026-02-01"),
		session("foreign", "another project", "2026-03-01", { cwd: "/other" }),
		session("unknown", "unknown project", "2026-03-01", { cwd: "" }),
		session("current", "exclude me", "2026-04-01"),
		session("empty", "(no messages)", "2026-05-01"),
		session("blank", " \n ", "2026-06-01"),
	];
	assert.deepEqual(openingPrompts(sessions, "/project/.", "current"), ["newer opening", "older opening"]);
});

test("history browses multiline entries and returns to an empty editor", () => {
	const history = new OpeningPromptHistory(["new\nopening", "old opening"]);
	assert.equal(history.move("next", ""), undefined);
	assert.equal(history.move("previous", ""), "new\nopening");
	assert.equal(history.move("previous", "new\nopening"), "old opening");
	assert.equal(history.move("previous", "old opening"), "old opening");
	assert.equal(history.move("next", "old opening"), "new\nopening");
	assert.equal(history.move("next", "new\nopening"), "");
	assert.equal(history.move("next", ""), undefined);
});

test("typing or editing a recalled prompt does not allow history to replace the draft", () => {
	const history = new OpeningPromptHistory(["opening"]);
	assert.equal(history.move("previous", "draft"), undefined);
	assert.equal(history.move("previous", ""), "opening");
	assert.equal(history.move("previous", "opening edited"), undefined);
	assert.equal(history.move("next", "opening edited"), undefined);
	assert.equal(history.move("previous", ""), "opening");
	assert.equal(new OpeningPromptHistory([]).move("previous", ""), undefined);
});

async function fixture(t, { started = false, mode = "tui", styling = false, bindings = {}, saved = true, autoStart = true } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pi-opening-history-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const cwd = join(dir, "project");
	const manager = SessionManager.create(cwd, dir);
	async function save(id, project, date, prompts) {
		const header = { type: "session", version: 3, id, cwd: project, timestamp: date };
		const entries = prompts.map((content, index) => ({
			type: "message", id: `${id}-${index}`, parentId: index ? `${id}-${index - 1}` : null,
			timestamp: date, message: { role: "user", content, timestamp: Date.parse(date) },
		}));
		await writeFile(join(dir, `${id}.jsonl`), [header, ...entries].map(JSON.stringify).join("\n") + "\n");
	}
	if (saved) {
		await save("older", cwd, "2026-01-01T00:00:00Z", ["older opening", "older follow-up"]);
		await save("newer", cwd, "2026-02-01T00:00:00Z", ["newer opening\nsecond line", "newer follow-up"]);
		await save("foreign", join(dir, "other-project"), "2026-03-01T00:00:00Z", ["foreign opening"]);
		await save("empty", cwd, "2026-04-01T00:00:00Z", []);
		await writeFile(join(dir, "broken.jsonl"), "not json\n");
	}
	if (started) manager.appendMessage({ role: "user", content: "existing session prompt", timestamp: Date.now() });
	const handlers = new Map();
	const pi = {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	const keybindings = new KeybindingsManager(bindings);
	setKeybindings(keybindings); // Pi installs the same manager for its base TUI editor.
	const tui = { requestRender() {}, terminal: { columns: 100, rows: 30 } };
	let editor = new CustomEditor(tui, theme, keybindings);
	let factory;
	const warnings = [];
	let installations = 0;
	const submit = (text) => {
		manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		editor.addToHistory(text);
	};
	editor.onSubmit = submit;
	const ctx = {
		mode, sessionManager: manager,
		ui: {
			theme: { fg: (_color, text) => text },
			notify: (...args) => warnings.push(args),
			getEditorComponent: () => factory,
			setEditorComponent(next) {
				installations++;
				const text = editor.getText();
				factory = next;
				editor = next ? next(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
				editor.onSubmit = submit;
				editor.setText(text);
			},
		},
	};
	if (styling) stylingExtension(pi);
	extension(pi);
	const emit = async (event, data = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(data, ctx);
	};
	if (autoStart) await emit("session_start", { reason: "startup" });
	return {
		ctx, manager, emit, warnings, save,
		press: (key) => { editor.handleInput(key); },
		get editor() { return editor; },
		get installations() { return installations; },
	};
}

test("real Pi editor recalls only opening prompts, then keeps only this session's history", async (t) => {
	const f = await fixture(t);
	f.press(UP);
	assert.equal(f.editor.getText(), "newer opening\nsecond line");
	f.press(UP);
	assert.equal(f.editor.getText(), "older opening");
	f.press(DOWN);
	assert.equal(f.editor.getText(), "newer opening\nsecond line");
	f.press(DOWN);
	assert.equal(f.editor.getText(), "");

	f.editor.setText("my first prompt");
	f.press("\r");
	await f.emit("before_agent_start");
	f.press(UP);
	assert.equal(f.editor.getText(), "my first prompt");
	f.press(UP);
	assert.equal(f.editor.getText(), "my first prompt");
	f.press(DOWN);
	assert.equal(f.editor.getText(), "");

	f.editor.setText("my follow-up");
	f.press("\r");
	f.press(UP);
	assert.equal(f.editor.getText(), "my follow-up");
	f.press(UP);
	assert.equal(f.editor.getText(), "my first prompt");
	f.press(UP);
	assert.equal(f.editor.getText(), "my first prompt");
	assert.deepEqual(f.warnings, []);
});

test("submitting a recalled opening adds just that prompt to native history", async (t) => {
	const f = await fixture(t);
	f.press(UP);
	f.press(UP);
	f.press("\r");
	f.press(UP); // Detect the saved user message even without before_agent_start.
	assert.equal(f.editor.getText(), "older opening");
	f.press(UP);
	assert.equal(f.editor.getText(), "older opening");
	f.press(DOWN);
	assert.equal(f.editor.getText(), "");
});

test("existing sessions, empty histories, and non-TUI modes leave the editor alone", async (t) => {
	for (const options of [{ started: true }, { saved: false }, { mode: "rpc" }, { mode: "json" }]) {
		const f = await fixture(t, options);
		assert.equal(f.installations, 0);
		f.editor.addToHistory("native history");
		f.press(UP);
		assert.equal(f.editor.getText(), "native history");
	}
});

test("autocomplete, typed drafts, and key-release events retain default behavior", async (t) => {
	const f = await fixture(t);
	let autocompleteChecks = 0;
	f.editor.isShowingAutocomplete = () => { autocompleteChecks++; return true; };
	f.press(UP);
	assert.equal(f.editor.getText(), "");
	assert.ok(autocompleteChecks > 0);
	f.editor.isShowingAutocomplete = () => false;
	f.press("\x1b[1;1:3A");
	assert.equal(f.editor.getText(), "");
	f.editor.setText("typed draft");
	f.press(UP);
	assert.equal(f.editor.getText(), "typed draft");
	f.editor.setText("");
	f.press(UP);
	f.press("!");
	assert.equal(f.editor.getText(), "newer opening\nsecond line!");
	f.press(UP);
	assert.equal(f.editor.getText(), "newer opening\nsecond line!");
});

test("dedicated configurable history keys work before and after the first prompt", async (t) => {
	const f = await fixture(t, { bindings: { "tui.editor.historyPrevious": "ctrl+p", "tui.editor.historyNext": "ctrl+n" } });
	f.press("\x10");
	assert.equal(f.editor.getText(), "newer opening\nsecond line");
	f.press("\x0e");
	assert.equal(f.editor.getText(), "");
	f.editor.setText("session prompt");
	f.press("\r");
	f.press("\x10");
	assert.equal(f.editor.getText(), "session prompt");
});

test("history composes with current and later editor factories without losing styling", async (t) => {
	const f = await fixture(t, { styling: true });
	assert.ok(f.editor.render(100).every((line) => line.includes("\x1b[48;2;48;48;60m")));
	f.press(UP);
	assert.equal(f.editor.getText(), "newer opening\nsecond line");
	f.editor.setText("");
	f.ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = new CustomEditor(tui, theme, keybindings);
		editor.otherExtension = true;
		return editor;
	});
	assert.equal(f.editor.otherExtension, true);
	assert.ok(f.editor.render(100).every((line) => line.includes("\x1b[48;2;48;48;60m")));
	f.press(UP);
	assert.equal(f.editor.getText(), "newer opening\nsecond line");
});

test("a session that started stays native on reload and a new empty session browses again", async (t) => {
	const f = await fixture(t);
	f.editor.setText("started prompt");
	f.press("\r");
	const installs = f.installations;
	await f.emit("session_start", { reason: "reload" });
	assert.equal(f.installations, installs);
	f.press(UP);
	assert.equal(f.editor.getText(), "started prompt");

	f.manager.newSession();
	f.editor.setText("");
	await f.emit("session_start", { reason: "new" });
	f.press(UP);
	assert.equal(f.editor.getText(), "started prompt"); // Most recently created session.
	f.press(UP);
	assert.equal(f.editor.getText(), "newer opening\nsecond line");
});

test("a delayed history load cannot install an editor after shutdown or first submission", async (t) => {
	for (const action of ["shutdown", "submit"]) {
		const f = await fixture(t, { autoStart: false });
		const originalList = SessionManager.list;
		let finish;
		try {
			SessionManager.list = () => new Promise((resolve) => { finish = resolve; });
			const starting = f.emit("session_start", { reason: "startup" });
			if (action === "shutdown") {
				await f.emit("session_shutdown");
			} else {
				f.editor.setText("already started");
				f.press("\r");
			}
			finish([session("previous", "opening", "2026-01-01", { cwd: f.manager.getCwd() })]);
			await starting;
			assert.equal(f.installations, 0);
		} finally {
			SessionManager.list = originalList;
		}
	}
});

test("history discovery failure warns but leaves normal editing available", async (t) => {
	const f = await fixture(t, { autoStart: false });
	const originalList = SessionManager.list;
	try {
		SessionManager.list = async () => { throw new Error("cannot read sessions"); };
		await f.emit("session_start", { reason: "startup" });
		assert.equal(f.installations, 0);
		assert.equal(f.warnings.length, 1);
		assert.match(f.warnings[0][0], /cannot read sessions/);
		f.editor.addToHistory("native prompt");
		f.press(UP);
		assert.equal(f.editor.getText(), "native prompt");
	} finally {
		SessionManager.list = originalList;
	}
});

test("shutdown restores the editor setter and disables old history wrappers", async (t) => {
	const f = await fixture(t);
	const wrappedSetter = f.ctx.ui.setEditorComponent;
	await f.emit("session_shutdown");
	assert.notEqual(f.ctx.ui.setEditorComponent, wrappedSetter);
	f.press(UP);
	assert.equal(f.editor.getText(), "");
});
