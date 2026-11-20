import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadModelPreferences, resolveModel, resolvePreferences } from "../../model-preferences/index.mjs";
import { parseCatalog, syncSettings } from "../../model-preferences/sync.mjs";

const configDir = new URL("../../", import.meta.url).pathname;
const config = loadModelPreferences(configDir);
const models = (provider, ...ids) => ids.map((id) => ({ provider, id }));

test("shared config keeps the existing command and tmux shortcuts", () => {
	assert.equal(config.startup.codex, "codex-sol");
	assert.equal(config.startup.anthropic, "anthropic-opus");
	for (const [i, family] of ["astra", "sol", "luna"].entries()) {
		assert.deepEqual(config.models[`codex-${family}`].shortcuts, [`super+${i + 1}`, `ctrl+alt+${i + 1}`]);
	}
});

test("Codex resolves newest numeric release per family, not previews or unrelated providers", () => {
	const catalog = [
		...models("openai-codex", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.2-sol", "gpt-6.10-sol", "gpt-9-astra", "gpt-99-sol-preview", "gpt-6-luna"),
		...models("openai", "gpt-99-sol"),
	];
	assert.equal(resolveModel(config.models["codex-sol"], catalog).id, "gpt-6.10-sol");
	assert.equal(resolveModel(config.models["codex-luna"], catalog).id, "gpt-6-luna");
	assert.equal(resolveModel(config.models["codex-sol"], []), undefined);
});

test("Anthropic compares versions numerically and does not mistake snapshot dates for versions", () => {
	const catalog = models("anthropic", "claude-opus-4-5-20251101", "claude-opus-5", "claude-opus-5-5", "claude-opus-5-5-20261101", "claude-opus-5-10", "claude-sonnet-99", "claude-opus-99-preview");
	assert.equal(resolveModel(config.models["anthropic-opus"], catalog).id, "claude-opus-5-10");
	assert.equal(resolveModel(config.models["anthropic-opus"], models("anthropic", "claude-opus-5-5-20261101", "claude-opus-5-5")).id, "claude-opus-5-5");
	assert.equal(resolveModel(config.models["anthropic-opus"], models("anthropic", "claude-opus-4-5-20251101")).id, "claude-opus-4-5-20251101");
});

test("a catalog refresh upgrades every configured family independently", () => {
	const catalog = [
		...models("openai-codex", "gpt-6.2-astra", "gpt-6.2-sol", "gpt-6-luna"),
		...models("anthropic", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"),
	];
	const resolved = resolvePreferences(config, catalog);
	assert.equal(resolved[config.startup.codex].id, "gpt-6.2-sol");
	assert.equal(resolved[config.startup.anthropic].id, "claude-opus-5-5");
	assert.equal(resolved["codex-luna"].id, "gpt-6-luna");
});

test("invalid shared config fails clearly, including aliases and duplicate modifier ordering", () => {
	const dir = mkdtempSync(join(tmpdir(), "model-preferences-"));
	try {
		assert.throws(() => loadModelPreferences(dir), /Cannot read/);
		cpSync(new URL("../../model-preferences", import.meta.url), join(dir, "model-preferences"), { recursive: true });
		const path = join(dir, "model-preferences", "models.json");
		for (const mutate of [
			(c) => { c.startup.codex = "missing"; },
			(c) => { c.startup.codex = "anthropic-opus"; },
			(c) => { c.models["codex-sol"].provider = "openai"; },
			(c) => { c.models["codex-sol"].family = "sol.*"; },
			(c) => { c.models["codex-sol"].shortcuts.push("alt+ctrl+1"); },
		]) {
			const copy = structuredClone(config);
			mutate(copy);
			writeFileSync(path, JSON.stringify(copy));
			assert.throws(() => loadModelPreferences(dir), /Invalid/);
		}
		writeFileSync(path, "{");
		assert.throws(() => loadModelPreferences(dir), /valid JSON/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sync previews without writes and only updates Pi's concrete startup fields", () => {
	const dir = mkdtempSync(join(tmpdir(), "model-preferences-sync-"));
	try {
		const path = join(dir, "settings.json");
		const settings = { defaultProvider: "openai-codex", defaultModel: "gpt-6.1-sol", theme: "dark", packages: ["example"], defaultThinkingLevel: "high" };
		const original = JSON.stringify(settings);
		writeFileSync(path, original);
		const model = { provider: "openai-codex", id: "gpt-6.2-sol" };
		assert.equal(syncSettings(dir, model), true);
		assert.equal(readFileSync(path, "utf8"), original);
		assert.equal(syncSettings(dir, model, true), true);
		assert.deepEqual(JSON.parse(readFileSync(path)), { ...settings, defaultModel: "gpt-6.2-sol" });
		assert.equal(syncSettings(dir, model, true), false);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("catalog parser uses exact provider/model pairs from Pi's public table", () => {
	assert.deepEqual(parseCatalog("provider model context\nanthropic claude-opus-5-5 1M\nopenai-codex gpt-6.2-sol 500K\nopenai gpt-99 1M\n"), [
		{ provider: "anthropic", id: "claude-opus-5-5" }, { provider: "openai-codex", id: "gpt-6.2-sol" },
	]);
});
