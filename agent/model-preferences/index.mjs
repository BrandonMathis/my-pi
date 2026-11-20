import { readFileSync } from "node:fs";
import { join } from "node:path";

export class ModelPreferencesError extends Error {}

export function loadModelPreferences(agentDir) {
	const path = join(agentDir, "model-preferences", "models.json");
	let config;
	try {
		config = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new ModelPreferencesError(`Cannot read ${path}; check that it exists and contains valid JSON.`);
	}
	const object = (value) => value && typeof value === "object" && !Array.isArray(value);
	const fail = () => { throw new ModelPreferencesError(`Invalid ${path}; check startup aliases, providers, families, and unique shortcuts.`); };
	if (!object(config) || !object(config.models) || !object(config.startup)) fail();
	const shortcuts = new Set();
	for (const entry of Object.values(config.models)) {
		if (!object(entry) || !["openai-codex", "anthropic"].includes(entry.provider)
			|| typeof entry.family !== "string" || !/^[a-z]+$/.test(entry.family)) fail();
		if (entry.shortcuts !== undefined && (!Array.isArray(entry.shortcuts)
			|| entry.shortcuts.some((key) => typeof key !== "string" || !/^(?:(?:ctrl|alt|shift|super)\+)+[a-z0-9]$/.test(key)))) fail();
		for (const key of entry.shortcuts ?? []) {
			// Treat reordered modifiers as the same key.
			const parts = key.split("+");
			const canonical = [...parts.slice(0, -1).sort(), parts.at(-1)].join("+");
			if (shortcuts.has(canonical)) fail();
			shortcuts.add(canonical);
		}
	}
	for (const [role, provider] of [["codex", "openai-codex"], ["anthropic", "anthropic"]]) {
		const alias = config.startup[role];
		if (typeof alias !== "string" || !Object.hasOwn(config.models, alias) || config.models[alias].provider !== provider) fail();
	}
	return config;
}

function modelVersion(id, preference) {
	if (preference.provider === "openai-codex") {
		const match = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/.exec(id);
		return match?.[2] === preference.family ? match[1].split(".").map(Number) : undefined;
	}
	const match = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(id);
	if (match?.[1] !== preference.family) return undefined;
	// A release date is a snapshot tie-breaker, not a semantic version component.
	const parts = match[2].split("-");
	if (parts.at(-1).length === 8) parts.pop();
	return parts.map(Number);
}

/** Select the newest stable catalog model in a family; never invent an ID. */
export function resolveModel(preference, models) {
	const candidates = models.flatMap((model) => {
		if (model.provider !== preference.provider) return [];
		const version = modelVersion(model.id, preference);
		return version ? [{ model, version }] : [];
	});
	candidates.sort((a, b) => {
		for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
			const diff = (b.version[i] ?? 0) - (a.version[i] ?? 0);
			if (diff) return diff;
		}
		// Prefer the canonical undated alias for the same release.
		return a.model.id.length - b.model.id.length || a.model.id.localeCompare(b.model.id);
	});
	return candidates[0]?.model;
}

export function resolvePreferences(config, models) {
	return Object.fromEntries(Object.entries(config.models).map(([alias, preference]) => [alias, resolveModel(preference, models)]));
}
