// Shared, cross-process cache for subscription usage meters (Anthropic + Codex).
//
// Every running pi process reads the same JSON file, so only one of them needs to
// hit a provider's usage endpoint per freshness window. Failed fetches back off
// (longer for HTTP 429) and keep the last known usage. If no successful fetch has
// happened for an hour, a full refresh bypasses the backoff (at most once per hour).
//
// This directory has no index.ts, so pi does not load it as an extension.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type UsageProvider = "anthropic" | "codex";

export type UsageFetchOutcome<T> =
	| { kind: "ok"; usage: T }
	/** Nothing was requested (for example, no credentials); leaves the cache untouched. */
	| { kind: "skipped" }
	| { kind: "error"; status?: number; retryAfterMs?: number; message?: string };

export type ProviderUsageEntry<T> = {
	usage?: T;
	/** Last successful fetch (epoch ms). */
	fetchedAt?: number;
	/** Last request attempt, successful or not (epoch ms). */
	lastAttemptAt?: number;
	/** Last time a full refresh bypassed backoff (epoch ms). */
	lastFullRefreshAt?: number;
	failureCount?: number;
	backoffUntil?: number;
	lastError?: string;
};

export type UsageCacheFile<T> = {
	version: 1;
	providers: Partial<Record<UsageProvider, ProviderUsageEntry<T>>>;
};

export type RefreshDecision = "fresh" | "backoff" | "fetch" | "full-refresh";

const MINUTE = 60_000;

/** How long a successful result is reused before anyone fetches again. */
export const USAGE_FRESH_MS: Record<UsageProvider, number> = {
	anthropic: 5 * MINUTE,
	codex: 1 * MINUTE,
};
/** Backoff after HTTP 429, indexed by consecutive failure count (last value repeats). */
export const RATE_LIMIT_BACKOFF_MS = [5 * MINUTE, 10 * MINUTE, 15 * MINUTE];
/** Backoff after other failures (network, timeout, 5xx, empty payload). */
export const ERROR_BACKOFF_MS = [1 * MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE];
/** Without new data for this long, bypass backoff and do a full refresh. */
export const FULL_REFRESH_AFTER_MS = 60 * MINUTE;

const FETCH_LOCK_STALE_MS = 30_000;
const WRITE_LOCK_STALE_MS = 5_000;
const WRITE_LOCK_WAIT_MS = 250;

export function defaultUsageCachePath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return join(agentDir, "cache", "subscription-usage.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeEntry<T>(value: unknown): ProviderUsageEntry<T> | undefined {
	if (!isRecord(value)) return undefined;
	return {
		usage: value.usage as T | undefined,
		fetchedAt: finiteOrUndefined(value.fetchedAt),
		lastAttemptAt: finiteOrUndefined(value.lastAttemptAt),
		lastFullRefreshAt: finiteOrUndefined(value.lastFullRefreshAt),
		failureCount: finiteOrUndefined(value.failureCount),
		backoffUntil: finiteOrUndefined(value.backoffUntil),
		lastError: typeof value.lastError === "string" ? value.lastError : undefined,
	};
}

export function readUsageCache<T>(path = defaultUsageCachePath()): UsageCacheFile<T> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		const providers = isRecord(parsed) && isRecord(parsed.providers) ? parsed.providers : {};
		const result: UsageCacheFile<T> = { version: 1, providers: {} };
		for (const provider of ["anthropic", "codex"] as const) {
			const entry = normalizeEntry<T>(providers[provider]);
			if (entry) result.providers[provider] = entry;
		}
		return result;
	} catch {
		return { version: 1, providers: {} };
	}
}

export function readProviderUsage<T>(provider: UsageProvider, path = defaultUsageCachePath()): ProviderUsageEntry<T> | undefined {
	return readUsageCache<T>(path).providers[provider];
}

export function decideRefresh(
	provider: UsageProvider,
	entry: ProviderUsageEntry<unknown> | undefined,
	now: number,
): RefreshDecision {
	const fetchedAt = entry?.fetchedAt ?? 0;
	if (entry?.usage !== undefined && now - fetchedAt < USAGE_FRESH_MS[provider]) return "fresh";
	if (now - fetchedAt >= FULL_REFRESH_AFTER_MS && now - (entry?.lastFullRefreshAt ?? 0) >= FULL_REFRESH_AFTER_MS) {
		return "full-refresh";
	}
	if ((entry?.backoffUntil ?? 0) > now) return "backoff";
	return "fetch";
}

