import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

const INPUT_BACKGROUND = "\x1b[48;2;48;48;60m"; // #30303c
const IDLE_LABEL = " 󰒲 idle ";
const RESET_BACKGROUND = "\x1b[49m";
const BACKGROUND_RESET = /\x1b\[(?:0|49)m/g;

/** Keep the background through nested styles and fill the row for Pi 1.0's fullscreen input bar. */
function applyBackground(line: string, background: string, width: number): string {
	const fittedLine = truncateToWidth(line, width, "");
	const padding = " ".repeat(Math.max(0, width - visibleWidth(fittedLine)));
	const styledLine = fittedLine.replace(BACKGROUND_RESET, (reset) => `${reset}${background}`);
	return `${background}${styledLine}${padding}${RESET_BACKGROUND}`;
}

export default function (pi: ExtensionAPI) {
	let idle = true;
	let activeTui: TUI | undefined;
	let restoreEditorSetter: (() => void) | undefined;

	const installEditorStyling = (ctx: ExtensionContext) => {
		const ui = ctx.ui;
		const originalSetter = ui.setEditorComponent.bind(ui);
		const styledFactories = new WeakSet<Function>();

		const styleFactory = (factory: NonNullable<ReturnType<typeof ui.getEditorComponent>>) => {
			if (styledFactories.has(factory)) return factory;
			const styledFactory = (tui: TUI, theme: Parameters<typeof factory>[1], keybindings: Parameters<typeof factory>[2]) => {
				activeTui = tui;
				const editor = factory(tui, theme, keybindings);

				// Let Pi render its working indicator above the editor, not in its border.
				if ("embedWorkingStatus" in editor) {
					(editor as unknown as { embedWorkingStatus: boolean }).embedWorkingStatus = false;
				}

				const render = editor.render.bind(editor);
				editor.render = (width: number) => {
					const lines = render(width);
					if (idle && lines.length > 0) {
						const borderColor = (editor as unknown as { borderColor?: (text: string) => string }).borderColor;
						const border = borderColor ? borderColor("─") : ui.theme.fg("border", "─");
						lines[0] = truncateToWidth(`${border}${ui.theme.fg("muted", IDLE_LABEL)}${lines[0]}`, width, "");
					}
					return lines.map((line) => applyBackground(line, INPUT_BACKGROUND, width));
				};
				return editor;
			};
			styledFactories.add(styledFactory);
			return styledFactory;
		};

		// Keep styling composed with editor factories installed by other extensions,
		// including async session_start handlers such as pi-fff's autocomplete.
		const patchedSetter: typeof ui.setEditorComponent = (factory) => {
			originalSetter(factory ? styleFactory(factory) : undefined);
		};
		ui.setEditorComponent = patchedSetter;
		restoreEditorSetter = () => {
			if (ui.setEditorComponent === patchedSetter) ui.setEditorComponent = originalSetter;
		};

		const currentFactory = ui.getEditorComponent();
		if (currentFactory) {
			patchedSetter(currentFactory);
		} else {
			patchedSetter((tui, theme, keybindings) =>
				new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: false }),
			);
		}
	};

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
		restoreEditorSetter?.();
		restoreEditorSetter = undefined;
		installEditorStyling(ctx);
	});

	pi.on("session_shutdown", () => {
		restoreEditorSetter?.();
		restoreEditorSetter = undefined;
		activeTui = undefined;
	});
}
