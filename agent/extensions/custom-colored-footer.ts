import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const FOLDER_ICON = "󰉋";
const BURNT_ORANGE = "#CC5500";
const WHITE = "#FFFFFF";
const GREY = "#9CA3AF";
const GREEN = "#22C55E";
const API_SPEND_START_GREEN = "#9CAEA4";
const DRACULA_GREEN = "#50FA7B";
const API_SPEND_MAX_DOLLARS = 5;
const YELLOW = "#FACC15";
const RED = "#EF4444";
const CODEX_GREEN = "#10B981";
const CLAUDE_ORANGE = "#D97706";
const SUBSCRIPTION_BAR_WIDTH = 10;
const AUTO_SESSION_NAME_ENTRY_TYPE = "auto-session-name";

type AutoSessionNameEntry = {
	title?: string;
};

type SubscriptionProvider = "anthropic" | "codex";
type BillingMode = "api" | "subscription";

type RateWindow = {
	label: string;
	usedPercent: number;
	resetDescription?: string;
	resetAt?: string;
};

type SubscriptionUsage = {
	provider: SubscriptionProvider;
	windows: RateWindow[];
};

type SessionEntryLike = {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		stopReason?: string;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			totalTokens?: number;
			cost?: {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				total?: number;
			};
		};
	};
};

type FooterContextUsage = {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
};

type TokenTotals = { input: number; output: number };
type FooterPiece = string | false | null | undefined;

type StatusBarParts = {
	width: number;
	top: FooterPiece[];
	left: FooterPiece[];
	right: string;
	separator: string;
};

