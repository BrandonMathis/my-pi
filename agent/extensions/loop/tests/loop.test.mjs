// node --test agent/extensions/loop/tests/loop.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageDir = process.env.PI_PACKAGE_DIR ?? join(
	execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
	"@earendil-works/pi-coding-agent",
);
const requirePi = createRequire(join(packageDir, "package.json"));
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": packageDir } });
const { parseInterval, parseCommand, formatInterval, LoopScheduler, DEFAULT_INTERVAL_MS } = await jiti.import("../core.ts");
const { runFreshSession, buildArgs, resolveCliPath } = await jiti.import("../worker.ts");
const { default: extension } = await jiti.import("../index.ts");

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
class FakeClock {
	time = 0;
	nextId = 0;
	timers = new Map();
	now = () => this.time;
	setTimeout = (callback, delay) => {
		const id = ++this.nextId;
		this.timers.set(id, { callback, at: this.time + delay });
		return id;
	};
	clearTimeout = (id) => this.timers.delete(id);
	async advance(ms) {
		const end = this.time + ms;
		while (true) {
			const due = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			if (!due || due[1].at > end) break;
			this.time = due[1].at;
			this.timers.delete(due[0]);
			due[1].callback();
			await flush();
		}
		this.time = end;
		await flush();
	}
}

function schedulerFixture(run = async () => {}) {
	const clock = new FakeClock();
	let idle = true;
	const calls = [];
	const scheduler = new LoopScheduler({
		clock, canRun: () => idle, onChange() {},
		run: async (iteration, signal) => { calls.push(iteration); await run(iteration, signal); },
	});
	return { scheduler, clock, calls, setIdle(value) { idle = value; } };
}

test("parse supported intervals and format them", () => {
	for (const [input, expected] of [["30s", 30_000], ["5m", 300_000], ["2H", 7_200_000], ["7d", 604_800_000], ["1.5s", 1_500]]) {
		assert.equal(parseInterval(input), expected);
		assert.equal(parseInterval(formatInterval(expected)), expected);
	}
});

test("reject malformed, zero, negative, tiny, huge, or imprecise intervals", () => {
	for (const input of ["5", "5ms", "0s", "-1m", "NaNs", "Infinityh", "0.1s", "8d", "1.0001s", "1m2s"]) {
		assert.throws(() => parseInterval(input));
	}
});

test("parse default tasks, explicit intervals, commands, multiline text, and escape syntax", () => {
	assert.deepEqual(parseCommand("check CI"), { type: "start", task: "check CI", intervalMs: DEFAULT_INTERVAL_MS });
	assert.deepEqual(parseCommand("5m check CI\nreport failures"), { type: "start", task: "check CI\nreport failures", intervalMs: 300_000 });
	assert.deepEqual(parseCommand("check CI", 60_000), { type: "start", task: "check CI", intervalMs: 60_000 });
	assert.deepEqual(parseCommand("default 1h"), { type: "default", intervalMs: 3_600_000 });
	for (const type of ["status", "stop", "help", "default"]) assert.deepEqual(parseCommand(type), { type });
	assert.deepEqual(parseCommand(""), { type: "help" });
	assert.equal(parseCommand("-- stop").task, "stop");
	assert.equal(parseCommand("-- 123 checks").task, "123 checks");
	assert.throws(() => parseCommand("5m"), /task/);
	assert.throws(() => parseCommand("5ms check CI"), /interval/);
});

test("first fire waits; subsequent fires wait a full interval from completion", async () => {
	const f = schedulerFixture();
	f.scheduler.start("task", 5_000);
	await f.clock.advance(4_999);
	assert.deepEqual(f.calls, []);
	await f.clock.advance(1);
	assert.deepEqual(f.calls, [1]);
	assert.equal(f.scheduler.snapshot.nextRunAt, 10_000);
	await f.clock.advance(5_000);
	assert.deepEqual(f.calls, [1, 2]);
	await f.scheduler.stop();
	assert.equal(f.clock.timers.size, 0);
});

