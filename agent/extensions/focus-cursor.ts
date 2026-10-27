/**
 * focus-cursor: only show the input cursor while the terminal (or tmux pane) has focus.
 *
 * Pi always draws its editor cursor, so with several Pi sessions in tmux panes every
 * pane shows a cursor. This extension enables terminal focus reporting (DECSET 1004)
 * and hides the cursor (reverse-video cursor and hardware cursor) on focus-out,
 * restoring it on focus-in, like Claude Code does.
 *
 * tmux needs `set -g focus-events on` to forward pane/client focus changes.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// Zero-width marker the focused component emits right before its cursor (pi-tui CURSOR_MARKER).
// Older pi-tui draws the cursor as CURSOR_MARKER + "\x1b[7m" + char + "\x1b[0m"; newer versions
// wrap it in fake-cursor APC markers that may still be present at this point.
const CURSOR_MARKER = "\x1b_pi:c\x07";
const FOCUSED_CURSOR = /\x1b_pi:c\x07(?:\x1b_pi:fc\x07)?(?:\x1b\[7m)?/g;
const FAKE_CURSOR_END = /\x1b_pi:\/fc\x07/g;

const PATCHED = Symbol.for("pi.focus-cursor.patched");

type CursorExtractor = ((this: TuiLike, lines: string[], height: number) => unknown) & { [PATCHED]?: true };
type TuiLike = {
	requestRender(force?: boolean): void;
	terminal?: { write(data: string): void };
	handleViewportInput?: unknown;
};

/** Remove the focused cursor highlight and marker in place; the TUI reads the mutated array. */
function stripCursor(lines: string[]): void {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line.includes(CURSOR_MARKER)) continue;
		lines[i] = line.replace(FOCUSED_CURSOR, "").replace(FAKE_CURSOR_END, "");
	}
}

export default function (pi: ExtensionAPI) {
	let focused = true;
	let activeTui: TuiLike | undefined;
	let restorePatch: (() => void) | undefined;
	let removeStdinListener: (() => void) | undefined;
	let removeInputHandler: (() => void) | undefined;

	const isFullscreenTui = (tui: TuiLike | undefined) => typeof tui?.handleViewportInput === "function";

	const writeTerminal = (tui: TuiLike | undefined, data: string) => {
		if (tui?.terminal) tui.terminal.write(data);
		else process.stdout.write(data);
	};

	const setFocused = (next: boolean) => {
		if (focused === next) return;
		focused = next;
		activeTui?.requestRender();
	};

	/**
	 * Patch the step that locates the focused cursor in the final composited frame (base
	 * content and overlays). Patching the shared prototype keeps working when Pi swaps
	 * between the fullscreen and regular renderers.
	 */
	const patchTui = (tui: TuiLike) => {
		let proto: object | null = Object.getPrototypeOf(tui);
		while (proto && !Object.prototype.hasOwnProperty.call(proto, "extractCursorPosition")) {
			proto = Object.getPrototypeOf(proto);
		}
		if (!proto) return;
		const target = proto as { extractCursorPosition: CursorExtractor };
		const original = target.extractCursorPosition;
		if (typeof original !== "function" || original[PATCHED]) return;

		const patched: CursorExtractor = function (this: TuiLike, lines: string[], height: number) {
			if (this !== activeTui) {
				// A new renderer instance (e.g. after switching TUI mode). Regular mode does not
				// enable focus reporting itself, so re-enable it for the new renderer.
				activeTui = this;
				writeTerminal(this, ENABLE_FOCUS_REPORTING);
			}
			// With the marker gone the TUI also hides the hardware cursor.
			if (!focused) stripCursor(lines);
			return original.call(this, lines, height);
		};
		patched[PATCHED] = true;
		target.extractCursorPosition = patched;
		restorePatch = () => {
			if (target.extractCursorPosition === patched) target.extractCursorPosition = original;
		};
	};

	/**
	 * Fullscreen mode consumes focus events before extension input listeners see them,
	 * so detect them on raw stdin, which sees every chunk regardless of mode.
	 */
	const listenToStdin = () => {
		let inPaste = false;
		const onData = (chunk: Buffer | string) => {
			const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (data.includes(PASTE_START)) inPaste = true;
			if (inPaste) {
				if (data.includes(PASTE_END)) inPaste = false;
				return;
			}
			const lastIn = data.lastIndexOf(FOCUS_IN);
			const lastOut = data.lastIndexOf(FOCUS_OUT);
			if (lastIn === -1 && lastOut === -1) return;
			setFocused(lastIn > lastOut);
		};
		process.stdin.on("data", onData);
		return () => process.stdin.removeListener("data", onData);
	};

	const cleanup = () => {
		removeStdinListener?.();
		removeStdinListener = undefined;
		removeInputHandler?.();
		removeInputHandler = undefined;
		restorePatch?.();
		restorePatch = undefined;
		// Fullscreen mode owns focus reporting (it disables it on exit); in regular mode it is ours.
		if (activeTui && !isFullscreenTui(activeTui)) writeTerminal(activeTui, DISABLE_FOCUS_REPORTING);
		activeTui?.requestRender();
		activeTui = undefined;
		focused = true;
	};

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		cleanup();

		// Borrow the TUI instance through a transient widget factory.
		const widgetKey = "focus-cursor-probe";
		ctx.ui.setWidget(widgetKey, (tui) => {
			activeTui = tui as unknown as TuiLike;
			return { render: () => [], invalidate() {} };
		});
		ctx.ui.setWidget(widgetKey, undefined);
		if (!activeTui) return;

		patchTui(activeTui);
		removeStdinListener = listenToStdin();
		// In regular mode focus events reach extension listeners; swallow them so they never
		// reach the editor as input.
		removeInputHandler = ctx.ui.onTerminalInput((data) =>
			data === FOCUS_IN || data === FOCUS_OUT ? { consume: true } : undefined,
		);
		writeTerminal(activeTui, ENABLE_FOCUS_REPORTING);
		activeTui.requestRender();
	});

	pi.on("session_shutdown", () => {
		cleanup();
	});
}
