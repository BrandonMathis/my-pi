// Run with: node --test agent/extensions/worktree/tests/worktree.test.mjs
// Uses the installed Pi package (or PI_PACKAGE_DIR) and disposable Git repositories.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const packageDir = process.env.PI_PACKAGE_DIR ?? join(
	execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
	"@earendil-works/pi-coding-agent",
);
const requirePi = createRequire(join(packageDir, "package.json"));
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": packageDir,
		"@earendil-works/pi-tui": requirePi.resolve("@earendil-works/pi-tui"),
	},
});
const agentDir = mkdtempSync(join(tmpdir(), "pi-worktree-agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});
const { default: worktreeExtension } = await jiti.import("../../worktree.ts");
const { getKeybindings, stripTerminalSequences, visibleWidth } = await jiti.import("@earendil-works/pi-tui");
const OTHER = "+ Create new worktree from another branch...";
const DEFAULT = "+ Create new worktree (from master or main)";

function fixture(t, options = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-test-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-b", "main");
	git("config", "user.name", "Worktree Test");
	git("config", "user.email", "worktree@example.invalid");
	if (!options.empty) {
		git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Initial commit");
		git("branch", "feature/foo");
		git("branch", "feature/bar");
		git("remote", "add", "origin", root);
		git("update-ref", "refs/remotes/origin/remote-only", "HEAD");
		git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/remote-only");
	}
	const commands = new Map();
	const calls = [];
	const notifications = [];
	const selections = [];
	let switchedSession;
	worktreeExtension({
		registerCommand: (name, command) => commands.set(name, command),
		on() {},
		async exec(command, args, { cwd }) {
			calls.push(args);
			const result = spawnSync(command, args, { cwd, encoding: "utf8" });
			return { code: result.status, stdout: result.stdout, stderr: result.stderr };
		},
	});
	const ctx = {
		cwd: root,
		hasUI: true,
		mode: options.mode ?? "tui",
		sessionManager: { getSessionFile: () => undefined },
		waitForIdle: async () => {},
		async switchSession(file, { withSession }) {
			switchedSession = file;
			await withSession({ ui: ctx.ui });
			return { cancelled: false };
		},
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setStatus() {},
			async input() {
				assert.ok(options.name, "Existing-branch flow must not ask for a new name");
				return options.name;
			},
			async select(title, items) {
				selections.push({ title, items });
				if (title === "Worktree:") return options.action ?? OTHER;
				if (title === "Choose a branch for the worktree:") return options.branch;
				assert.equal(title, "Session context for the worktree:");
				return options.switch ? "Start fresh (clear session context)" : undefined;
			},
			async custom(factory) {
				let completed = false;
				let result;
				const component = factory(
					{ requestRender() {} },
					{ fg: (_color, text) => text, bold: (text) => text },
					getKeybindings(),
					(value) => { completed = true; result = value; },
				);
				component.focused = true;
				assert.equal(component.focused, true);
				const initial = stripTerminalSequences(component.render(100).join("\n"));
				assert.match(initial, /Type to filter branches/);
				assert.doesNotMatch(initial, /origin\/HEAD/);
				assert.doesNotMatch(initial, /^\s+origin\s+remote branch/m);
				if (options.picker) options.picker(component);
				else {
					for (const char of options.branch ?? "feature/foo") component.handleInput(char);
					component.handleInput("\r");
				}
				assert.ok(completed, "Picker must finish after confirm or cancel");
				return result;
			},
		},
	};
	return {
		root, git, calls, notifications, selections,
		run: (args = "") => commands.get("worktree").handler(args, ctx),
		worktree: (branch) => join(root, ".pi", "worktrees", branch.replaceAll("/", "-")),
		session: () => switchedSession,
	};
}

test("selecting a filtered local branch creates its worktree and switches sessions", async (t) => {
	const f = fixture(t, { branch: "FEATURE/FOO", switch: true });
	await f.run();
	assert.equal(f.git("-C", f.worktree("feature/foo"), "branch", "--show-current"), "feature/foo");
	assert.ok(f.calls.some((args) => args[0] === "worktree" && args[1] === "add" && !args.includes("-b")));
	assert.equal(JSON.parse(readFileSync(f.session(), "utf8").trim()).cwd, f.worktree("feature/foo"));
	assert.ok(!f.notifications.some(({ level }) => level === "error"));
});

test("selecting a remote-only branch creates a local tracking branch", async (t) => {
	const f = fixture(t, { branch: "origin/remote-only" });
	await f.run();
	assert.equal(f.git("-C", f.worktree("remote-only"), "branch", "--show-current"), "remote-only");
	assert.equal(f.git("rev-parse", "--abbrev-ref", "remote-only@{upstream}"), "origin/remote-only");
});

test("filtering supports no matches, backspace, navigation, and narrow rendering", async (t) => {
	const f = fixture(t, {
		picker(component) {
			for (const char of "zzz") component.handleInput(char);
			assert.match(component.render(100).join("\n"), /No matching/);
			component.handleInput("\r"); // No match must not select an arbitrary branch.
			for (let i = 0; i < 3; i++) component.handleInput("\x7f");
			for (const char of "feature/") component.handleInput(char);
			const rendered = component.render(100).join("\n");
			assert.match(rendered, /feature\/bar/);
			assert.match(rendered, /feature\/foo/);
			assert.doesNotMatch(rendered, /remote-only/);
			for (const width of [12, 40, 100]) {
				assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
			}
			component.invalidate();
			component.handleInput("\x1b[B");
			component.handleInput("\r");
		},
	});
	await f.run();
	assert.equal(f.git("-C", f.worktree("feature/foo"), "branch", "--show-current"), "feature/foo");
});

test("cancelling the picker creates nothing", async (t) => {
	const f = fixture(t, { picker: (component) => component.handleInput("\x1b") });
	await f.run();
	assert.ok(!f.calls.some((args) => args[0] === "worktree" && args[1] === "add"));
	assert.equal(f.selections.length, 1);
});

test("a branch with an existing worktree reuses it", async (t) => {
	const f = fixture(t, { branch: "feature/foo" });
	f.git("worktree", "add", join(f.root, "existing"), "feature/foo");
	await f.run();
	assert.ok(!f.calls.some((args) => args[0] === "worktree" && args[1] === "add"));
	assert.ok(f.notifications.some(({ message }) => message.includes("Using existing worktree")));
});

test("a branch checked out in the main tree is not checked out twice", async (t) => {
	const f = fixture(t, { branch: "main" });
	await f.run();
	assert.ok(!f.calls.some((args) => args[0] === "worktree" && args[1] === "add"));
	assert.ok(f.notifications.some(({ message, level }) => level === "error" && message.includes("main working tree")));
});

test("default creation still asks for a new name and bases it on main", async (t) => {
	const f = fixture(t, { action: DEFAULT, name: "feature/new" });
	await f.run();
	assert.equal(f.git("-C", f.worktree("feature/new"), "branch", "--show-current"), "feature/new");
	assert.equal(f.git("rev-parse", "feature/new"), f.git("rev-parse", "main"));
});

test("RPC uses a standard existing-branch dialog", async (t) => {
	const f = fixture(t, { mode: "rpc", branch: "feature/foo" });
	await f.run();
	assert.ok(f.selections.some(({ title }) => title === "Choose a branch for the worktree:"));
	assert.equal(f.git("-C", f.worktree("feature/foo"), "branch", "--show-current"), "feature/foo");
});

test("repositories without branches report an empty list without prompting", async (t) => {
	const f = fixture(t, { empty: true });
	await f.run();
	assert.ok(f.notifications.some(({ message }) => message === "No existing branches found"));
	assert.equal(f.selections.length, 1);
});
