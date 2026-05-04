import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

type PeonPayload = {
	hook_event_name: string;
	notification_type: string;
	cwd: string;
	session_id: string;
	permission_mode: string;
	source: string;
	transcript_summary?: string;
	tool_name?: string;
	error?: string;
};

type HookEventLike = {
	reason?: string;
	source?: string;
	text?: string;
	images?: unknown[];
	toolName?: string;
	isError?: boolean;
	content?: unknown;
};

const SOURCE = process.env.PI_PEON_PING_SOURCE?.trim() || "pi";
const PEON_BIN = process.env.PI_PEON_PING_BIN?.trim() || "peon";
const CUSTOM_SCRIPT_PATH = process.env.PI_PEON_PING_SCRIPT?.trim() || "";
const IS_DISABLED = ["1", "true", "yes", "on"].includes(
	(process.env.PI_PEON_PING_DISABLED || "").toLowerCase(),
);

let hasWarnedMissingRuntime = false;

function readTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			const block = item as Record<string, unknown>;
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function firstLine(value: string, maxChars = 180): string | undefined {
	const line = value
		.split(/\r?\n/)
		.map((item) => item.trim())
		.find((item) => item.length > 0);
	if (!line) return undefined;
	return line.slice(0, maxChars);
}

function sanitizeSessionId(raw: string): string {
	const sanitized = raw.replace(/[^A-Za-z0-9._:-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || `pid-${process.pid}`;
}

function getSessionId(ctx: ExtensionContext): string {
	const rawSessionId = ctx.sessionManager.getSessionId();
	return `pi-${sanitizeSessionId(rawSessionId || "session")}`;
}

function resolvePeonScript(cwd: string): string | undefined {
	const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
	const candidateDirs = [
		CUSTOM_SCRIPT_PATH,
		resolve(cwd, ".claude", "hooks", "peon-ping", "peon.sh"),
		process.env.PEON_DIR ? join(process.env.PEON_DIR, "peon.sh") : "",
		process.env.CLAUDE_PEON_DIR ? join(process.env.CLAUDE_PEON_DIR, "peon.sh") : "",
		join(claudeConfigDir, "hooks", "peon-ping", "peon.sh"),
		join(homedir(), ".openpeon", "peon.sh"),
	].filter(Boolean);

	for (const candidate of candidateDirs) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function notifyMissingRuntimeOnce(ctx: ExtensionContext): void {
	if (hasWarnedMissingRuntime || !ctx.hasUI) return;
	hasWarnedMissingRuntime = true;
	ctx.ui.notify(
		"Peon Ping runtime not found. Install it with `brew install PeonPing/tap/peon-ping` or set PI_PEON_PING_SCRIPT.",
		"warning",
	);
}

function sendPeonEvent(eventName: string, ctx: ExtensionContext, extras: Partial<PeonPayload> = {}): void {
	if (IS_DISABLED) return;

	const scriptPath = resolvePeonScript(ctx.cwd);
	const payload: PeonPayload = {
		hook_event_name: eventName,
		notification_type: "",
		cwd: ctx.cwd,
		session_id: getSessionId(ctx),
		permission_mode: "",
		source: SOURCE,
		...extras,
	};

	const command = scriptPath ? "bash" : PEON_BIN;
	const args = scriptPath ? [scriptPath] : [];
	const child = spawn(command, args, {
		stdio: ["pipe", "ignore", "ignore"],
		env: process.env,
	});

	child.on("error", () => {
		notifyMissingRuntimeOnce(ctx);
	});
	child.stdin.on("error", () => {});
	child.stdin.end(`${JSON.stringify(payload)}\n`);
	child.unref();
}

async function runPeonCli(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string[],
): Promise<{ ok: boolean; output: string }> {
	const scriptPath = resolvePeonScript(ctx.cwd);
	const result = scriptPath
		? await pi.exec("bash", [scriptPath, ...args], { timeout: 5000 })
		: await pi.exec(PEON_BIN, args, { timeout: 5000 });

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
	return { ok: result.code === 0, output };
}

export default function peonPingExtension(pi: ExtensionAPI) {
	if (IS_DISABLED) return;

	pi.on("session_start", async (event: HookEventLike, ctx) => {
		if (event.reason === "reload") return;

		sendPeonEvent("SessionStart", ctx, {
			source: event.reason === "resume" ? "resume" : SOURCE,
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sendPeonEvent("SessionEnd", ctx);
	});

	pi.on("input", async (event: HookEventLike, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };

		const text = (event.text || "").trim();
		const hasImages = Array.isArray(event.images) && event.images.length > 0;
		if (!text && !hasImages) return { action: "continue" as const };
		if (text.startsWith("/") || text.startsWith("!")) return { action: "continue" as const };

		sendPeonEvent("UserPromptSubmit", ctx);
		return { action: "continue" as const };
	});

	pi.on("agent_end", async (_event, ctx) => {
		sendPeonEvent("Stop", ctx);
	});

	pi.on("tool_result", async (event: HookEventLike, ctx) => {
		if (!event.isError) return;

		const toolName = (event.toolName || "").trim();
		const errorMessage = firstLine(readTextContent(event.content) || "Tool execution failed") || "Tool execution failed";

		sendPeonEvent("PostToolUseFailure", ctx, {
			tool_name: toolName.toLowerCase() === "bash" ? "Bash" : toolName,
			error: errorMessage,
		});
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		sendPeonEvent("PreCompact", ctx);
	});

	pi.registerCommand("peon-ping-toggle", {
		description: "Toggle Peon Ping mute state",
		handler: async (_args, ctx) => {
			try {
				const result = await runPeonCli(pi, ctx, ["toggle"]);
				if (!result.ok) {
					ctx.ui.notify(result.output || "Failed to toggle Peon Ping", "error");
					return;
				}
				ctx.ui.notify(result.output || "Toggled Peon Ping", "info");
			} catch {
				ctx.ui.notify("Peon Ping command failed. Is `peon` installed?", "error");
			}
		},
	});

	pi.registerCommand("peon-ping-test", {
		description: "Send a test completion event to Peon Ping",
		handler: async (_args, ctx) => {
			sendPeonEvent("Stop", ctx, {
				transcript_summary: "Pi Peon Ping test",
			});
			ctx.ui.notify("Sent test event to Peon Ping", "info");
		},
	});
}
