import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";

export default function confirmAbortExtension(pi: ExtensionAPI) {
	let confirming = false;
	let unsubscribe: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		unsubscribe?.();
		unsubscribe = undefined;
		confirming = false;

		if (!ctx.hasUI) return;

		unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, Key.escape)) return undefined;

			// Let Escape keep its normal behavior while pi is idle.
			if (ctx.isIdle()) return undefined;

			// When the confirmation dialog is already focused, let Escape cancel it.
			if (confirming) return undefined;

			confirming = true;

			void (async () => {
				try {
					const confirmed = await ctx.ui.confirm(
						"Abort current operation?",
						"Pi is currently working. Do you really want to abort?",
					);

					if (confirmed && !ctx.isIdle()) {
						ctx.abort();
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Abort confirmation failed: ${message}`, "warning");
				} finally {
					confirming = false;
				}
			})();

			// Consume the original Escape so pi does not abort before confirmation.
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		confirming = false;
	});
}
