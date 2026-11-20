import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const version = readFileSync(new URL("../../install/current-version", import.meta.url), "utf8").trim();
const packageDir = process.env.PI_PACKAGE_DIR ?? resolve(new URL(`../../install/releases/${version}/node_modules/@earendil-works/pi-coding-agent`, import.meta.url).pathname);
const requirePi = createRequire(join(packageDir, "package.json"));
const { createJiti } = requirePi("jiti");
const dir = mkdtempSync(join(tmpdir(), "model-hotkeys-"));
cpSync(new URL("../../model-preferences", import.meta.url), join(dir, "model-preferences"), { recursive: true });
const originalDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": join(packageDir, "dist/index.js"),
	"@earendil-works/pi-ai": join(packageDir, "../pi-ai/dist/index.js"),
} });
const { default: extension } = await jiti.import("../pi-control-hotkeys.ts");
after(() => {
	if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalDir;
	rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const shortcuts = new Map();
	const selected = [];
	const notes = [];
	const catalog = ["gpt-6-astra", "gpt-6.2-astra", "gpt-6.1-sol", "gpt-6.2-sol", "gpt-6-luna"].map((id) => ({ provider: "openai-codex", id }));
	const ctx = { modelRegistry: { getAvailable: () => catalog }, ui: { notify: (...args) => notes.push(args) } };
	const pi = {
		registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut),
		setModel: async (model) => { selected.push(model); return true; },
		getThinkingLevel: () => "high",
		setThinkingLevel: () => {},
	};
	extension(pi);
	return { pi, ctx, catalog, selected, notes, shortcuts, press: (key) => shortcuts.get(key).handler(ctx) };
}

test("command and tmux keys select current Astra, Sol, and newest available Luna", async () => {
	const f = fixture();
	for (const prefix of ["super", "ctrl+alt"]) {
		for (const [index, id] of ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6-luna"].entries()) {
			await f.press(`${prefix}+${index + 1}`);
			assert.equal(f.selected.at(-1).id, id);
		}
	}
	assert.ok(f.shortcuts.has("ctrl+shift+tab"));
});

test("hotkeys use newly refreshed releases without hardcoded IDs", async () => {
	const f = fixture();
	f.catalog.push({ provider: "openai-codex", id: "gpt-6.3-sol" });
	await f.press("super+2");
	assert.equal(f.selected[0].id, "gpt-6.3-sol");
});

test("missing models and failed credentials never silently switch providers", async () => {
	const f = fixture();
	f.catalog.splice(0);
	await f.press("super+1");
	assert.equal(f.selected.length, 0);
	assert.equal(f.notes[0][1], "error");
	f.catalog.push({ provider: "openai-codex", id: "gpt-6.2-sol" });
	f.pi.setModel = async () => false;
	await f.press("super+2");
	assert.match(f.notes.at(-1)[0], /No credentials/);
});

test("a failed switch releases the lock so the next key press works", async () => {
	const f = fixture();
	f.pi.setModel = async () => { throw new Error("failed"); };
	await f.press("super+1");
	assert.equal(f.notes.at(-1)[1], "error");
	f.pi.setModel = async (model) => { f.selected.push(model); return true; };
	await f.press("super+2");
	assert.equal(f.selected[0].id, "gpt-6.2-sol");
});

test("shared family edits are read on the next press; corrupt config leaves the model alone", async () => {
	const path = join(dir, "model-preferences", "models.json");
	const original = readFileSync(path, "utf8");
	const f = fixture();
	try {
		const config = JSON.parse(original);
		config.models["codex-sol"].family = "astra";
		writeFileSync(path, JSON.stringify(config));
		await f.press("super+2");
		assert.equal(f.selected[0].id, "gpt-6.2-astra");
		writeFileSync(path, "{");
		await f.press("super+2");
		assert.equal(f.selected.length, 1);
		assert.match(f.notes.at(-1)[0], /valid JSON/);
	} finally { writeFileSync(path, original); }
});