test("busy parent defers and coalesces missed fires", async () => {
	const f = schedulerFixture();
	f.setIdle(false);
	f.scheduler.start("task", 1_000);
	await f.clock.advance(30_000);
	assert.deepEqual(f.calls, []);
	f.setIdle(true);
	await f.clock.advance(1_000);
	assert.deepEqual(f.calls, [1]);
	await f.scheduler.stop();
});

test("long runs cannot overlap and stopping aborts active work without rescheduling", async () => {
	let signal;
	const f = schedulerFixture((_iteration, activeSignal) => new Promise((resolveRun) => {
		signal = activeSignal;
		activeSignal.addEventListener("abort", resolveRun, { once: true });
	}));
	f.scheduler.start("task", 1_000);
	assert.throws(() => f.scheduler.start("another", 1_000), /already active/);
	await f.clock.advance(10_000);
	assert.deepEqual(f.calls, [1]);
	assert.equal(f.scheduler.snapshot.running, true);
	await f.scheduler.stop();
	assert.equal(signal.aborted, true);
	await f.clock.advance(10_000);
	assert.deepEqual(f.calls, [1]);
	assert.equal(f.scheduler.snapshot, undefined);
	await f.scheduler.stop();
});

test("failure is recorded, retried at the normal interval, and cleared on success", async () => {
	const f = schedulerFixture(async (iteration) => { if (iteration === 1) throw new Error("failed"); });
	f.scheduler.start("task", 1_000);
	await f.clock.advance(1_000);
	assert.equal(f.scheduler.snapshot.lastError, "failed");
	await f.clock.advance(1_000);
	assert.equal(f.scheduler.snapshot.lastError, undefined);
	await f.scheduler.stop();
});

test("synchronous run failures and immediate cancellation leave the scheduler reusable", async () => {
	const clock = new FakeClock();
	const scheduler = new LoopScheduler({ clock, canRun: () => true, onChange() {}, run() { throw new Error("sync"); } });
	scheduler.start("task", 1_000);
	await clock.advance(1_000);
	assert.equal(scheduler.snapshot.lastError, "sync");
	await scheduler.stop();
	scheduler.start("task", 1_000);
	await scheduler.stop();
	await clock.advance(5_000);
	assert.equal(clock.timers.size, 0);
});

async function workerFixture(t, prompt = "task") {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-loop-test-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	return {
		cwd: root, runDir: join(root, "run"),
		cliPath: fileURLToPath(new URL("./fake-cli.mjs", import.meta.url)),
		prompt, name: "loop-test-1", provider: "test", model: "test-model", thinking: "off",
		trusted: false, signal: new AbortController().signal,
	};
}

