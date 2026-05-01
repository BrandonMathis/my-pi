import { basename } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const FOLDER_ICON = "󰉋";
const BURNT_ORANGE = "#CC5500";
const WHITE = "#FFFFFF";
const GREY = "#9CA3AF";
const GREEN = "#22C55E";
const AUTO_SESSION_NAME_ENTRY_TYPE = "auto-session-name";

type AutoSessionNameEntry = {
	title?: string;
};

type SessionEntryLike = {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
	};
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

function gradientText(text: string, fromHex: string, toHex: string): string {
	const from = hexToRgb(fromHex);
	const to = hexToRgb(toHex);
	if (!from || !to) return text;
	const chars = [...text];
	const denominator = Math.max(chars.length - 1, 1);
	return chars
		.map((char, index) => {
			if (char === " ") return char;
			const t = index / denominator;
			const r = from.r + (to.r - from.r) * t;
			const g = from.g + (to.g - from.g) * t;
			const b = from.b + (to.b - from.b) * t;
			return hex(rgbToHex(r, g, b), char);
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

export default function customColoredFooter(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let cost = 0;

					const entries = ctx.sessionManager.getEntries() as SessionEntryLike[];
					for (const entry of entries) {
						if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
						const msg = entry.message as AssistantMessage;
						input += msg.usage.input;
						output += msg.usage.output;
						cacheRead += msg.usage.cacheRead;
						cacheWrite += msg.usage.cacheWrite;
						cost += msg.usage.cost.total;
					}

					const cwd = ctx.sessionManager.getCwd();
					const dirName = basename(cwd) || cwd;
					const branch = footerData.getGitBranch();
					const sessionName = ctx.sessionManager.getSessionName() ?? getAutoSessionTitle(entries);
					const prNumber = extractPrNumber(branch);

					const line1Parts = [`${FOLDER_ICON} ${dirName}`];
					if (branch) line1Parts.push(theme.fg("dim", `(${branch})`));
					if (sessionName) line1Parts.push(theme.fg("dim", `• ${sessionName}`));
					if (prNumber) line1Parts.push(hex(BURNT_ORANGE, `PR #${prNumber}`));
					const line1 = truncateToWidth(line1Parts.join(" "), width, "...");

					const leftParts: string[] = [];
					if (input > 0) leftParts.push(`${hex(WHITE, "↑")}${hex(GREY, formatTokens(input))}`);
					if (output > 0) leftParts.push(`${hex(WHITE, "↓")}${hex(GREY, formatTokens(output))}`);
					if (cacheRead > 0) leftParts.push(theme.fg("dim", `R${formatTokens(cacheRead)}`));
					if (cacheWrite > 0) leftParts.push(theme.fg("dim", `W${formatTokens(cacheWrite)}`));
					leftParts.push(hex(GREEN, `$${cost.toFixed(3)}`));

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
					const contextText =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)} (auto)`
							: `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
					leftParts.push(theme.fg("dim", contextText));
					const left = leftParts.join(" ");

					const modelId = ctx.model?.id || "no-model";
					const provider = ctx.model?.provider;
					const thinkingLevel = pi.getThinkingLevel();
					const providerPart =
						provider && footerData.getAvailableProviderCount() > 1 ? theme.fg("dim", `(${provider}) `) : "";
					const modelPart = hex(WHITE, theme.bold(modelId));
					const thinkingPart = colorizeThinkingLevel(thinkingLevel);
					const right = `${providerPart}${modelPart}${thinkingPart}`;

					let line2: string;
					const minPadding = 2;
					const leftWidth = visibleWidth(left);
					const rightWidth = visibleWidth(right);
					const totalNeeded = leftWidth + minPadding + rightWidth;
					if (totalNeeded <= width) {
						const padding = " ".repeat(width - leftWidth - rightWidth);
						line2 = `${left}${padding}${right}`;
					} else {
						const availableForRight = width - leftWidth - minPadding;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(right, availableForRight, "");
							const pad = " ".repeat(Math.max(0, width - leftWidth - visibleWidth(truncatedRight)));
							line2 = `${left}${pad}${truncatedRight}`;
						} else {
							line2 = truncateToWidth(left, width, "");
						}
					}

					return [line1, line2];
				},
			};
		});
	});
}
