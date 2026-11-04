// PI_PACKAGE_DIR=/path/to/pi-coding-agent node --test agent/extensions/tests/cursor-mode.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const packageDir = process.env.PI_PACKAGE_DIR ?? join(
	execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
	"@earendil-works/pi-coding-agent",
);
const requirePi = createRequire(join(packageDir, "package.json"));
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-coding-agent": join(packageDir, "dist/index.js") },
});
const { default: extension, cursorExtensionPaths } = await jiti.import("../cursor-mode.ts");
const { default: focusExtension } = await jiti.import("../focus-cursor.ts");
const { SettingsManager, DefaultResourceLoader } = await jiti.import(join(packageDir, "dist/index.js"));

test("cursor resource filters replace exact aliases and preserve unrelated filters", () => {
	const dir = join(homedir(), ".pi/agent");
	const paths = [
		"other.ts", "!extensions/legacy*.ts", "-builtin:mcp",
		"-extensions/focus-cursor.ts", "+./extensions/focus-cursor.ts",
		join(dir, "extensions/focus-cursor.ts"), "-~/.pi/agent/extensions/focus-cursor.ts",
	];
	const kept = paths.slice(0, 3);
	assert.deepEqual(cursorExtensionPaths(paths, dir, false), [...kept, "+extensions/focus-cursor.ts"]);
	assert.deepEqual(cursorExtensionPaths(paths, dir, true), [...kept, "-extensions/focus-cursor.ts"]);
});

async function fixture(t, initial = { showHardwareCursor: true, extensions: ["-extensions/focus-cursor.ts"] }) {
	const root = await mkdtemp(join(tmpdir(), "pi-cursor-test-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir);
	await mkdir(cwd);
	const path = join(agentDir, "settings.json");
	await writeFile(path, JSON.stringify(initial));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	});
	const commands = new Map();
	const notifications = [];
	const reloaded = [];
	let effective = structuredClone(initial);
	let waits = 0;
	const ctx = {
		cwd,
		mode: "tui",
		isProjectTrusted: () => true,
		waitForIdle: async () => { waits++; },
		ui: { notify: (...args) => notifications.push(args) },
		reload: async () => {
			assert.ok(waits > 0, "must wait for idle before reloading");
			effective = JSON.parse(await readFile(path, "utf8"));
			reloaded.push(structuredClone(effective));
		},
	};
	extension({
		registerCommand: (name, definition) => commands.set(name, definition),
		getSettings: () => structuredClone(effective),
	});
	return {
		ctx, path, notifications, reloaded, command: commands.get("cursor"),
		run: (args = "") => commands.get("cursor").handler(args, ctx),
		read: async () => JSON.parse(await readFile(path, "utf8")),
	};
}

test("bare /cursor toggles both settings in either direction before reloading", async (t) => {
	const f = await fixture(t, {
		showHardwareCursor: true,
		extensions: ["-extensions/focus-cursor.ts", "other.ts"],
		theme: "dark", packages: ["npm:example"], compaction: { enabled: false },
	});
	await f.run();
	assert.equal(f.reloaded[0].showHardwareCursor, false);
	assert.deepEqual(f.reloaded[0].extensions, ["other.ts", "+extensions/focus-cursor.ts"]);
	await f.run();
	assert.equal(f.reloaded[1].showHardwareCursor, true);
	assert.deepEqual(f.reloaded[1].extensions, ["other.ts", "-extensions/focus-cursor.ts"]);
	assert.equal(f.reloaded[1].theme, "dark");
	assert.deepEqual(f.reloaded[1].packages, ["npm:example"]);
	assert.deepEqual(f.reloaded[1].compaction, { enabled: false });
});

test("explicit modes are idempotent and survive a fresh extension instance", async (t) => {
	const f = await fixture(t);
	await f.run(" drawn ");
	await f.run("drawn");
	assert.equal((await f.read()).showHardwareCursor, false);
	assert.deepEqual((await f.read()).extensions, ["+extensions/focus-cursor.ts"]);
	let freshCommand;
	extension({
		registerCommand: (_name, definition) => { freshCommand = definition; },
		getSettings: () => f.reloaded.at(-1),
	});
	await freshCommand.handler("", f.ctx);
	assert.equal((await f.read()).showHardwareCursor, true);
	await f.run("HARDWARE");
	assert.equal((await f.read()).showHardwareCursor, true);
});

test("missing settings default to drawn, and the toggle enables hardware", async (t) => {
	const f = await fixture(t, {});
	await f.run();
	assert.deepEqual(await f.read(), { showHardwareCursor: true, extensions: ["-extensions/focus-cursor.ts"] });
});

test("status, invalid arguments, and non-TUI invocations never write or reload", async (t) => {
	const f = await fixture(t);
	const before = await readFile(f.path, "utf8");
	await f.run("status");
	assert.match(f.notifications.at(-1)[0], /Cursor: hardware/);
	await f.run("invalid");
	assert.equal(f.notifications.at(-1)[1], "warning");
	f.ctx.mode = "rpc";
	await f.run();
	assert.equal(f.notifications.at(-1)[1], "warning");
	assert.equal(await readFile(f.path, "utf8"), before);
	assert.equal(f.reloaded.length, 0);
});

test("arguments have autocomplete", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(f.command.getArgumentCompletions("d"), [{ value: "drawn", label: "drawn" }]);
	assert.equal(f.command.getArgumentCompletions("unknown"), null);
});

