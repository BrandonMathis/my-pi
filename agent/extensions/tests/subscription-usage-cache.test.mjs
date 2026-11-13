// node --test agent/extensions/tests/subscription-usage-cache.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	decideRefresh,
	FULL_REFRESH_AFTER_MS,
	readProviderUsage,
	readUsageCache,
	refreshSharedUsage,
	updateProviderUsage,
	USAGE_FRESH_MS,
} from "../lib/subscription-usage-cache.ts";

const dir = mkdtempSync(join(tmpdir(), "usage-cache-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
const freshPath = () => join(dir, `cache-${counter++}`, "subscription-usage.json");
const MIN = 60_000;
const T0 = 1_800_000_000_000;
const usage = (provider, percent) => ({ provider, windows: [{ label: "5h", usedPercent: percent }] });

function counted(outcome) {
	const fetcher = async () => {
		fetcher.calls += 1;
		return typeof outcome === "function" ? outcome() : outcome;
	};
	fetcher.calls = 0;
	return fetcher;
}

test("decideRefresh honors freshness, backoff, and the hourly full refresh", () => {
	const ok = { usage: usage("anthropic", 1), fetchedAt: T0 };
	assert.equal(decideRefresh("anthropic", ok, T0 + USAGE_FRESH_MS.anthropic - 1), "fresh");
	assert.equal(decideRefresh("anthropic", ok, T0 + USAGE_FRESH_MS.anthropic), "fetch");
	assert.equal(decideRefresh("anthropic", { ...ok, backoffUntil: T0 + 10 * MIN }, T0 + 6 * MIN), "backoff");
	assert.equal(decideRefresh("anthropic", { ...ok, backoffUntil: T0 + 2 * FULL_REFRESH_AFTER_MS }, T0 + FULL_REFRESH_AFTER_MS), "full-refresh");
	assert.equal(
		decideRefresh("anthropic", { ...ok, backoffUntil: T0 + 3 * FULL_REFRESH_AFTER_MS, lastFullRefreshAt: T0 + FULL_REFRESH_AFTER_MS }, T0 + FULL_REFRESH_AFTER_MS + MIN),
		"backoff",
		"full refresh runs at most once per hour",
	);
	assert.equal(decideRefresh("codex", { usage: usage("codex", 1), fetchedAt: T0 }, T0 + USAGE_FRESH_MS.codex), "fetch");
});

test("fresh shared data is reused without fetching", async () => {
	const path = freshPath();
	let now = T0;
	const fetcher = counted({ kind: "ok", usage: usage("anthropic", 10) });
	await refreshSharedUsage("anthropic", fetcher, { path, now: () => now });
	now += 4 * MIN;
	const entry = await refreshSharedUsage("anthropic", fetcher, { path, now: () => now });
	assert.equal(fetcher.calls, 1);
	assert.deepEqual(entry.usage, usage("anthropic", 10));
	now += 2 * MIN;
	await refreshSharedUsage("anthropic", fetcher, { path, now: () => now });
	assert.equal(fetcher.calls, 2);
});

test("429 backs off, escalates, and keeps the last known usage", async () => {
	const path = freshPath();
	let now = T0;
	await refreshSharedUsage("anthropic", counted({ kind: "ok", usage: usage("anthropic", 42) }), { path, now: () => now });

	const limited = counted({ kind: "error", status: 429 });
	now += 6 * MIN;
	let entry = await refreshSharedUsage("anthropic", limited, { path, now: () => now });
	assert.equal(limited.calls, 1);
	assert.deepEqual(entry.usage, usage("anthropic", 42));
	assert.equal(entry.failureCount, 1);
	assert.equal(entry.backoffUntil, now + 5 * MIN);
	assert.equal(entry.lastError, "HTTP 429");

	now += 4 * MIN;
	await refreshSharedUsage("anthropic", limited, { path, now: () => now });
	assert.equal(limited.calls, 1, "no fetch during backoff");

	now += 1 * MIN;
	entry = await refreshSharedUsage("anthropic", limited, { path, now: () => now });
	assert.equal(limited.calls, 2);
	assert.equal(entry.backoffUntil, now + 10 * MIN);

	now += 10 * MIN;
	entry = await refreshSharedUsage("anthropic", limited, { path, now: () => now });
	assert.equal(entry.backoffUntil, now + 15 * MIN, "429 backoff caps at 15 minutes");

	const larger = counted({ kind: "error", status: 429, retryAfterMs: 40 * MIN });
	now += 15 * MIN;
	entry = await refreshSharedUsage("anthropic", larger, { path, now: () => now });
	assert.equal(entry.backoffUntil, now + 40 * MIN, "Retry-After wins when longer");
	assert.deepEqual(entry.usage, usage("anthropic", 42));
});

test("success clears failure state", async () => {
	const path = freshPath();
	let now = T0;
	await refreshSharedUsage("codex", counted({ kind: "error", message: "network error or timeout" }), { path, now: () => now });
	assert.equal(readProviderUsage("codex", path).backoffUntil, now + 1 * MIN);
	now += 1 * MIN;
	const entry = await refreshSharedUsage("codex", counted({ kind: "ok", usage: usage("codex", 3) }), { path, now: () => now });
	assert.equal(entry.failureCount, undefined);
	assert.equal(entry.backoffUntil, undefined);
	assert.equal(entry.fetchedAt, now);
});

test("no new data for an hour forces a full refresh past backoff", async () => {
	const path = freshPath();
	updateProviderUsage(
		"anthropic",
		() => ({ usage: usage("anthropic", 50), fetchedAt: T0, failureCount: 9, backoffUntil: T0 + 5 * FULL_REFRESH_AFTER_MS, lastFullRefreshAt: T0 - 1 }),
		path,
	);
	const fetcher = counted({ kind: "error", status: 429 });
	let now = T0 + FULL_REFRESH_AFTER_MS - 1;
	await refreshSharedUsage("anthropic", fetcher, { path, now: () => now });
	assert.equal(fetcher.calls, 0, "still backing off before the hour");

	now = T0 + FULL_REFRESH_AFTER_MS;
	let entry = await refreshSharedUsage("anthropic", fetcher, { path, now: () => now });
	assert.equal(fetcher.calls, 1, "full refresh ignores backoff");
	assert.equal(entry.lastFullRefreshAt, now);
	assert.equal(entry.failureCount, 1, "full refresh restarts the backoff sequence");
	assert.equal(entry.backoffUntil, now + 5 * MIN);
	assert.deepEqual(entry.usage, usage("anthropic", 50));

	now += 30 * MIN;
	entry = await refreshSharedUsage("anthropic", fetcher, { path, now: () => now });
	assert.equal(fetcher.calls, 2, "normal backoff retries continue");

	const ok = counted({ kind: "ok", usage: usage("anthropic", 60) });
	now += 60 * MIN;
	entry = await refreshSharedUsage("anthropic", ok, { path, now: () => now });
	assert.equal(ok.calls, 1);
	assert.deepEqual(entry.usage, usage("anthropic", 60));
});

test("anthropic and codex share one JSON file", async () => {
	const path = freshPath();
	await refreshSharedUsage("anthropic", counted({ kind: "ok", usage: usage("anthropic", 11) }), { path, now: () => T0 });
	await refreshSharedUsage("codex", counted({ kind: "ok", usage: usage("codex", 22) }), { path, now: () => T0 });
	const file = JSON.parse(readFileSync(path, "utf-8"));
	assert.equal(file.version, 1);
	assert.deepEqual(file.providers.anthropic.usage, usage("anthropic", 11));
	assert.deepEqual(file.providers.codex.usage, usage("codex", 22));
	assert.doesNotMatch(readFileSync(path, "utf-8"), /token|Bearer/i);
});

test("skipped fetches (no credentials) leave the cache untouched", async () => {
	const path = freshPath();
	const entry = await refreshSharedUsage("anthropic", counted({ kind: "skipped" }), { path, now: () => T0 });
	assert.equal(entry, undefined);
	assert.deepEqual(readUsageCache(path).providers, {});
});

test("concurrent callers in one process share a single fetch", async () => {
	const path = freshPath();
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	const fetcher = counted(async () => {
		await gate;
		return { kind: "ok", usage: usage("anthropic", 7) };
	});
	const runs = [1, 2, 3].map(() => refreshSharedUsage("anthropic", fetcher, { path, now: () => T0 }));
	release();
	const entries = await Promise.all(runs);
	assert.equal(fetcher.calls, 1);
	for (const entry of entries) assert.deepEqual(entry.usage, usage("anthropic", 7));
});

test("another process's fetch lock blocks fetching until it goes stale", async () => {
	const path = freshPath();
	updateProviderUsage("anthropic", () => ({ usage: usage("anthropic", 5), fetchedAt: T0 }), path);
	const lockPath = `${path}.anthropic.fetch.lock`;
	writeFileSync(lockPath, "");
	const fetcher = counted({ kind: "ok", usage: usage("anthropic", 6) });
	const now = () => T0 + 10 * MIN;

	let entry = await refreshSharedUsage("anthropic", fetcher, { path, now });
	assert.equal(fetcher.calls, 0);
	assert.deepEqual(entry.usage, usage("anthropic", 5));

	const old = new Date(Date.now() - 60_000);
	utimesSync(lockPath, old, old);
	entry = await refreshSharedUsage("anthropic", fetcher, { path, now });
	assert.equal(fetcher.calls, 1, "stale lock from a crashed process is reclaimed");
	assert.deepEqual(entry.usage, usage("anthropic", 6));
});

test("thrown fetchers are recorded without raw error text", async () => {
	const path = freshPath();
	const entry = await refreshSharedUsage(
		"codex",
		async () => {
			throw new Error("secret-token-abc");
		},
		{ path, now: () => T0 },
	);
	assert.equal(entry.lastError, "fetch failed");
	assert.doesNotMatch(readFileSync(path, "utf-8"), /secret-token/);
});

test("corrupt cache files are treated as empty", () => {
	const path = freshPath();
	updateProviderUsage("codex", () => ({ fetchedAt: T0 }), path);
	writeFileSync(path, "{not json");
	assert.deepEqual(readUsageCache(path).providers, {});
	updateProviderUsage("codex", () => ({ fetchedAt: T0 }), path);
	assert.equal(readProviderUsage("codex", path).fetchedAt, T0);
});
