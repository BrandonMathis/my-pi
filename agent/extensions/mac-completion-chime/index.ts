/**
 * macOS Completion Chime Extension
 *
 * Plays a macOS alert sound when Pi finishes an agent run.
 *
 * Commands:
 *   /chime             Open interactive sound picker. Press Space/P to demo, Enter to select.
 *   /chime on          Enable completion chime.
 *   /chime off         Disable completion chime.
 *   /chime preview     Demo the currently selected chime.
 *   /chime status      Show current configuration.
 *   /chime reset       Reset to Ping or the first available macOS sound.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

const EXTENSION_ID = "completion-chime";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "state", "mac-completion-chime.json");
const SOUND_DIRS = ["/System/Library/Sounds", "/Library/Sounds", join(homedir(), "Library", "Sounds")];
const SOUND_EXTENSIONS = new Set([".aiff", ".aif", ".wav", ".mp3", ".m4a"]);

type SoundKind = "file" | "applescript-beep";

interface SoundOption {
	id: string;
	kind: SoundKind;
	label: string;
	description: string;
	path?: string;
}

interface ChimeConfig {
	enabled: boolean;
	kind: SoundKind;
	soundPath?: string;
}

const DEFAULT_CONFIG: ChimeConfig = {
	enabled: true,
	kind: "file",
	soundPath: "/System/Library/Sounds/Ping.aiff",
};

let config: ChimeConfig = { ...DEFAULT_CONFIG };
let lastChimeAt = 0;
let currentPreview: ChildProcess | undefined;

function isMac(): boolean {
	return process.platform === "darwin";
}

function soundLabelFromPath(path: string): string {
	return basename(path, extname(path));
}

function expandHome(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

async function loadConfig(): Promise<ChimeConfig> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<ChimeConfig>;
		return {
			enabled: parsed.enabled !== false,
			kind: parsed.kind === "applescript-beep" ? "applescript-beep" : "file",
			soundPath: typeof parsed.soundPath === "string" ? parsed.soundPath : DEFAULT_CONFIG.soundPath,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

async function saveConfig(next: ChimeConfig): Promise<void> {
	await mkdir(join(homedir(), ".pi", "agent", "state"), { recursive: true });
	await writeFile(CONFIG_PATH, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
	config = next;
}

async function discoverSounds(): Promise<SoundOption[]> {
	const options: SoundOption[] = [
		{
			id: "applescript-beep",
			kind: "applescript-beep",
			label: "System Alert",
			description: "AppleScript beep using your current macOS alert sound",
		},
	];

	for (const dir of SOUND_DIRS) {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				const extension = extname(entry.name).toLowerCase();
				if (!SOUND_EXTENSIONS.has(extension)) continue;

				const path = join(dir, entry.name);
				options.push({
					id: path,
					kind: "file",
					label: soundLabelFromPath(path),
					description: expandHome(path),
					path,
				});
			}
		} catch {
			// Some sound directories may not exist; ignore them.
		}
	}

	const [beep, ...files] = options;
	files.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
	return [beep!, ...files];
}

function configToOption(options: SoundOption[], current: ChimeConfig): SoundOption {
	if (current.kind === "applescript-beep") {
		return options.find((option) => option.kind === "applescript-beep") ?? options[0]!;
	}

	if (current.soundPath) {
		const exact = options.find((option) => option.path === current.soundPath);
		if (exact) return exact;
	}

	const ping = options.find((option) => option.path === DEFAULT_CONFIG.soundPath);
	const firstFile = options.find((option) => option.kind === "file");
	return ping ?? firstFile ?? options[0]!;
}

function optionToConfig(option: SoundOption, enabled = config.enabled): ChimeConfig {
	if (option.kind === "applescript-beep") {
		return { enabled, kind: "applescript-beep" };
	}
	return { enabled, kind: "file", soundPath: option.path };
}

function playOption(option: SoundOption, signal?: AbortSignal): boolean {
	if (!isMac()) return false;

	if (option.kind === "applescript-beep") {
		const child = spawn("osascript", ["-e", "beep"], { stdio: "ignore", signal });
		child.unref();
		return true;
	}

	if (!option.path || !existsSync(option.path)) return false;
	const child = spawn("afplay", [option.path], { stdio: "ignore", signal });
	child.unref();
	return true;
}

function stopPreview(): void {
	if (currentPreview && !currentPreview.killed) {
		currentPreview.kill();
	}
	currentPreview = undefined;
}

function previewOption(option: SoundOption): boolean {
	if (!isMac()) return false;
	stopPreview();

	if (option.kind === "applescript-beep") {
		currentPreview = spawn("osascript", ["-e", "beep"], { stdio: "ignore" });
		currentPreview.unref();
		return true;
	}

	if (!option.path || !existsSync(option.path)) return false;
	currentPreview = spawn("afplay", [option.path], { stdio: "ignore" });
	currentPreview.unref();
	return true;
}

function describeConfig(options: SoundOption[], current: ChimeConfig): string {
	const option = configToOption(options, current);
	const state = current.enabled ? "enabled" : "disabled";
	return `${state}; sound: ${option.label}`;
}

function setStatus(ctx: ExtensionContext, options?: SoundOption[]): void {
	if (!ctx.hasUI) return;

	const apply = (knownOptions: SoundOption[]) => {
		const option = configToOption(knownOptions, config);
		const text = config.enabled ? `Chime: ${option.label}` : "Chime: off";
		ctx.ui.setStatus(EXTENSION_ID, ctx.ui.theme.fg(config.enabled ? "dim" : "warning", text));
	};

	if (options) {
		apply(options);
	} else {
		void discoverSounds().then(apply).catch(() => undefined);
	}
}

async function openPicker(ctx: ExtensionContext): Promise<void> {
	if (!isMac()) {
		ctx.ui.notify("Completion chime is macOS-only.", "warning");
		return;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The interactive sound picker requires Pi TUI mode.", "warning");
		return;
	}

	const options = await discoverSounds();
	if (options.length === 0) {
		ctx.ui.notify("No macOS sounds found.", "error");
		return;
	}

	const current = configToOption(options, config);
	const initialIndex = Math.max(0, options.findIndex((option) => option.id === current.id));

	const selected = await ctx.ui.custom<SoundOption | null>((tui, theme, _keybindings, done) => {
		let selectedIndex = initialIndex;
		let autoPreview = false;
		let status = "Space/P previews highlighted sound • A toggles auto-preview • Enter selects • Esc cancels";
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;

		function invalidate() {
			cachedWidth = undefined;
			cachedLines = undefined;
		}

		function requestRender() {
			invalidate();
			tui.requestRender();
		}

		function demoSelected() {
			const option = options[selectedIndex]!;
			const ok = previewOption(option);
			status = ok ? `Previewing ${option.label}` : `Could not preview ${option.label}`;
			requestRender();
		}

		function moveSelection(nextIndex: number) {
			selectedIndex = Math.max(0, Math.min(options.length - 1, nextIndex));
			if (autoPreview) {
				demoSelected();
			} else {
				requestRender();
			}
		}

		function handleInput(data: string): void {
			const lower = data.toLowerCase();

			if (matchesKey(data, Key.up)) {
				moveSelection(selectedIndex - 1);
				return;
			}
			if (matchesKey(data, Key.down)) {
				moveSelection(selectedIndex + 1);
				return;
			}
			if (matchesKey(data, Key.home)) {
				moveSelection(0);
				return;
			}
			if (matchesKey(data, Key.end)) {
				moveSelection(options.length - 1);
				return;
			}
			if (matchesKey(data, Key.space) || lower === " " || lower === "p" || lower === "r") {
				demoSelected();
				return;
			}
			if (lower === "a") {
				autoPreview = !autoPreview;
				status = autoPreview
					? "Auto-preview on: moving through sounds will play each highlighted chime"
					: "Auto-preview off: press Space/P to preview highlighted sound";
				if (autoPreview) {
					demoSelected();
				} else {
					requestRender();
				}
				return;
			}
			if (lower === "e") {
				config = { ...config, enabled: !config.enabled };
				status = config.enabled ? "Chime enabled" : "Chime disabled";
				requestRender();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				stopPreview();
				done(options[selectedIndex]!);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				stopPreview();
				done(null);
			}
		}

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));
			const visibleCount = Math.min(14, options.length);
			let start = Math.max(0, selectedIndex - Math.floor(visibleCount / 2));
			start = Math.min(start, Math.max(0, options.length - visibleCount));
			const end = Math.min(options.length, start + visibleCount);

			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("accent", theme.bold(" macOS Completion Chime")));
			add(
				theme.fg(
					config.enabled ? "success" : "warning",
					` ${config.enabled ? "Enabled" : "Disabled"} • Auto-preview: ${autoPreview ? "on" : "off"}`,
				),
			);
			lines.push("");

			for (let index = start; index < end; index++) {
				const option = options[index]!;
				const isSelected = index === selectedIndex;
				const isCurrent = option.id === current.id;
				const marker = isSelected ? ">" : " ";
				const currentMarker = isCurrent ? "✓" : " ";
				const label = `${marker} ${currentMarker} ${option.label}`;
				const styledLabel = isSelected ? theme.fg("accent", label) : theme.fg(isCurrent ? "success" : "text", label);
				add(`${styledLabel} ${theme.fg("dim", option.description)}`);
			}

			if (options.length > visibleCount) {
				add(theme.fg("dim", ` Showing ${start + 1}-${end} of ${options.length}`));
			}

			lines.push("");
			add(theme.fg("muted", ` ${status}`));
			add(theme.fg("accent", "─".repeat(width)));

			cachedWidth = width;
			cachedLines = lines;
			return lines;
		}

		return { render, invalidate, handleInput };
	});

	if (!selected) {
		ctx.ui.notify("Chime selection cancelled", "info");
		config = await loadConfig();
		setStatus(ctx, options);
		return;
	}

	const next = optionToConfig(selected, config.enabled);
	await saveConfig(next);
	setStatus(ctx, options);
	ctx.ui.notify(`Completion chime set to ${selected.label}`, "info");
}

export default function macCompletionChime(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig();
		setStatus(ctx);
	});

	pi.on("agent_end", async (_event, _ctx) => {
		if (!isMac() || !config.enabled) return;

		const now = Date.now();
		if (now - lastChimeAt < 1000) return;
		lastChimeAt = now;

		const options = await discoverSounds();
		const option = configToOption(options, config);
		playOption(option);
	});

	pi.on("session_shutdown", async () => {
		stopPreview();
	});

	pi.registerCommand("chime", {
		description: "Configure the macOS completion chime sound.",
		getArgumentCompletions: (prefix) => {
			const commands = ["on", "off", "preview", "status", "reset", "select"];
			const filtered = commands.filter((command) => command.startsWith(prefix.trim().toLowerCase()));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			config = await loadConfig();
			const command = args.trim().toLowerCase();
			const options = await discoverSounds();

			if (!command || command === "select") {
				await openPicker(ctx);
				return;
			}

			if (command === "on") {
				await saveConfig({ ...config, enabled: true });
				setStatus(ctx, options);
				ctx.ui.notify("Completion chime enabled", "info");
				return;
			}

			if (command === "off") {
				await saveConfig({ ...config, enabled: false });
				setStatus(ctx, options);
				ctx.ui.notify("Completion chime disabled", "info");
				return;
			}

			if (command === "preview" || command === "demo") {
				const option = configToOption(options, config);
				const ok = previewOption(option);
				ctx.ui.notify(ok ? `Previewing ${option.label}` : `Could not preview ${option.label}`, ok ? "info" : "error");
				return;
			}

			if (command === "status") {
				ctx.ui.notify(`Completion chime: ${describeConfig(options, config)}`, "info");
				return;
			}

			if (command === "reset") {
				const fallback = configToOption(options, DEFAULT_CONFIG);
				await saveConfig(optionToConfig(fallback, true));
				setStatus(ctx, options);
				ctx.ui.notify(`Completion chime reset to ${fallback.label}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /chime [on|off|preview|status|reset|select]", "error");
		},
	});
}
