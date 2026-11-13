// End-to-end CLI startup tests: fake OAuth credentials, mocked usage HTTP, no model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const version = readFileSync(new URL("../../install/current-version", import.meta.url), "utf8").trim();
const packageDir = process.env.PI_PACKAGE_DIR ?? fileURLToPath(new URL(`../../install/releases/${version}/node_modules/@earendil-works/pi-coding-agent`, import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const cli = join(packageDir, manifest.bin.pi);

function setup() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "plan-default-startup-")));
	const agent = join(dir, "agent");
	mkdirSync(join(agent, "extensions"), { recursive: true });
	symlinkSync(fileURLToPath(new URL("../plan-default", import.meta.url)), join(agent, "extensions", "plan-default"));
	const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } })).toString("base64url")}.signature`;
	writeFileSync(join(agent, "auth.json"), JSON.stringify({
		"openai-codex": { type: "oauth", access: token, refresh: "fake", expires: Date.now() + 86400000 },
		anthropic: { type: "oauth", access: "sk-ant-oat01-fake", refresh: "fake", expires: Date.now() + 86400000 },
	}));
	writeFileSync(join(agent, "settings.json"), JSON.stringify({
		defaultProvider: "openai-codex", defaultModel: "gpt-6.1-sol", packages: [],
	}));
	const model = (id, api) => ({ id, name: id, api, reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: {
		"openai-codex": { models: [model("gpt-6.1-sol", "openai-codex-responses")] },
		anthropic: { models: [model("claude-opus-5-5", "anthropic-messages")] },
	} }));
	// Install after Pi's HTTP setup using a test-only extension, before the real
	// plan-default extension loads. A Node preload is overwritten by CLI setup.
	writeFileSync(join(agent, "extensions", "00-mock-http.ts"), `
		export default function () {
		globalThis.fetch = async (input) => {
			const url = String(input);
			if (url === "https://chatgpt.com/backend-api/wham/usage") {
				return Response.json({ rate_limit: { allowed: false, limit_reached: true,
					primary_window: { used_percent: 100, limit_window_seconds: 18000 } } });
			}
			if (url === "https://api.anthropic.com/api/oauth/usage") return new Response(null, { status: 429 });
			throw new Error("Network disabled in startup test");
		};
		}
	`);
	return { dir, agent };
}

async function run(f, args = []) {
	const env = { ...process.env, PI_CODING_AGENT_DIR: f.agent, NO_COLOR: "1" };
	// No ambient credentials or parent-session hints should affect these fixtures.
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "PI_SESSION_ID", "PI_SESSION_FILE", "NODE_OPTIONS"]) delete env[key];
	const child = spawn(process.execPath, [cli,
		"--mode", "rpc", "--no-skills", "--no-prompt-templates", ...args], {
		cwd: f.dir, env, stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	let buffer = "";
	const notifications = [];
	try {
		return await new Promise((resolveResult, reject) => {
			const timer = setTimeout(() => reject(new Error(`CLI startup timed out: ${stderr}`)), 15000);
			child.on("error", (error) => { clearTimeout(timer); reject(error); });
			child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`CLI exited (${code}): ${stderr}`)); });
			child.stderr.on("data", (chunk) => { stderr += chunk; });
			child.stdout.on("data", (chunk) => {
				buffer += chunk;
				let newline;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
					let message;
					try { message = JSON.parse(line); } catch { continue; }
					if (message.type === "extension_ui_request" && message.method === "notify") notifications.push(message.message);
					if (message.id === "state") {
						clearTimeout(timer);
						resolveResult({ state: message.data, notifications, stderr });
					}
				}
			});
			child.stdin.write(JSON.stringify({ id: "state", type: "get_state" }) + "\n");
		});
	} finally {
		child.kill("SIGTERM");
		await new Promise((done) => child.exitCode !== null ? done() : child.once("exit", done));
	}
}

function savedSession(f) {
	const path = join(f.dir, "saved.jsonl");
	const timestamp = "2026-01-01T00:00:00.000Z";
	// Deliberately no conversation messages: even an empty saved session must keep its model.
	writeFileSync(path, [
		{ type: "session", version: 3, id: "saved-session", timestamp, cwd: f.dir },
		{ type: "model_change", id: "model", parentId: null, timestamp, provider: "openai-codex", modelId: "gpt-6.1-sol" },
		{ type: "thinking_level_change", id: "thinking", parentId: "model", timestamp, thinkingLevel: "off" },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return path;
}

test("real Pi auto-discovers the extension and selects Anthropic on fresh startup despite usage HTTP 429", async () => {
	const f = setup();
	try {
		const result = await run(f);
		assert.equal(result.state.model.provider, "anthropic", JSON.stringify(result));
		assert.equal(result.state.model.id, "claude-opus-5-5");
		assert.ok(result.notifications.some((note) => note.includes("usage unknown; trying subscription")));
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("real Pi --session resumes the saved model instead of applying fresh-start routing", async () => {
	const f = setup();
	try {
		const result = await run(f, ["--session", savedSession(f)]);
		assert.equal(result.state.model.provider, "openai-codex", JSON.stringify(result));
		assert.equal(result.notifications.length, 0, "resume should not check usage or route models");
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("real Pi --continue preserves the saved model", async () => {
	const f = setup();
	try {
		const sessions = join(f.dir, "saved-sessions");
		mkdirSync(sessions);
		const source = savedSession(f);
		writeFileSync(join(sessions, "saved.jsonl"), readFileSync(source));
		const result = await run(f, ["--continue", "--session-dir", sessions]);
		assert.equal(result.state.model.provider, "openai-codex", JSON.stringify(result));
		assert.equal(result.notifications.length, 0);
	} finally { rmSync(f.dir, { recursive: true, force: true }); }
});
