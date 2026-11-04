// node --test agent/extensions/tests/image-guard.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Isolate the state file from the real agent dir.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "image-guard-"));

const packageDir = process.env.PI_PACKAGE_DIR ?? join(
	execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
	"@earendil-works/pi-coding-agent",
);
const requirePi = createRequire(join(packageDir, "package.json"));
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-coding-agent": join(packageDir, "dist/index.js") },
});
const { default: extension, modelKey } = await jiti.import("../image-guard.ts");

const kimi = { provider: "amazon-bedrock", id: "us.moonshotai.kimi-k3", input: ["text", "image"] };
const claude = { provider: "amazon-bedrock", id: "us.anthropic.claude-sonnet-5", input: ["text", "image"] };
const newModel = { provider: "amazon-bedrock", id: "us.acme.new-model", input: ["text", "image"] };
const img = { type: "image", data: "AAAA", mimeType: "image/png" };

function fixture(model, { choices = [] } = {}) {
	const handlers = new Map();
	const sent = [];
	const notes = [];
	const prompts = [];
	const ctx = {
		model,
		hasUI: choices.length > 0,
		ui: {
			notify: (...a) => notes.push(a),
			select: async (title, options) => {
				prompts.push({ title, options });
				const pick = choices.shift();
				return pick === undefined ? undefined : options.find((o) => o.startsWith(pick));
			},
		},
	};
	extension({
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: () => {},
		sendMessage: (...a) => sent.push(a),
	});
	const emit = (name, event) => handlers.get(name)(event, ctx);
	return { emit, sent, notes, prompts, ctx };
}

const readPng = { toolName: "read", input: { path: "shot.png" } };

test("modelKey strips Bedrock region prefixes", () => {
	assert.equal(modelKey(kimi), "amazon-bedrock/moonshotai.kimi-k3");
	assert.equal(modelKey({ provider: "x", id: "us.foo" }), "x/us.foo");
});

test("blocks image reads and strips images for a known-bad model", async () => {
	const f = fixture(kimi);
	const r = await f.emit("tool_call", { toolName: "read", input: { path: "shot.PNG" } });
	assert.equal(r.block, true);
	assert.match(r.reason, /cannot take images/);
	assert.equal(await f.emit("tool_call", { toolName: "read", input: { path: "a.ts" } }), undefined);

	const tr = f.emit("tool_result", { content: [{ type: "text", text: "hi" }, img], details: {} });
	assert.deepEqual(tr.content.map((b) => b.type), ["text", "text"]);

	const c = f.emit("context", {
		messages: [
			{ role: "user", content: [img, { type: "text", text: "look" }] },
			{ role: "toolResult", content: [img] },
			{ role: "user", content: "plain" },
		],
	});
	assert.ok(c.messages.every((m) => !Array.isArray(m.content) || m.content.every((b) => b.type !== "image")));
});

test("skip choice tells the model to move on without the image", async () => {
	const f = fixture(kimi, { choices: ["Skip this step"] });
	const r = await f.emit("tool_call", readPng);
	assert.equal(r.block, true);
	assert.match(r.reason, /chose to skip this step/);
	assert.equal(f.prompts.length, 1);
});

test("always-skip stops asking for the rest of the session", async () => {
	const f = fixture(kimi, { choices: ["Always skip"] });
	await f.emit("tool_call", readPng);
	const r = await f.emit("tool_call", readPng);
	assert.match(r.reason, /chose to skip this step/);
	assert.equal(f.prompts.length, 1);
	f.emit("session_start", {});
	f.ctx.hasUI = true;
	await f.emit("tool_call", readPng);
	assert.equal(f.prompts.length, 2);
});

test("stop choice terminates; dismissing falls back to a plain block", async () => {
	const f = fixture(kimi, { choices: ["Stop", undefined] });
	f.ctx.hasUI = true;
	const stop = await f.emit("tool_call", readPng);
	assert.equal(stop.terminate, true);
	const dismissed = await f.emit("tool_call", readPng);
	assert.match(dismissed.reason, /cannot take images/);
	assert.equal(dismissed.terminate, undefined);
});

test("leaves vision models alone", async () => {
	const f = fixture(claude);
	assert.equal(await f.emit("tool_call", { toolName: "read", input: { path: "a.png" } }), undefined);
	assert.equal(f.emit("tool_result", { content: [img] }), undefined);
	assert.equal(f.emit("context", { messages: [{ role: "user", content: [img] }] }), undefined);
});

test("learns from the provider error, saves it, and retries once", () => {
	const f = fixture(newModel);
	assert.equal(f.emit("context", { messages: [{ role: "toolResult", content: [img] }] }), undefined);

	f.emit("message_end", {
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage: "Validation error: This model doesn't support the image field for user messages. Remove image and try again.",
		},
	});
	const saved = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "image-guard.json"), "utf8"));
	assert.deepEqual(saved.deny, ["amazon-bedrock/acme.new-model"]);
	assert.ok(f.emit("context", { messages: [{ role: "toolResult", content: [img] }] }));

	f.emit("agent_settled", { aborted: false });
	assert.equal(f.sent.length, 1);
	assert.equal(f.sent[0][1].triggerTurn, true);

	// A second identical error does not retry again.
	f.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "doesn't support the image field" } });
	f.emit("agent_settled", { aborted: false });
	assert.equal(f.sent.length, 1);
});
