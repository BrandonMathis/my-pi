import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const INPUT_BACKGROUND = "\x1b[48;2;52;52;64m"; // #343440
const IDLE_LABEL = " 󰒲 idle ";
const RESET_BACKGROUND = "\x1b[49m";
const BACKGROUND_RESET = /\x1b\[(?:0|49)m/g;

/** Keep the editor background active after nested styles (notably the cursor) reset it. */
function applyBackground(line: string, background: string): string {
	const styledLine = line.replace(BACKGROUND_RESET, (reset) => `${reset}${background}`);
	return `${background}${styledLine}${RESET_BACKGROUND}`;
}

class InputBackgroundEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly isIdle: () => boolean,
		private readonly getIdleLabel: () => string,
	) {
		super(tui, theme, keybindings);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (this.isIdle() && lines.length > 0) {
			lines[0] = truncateToWidth(
				`${this.borderColor("─")}${this.getIdleLabel()}${lines[0]}`,
				width,
				"",
			);
		}
		return lines.map((line) => applyBackground(line, INPUT_BACKGROUND));
	}
}

export default function (pi: ExtensionAPI) {
	let idle = true;
	let activeTui: TUI | undefined;

	pi.on("agent_start", () => {
		idle = false;
		activeTui?.requestRender();
	});

	pi.on("agent_settled", () => {
		idle = true;
		activeTui?.requestRender();
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		idle = true;

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			activeTui = tui;
			return new InputBackgroundEditor(
				tui,
				theme,
				keybindings,
				() => idle,
				() => ctx.ui.theme.fg("muted", IDLE_LABEL),
			);
		});
	});

	pi.on("session_shutdown", () => {
		activeTui = undefined;
	});
}