function hex(hexColor: string, text: string): string {
	const clean = hexColor.replace("#", "");
	if (clean.length !== 6) return text;
	const r = Number.parseInt(clean.slice(0, 2), 16);
	const g = Number.parseInt(clean.slice(2, 4), 16);
	const b = Number.parseInt(clean.slice(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return text;
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function hexToRgb(hexColor: string): { r: number; g: number; b: number } | null {
	const clean = hexColor.replace("#", "");
	if (clean.length !== 6) return null;
	const r = Number.parseInt(clean.slice(0, 2), 16);
	const g = Number.parseInt(clean.slice(2, 4), 16);
	const b = Number.parseInt(clean.slice(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
	return { r, g, b };
}

function rgbToHex(r: number, g: number, b: number): string {
	const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function mixHexColor(fromHex: string, toHex: string, amount: number): string {
	const from = hexToRgb(fromHex);
	const to = hexToRgb(toHex);
	if (!from || !to) return toHex;
	const t = Math.max(0, Math.min(1, amount));
	const r = from.r + (to.r - from.r) * t;
	const g = from.g + (to.g - from.g) * t;
	const b = from.b + (to.b - from.b) * t;
	return rgbToHex(r, g, b);
}

function gradientText(text: string, fromHex: string, toHex: string): string {
	const chars = [...text];
	const denominator = Math.max(chars.length - 1, 1);
	return chars
		.map((char, index) => {
			if (char === " ") return char;
			return hex(mixHexColor(fromHex, toHex, index / denominator), char);
		})
		.join("");
}

function rainbowText(text: string): string {
	const palette = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];
	let i = 0;
	return [...text]
		.map((char) => {
			if (char === " ") return char;
			const color = palette[i % palette.length];
			i += 1;
			return hex(color, char);
		})
		.join("");
}

function colorizeThinkingLevel(level: string): string {
	switch (level) {
		case "off":
			return hex("#6b7280", " • thinking off");
		case "minimal":
			return hex("#60a5fa", " • minimal");
		case "low":
			return hex("#2dd4bf", " • low");
		case "medium":
			return hex("#a78bfa", " • medium");
		case "high":
			return gradientText(" • high", "#f59e0b", "#f43f5e");
		case "xhigh":
			return rainbowText(" • xhigh");
		default:
			return hex("#9ca3af", ` • ${level}`);
	}
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function getPercentColor(percent: number): string {
	if (percent >= 90) return RED;
	if (percent >= 75) return YELLOW;
	return percent >= 60 ? CLAUDE_ORANGE : GREEN;
}

function getProviderColor(provider: SubscriptionProvider): string {
	return provider === "anthropic" ? CLAUDE_ORANGE : CODEX_GREEN;
}

function renderSolidBar(percent: number, width: number, fillColor: string, dim: (text: string) => string): string {
	const clamped = clampPercent(percent);
	// Avoid fractional block glyphs here: terminals render the unused part of
	// those cells with the footer background, creating a third, dark color.
	const filledCount = Math.round((clamped / 100) * width);
	const emptyCount = width - filledCount;
	const filled = "█".repeat(filledCount);
	const empty = "░".repeat(emptyCount);
	return `${hex(fillColor, filled)}${dim(empty)}`;
}

function normalizeSubscriptionProvider(value: unknown): SubscriptionProvider | undefined {
	return value === "anthropic" || value === "codex" ? value : undefined;
}

function normalizeRateWindow(value: unknown): RateWindow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as { label?: unknown; usedPercent?: unknown; resetDescription?: unknown };
	const percent = typeof raw.usedPercent === "number" ? raw.usedPercent : Number(raw.usedPercent);
	if (!Number.isFinite(percent)) return undefined;
	return {
		label: typeof raw.label === "string" ? raw.label : "",
		usedPercent: percent,
		resetDescription: typeof raw.resetDescription === "string" ? raw.resetDescription : undefined,
	};
}

function getSubscriptionUsageFromPayload(payload: unknown): SubscriptionUsage | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const state = (payload as { state?: unknown }).state;
	if (!state || typeof state !== "object") return undefined;
	const rawState = state as { provider?: unknown; usage?: unknown };
	const usage = rawState.usage && typeof rawState.usage === "object" ? rawState.usage : undefined;
	const rawUsage = usage as { provider?: unknown; windows?: unknown } | undefined;
	const provider = normalizeSubscriptionProvider(rawUsage?.provider ?? rawState.provider);
	if (!provider || !Array.isArray(rawUsage?.windows)) return undefined;

	const windows = rawUsage.windows.map(normalizeRateWindow).filter((w): w is RateWindow => Boolean(w));
	if (windows.length === 0) return undefined;

	return { provider, windows };
}

function getSubscriptionSessionWindow(usage: SubscriptionUsage): RateWindow | undefined {
	return (
		usage.windows.find((window) => /(?:^|\s)5h(?:\s|$)/i.test(window.label)) ??
		usage.windows.find((window) => /(?:^|\s)\d+h(?:\s|$)/i.test(window.label)) ??
		usage.windows[0]
	);
}

function getLiveResetDescription(window: RateWindow): string | undefined {
	if (window.resetAt) {
		const resetDate = new Date(window.resetAt);
		if (Number.isFinite(resetDate.getTime())) return formatResetDescription(resetDate);
	}
	return window.resetDescription;
}

function renderSubscriptionUsage(usage: SubscriptionUsage, dim: (text: string) => string): string | undefined {
	const window = getSubscriptionSessionWindow(usage);
	if (!window) return undefined;

	const percent = clampPercent(window.usedPercent);
	const percentColor = getPercentColor(percent);
	const providerColor = getProviderColor(usage.provider);
	const fillColor = percentColor === GREEN ? providerColor : percentColor;
	const period = window.label ? `${hex(providerColor, window.label)} ` : "";
	const bar = renderSolidBar(percent, SUBSCRIPTION_BAR_WIDTH, fillColor, dim);
	const resetDescription = getLiveResetDescription(window);
	const reset = resetDescription && resetDescription !== "__ACTIVE__" ? dim(`↻ ${resetDescription}`) : "";

	return `${period}${bar} ${hex(percentColor, `${Math.round(percent)}%`)}${reset ? ` ${reset}` : ""}`;
}

function hasEnvironmentSubscriptionAuth(ctx: ExtensionContext): boolean {
	const provider = ctx.model?.provider?.toLowerCase() ?? "";
	if (provider.includes("anthropic")) return Boolean(stringValue(process.env.ANTHROPIC_OAUTH_TOKEN));
	if (!provider.includes("codex")) return false;
	return Boolean(
		stringValue(process.env.OPENAI_CODEX_OAUTH_TOKEN) ??
			stringValue(process.env.OPENAI_CODEX_ACCESS_TOKEN) ??
			stringValue(process.env.CODEX_OAUTH_TOKEN) ??
			stringValue(process.env.CODEX_ACCESS_TOKEN),
	);
}

function getContextBillingMode(ctx: ExtensionContext): BillingMode | undefined {
	if (!ctx.model) return undefined;
	return ctx.modelRegistry.isUsingOAuth(ctx.model) || hasEnvironmentSubscriptionAuth(ctx) ? "subscription" : "api";
}

function formatDollars(amount: number): string {
	if (!Number.isFinite(amount) || amount <= 0) return "$0.000";
	return `$${amount < 0.01 ? amount.toFixed(4) : amount.toFixed(3)}`;
}

function getUsageCostTotal(usage: SessionEntryLike["message"]["usage"]): number {
	const cost = usage?.cost;
	if (!cost) return 0;
	const total = numberValue(cost.total);
	if (total !== undefined) return total;
	return (
		(numberValue(cost.input) ?? 0) +
		(numberValue(cost.output) ?? 0) +
		(numberValue(cost.cacheRead) ?? 0) +
		(numberValue(cost.cacheWrite) ?? 0)
	);
}

function getSessionSpend(entries: SessionEntryLike[]): number {
	return entries.reduce((total, entry) => {
		if (entry.type !== "message" || entry.message?.role !== "assistant") return total;
		return total + getUsageCostTotal(entry.message.usage);
	}, 0);
}

function renderSessionSpend(entries: SessionEntryLike[]): string {
	const total = getSessionSpend(entries);
	const color = mixHexColor(API_SPEND_START_GREEN, DRACULA_GREEN, total / API_SPEND_MAX_DOLLARS);
	return hex(color, formatDollars(total));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		return asRecord(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return undefined;
	}
}

function readPiAuth(): Record<string, unknown> | undefined {
	return readJsonFile(join(homedir(), ".pi", "agent", "auth.json"));
}

function formatResetDescription(date: Date): string {
	const diffMs = date.getTime() - Date.now();
	if (diffMs <= 0) return "now";

	const minutes = Math.floor(diffMs / 60000);
	if (minutes < 60) return `${minutes}m`;

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours < 24) return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;

	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return remainingHours > 0 ? `${days}d${remainingHours}h` : `${days}d`;
}

function getWindowLabel(windowSeconds?: number, fallbackWindowSeconds?: number): string {
	const safeSeconds =
		typeof windowSeconds === "number" && windowSeconds > 0
			? windowSeconds
			: typeof fallbackWindowSeconds === "number" && fallbackWindowSeconds > 0
				? fallbackWindowSeconds
				: 0;
	if (!safeSeconds) return "0h";
	const hours = Math.round(safeSeconds / 3600);
	if (hours >= 144) return "Week";
	if (hours >= 24) return "Day";
	return `${hours}h`;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		if (!response.ok) return undefined;
		return await response.json();
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

function loadAnthropicToken(): string | undefined {
	const envToken = stringValue(process.env.ANTHROPIC_OAUTH_TOKEN);
	if (envToken) return envToken;

	const auth = readPiAuth();
	const piToken = stringValue(asRecord(auth?.anthropic)?.access);
	if (piToken) return piToken;

	try {
		const keychainData = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const parsed = asRecord(JSON.parse(keychainData));
		const oauth = asRecord(parsed?.claudeAiOauth);
		const scopes = Array.isArray(oauth?.scopes) ? oauth.scopes : [];
		if (scopes.includes("user:profile")) return stringValue(oauth?.accessToken);
	} catch {
		return undefined;
	}

	return undefined;
}

function loadCodexCredentials(): { accessToken?: string; accountId?: string } {
	const envAccessToken =
		stringValue(process.env.OPENAI_CODEX_OAUTH_TOKEN) ??
		stringValue(process.env.OPENAI_CODEX_ACCESS_TOKEN) ??
		stringValue(process.env.CODEX_OAUTH_TOKEN) ??
		stringValue(process.env.CODEX_ACCESS_TOKEN);
	const envAccountId = stringValue(process.env.OPENAI_CODEX_ACCOUNT_ID) ?? stringValue(process.env.CHATGPT_ACCOUNT_ID);
	if (envAccessToken) return { accessToken: envAccessToken, accountId: envAccountId };

	const piAuth = readPiAuth();
	const codexAuth = asRecord(piAuth?.["openai-codex"]);
	const piAccessToken = stringValue(codexAuth?.access);
	if (piAccessToken) {
		return { accessToken: piAccessToken, accountId: stringValue(codexAuth?.accountId) };
	}

	const codexHome = stringValue(process.env.CODEX_HOME) ?? join(homedir(), ".codex");
	const legacyAuth = readJsonFile(join(codexHome, "auth.json"));
	const legacyApiKey = stringValue(legacyAuth?.OPENAI_API_KEY);
	if (legacyApiKey) return { accessToken: legacyApiKey };

	const legacyTokens = asRecord(legacyAuth?.tokens);
	return {
		accessToken: stringValue(legacyTokens?.access_token),
		accountId: stringValue(legacyTokens?.account_id),
	};
}

async function fetchAnthropicSubscriptionUsage(): Promise<SubscriptionUsage | undefined> {
	const token = loadAnthropicToken();
	if (!token) return undefined;

	const data = asRecord(
		await fetchJson("https://api.anthropic.com/api/oauth/usage", {
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
		}),
	);
	if (!data) return undefined;

	const windows: RateWindow[] = [];
	for (const [key, label] of [
		["five_hour", "5h"],
		["seven_day", "Week"],
	] as const) {
		const source = asRecord(data[key]);
		const usedPercent = numberValue(source?.utilization);
		if (usedPercent === undefined) continue;
		const resetAt = stringValue(source?.resets_at);
		const resetDate = resetAt ? new Date(resetAt) : undefined;
		windows.push({
			label,
			usedPercent,
			resetDescription: resetDate && Number.isFinite(resetDate.getTime()) ? formatResetDescription(resetDate) : undefined,
			resetAt: resetDate && Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : undefined,
		});
	}

	return windows.length > 0 ? { provider: "anthropic", windows } : undefined;
}

function pushCodexWindow(
	windows: RateWindow[],
	prefix: string | undefined,
	window: Record<string, unknown> | undefined,
	fallbackWindowSeconds?: number,
): void {
	if (!window) return;
	const usedPercent = numberValue(window.used_percent) ?? 0;
	const resetSeconds = numberValue(window.reset_at);
	const resetDate = resetSeconds ? new Date(resetSeconds * 1000) : undefined;
	const label = getWindowLabel(numberValue(window.limit_window_seconds), fallbackWindowSeconds);
	windows.push({
		label: prefix ? `${prefix} ${label}` : label,
		usedPercent,
		resetDescription: resetDate && Number.isFinite(resetDate.getTime()) ? formatResetDescription(resetDate) : undefined,
		resetAt: resetDate && Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : undefined,
	});
}

function pushCodexRateWindows(
	windows: RateWindow[],
	rateLimit: Record<string, unknown> | undefined,
	prefix?: string,
): void {
	pushCodexWindow(windows, prefix, asRecord(rateLimit?.primary_window), 10800);
	pushCodexWindow(windows, prefix, asRecord(rateLimit?.secondary_window), 86400);
}

async function fetchCodexSubscriptionUsage(): Promise<SubscriptionUsage | undefined> {
	const { accessToken, accountId } = loadCodexCredentials();
	if (!accessToken) return undefined;

	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
	};
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;

	const data = asRecord(await fetchJson("https://chatgpt.com/backend-api/wham/usage", { headers }));
	if (!data) return undefined;

	const windows: RateWindow[] = [];
	pushCodexRateWindows(windows, asRecord(data.rate_limit));

	const additionalRateLimits = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
	for (const item of additionalRateLimits) {
		const entry = asRecord(item);
		if (!entry) continue;
		const prefix = stringValue(entry.limit_name) ?? stringValue(entry.metered_feature) ?? "Additional";
		pushCodexRateWindows(windows, asRecord(entry.rate_limit), prefix);
	}

	return windows.length > 0 ? { provider: "codex", windows } : undefined;
}

function getContextSubscriptionProvider(ctx: ExtensionContext): SubscriptionProvider | undefined {
	const provider = ctx.model?.provider?.toLowerCase() ?? "";
	const modelId = ctx.model?.id?.toLowerCase() ?? "";
	if (provider.includes("anthropic") || modelId.includes("claude")) return "anthropic";
	if (provider.includes("codex")) return "codex";
	return undefined;
}

async function fetchSubscriptionUsageForContext(ctx: ExtensionContext): Promise<SubscriptionUsage | undefined> {
	const provider = getContextSubscriptionProvider(ctx);
	if (provider === "anthropic") return fetchAnthropicSubscriptionUsage();
	if (provider === "codex") return fetchCodexSubscriptionUsage();
	return undefined;
}

function extractPrNumber(branch: string | null): string | null {
	if (!branch) return null;
	const patterns = [
		/#(\d+)/i,
		/(?:^|[\/-])(?:pr|pull|mr)[\/-]?(\d+)(?:$|[\/-])/i,
		/(?:^|[\/-])PR-(\d+)(?:$|[\/-])/i,
	];
	for (const pattern of patterns) {
		const match = branch.match(pattern);
		if (match?.[1]) return match[1];
	}
	return null;
}

function getAutoSessionTitle(entries: SessionEntryLike[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== AUTO_SESSION_NAME_ENTRY_TYPE) continue;
		const data = entry.data as AutoSessionNameEntry | undefined;
		if (typeof data?.title !== "string") continue;
		const title = data.title.trim();
		if (title) return title;
	}
	return undefined;
}

function getAssistantContextTokens(message: SessionEntryLike["message"]): number {
	const usage = message?.usage;
	if (!usage) return 0;
	return (
		usage.totalTokens ||
		(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
	);
}

function getFooterContextUsage(entries: SessionEntryLike[], contextWindow: number): FooterContextUsage {
	if (contextWindow <= 0) return { tokens: null, contextWindow, percent: null };

	const latestCompactionIndex = entries.map((entry) => entry.type).lastIndexOf("compaction");
	for (let i = entries.length - 1; i > latestCompactionIndex; i -= 1) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		if (entry.message.stopReason === "aborted" || entry.message.stopReason === "error") continue;

		const tokens = getAssistantContextTokens(entry.message);
		if (tokens <= 0) break;
		return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
	}

	return { tokens: null, contextWindow, percent: null };
}

function compactPieces(parts: FooterPiece[]): string[] {
	return parts.filter((part): part is string => typeof part === "string" && part.length > 0);
}

function getTokenTotals(entries: SessionEntryLike[]): TokenTotals {
	return entries.reduce(
		(totals, entry) => {
			if (entry.type !== "message" || entry.message?.role !== "assistant") return totals;
			return {
				input: totals.input + (entry.message.usage?.input ?? 0),
				output: totals.output + (entry.message.usage?.output ?? 0),
			};
		},
		{ input: 0, output: 0 },
	);
}

function renderTokenTotals({ input, output }: TokenTotals): string | undefined {
	const parts = compactPieces([
		input > 0 && `${hex(WHITE, "↑")}${hex(GREY, formatTokens(input))}`,
		output > 0 && `${hex(WHITE, "↓")}${hex(GREY, formatTokens(output))}`,
	]);
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function renderContextUsage(
	usage: FooterContextUsage,
	colorize: (color: "dim" | "warning" | "error", text: string) => string,
): string {
	const percent = usage.percent ?? 0;
	const color = percent > 90 ? "error" : percent > 70 ? "warning" : "dim";
	const tokensText = usage.tokens === null ? "?" : formatTokens(usage.tokens);
	const percentText = usage.percent === null ? "?" : `${usage.percent.toFixed(1)}%`;
	return colorize(color, `${tokensText}/${formatTokens(usage.contextWindow)} ${percentText} (auto)`);
}

function renderModelStatus({
	modelId,
	provider,
	showProvider,
	thinkingLevel,
	dim,
	bold,
}: {
	modelId: string;
	provider?: string;
	showProvider: boolean;
	thinkingLevel: string;
	dim: (text: string) => string;
	bold: (text: string) => string;
}): string {
	const providerPart = provider && showProvider ? dim(`(${provider}) `) : "";
	return `${providerPart}${hex(WHITE, bold(modelId))}${colorizeThinkingLevel(thinkingLevel)}`;
}

function fitLeftRight(left: string, right: string, width: number, minPadding = 2): string {
	if (!left) return truncateToWidth(right, width, "");

	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);

	if (leftWidth + minPadding + rightWidth <= width) {
		return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
	}

	const availableForRight = width - leftWidth - minPadding;
	if (availableForRight <= 0) return truncateToWidth(left, width, "");

	const truncatedRight = truncateToWidth(right, availableForRight, "");
	const padding = " ".repeat(Math.max(0, width - leftWidth - visibleWidth(truncatedRight)));
	return `${left}${padding}${truncatedRight}`;
}

function assembleStatusBar({ width, top, left, right, separator }: StatusBarParts): string[] {
	const headline = compactPieces(top).join(" ");
	const status = compactPieces(left).join(separator);
	return [truncateToWidth(headline, width, "..."), fitLeftRight(status, right, width)];
}

export default function customColoredFooter(pi: ExtensionAPI) {
	let subscriptionUsage: SubscriptionUsage | undefined;
	let requestFooterRender: (() => void) | undefined;
	let lastContext: ExtensionContext | undefined;
	let subscriptionRefreshInterval: ReturnType<typeof setInterval> | undefined;
	let lastSubscriptionRefreshAt = 0;
	let subscriptionRefreshId = 0;

	const setSubscriptionUsage = (nextUsage: SubscriptionUsage | undefined) => {
		subscriptionUsage = nextUsage;
		requestFooterRender?.();
	};

	const updateSubscriptionUsage = (payload: unknown) => {
		if (lastContext && getContextBillingMode(lastContext) !== "subscription") {
			setSubscriptionUsage(undefined);
			return;
		}
		setSubscriptionUsage(getSubscriptionUsageFromPayload(payload));
	};

	const refreshSubscriptionUsage = (ctx: ExtensionContext, force = false) => {
		if (getContextBillingMode(ctx) !== "subscription") {
			subscriptionRefreshId += 1;
			if (subscriptionUsage) setSubscriptionUsage(undefined);
			return;
		}

		const now = Date.now();
		if (!force && now - lastSubscriptionRefreshAt < 60_000) return;
		lastSubscriptionRefreshAt = now;
		const expectedProvider = getContextSubscriptionProvider(ctx);
		const refreshId = ++subscriptionRefreshId;
		void fetchSubscriptionUsageForContext(ctx).then((nextUsage) => {
			if (refreshId !== subscriptionRefreshId) return;
			if (getContextBillingMode(ctx) !== "subscription") {
				setSubscriptionUsage(undefined);
			} else if (nextUsage) {
				setSubscriptionUsage(nextUsage);
			} else if (!expectedProvider || !subscriptionUsage || subscriptionUsage.provider !== expectedProvider) {
				setSubscriptionUsage(undefined);
			}
		});
	};

	pi.events.on("sub-core:ready", updateSubscriptionUsage);
	pi.events.on("sub-core:update-current", updateSubscriptionUsage);

	pi.on("session_start", async (_event, ctx) => {
		lastContext = ctx;
		refreshSubscriptionUsage(ctx, true);
		if (!subscriptionRefreshInterval) {
			subscriptionRefreshInterval = setInterval(() => {
				requestFooterRender?.();
				if (lastContext) refreshSubscriptionUsage(lastContext);
			}, 30_000);
			subscriptionRefreshInterval.unref?.();
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestFooterRender = () => tui.requestRender();
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			pi.events.emit("sub-core:request", {
				includeSettings: false,
				reply: (payload: unknown) => updateSubscriptionUsage(payload),
			});

			return {
				dispose: () => {
					requestFooterRender = undefined;
					unsub();
				},
				invalidate() {},
				render(width: number): string[] {
					const entries = ctx.sessionManager.getEntries() as SessionEntryLike[];
					const branchEntries = ctx.sessionManager.getBranch() as SessionEntryLike[];
					const cwd = ctx.sessionManager.getCwd();
					const branch = footerData.getGitBranch();
					const billingMode = getContextBillingMode(ctx);
					const billing =
						billingMode === "subscription"
							? subscriptionUsage && renderSubscriptionUsage(subscriptionUsage, (text) => theme.fg("dim", text))
							: billingMode === "api"
								? renderSessionSpend(entries)
								: undefined;
					const sessionTitle = ctx.sessionManager.getSessionName() ?? getAutoSessionTitle(entries);
					const prNumber = extractPrNumber(branch);

					return assembleStatusBar({
						width,
						separator: theme.fg("dim", " • "),
						top: [
							`${FOLDER_ICON} ${basename(cwd) || cwd}`,
							branch && theme.fg("dim", `(${branch})`),
							sessionTitle && theme.fg("dim", `• ${sessionTitle}`),
							prNumber && hex(BURNT_ORANGE, `PR #${prNumber}`),
						],
						left: [
							renderTokenTotals(getTokenTotals(entries)),
							renderContextUsage(
								getFooterContextUsage(branchEntries.length > 0 ? branchEntries : entries, ctx.model?.contextWindow ?? 0),
								(color, text) => theme.fg(color, text),
							),
							billing,
						],
						right: renderModelStatus({
							modelId: ctx.model?.id || "no-model",
							provider: ctx.model?.provider,
							showProvider: footerData.getAvailableProviderCount() > 1,
							thinkingLevel: pi.getThinkingLevel(),
							dim: (text) => theme.fg("dim", text),
							bold: (text) => theme.bold(text),
						}),
					});
				},
			};
		});
	});

	pi.on("message_end", async (_event, ctx) => {
		lastContext = ctx;
		requestFooterRender?.();
	});

	pi.on("turn_end", async (_event, ctx) => {
		lastContext = ctx;
		requestFooterRender?.();
		refreshSubscriptionUsage(ctx, true);
	});

	pi.on("model_select", async (_event, ctx) => {
		lastContext = ctx;
		refreshSubscriptionUsage(ctx, true);
	});

	pi.on("session_shutdown", async () => {
		lastContext = undefined;
		if (subscriptionRefreshInterval) {
			clearInterval(subscriptionRefreshInterval);
			subscriptionRefreshInterval = undefined;
		}
	});
}
