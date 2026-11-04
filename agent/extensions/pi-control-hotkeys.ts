import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

const PROVIDER = "openai-codex";
// tmux preserves Ctrl/Alt/Shift extended-key modifiers, but not Super.
const MODEL_SHORTCUTS = [
	{ shortcuts: ["super+1", "ctrl+alt+1"], name: "Astra" },
	{ shortcuts: ["super+2", "ctrl+alt+2"], name: "Sol" },
	{ shortcuts: ["super+3", "ctrl+alt+3"], name: "Luna" },
] as const;
const THINKING_BACKWARD_SHORTCUT = "ctrl+shift+tab";

export default function piControlHotkeys(pi: ExtensionAPI) {
	let switching = false;

	async function selectModel(ctx: ExtensionContext, name: string): Promise<void> {
		if (switching) return;
		switching = true;

		try {
			// Resolve on every press so newly available versions are picked automatically.
			const candidates = ctx.modelRegistry.getAvailable().flatMap((model) => {
				if (model.provider !== PROVIDER) return [];
				const match = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/.exec(model.id);
				if (!match || match[2] !== name.toLowerCase()) return [];
				return [{ model, version: match[1] }];
			});
			candidates.sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }));
			const target = candidates[0]?.model;
			if (!target) {
				ctx.ui.notify(`No available GPT ${name} models for ${PROVIDER}`, "error");
				return;
			}

			if (!(await pi.setModel(target))) {
				ctx.ui.notify(`No credentials available for ${PROVIDER}/${target.id}`, "error");
				return;
			}

			ctx.ui.notify(`Model: ${target.id}`, "info");
		} finally {
			switching = false;
		}
	}

	function cycleThinkingBackward(ctx: ExtensionContext): void {
		if (!ctx.model?.reasoning) {
			ctx.ui.notify("Current model does not support thinking", "warning");
			return;
		}

		const levels = getSupportedThinkingLevels(ctx.model);
		const currentIndex = levels.indexOf(pi.getThinkingLevel());
		const previousIndex = (currentIndex - 1 + levels.length) % levels.length;
		const level = levels[previousIndex];

		pi.setThinkingLevel(level);
		ctx.ui.notify(`Thinking level: ${level}`, "info");
	}

	for (const model of MODEL_SHORTCUTS) {
		for (const shortcut of model.shortcuts) {
			pi.registerShortcut(shortcut, {
				description: `Select latest available GPT ${model.name}`,
				handler: (ctx) => selectModel(ctx, model.name),
			});
		}
	}

	pi.registerShortcut(THINKING_BACKWARD_SHORTCUT, {
		description: "Cycle thinking level backward",
		handler: cycleThinkingBackward,
	});
}
