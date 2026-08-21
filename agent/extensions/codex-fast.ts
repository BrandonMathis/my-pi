import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "codex-fast.json");
const FAST_STATE_EVENT = "codex-fast:state";
const FAST_REQUEST_EVENT = "codex-fast:request";

type FastModeConfig = {
	enabled: boolean;
};

type FastModeRequest = {
	reply?: (state: FastModeConfig) => void;
};

function loadFastModeEnabled(): boolean {
	try {
		if (!existsSync(CONFIG_PATH)) return false;
		const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<FastModeConfig>;
		return config.enabled === true;
	} catch {
		return false;
	}
}

function saveFastModeEnabled(enabled: boolean): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf-8");
}

function modelSupportsFastMode(ctx: ExtensionContext): boolean {
	return (
		ctx.model?.provider === "openai-codex" &&
		/^gpt-5\.(?:4|5|6)(?:$|-)/.test(ctx.model.id)
	);
}

export default function codexFast(pi: ExtensionAPI) {
	let enabled = loadFastModeEnabled();

	const state = (): FastModeConfig => ({ enabled });
	const publishState = () => pi.events.emit(FAST_STATE_EVENT, state());
	const isActive = (ctx: ExtensionContext) => enabled && modelSupportsFastMode(ctx);

	pi.events.on(FAST_REQUEST_EVENT, (payload: unknown) => {
		const request = payload as FastModeRequest | undefined;
		request?.reply?.(state());
	});

	pi.registerCommand("fast", {
		description: "Toggle Codex fast mode: /fast [on|off|status]",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || (enabled ? "off" : "on");

			if (action === "status") {
				const suffix = enabled && !modelSupportsFastMode(ctx) ? " (current model unsupported)" : "";
				ctx.ui.notify(`Codex fast mode is ${enabled ? "on" : "off"}${suffix}`, "info");
				return;
			}

			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /fast on|off|status", "warning");
				return;
			}

			enabled = action === "on";
			try {
				saveFastModeEnabled(enabled);
			} catch (error) {
				ctx.ui.notify(`Could not save Codex fast mode: ${String(error)}`, "warning");
			}
			publishState();

			const suffix = enabled && !modelSupportsFastMode(ctx) ? "; current model is unsupported" : "";
			ctx.ui.notify(`Codex fast mode ${enabled ? "enabled" : "disabled"}${suffix}`, "info");
		},
	});

	pi.on("session_start", () => publishState());

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isActive(ctx) || !ctx.model) return;
		event.headers["x-codex-routing-hint"] = `model=${ctx.model.id};tier=priority`;
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isActive(ctx) || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
			return;
		}

		return {
			...(event.payload as Record<string, unknown>),
			service_tier: "priority",
		};
	});
}