test("worker invokes a real subprocess with fresh session storage, literal args, and recursion guard", async (t) => {
	const options = await workerFixture(t, "@not-a-file; $(do not execute)");
	const args = buildArgs(options);
	for (const forbidden of ["--continue", "--resume", "--fork", "--session", "--no-session"]) assert.ok(!args.includes(forbidden));
	assert.ok(args.includes("--no-approve"));
	assert.equal(args.at(-1), options.prompt);
	assert.equal(args.at(-2), "--");
	assert.ok(buildArgs({ ...options, trusted: true }).includes("--approve"));
	const first = await runFreshSession(options);
	assert.equal(first.output, "fresh-session result");
	const invocation = JSON.parse(await readFile(join(options.runDir, "invocation.json"), "utf8"));
	assert.equal(invocation.worker, "1");
	assert.equal(invocation.cwd, options.cwd);
	const secondDir = join(options.cwd, "run2");
	await runFreshSession({ ...options, runDir: secondDir });
	const sessionFiles = async (dir) => (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
	assert.equal((await sessionFiles(options.runDir)).length, 1);
	assert.notEqual((await sessionFiles(options.runDir))[0], (await sessionFiles(secondDir))[0]);
});

test("large output is bounded in the result but fully logged", async (t) => {
	const options = await workerFixture(t, "large");
	const result = await runFreshSession(options);
	assert.ok(result.output.length < 4_100);
	assert.match(result.output, /truncated/);
	assert.ok((await readFile(join(options.runDir, "stdout.txt"))).length > 20_000);
});

test("nonzero exit and empty responses are errors", async (t) => {
	const options = await workerFixture(t, "fail");
	await assert.rejects(runFreshSession(options), /simulated provider failure/);
	await assert.rejects(runFreshSession({ ...options, prompt: "empty" }), /no final response/);
});

test("run timeout terminates a hanging process", async (t) => {
	const options = await workerFixture(t, "hang");
	await assert.rejects(runFreshSession({ ...options, timeoutMs: 150, killGraceMs: 50 }), /timed out/);
});

test("abort terminates an active subprocess and pre-aborted runs do not start", async (t) => {
	const options = await workerFixture(t, "hang");
	const controller = new AbortController();
	const pending = runFreshSession({ ...options, signal: controller.signal });
	const timer = setTimeout(() => controller.abort(), 150);
	try { await assert.rejects(pending, { name: "AbortError" }); }
	finally { clearTimeout(timer); }
	await assert.rejects(runFreshSession({ ...options, signal: controller.signal }), { name: "AbortError" });
});

function extensionFixture(t, mode = "tui") {
	const commands = new Map();
	const events = new Map();
	const notices = [];
	const statuses = [];
	extension({
		registerCommand: (name, command) => commands.set(name, command),
		on: (name, handler) => events.set(name, handler),
		getThinkingLevel: () => "off",
	});
	const ctx = {
		mode, cwd: resolve("."), model: { provider: "test", id: "test" },
		isProjectTrusted: () => false, isIdle: () => true, hasPendingMessages: () => false,
		ui: { notify: (message, level) => notices.push({ message, level }), setStatus: (_key, text) => statuses.push(text) },
	};
	t.after(async () => { await events.get("session_shutdown")({}, ctx); });
	return { command: (args) => commands.get("loop").handler(args, ctx), notices, statuses, events, ctx };
}

test("extension registers commands, changes defaults, rejects duplicate loops, and cleans up on shutdown", async (t) => {
	const f = extensionFixture(t);
	await f.command("default 1h");
	await f.command("check CI");
	assert.match(f.notices.at(-1).message, /First run in 1h/);
	await f.command("another task");
	assert.equal(f.notices.at(-1).level, "error");
	await f.command("status");
	assert.match(f.notices.at(-1).message, /Task: check CI/);
	await f.events.get("session_shutdown")({}, f.ctx);
	assert.equal(f.statuses.at(-1), undefined);
	await f.command("status");
	assert.match(f.notices.at(-1).message, /No active loop/);
});

test("print mode cannot start a recurring loop", async (t) => {
	const f = extensionFixture(t, "print");
	await f.command("1h check CI");
	assert.equal(f.notices.at(-1).level, "error");
	assert.match(f.notices.at(-1).message, /stays open/);
});

test("published Pi CLI loads and registers /loop through RPC without model calls", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-loop-load-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const output = execFileSync(process.execPath, [
		resolveCliPath(packageDir), "--mode", "rpc", "--no-session", "--no-extensions",
		"--extension", fileURLToPath(new URL("../index.ts", import.meta.url)),
		"--no-mcp", "--no-approve", "--offline",
	], {
		cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: root }, encoding: "utf8", timeout: 15_000,
		input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
	});
	const records = output.trim().split("\n").map((line) => JSON.parse(line));
	const response = records.find((record) => record.id === "commands");
	assert.equal(response?.success, true);
	assert.ok(response.data.commands.some((command) => command.name === "loop" && command.source === "extension"));
	assert.ok(!records.some((record) => record.type === "extension_error"));
});

test("worker mode does not register /loop or lifecycle handlers", () => {
	const previous = process.env.PI_LOOP_WORKER;
	process.env.PI_LOOP_WORKER = "1";
	try {
		extension({ registerCommand() { assert.fail("recursive command"); }, on() { assert.fail("recursive handler"); } });
	} finally {
		if (previous === undefined) delete process.env.PI_LOOP_WORKER;
		else process.env.PI_LOOP_WORKER = previous;
	}
});
