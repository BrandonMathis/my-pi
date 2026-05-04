import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function workingShineExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus(
			"working-shine",
			ctx.ui.theme.fg("dim", "working-shine merged into working-verbs (gradient + shuffled phrases + green spinner)"),
		);
	});

}
