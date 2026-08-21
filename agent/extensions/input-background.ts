import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const INPUT_BACKGROUND = "\x1b[48;2;48;48;60m"; // #30303c
const IDLE_LABEL = " 󰒲 idle ";
const WORKING_STATUS_FRAME_EVENT = "pi-working-phrase:frame";
const WORKING_STATUS_STOP_EVENT = "pi-working-phrase:stop";

type WorkingStatusFrame = {
	text: string;
};
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
		private readonly getStatusLabel: () => string,
	) {
		super(tui, theme, keybindings);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length > 0) {
			lines[0] = truncateToWidth(
				`${this.borderColor("─")}${this.getStatusLabel()}${lines[0]}`,
				width,
				"",
			);
		}
		return lines.map((line) => applyBackground(line, INPUT_BACKGROUND));
	}
}

export default function (pi: ExtensionAPI) {
	let workingStatus: string | undefined;
	let activeTui: TUI | undefined;

	pi.events.on(WORKING_STATUS_FRAME_EVENT, (data) => {
		const frame = data as WorkingStatusFrame;
		if (typeof frame?.text !== "string") return;
		workingStatus = frame.text;
		activeTui?.requestRender();
	});

	pi.events.on(WORKING_STATUS_STOP_EVENT, () => {
		workingStatus = undefined;
		activeTui?.requestRender();
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		workingStatus = undefined;
		ctx.ui.setWorkingVisible(false);

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			activeTui = tui;
			return new InputBackgroundEditor(tui, theme, keybindings, () =>
				workingStatus
					? ` ${workingStatus} `
					: ctx.ui.theme.fg("muted", IDLE_LABEL),
			);
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setWorkingVisible(true);
		workingStatus = undefined;
		activeTui = undefined;
	});
}
