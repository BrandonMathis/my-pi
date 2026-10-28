import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, Key, matchesKey } from "@mariozechner/pi-tui";

export default function confirmAbortExtension(pi: ExtensionAPI) {
	let confirmation: AbortController | undefined;
	let unsubscribe: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		unsubscribe?.();
		unsubscribe = undefined;
		confirmation?.abort();
		confirmation = undefined;

		if (!ctx.hasUI) return;

		unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, Key.escape)) return undefined;

			// Raw input listeners run before Pi filters keyup events. Only a fresh
			// keydown should open/cancel the dialog, never a release or held-key repeat.
			if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };

			// Dismiss our dialog explicitly and consume Escape so it cannot abort work.
			// Check this even if the operation finished while the dialog was open.
			if (confirmation) {
				confirmation.abort();
				return { consume: true };
			}

			// Let Escape keep its normal behavior while pi is idle.
			if (ctx.isIdle()) return undefined;

			const controller = new AbortController();
			confirmation = controller;

			void (async () => {
				try {
					const choice = await ctx.ui.select(
						"Abort current operation?\nPi is currently working. Do you really want to abort? Press Escape to keep working.",
						["No", "Yes"],
						{ signal: controller.signal },
					);

					if (choice === "Yes" && !controller.signal.aborted && !ctx.isIdle()) {
						ctx.abort();
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Abort confirmation failed: ${message}`, "warning");
				} finally {
					if (confirmation === controller) confirmation = undefined;
				}
			})();

			// Consume the original Escape so pi does not abort before confirmation.
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		confirmation?.abort();
		confirmation = undefined;
	});
}
