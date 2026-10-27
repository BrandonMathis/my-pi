import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "fast-mode.json");
const FAST_STATE_EVENT = "fast-mode:state";
const FAST_REQUEST_EVENT = "fast-mode:request";

type FastModeConfig = {
	codex: boolean;
	anthropic: boolean;
};

type FastModeRequest = {
	reply?: (state: FastModeConfig) => void;
};

function loadFastModeConfig(): FastModeConfig {
	try {
		if (!existsSync(CONFIG_PATH)) {
			// Try to migrate from old codex-fast.json
			const oldPath = join(homedir(), ".pi", "agent", "codex-fast.json");
			if (existsSync(oldPath)) {
				const oldConfig = JSON.parse(readFileSync(oldPath, "utf-8")) as { enabled?: boolean };
				return { codex: oldConfig.enabled === true, anthropic: false };
			}
			return { codex: false, anthropic: false };
		}
		const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<FastModeConfig>;
		return {
			codex: config.codex === true,
			anthropic: config.anthropic === true,
		};
	} catch {
		return { codex: false, anthropic: false };
	}
}

function saveFastModeConfig(config: FastModeConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function getActiveProvider(ctx: ExtensionContext): "codex" | "anthropic" | null {
	if (ctx.model?.provider === "openai-codex") return "codex";
	if (ctx.model?.provider === "anthropic") return "anthropic";
	return null;
}

function modelSupportsFastMode(ctx: ExtensionContext): boolean {
	const provider = getActiveProvider(ctx);
	if (provider === "codex") {
		return /^gpt-5\.(?:4|5|6)(?:$|-)/.test(ctx.model?.id ?? "");
	}
	if (provider === "anthropic") {
		// Anthropic doesn't have a documented priority tier yet,
		// but we support the toggle for future use
		return true;
	}
	return false;
}

export default function fastMode(pi: ExtensionAPI) {
	let config = loadFastModeConfig();

	const state = (): FastModeConfig => config;
	const publishState = () => pi.events.emit(FAST_STATE_EVENT, state());
	const isActive = (ctx: ExtensionContext) => {
		const provider = getActiveProvider(ctx);
		if (!provider || !modelSupportsFastMode(ctx)) return false;
		return config[provider] === true;
	};

	pi.events.on(FAST_REQUEST_EVENT, (payload: unknown) => {
		const request = payload as FastModeRequest | undefined;
		request?.reply?.(state());
	});

	pi.registerCommand("fast", {
		description: "Toggle fast mode for active provider: /fast [on|off|status]",
		handler: async (args, ctx) => {
			const provider = getActiveProvider(ctx);
			
			if (!provider) {
				ctx.ui.notify("Fast mode not supported for current provider", "warning");
				return;
			}

			const currentEnabled = config[provider];
			const action = args.trim().toLowerCase() || (currentEnabled ? "off" : "on");

			if (action === "status") {
				const providerName = provider === "codex" ? "Codex" : "Anthropic";
				const suffix = currentEnabled && !modelSupportsFastMode(ctx) ? " (current model unsupported)" : "";
				ctx.ui.notify(`${providerName} fast mode is ${currentEnabled ? "on" : "off"}${suffix}`, "info");
				return;
			}

			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /fast on|off|status", "warning");
				return;
			}

			config[provider] = action === "on";
			try {
				saveFastModeConfig(config);
			} catch (error) {
				ctx.ui.notify(`Could not save fast mode: ${String(error)}`, "warning");
			}
			publishState();

			const providerName = provider === "codex" ? "Codex" : "Anthropic";
			const enabled = config[provider];
			const suffix = enabled && !modelSupportsFastMode(ctx) ? "; current model is unsupported" : "";
			ctx.ui.notify(`${providerName} fast mode ${enabled ? "enabled" : "disabled"}${suffix}`, "info");
		},
	});

	pi.on("session_start", () => publishState());

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isActive(ctx) || !ctx.model) return;
		
		const provider = getActiveProvider(ctx);
		if (provider === "codex") {
			event.headers["x-codex-routing-hint"] = `model=${ctx.model.id};tier=priority`;
		}
		// Anthropic doesn't currently have priority tier headers
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isActive(ctx) || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
			return;
		}

		const provider = getActiveProvider(ctx);
		if (provider === "codex") {
			return {
				...(event.payload as Record<string, unknown>),
				service_tier: "priority",
			};
		}
		// Anthropic: When they release priority tier support, add it here
	});
}
