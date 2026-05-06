import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createWorkingStatusController } from "./timers";

export default function piWorkingPhraseExtension(pi: ExtensionAPI) {
	const controller = createWorkingStatusController();

	pi.on("agent_start", async (_event, ctx) => {
		controller.start(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		controller.stop(ctx);
	});

	pi.on("session_shutdown", async () => {
		controller.stop();
	});
}
