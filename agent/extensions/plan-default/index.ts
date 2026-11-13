/** Startup preference: Codex subscription → Anthropic subscription → Codex. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { anthropicAvailability, codexAccountId, codexAvailability, hasExplicitModel, type Availability } from "./usage.ts";

interface Config {
	codexModel: string;
	anthropicModel: string;
	minimumRemainingPercent: number;
	timeoutMs: number;
}

class ConfigError extends Error {}

const DEFAULTS: Config = {
	codexModel: "gpt-6.1-sol",
	anthropicModel: "claude-opus-5-5",
	minimumRemainingPercent: 0,
	timeoutMs: 5000,
};

async function loadConfig(): Promise<Config> {
	let input: Partial<Config>;
	try {
		input = JSON.parse(await readFile(join(getAgentDir(), "plan-default.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULTS };
		throw new ConfigError("Cannot read plan-default.json; check that it contains valid JSON.");
	}
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConfigError("Invalid plan-default.json.");
	const config = { ...DEFAULTS, ...input };
	if (typeof config.codexModel !== "string" || !config.codexModel.trim()
		|| typeof config.anthropicModel !== "string" || !config.anthropicModel.trim()
		|| !Number.isFinite(config.minimumRemainingPercent) || config.minimumRemainingPercent < 0 || config.minimumRemainingPercent >= 100
		|| !Number.isFinite(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 30000) {
		throw new ConfigError("Invalid plan-default.json: check model IDs, minimumRemainingPercent (0–99), and timeoutMs (100–30000).");
	}
	return config;
}

async function checkUsage(ctx: ExtensionContext, provider: string, modelId: string, config: Config): Promise<Availability> {
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) return { status: "unavailable", available: false, summary: `model ${modelId} not found` };
	if (!ctx.modelRegistry.isUsingOAuth(model)) return { status: "unavailable", available: false, summary: "subscription login missing (use /login)" };
	try {
		// Resolve through Pi so expired OAuth tokens are refreshed and stored safely.
		const token = (await ctx.modelRegistry.getProviderAuth(provider))?.auth.apiKey;
		if (!token) return { status: "unavailable", available: false, summary: "subscription authentication unavailable" };
		const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
		const codex = provider === "openai-codex";
		if (codex) {
			const accountId = codexAccountId(token);
			if (accountId) headers["ChatGPT-Account-Id"] = accountId;
		} else {
			headers["anthropic-beta"] = "oauth-2025-04-20";
		}
		const response = await fetch(codex
			? "https://chatgpt.com/backend-api/wham/usage"
			: "https://api.anthropic.com/api/oauth/usage", {
			headers,
			signal: AbortSignal.timeout(config.timeoutMs),
			redirect: "error", // Never forward subscription tokens through a redirect.
		});
		if (!response.ok) {
			await response.body?.cancel();
			return { status: "unknown", available: false, summary: `usage unknown (HTTP ${response.status} from usage endpoint, not a confirmed plan limit)` };
		}
		const data: unknown = await response.json();
		return codex ? codexAvailability(data, modelId, config.minimumRemainingPercent)
			: anthropicAvailability(data, modelId, config.minimumRemainingPercent);
	} catch {
		// Provider error messages and response bodies may contain credentials.
		return { status: "unknown", available: false, summary: "usage check failed or timed out" };
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-plan-default", {
		description: "Skip automatic subscription-based startup model selection",
		type: "boolean",
		default: false,
	});

	async function select(ctx: ExtensionContext) {
		try {
			const config = await loadConfig();
			const [codex, anthropic] = await Promise.all([
				checkUsage(ctx, "openai-codex", config.codexModel, config),
				checkUsage(ctx, "anthropic", config.anthropicModel, config),
			]);
			// An unavailable usage endpoint is NOT evidence of exhausted capacity.
			// Try the unknown Anthropic subscription rather than a known-exhausted Codex plan.
			const tryAnthropic = !codex.available && (anthropic.available
				|| (anthropic.status === "unknown" && (codex.status === "exhausted" || codex.status === "unavailable")));
			const provider = tryAnthropic ? "anthropic" : "openai-codex";
			const id = tryAnthropic ? config.anthropicModel : config.codexModel;
			const selectedUsage = tryAnthropic ? anthropic : codex;
			const unverified = selectedUsage.status === "unknown";
			const fallback = !selectedUsage.available && !unverified;
			const model = ctx.modelRegistry.find(provider, id);
			// A last-resort Codex selection still requires a subscription login: no API billing fallback.
			if (!model || !ctx.modelRegistry.isUsingOAuth(model)) {
				if (ctx.hasUI) ctx.ui.notify(`Plan default: cannot select ${provider}/${id}. Check /login and /model.\nCodex: ${codex.summary}\nAnthropic: ${anthropic.summary}`, "warning");
				return;
			}
			const alreadySelected = ctx.model?.provider === provider && ctx.model.id === id;
			if (!alreadySelected && !await pi.setModel(model)) {
				if (ctx.hasUI) ctx.ui.notify(`Plan default: could not select ${provider}/${id}; current model unchanged.`, "warning");
				return;
			}
			if (ctx.hasUI) ctx.ui.notify(
				`Plan default: ${provider}/${id}${unverified ? " (usage unknown; trying subscription)" : fallback ? " (last resort; usage limit reached)" : ""}.\nCodex: ${codex.summary}\nAnthropic: ${anthropic.summary}`,
				fallback || unverified ? "warning" : "info",
			);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(error instanceof ConfigError ? error.message : "Plan default selection failed; current model may be unchanged.", "warning");
		}
	}

	pi.on("session_start", async (event, ctx) => {
		if (pi.getFlag("no-plan-default") || hasExplicitModel(process.argv.slice(2))) return;
		if (event.reason !== "startup" && event.reason !== "new") return;
		// A fresh session's path is allocated but not written yet. An existing
		// session file also detects resumes of empty/rewound sessions with no
		// message entries on their active branch; don't replace their saved model.
		if (event.reason === "startup") {
			const file = ctx.sessionManager.getSessionFile();
			if ((file && existsSync(file)) || ctx.sessionManager.getHeader()?.parentSession
				|| ctx.sessionManager.getBranch().some((entry) => entry.type === "message")) return;
		}
		await select(ctx);
	});

	pi.registerCommand("plan-model", {
		description: "Recheck subscription usage and select Codex → Anthropic → Codex",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			await select(ctx);
		},
	});
}