test("waits for idle before saving", async (t) => {
	const f = await fixture(t);
	let release;
	f.ctx.waitForIdle = () => new Promise((resolve) => { release = resolve; });
	const before = await readFile(f.path, "utf8");
	const running = f.run();
	assert.equal(await readFile(f.path, "utf8"), before);
	// This fixture's replacement reload checks disk persistence, not the original wait counter.
	f.ctx.reload = async () => { assert.equal((await f.read()).showHardwareCursor, false); };
	release();
	await running;
});

test("refuses a conflicting trusted project override without writing global settings", async (t) => {
	const f = await fixture(t);
	const projectPath = join(f.ctx.cwd, ".pi/settings.json");
	await mkdir(dirname(projectPath));
	await writeFile(projectPath, JSON.stringify({ showHardwareCursor: true }));
	const before = await readFile(f.path, "utf8");
	await f.run("drawn");
	assert.equal(await readFile(f.path, "utf8"), before);
	assert.match(f.notifications.at(-1)[0], /Project settings override/);
	assert.equal(f.reloaded.length, 0);
});

test("invalid settings report an error without overwriting the file or reloading", async (t) => {
	const f = await fixture(t);
	await writeFile(f.path, "{invalid");
	await f.run();
	assert.equal(await readFile(f.path, "utf8"), "{invalid");
	assert.equal(f.notifications.at(-1)[1], "error");
	assert.equal(f.reloaded.length, 0);
});

test("save failures are reported without reloading", async (t) => {
	const f = await fixture(t);
	await chmod(f.path, 0o444);
	try {
		await f.run("drawn");
		assert.equal(f.notifications.at(-1)[1], "error");
		assert.match(f.notifications.at(-1)[0], /Could not save cursor mode/);
		assert.equal(f.reloaded.length, 0);
		assert.equal((await f.read()).showHardwareCursor, true);
	} finally {
		await chmod(f.path, 0o644);
	}
});

test("real resource discovery keeps /cursor available and loads focus only in drawn mode", async (t) => {
	const f = await fixture(t);
	const agentDir = dirname(f.path);
	await mkdir(join(agentDir, "extensions"));
	for (const name of ["cursor-mode.ts", "focus-cursor.ts"]) {
		await copyFile(new URL(`../${name}`, import.meta.url), join(agentDir, "extensions", name));
	}
	const settings = SettingsManager.create(f.ctx.cwd, agentDir);
	const loader = new DefaultResourceLoader({
		cwd: f.ctx.cwd, agentDir, settingsManager: settings,
		disabledBuiltinExtensions: ["mcp", "llama.cpp", "codemode", "tool-search"],
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	for (const mode of ["hardware", "drawn", "hardware"]) {
		await f.run(mode);
		await settings.reload();
		await loader.reload();
		const result = loader.getExtensions();
		assert.deepEqual(result.errors, []);
		assert.ok(result.extensions.some((entry) => entry.commands.has("cursor")));
		assert.equal(result.extensions.some((entry) => entry.path.endsWith("/focus-cursor.ts")), mode === "drawn");
		assert.equal(settings.getShowHardwareCursor(), mode === "hardware");
	}
});

test("unrelated settings changed since startup are retained", async (t) => {
	const f = await fixture(t);
	await writeFile(f.path, JSON.stringify({ ...(await f.read()), theme: "light", extensions: ["extra.ts"] }));
	await f.run("drawn");
	assert.equal((await f.read()).theme, "light");
	assert.deepEqual((await f.read()).extensions, ["extra.ts", "+extensions/focus-cursor.ts"]);
});

test("focus extension cleanup restores the renderer and listeners on switching back to hardware", () => {
	const handlers = new Map();
	const writes = [];
	const cursor = "\x1b_pi:c\x07\x1b_pi:fc\x07\x1b[7m \x1b[0m\x1b_pi:/fc\x07";
	class Tui {
		terminal = { write: (data) => writes.push(data) };
		requestRender() {}
		extractCursorPosition(lines) { return lines; }
	}
	const tui = new Tui();
	const original = Tui.prototype.extractCursorPosition;
	const listenersBefore = process.stdin.listenerCount("data");
	const wasFlowing = process.stdin.readableFlowing;
	let inputRemoved = false;
	focusExtension({ on: (name, handler) => handlers.set(name, handler) });
	try {
		handlers.get("session_start")({}, {
			mode: "tui",
			ui: {
				setWidget: (_key, factory) => factory?.(tui),
				onTerminalInput: () => () => { inputRemoved = true; },
			},
		});
		assert.equal(process.stdin.listenerCount("data"), listenersBefore + 1);
		process.stdin.emit("data", "\x1b[O");
		assert.ok(!tui.extractCursorPosition([cursor], 20)[0].includes("\x1b_pi:c\x07"));
		process.stdin.emit("data", "\x1b[I");
		assert.equal(tui.extractCursorPosition([cursor], 20)[0], cursor);
	} finally {
		handlers.get("session_shutdown")();
		if (!wasFlowing) process.stdin.pause();
	}
	assert.equal(Tui.prototype.extractCursorPosition, original);
	assert.equal(process.stdin.listenerCount("data"), listenersBefore);
	assert.equal(inputRemoved, true);
	assert.equal(writes.at(-1), "\x1b[?1004l");
});
