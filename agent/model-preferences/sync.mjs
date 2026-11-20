// Run from anywhere: node ~/.pi/agent/model-preferences/sync.mjs [--write|--check]
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModelPreferences, resolvePreferences } from "./index.mjs";

/** Parse the public `pi --list-models` table, ignoring headers and diagnostics. */
export function parseCatalog(output) {
	return output.split("\n").flatMap((line) => {
		const [provider, id] = line.trim().split(/\s+/);
		return ["openai-codex", "anthropic"].includes(provider) && id ? [{ provider, id }] : [];
	});
}

/** Pi requires a concrete startup ID in settings; this is a generated projection. */
export function syncSettings(agentDir, model, write = false) {
	const path = join(agentDir, "settings.json");
	const settings = JSON.parse(readFileSync(path, "utf8"));
	const changed = settings.defaultProvider !== model.provider || settings.defaultModel !== model.id;
	if (write && changed) {
		const temporary = `${path}.${process.pid}.tmp`;
		try {
			writeFileSync(temporary, JSON.stringify({ ...settings, defaultProvider: model.provider, defaultModel: model.id }, null, 2) + "\n", {
				mode: statSync(path).mode & 0o777,
				flag: "wx",
			});
			renameSync(temporary, path);
		} finally {
			rmSync(temporary, { force: true });
		}
	}
	return changed;
}

export function main(args = process.argv.slice(2)) {
	if (args.some((arg) => !["--write", "--check"].includes(arg)) || args.length > 1) {
		throw new Error("Usage: node sync.mjs [--write|--check] (no flag previews without changing files)");
	}
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? dirname(dirname(fileURLToPath(import.meta.url)));
	const config = loadModelPreferences(agentDir);
	const catalog = parseCatalog(execFileSync("pi", ["--list-models"], {
		encoding: "utf8", timeout: 30000, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NO_COLOR: "1" },
	}));
	const resolved = resolvePreferences(config, catalog);
	for (const [alias, model] of Object.entries(resolved)) {
		if (!model) throw new Error(`No available catalog model for ${alias}; check /login and refresh with pi update --models. No settings changed.`);
		console.log(`${alias}: ${model.provider}/${model.id}`);
	}
	const startup = resolved[config.startup.codex];
	const changed = syncSettings(agentDir, startup, args.includes("--write"));
	console.log(`Startup: ${startup.provider}/${startup.id} (${changed ? args.includes("--write") ? "settings updated" : "settings need sync; run with --write" : "settings already current"})`);
	console.log(`Anthropic fallback: ${resolved[config.startup.anthropic].id}`);
	if (args.includes("--check") && changed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { main(); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
