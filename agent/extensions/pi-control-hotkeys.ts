import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { loadModelPreferences, ModelPreferencesError, resolveModel } from "../model-preferences/index.mjs";
const THINKING_BACKWARD_SHORTCUT = "ctrl+shift+tab";

export default function piControlHotkeys(pi: ExtensionAPI) {
	let switching = false;

	async function selectModel(ctx: ExtensionContext, alias: string): Promise<void> {
		if (switching) return;
		switching = true;

		try {
			// Resolve shared preferences on every press, against the live authenticated catalog.
			const preference = loadModelPreferences(getAgentDir()).models[alias];
			const target = preference && resolveModel(preference, ctx.modelRegistry.getAvailable());
			if (!target) {
				ctx.ui.notify(`No available model for ${alias}; check model-preferences/models.json and /login`, "error");
				return;
			}

			if (!(await pi.setModel(target))) {
				ctx.ui.notify(`No credentials available for ${target.provider}/${target.id}`, "error");
				return;
			}

			ctx.ui.notify(`Model: ${target.id}`, "info");
		} catch (error) {
			ctx.ui.notify(error instanceof ModelPreferencesError ? error.message : "Model switch failed; try /model.", "error");
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

	for (const [alias, model] of Object.entries(loadModelPreferences(getAgentDir()).models)) {
		for (const shortcut of model.shortcuts ?? []) {
			pi.registerShortcut(shortcut, {
				description: `Select latest available ${model.provider} ${model.family}`,
				handler: (ctx) => selectModel(ctx, alias),
			});
		}
	}

	pi.registerShortcut(THINKING_BACKWARD_SHORTCUT, {
		description: "Cycle thinking level backward",
		handler: cycleThinkingBackward,
	});
}
