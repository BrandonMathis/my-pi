import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const SOL = "gpt-5.6-sol";
const TERRA = "gpt-5.6-terra";
const SHORTCUT = "ctrl+shift+tab";

export default function solTerraSwitcher(pi: ExtensionAPI) {
	let switching = false;

	async function toggleModel(ctx: ExtensionContext): Promise<void> {
		if (switching) return;
		switching = true;

		try {
			const targetId = ctx.model?.provider === PROVIDER && ctx.model.id === SOL ? TERRA : SOL;
			const target = ctx.modelRegistry.find(PROVIDER, targetId);

			if (!target) {
				ctx.ui.notify(`Model not found: ${PROVIDER}/${targetId}`, "error");
				return;
			}

			const success = await pi.setModel(target);
			if (!success) {
				ctx.ui.notify(`No credentials available for ${PROVIDER}/${targetId}`, "error");
				return;
			}

			ctx.ui.notify(`Model: ${target.id}`, "info");
		} finally {
			switching = false;
		}
	}

	pi.registerShortcut(SHORTCUT, {
		description: "Toggle between GPT-5.6 Sol and Terra",
		handler: toggleModel,
	});

	pi.registerCommand("sol-terra", {
		description: "Toggle between GPT-5.6 Sol and Terra",
		handler: async (_args, ctx) => toggleModel(ctx),
	});
}
