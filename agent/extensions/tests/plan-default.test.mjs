// node --test agent/extensions/tests/plan-default.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { anthropicAvailability, codexAccountId, codexAvailability, hasExplicitModel } from "../plan-default/usage.ts";

const version = readFileSync(new URL("../../install/current-version", import.meta.url), "utf8").trim();
const packageDir = process.env.PI_PACKAGE_DIR ?? resolve(new URL(`../../install/releases/${version}/node_modules/@earendil-works/pi-coding-agent`, import.meta.url).pathname);
const requirePi = createRequire(join(packageDir, "package.json"));
const { createJiti } = requirePi("jiti");
const agentDir = mkdtempSync(join(tmpdir(), "plan-default-test-"));
const originalDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-coding-agent": join(packageDir, "dist/index.js") },
});
const { default: extension } = await jiti.import("../plan-default/index.ts");
const originalFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = originalFetch;
	if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalDir;
	rmSync(agentDir, { recursive: true, force: true });
});

const codexData = (used = 20, secondary = 30) => ({ rate_limit: {
	allowed: true,
	limit_reached: false,
	primary_window: { used_percent: used, limit_window_seconds: 18000 },
	secondary_window: { used_percent: secondary, limit_window_seconds: 604800 },
} });
const anthropicData = (used = 25, weekly = 40) => ({ five_hour: { utilization: used }, seven_day: { utilization: weekly } });

test("Codex requires capacity in both windows and honors blocking flags", () => {
	assert.equal(codexAvailability(codexData(), "gpt-6.1-sol").available, true);
	assert.equal(codexAvailability(codexData(100), "x").available, false);
	assert.equal(codexAvailability(codexData(1, 100), "x").available, false);
	for (const flag of [{ allowed: false }, { limit_reached: true }]) {
		const data = codexData();
		Object.assign(data.rate_limit, flag);
		assert.equal(codexAvailability(data, "x").available, false);
	}
	assert.equal(codexAvailability(codexData(95, 5), "x", 5).available, false);
	assert.equal(codexAvailability(codexData(94.9, 5), "x", 5).available, true);
});

test("malformed usage never implies available quota", () => {
	for (const data of [null, {}, [], { rate_limit: {} }, codexData(null), codexData("0"), codexData(NaN), codexData(-1), codexData(101)]) {
		assert.equal(codexAvailability(data, "x").available, false);
	}
	for (const data of [null, {}, [], { five_hour: { utilization: null } }, { seven_day: { utilization: "0" } }]) {
		assert.equal(anthropicAvailability(data, "claude-fable-5").available, false);
	}
});

test("Codex ignores other models' limits, but honors an exact model limit", () => {
	const data = codexData();
	data.additional_rate_limits = [{ limit_name: "gpt-spark", rate_limit: { allowed: false } }];
	assert.equal(codexAvailability(data, "gpt-6.1-sol").available, true);
	data.additional_rate_limits[0].limit_name = "gpt-6.1-sol";
	assert.equal(codexAvailability(data, "gpt-6.1-sol").available, false);
});

test("Anthropic checks shared and matching model windows, not unrelated families or paid extra usage", () => {
	const data = { ...anthropicData(), seven_day_opus: { utilization: 100 }, seven_day_fable: null };
	assert.equal(anthropicAvailability(data, "claude-fable-5").available, true);
	assert.equal(anthropicAvailability(data, "claude-opus-5-5").available, false);
	data.seven_day_oauth_apps = { utilization: 100 };
	assert.equal(anthropicAvailability(data, "claude-fable-5").available, false);
	assert.equal(anthropicAvailability({ ...anthropicData(100), extra_usage: { is_enabled: true } }, "claude-fable-5").available, false);
});

test("extracts account id without throwing on malformed tokens", () => {
	const claim = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url");
	assert.equal(codexAccountId(`header.${claim}.sig`), "test-account");
	assert.equal(codexAccountId("bad-token"), undefined);
});

test("explicit CLI model/provider arguments win", () => {
	for (const args of [["--model", "x"], ["--model=x"], ["-m", "x"], ["-mx"], ["--provider=x"]]) assert.equal(hasExplicitModel(args), true);
	assert.equal(hasExplicitModel(["--models", "openai-codex/*"]), false);
});

function fixture({ codex = codexData(), anthropic = anthropicData(), oauth = true, entries = [], sessionFile, parentSession, disabled = false, failSet = false } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const selected = [];
	const notes = [];
	const requests = [];
	const models = [
		{ provider: "openai-codex", id: "gpt-6.1-sol" },
		{ provider: "anthropic", id: "claude-opus-5-5" },
	];
	globalThis.fetch = async (url, options) => {
		requests.push({ url, options });
		const data = url.includes("chatgpt.com") ? codex : anthropic;
		if (data instanceof Error) throw data;
		if (typeof data === "number") return new Response(null, { status: data });
		return Response.json(data);
	};
	const ctx = {
		model: { provider: "other", id: "previous" },
		hasUI: true,
		ui: { notify: (...args) => notes.push(args) },
		waitForIdle: async () => {},
		sessionManager: {
			getBranch: () => entries,
			getSessionFile: () => sessionFile,
			getHeader: () => ({ parentSession }),
		},
		modelRegistry: {
			find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
			isUsingOAuth: () => oauth,
			getProviderAuth: async () => ({ auth: { apiKey: "test-token" } }),
		},
	};
	extension({
		on: (name, handler) => handlers.set(name, handler),
		registerFlag: () => {},
		getFlag: () => disabled,
		registerCommand: (name, command) => commands.set(name, command),
		setModel: async (model) => { selected.push(model); return !failSet; },
	});
	return { ctx, selected, notes, requests,
		start: (reason = "startup") => handlers.get("session_start")({ reason }, ctx),
		select: () => commands.get("plan-model").handler("", ctx),
	};
}