export function backoffDelayMs(status: number | undefined, failureCount: number, retryAfterMs?: number): number {
	const schedule = status === 429 ? RATE_LIMIT_BACKOFF_MS : ERROR_BACKOFF_MS;
	const index = Math.min(Math.max(failureCount, 1), schedule.length) - 1;
	return Math.max(schedule[index] ?? schedule[schedule.length - 1] ?? MINUTE, retryAfterMs ?? 0);
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Create `lockPath` exclusively. Removes a stale lock left by a crashed process. */
function tryAcquireLock(lockPath: string, staleMs: number): boolean {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			mkdirSync(dirname(lockPath), { recursive: true });
			closeSync(openSync(lockPath, "wx"));
			return true;
		} catch {
			try {
				if (Date.now() - statSync(lockPath).mtimeMs <= staleMs) return false;
				rmSync(lockPath, { force: true });
			} catch {
				// Lock vanished between calls; retry once.
			}
		}
	}
	return false;
}

function releaseLock(lockPath: string): void {
	try {
		rmSync(lockPath, { force: true });
	} catch {
		// Best effort.
	}
}

/** Read-modify-write one provider's entry under a short write lock, atomically replacing the file. */
export function updateProviderUsage<T>(
	provider: UsageProvider,
	mutate: (entry: ProviderUsageEntry<T>) => ProviderUsageEntry<T>,
	path = defaultUsageCachePath(),
): ProviderUsageEntry<T> {
	const lockPath = `${path}.lock`;
	const deadline = Date.now() + WRITE_LOCK_WAIT_MS;
	let locked = tryAcquireLock(lockPath, WRITE_LOCK_STALE_MS);
	while (!locked && Date.now() < deadline) {
		sleepSync(10);
		locked = tryAcquireLock(lockPath, WRITE_LOCK_STALE_MS);
	}

	try {
		const cache = readUsageCache<T>(path);
		const next = mutate({ ...cache.providers[provider] });
		cache.providers[provider] = next;
		mkdirSync(dirname(path), { recursive: true });
		const tmpPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		writeFileSync(tmpPath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmpPath, path);
		return next;
	} finally {
		if (locked) releaseLock(lockPath);
	}
}

const inFlight = new Map<string, Promise<ProviderUsageEntry<unknown> | undefined>>();

/**
 * Return the shared entry for `provider`, fetching first only if the cache is
 * stale, not backing off, and no other process is already fetching.
 */
export function refreshSharedUsage<T>(
	provider: UsageProvider,
	fetcher: () => Promise<UsageFetchOutcome<T>>,
	options: { path?: string; now?: () => number } = {},
): Promise<ProviderUsageEntry<T> | undefined> {
	const path = options.path ?? defaultUsageCachePath();
	const key = `${path}\0${provider}`;
	const existing = inFlight.get(key);
	if (existing) return existing as Promise<ProviderUsageEntry<T> | undefined>;

	const run = runRefresh(provider, fetcher, path, options.now ?? Date.now).finally(() => inFlight.delete(key));
	inFlight.set(key, run as Promise<ProviderUsageEntry<unknown> | undefined>);
	return run;
}

async function runRefresh<T>(
	provider: UsageProvider,
	fetcher: () => Promise<UsageFetchOutcome<T>>,
	path: string,
	now: () => number,
): Promise<ProviderUsageEntry<T> | undefined> {
	const initial = readProviderUsage<T>(provider, path);
	if (["fresh", "backoff"].includes(decideRefresh(provider, initial, now()))) return initial;

	const fetchLockPath = `${path}.${provider}.fetch.lock`;
	if (!tryAcquireLock(fetchLockPath, FETCH_LOCK_STALE_MS)) return initial;

	try {
		// Another process may have finished a fetch while we were acquiring the lock.
		const entry = readProviderUsage<T>(provider, path);
		const decision = decideRefresh(provider, entry, now());
		if (decision === "fresh" || decision === "backoff") return entry;

		const fullRefresh = decision === "full-refresh";
		const attemptAt = now();
		let outcome: UsageFetchOutcome<T>;
		try {
			outcome = await fetcher();
		} catch {
			// Raw provider errors may echo credentials; store a generic message only.
			outcome = { kind: "error", message: "fetch failed" };
		}
		if (outcome.kind === "skipped") return entry;

		return updateProviderUsage<T>(
			provider,
			(current) => {
				if (outcome.kind === "ok") {
					return {
						usage: outcome.usage,
						fetchedAt: attemptAt,
						lastAttemptAt: attemptAt,
						lastFullRefreshAt: fullRefresh ? attemptAt : current.lastFullRefreshAt,
					};
				}
				// A full refresh starts a fresh backoff sequence.
				const failureCount = (fullRefresh ? 0 : (current.failureCount ?? 0)) + 1;
				return {
					...current, // keep the last known usage
					lastAttemptAt: attemptAt,
					lastFullRefreshAt: fullRefresh ? attemptAt : current.lastFullRefreshAt,
					failureCount,
					backoffUntil: attemptAt + backoffDelayMs(outcome.status, failureCount, outcome.retryAfterMs),
					lastError: outcome.status ? `HTTP ${outcome.status}` : (outcome.message ?? "fetch failed"),
				};
			},
			path,
		);
	} finally {
		releaseLock(fetchLockPath);
	}
}
