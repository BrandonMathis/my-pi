// node --test agent/extensions/tests/confirm-abort.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

const packageDir = process.env.PI_PACKAGE_DIR ?? join(
	execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
	"@earendil-works/pi-coding-agent",
);
const requirePi = createRequire(join(packageDir, "package.json"));
const { createJiti } = requirePi("jiti");
const jiti = createJiti(import.meta.url, {
	alias: { "@mariozechner/pi-tui": requirePi.resolve("@earendil-works/pi-tui") },
});
const { default: extension } = await jiti.import("../confirm-abort.ts");
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture() {
	const handlers = new Map();
	let input;
	let idle = false;
	let aborts = 0;
	const dialogs = [];
	const warnings = [];
	const ctx = {
		hasUI: true,
		isIdle: () => idle,
		abort: () => { aborts++; },
		ui: {
			onTerminalInput(handler) {
				input = handler;
				return () => { input = undefined; };
			},
			select(_title, options, { signal }) {
				return new Promise((resolve, reject) => {
					dialogs.push({ options, signal, resolve, reject });
					signal.addEventListener("abort", () => resolve(undefined), { once: true });
				});
			},
			notify: (...args) => warnings.push(args),
		},
	};
	extension({ on: (event, handler) => handlers.set(event, handler) });
	const emit = (event) => handlers.get(event)({}, ctx);
	emit("session_start");
	return {
		emit, dialogs, warnings,
		press: (key = "\x1b") => input?.(key),
		setIdle: (value) => { idle = value; },
		get aborts() { return aborts; },
	};
}

test("Escape dismisses the confirmation without aborting and allows another prompt", async () => {
	const f = fixture();
	assert.deepEqual(f.press(), { consume: true });
	assert.equal(f.dialogs.length, 1);
	assert.equal(f.aborts, 0);
	assert.deepEqual(f.press(), { consume: true });
	assert.equal(f.dialogs[0].signal.aborted, true);
	await flush();
	assert.equal(f.aborts, 0);
	assert.deepEqual(f.press(), { consume: true });
	assert.equal(f.dialogs.length, 2);
});

test("Escape keyup and repeats do not immediately close the dialog", async () => {
	const f = fixture();
	const keydown = "\x1b[27;1:1u";
	const repeat = "\x1b[27;1:2u";
	const keyup = "\x1b[27;1:3u";

	assert.deepEqual(f.press(keydown), { consume: true });
	assert.equal(f.dialogs.length, 1);
	for (const event of [repeat, repeat, keyup]) {
		assert.deepEqual(f.press(event), { consume: true });
		assert.equal(f.dialogs[0].signal.aborted, false);
	}
	await flush();
	assert.equal(f.dialogs.length, 1);
	assert.equal(f.aborts, 0);

	// Only a separate press cancels; its keyup must not reopen the dialog.
	assert.deepEqual(f.press(keydown), { consume: true });
	assert.equal(f.dialogs[0].signal.aborted, true);
	await flush();
	for (const event of [repeat, keyup]) {
		assert.deepEqual(f.press(event), { consume: true });
	}
	assert.equal(f.dialogs.length, 1);
	assert.equal(f.aborts, 0);
});

test("orphaned Escape keyup and repeat events do not open a dialog", () => {
	const f = fixture();
	for (const event of ["\x1b[27;1:3u", "\x1b[27;1:2u"]) {
		assert.deepEqual(f.press(event), { consume: true });
	}
	assert.equal(f.dialogs.length, 0);
	assert.equal(f.aborts, 0);
});

test("Escape still dismisses the dialog if work finished meanwhile", async () => {
	const f = fixture();
	f.press();
	f.setIdle(true);
	assert.deepEqual(f.press(), { consume: true });
	assert.equal(f.dialogs[0].signal.aborted, true);
	await flush();
	assert.equal(f.aborts, 0);
	assert.equal(f.press(), undefined);
});

test("idle Escape and other keys pass through", () => {
	const f = fixture();
	assert.equal(f.press("x"), undefined);
	f.setIdle(true);
	assert.equal(f.press(), undefined);
	assert.equal(f.dialogs.length, 0);
});

test("No is the default option and Enter keeps working", async () => {
	const f = fixture();
	f.press();
	assert.deepEqual(f.dialogs[0].options, ["No", "Yes"]);
	f.dialogs[0].resolve(f.dialogs[0].options[0]);
	await flush();
	assert.equal(f.aborts, 0);
});

test("Yes aborts work and No keeps working", async () => {
	for (const choice of ["Yes", "No"]) {
		const f = fixture();
		f.press();
		f.dialogs[0].resolve(choice);
		await flush();
		assert.equal(f.aborts, choice === "Yes" ? 1 : 0);
	}
});

test("Escape overrides a Yes result that has not resumed yet", async () => {
	const f = fixture();
	f.press();
	f.dialogs[0].resolve("Yes");
	f.press();
	await flush();
	assert.equal(f.aborts, 0);
});

test("session changes dismiss old dialogs without clearing the new confirmation", async () => {
	const f = fixture();
	f.press();
	f.emit("session_start");
	assert.equal(f.dialogs[0].signal.aborted, true);
	f.press();
	await flush();
	f.press();
	assert.equal(f.dialogs.length, 2);
	assert.equal(f.dialogs[1].signal.aborted, true);
	f.emit("session_shutdown");
	assert.equal(f.press(), undefined);
	assert.equal(f.aborts, 0);
});

test("dialog failures warn and release the confirmation state", async () => {
	const f = fixture();
	f.press();
	f.dialogs[0].reject(new Error("dialog failed"));
	await flush();
	assert.equal(f.warnings.length, 1);
	f.press();
	assert.equal(f.dialogs.length, 2);
});