test("startup selects Codex first, Anthropic second, Codex last", async () => {
	for (const [options, provider, warning] of [
		[{}, "openai-codex", false],
		[{ codex: codexData(100) }, "anthropic", false],
		[{ codex: codexData(100), anthropic: anthropicData(100) }, "openai-codex", true],
	]) {
		const f = fixture(options);
		await f.start();
		assert.equal(f.selected[0].provider, provider);
		assert.equal(f.requests.length, 2);
		assert.equal(f.notes[0][1], warning ? "warning" : "info");
	}
});

test("unknown or failed usage checks use fallback policy, not an exception", async () => {
	for (const failure of [401, 403, 429, new Error("secret must not leak"), {}]) {
		const f = fixture({ codex: failure });
		await f.start();
		assert.equal(f.selected[0].provider, "anthropic");
		assert.ok(!JSON.stringify(f.notes).includes("secret must not leak"));
	}
	const f = fixture({ codex: 500, anthropic: new Error("offline") });
	await f.start();
	assert.equal(f.selected[0].provider, "openai-codex");
	assert.match(f.notes[0][0], /usage unknown; trying subscription/);
});

test("exhausted Codex plus rate-limited Anthropic usage endpoint tries Anthropic automatically", async () => {
	for (const anthropic of [429, 503, new Error("timeout"), {}]) {
		const f = fixture({ codex: codexData(100), anthropic });
		await f.start();
		assert.equal(f.selected[0].provider, "anthropic");
		assert.equal(f.notes[0][1], "warning");
		assert.match(f.notes[0][0], /usage unknown; trying subscription/);
		assert.doesNotMatch(f.notes[0][0], /last resort/);
	}
});

test("usage parsers distinguish confirmed exhaustion from missing data", () => {
	assert.equal(codexAvailability(codexData(100), "x").status, "exhausted");
	assert.equal(anthropicAvailability(anthropicData(100), "claude-fable-5").status, "exhausted");
	assert.equal(codexAvailability({}, "x").status, "unknown");
	assert.equal(anthropicAvailability({}, "claude-fable-5").status, "unknown");
});

test("persisted empty or rewound sessions retain their saved model on startup", async () => {
	const sessionFile = join(agentDir, "existing-session.jsonl");
	writeFileSync(sessionFile, "");
	try {
		for (const options of [{ sessionFile }, { parentSession: "original-session.jsonl" }]) {
			const f = fixture({ ...options, codex: codexData(100), entries: [{ type: "model_change" }] });
			await f.start();
			assert.equal(f.requests.length, 0);
			assert.equal(f.selected.length, 0);
		}
		const fresh = fixture({ sessionFile: join(agentDir, "not-yet-written.jsonl"), codex: codexData(100) });
		await fresh.start();
		assert.equal(fresh.selected[0].provider, "anthropic");
	} finally {
		rmSync(sessionFile, { force: true });
	}
});

test("never treats API-key authentication as a subscription", async () => {
	const f = fixture({ oauth: false });
	await f.start();
	assert.equal(f.requests.length, 0);
	assert.equal(f.selected.length, 0);
	assert.equal(f.notes[0][1], "warning");
});

test("preserves resumes, forks, reloads, continued sessions, and opt-out", async () => {
	for (const reason of ["resume", "fork", "reload"]) {
		const f = fixture();
		await f.start(reason);
		assert.equal(f.requests.length, 0);
	}
	for (const options of [{ entries: [{ type: "message" }] }, { disabled: true }]) {
		const f = fixture(options);
		await f.start();
		assert.equal(f.requests.length, 0);
	}
	const f = fixture();
	await f.start("new");
	assert.equal(f.selected[0].provider, "openai-codex");
});

test("manual command rechecks; current model avoids a redundant selection", async () => {
	const f = fixture();
	f.ctx.model = { provider: "openai-codex", id: "gpt-6.1-sol" };
	await f.select();
	assert.equal(f.requests.length, 2);
	assert.equal(f.selected.length, 0);
	assert.equal(f.requests[0].options.redirect, "error");
	assert.ok(f.requests[0].options.signal instanceof AbortSignal);
});

test("failed model selection reports a warning", async () => {
	const f = fixture({ failSet: true });
	await f.start();
	assert.match(f.notes[0][0], /current model unchanged/);
});

test("config changes quota threshold; invalid config leaves current model alone", async () => {
	const path = join(agentDir, "plan-default.json");
	try {
		writeFileSync(path, JSON.stringify({ minimumRemainingPercent: 10 }));
		const f = fixture({ codex: codexData(95) });
		await f.start();
		assert.equal(f.selected[0].provider, "anthropic");
		writeFileSync(path, JSON.stringify({ minimumRemainingPercent: -1 }));
		const invalid = fixture();
		await invalid.start();
		assert.equal(invalid.selected.length, 0);
		assert.equal(invalid.requests.length, 0);
		assert.match(invalid.notes[0][0], /Invalid plan-default.json/);
	} finally {
		rmSync(path, { force: true });
	}
});
