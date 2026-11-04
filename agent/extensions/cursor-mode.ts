/**
 * /cursor [hardware|drawn|status] — persist a cursor mode and apply it via /reload.
 * Kept separate from focus-cursor.ts so the command stays loaded in hardware mode.
 */
import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const FOCUS_EXTENSION = "extensions/focus-cursor.ts";
const ACTIONS = ["hardware", "drawn", "status"];

/** Remove only exact references to our extension; preserve other resource filters. */
export function cursorExtensionPaths(paths: string[], agentDir: string, hardware: boolean): string[] {
	const target = resolve(agentDir, FOCUS_EXTENSION);
	const otherPaths = paths.filter((entry) => {
		if (entry.startsWith("!")) return true;
		const path = entry.replace(/^[+-]/, "").replace(/^~(?=\/|$)/, homedir());
		return resolve(agentDir, path) !== target;
	});
	return [...otherPaths, `${hardware ? "-" : "+"}${FOCUS_EXTENSION}`];
}

export default function cursorMode(pi: ExtensionAPI) {
	pi.registerCommand("cursor", {
		description: "Toggle hardware cursor vs drawn cursor + focus extension: /cursor [hardware|drawn|status]",
		getArgumentCompletions: (prefix) => {
			const items = ACTIONS.filter((action) => action.startsWith(prefix))
				.map((action) => ({ value: action, label: action }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/cursor is only available in the terminal UI.", "warning");
				return;
			}
			const action = args.trim().toLowerCase();
			if (action && !ACTIONS.includes(action)) {
				ctx.ui.notify("Usage: /cursor [hardware|drawn|status] (no argument toggles)", "warning");
				return;
			}
			if (action === "status") {
				ctx.ui.notify(`Cursor: ${pi.getSettings().showHardwareCursor ? "hardware" : "drawn"}. /cursor toggles hardware vs drawn + focus extension.`, "info");
				return;
			}

			await ctx.waitForIdle();
			const hardware = action ? action === "hardware" : !pi.getSettings().showHardwareCursor;
			try {
				const agentDir = getAgentDir();
				const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
				const loadErrors = settings.drainErrors();
				if (loadErrors.length) throw loadErrors[0].error;
				const project = settings.getProjectSettings();
				if (project.showHardwareCursor !== undefined && project.showHardwareCursor !== hardware) {
					ctx.ui.notify(`Project settings override showHardwareCursor. Remove that override in ${join(ctx.cwd, ".pi/settings.json")} before using /cursor.`, "warning");
					return;
				}
				const global = settings.getGlobalSettings();
				settings.setShowHardwareCursor(hardware);
				settings.setExtensionPaths(cursorExtensionPaths(global.extensions ?? [], agentDir, hardware));
				await settings.flush();
				const saveErrors = settings.drainErrors();
				if (saveErrors.length) throw saveErrors[0].error;
			} catch (error) {
				ctx.ui.notify(`Could not save cursor mode; Pi was not reloaded: ${String(error)}`, "error");
				return;
			}

			ctx.ui.notify(`Switching to ${hardware ? "hardware cursor (focus extension off)" : "drawn cursor + focus extension"}. Saved globally; reloading Pi…`, "info");
			await ctx.reload();
			return;
		},
	});
}
