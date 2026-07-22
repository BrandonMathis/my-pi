import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";

const PROVIDER = "openai-codex";
const MODEL_SHORTCUTS = [
	{ shortcut: "super+1", name: "Sol", id: "gpt-5.6-sol" },
	{ shortcut: "super+2", name: "Terra", id: "gpt-5.6-terra" },
	{ shortcut: "super+3", name: "Luna", id: "gpt-5.6-luna" },
] as const;
const THINKING_BACKWARD_SHORTCUT = "ctrl+shift+tab";

export default function piControlHotkeys(pi: ExtensionAPI) {
	let switching = false;

	async function selectModel(ctx: ExtensionContext, name: string, id: string): Promise<void> {
		if (switching) return;
		switching = true;

		try {
			const target = ctx.modelRegistry.find(PROVIDER, id);
			if (!target) {
				ctx.ui.notify(`Model not found: ${PROVIDER}/${id}`, "error");
				return;
			}

			if (!(await pi.setModel(target))) {
				ctx.ui.notify(`No credentials available for ${PROVIDER}/${id}`, "error");
				return;
			}

			ctx.ui.notify(`Model: ${name}`, "info");
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
		pi.registerShortcut(model.shortcut, {
			description: `Select GPT-5.6 ${model.name}`,
			handler: (ctx) => selectModel(ctx, model.name, model.id),
		});
	}

	pi.registerShortcut(THINKING_BACKWARD_SHORTCUT, {
		description: "Cycle thinking level backward",
		handler: cycleThinkingBackward,
	});
}
