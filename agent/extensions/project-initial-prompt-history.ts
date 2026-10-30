/**
 * Before a session's first prompt, Up/Down browse opening prompts from saved
 * sessions in this working directory (newest session first). After the first
 * user message, all history behavior is left to Pi's existing editor.
 */
import { resolve } from "node:path";
import {
	CustomEditor,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** Do not use last-modified time: resuming an old session must not reorder it. */
export function openingPrompts(sessions: SessionInfo[], cwd: string, currentId: string): string[] {
	return sessions
		.filter((session) =>
			session.id !== currentId &&
			session.cwd !== "" && resolve(session.cwd) === resolve(cwd) &&
			session.firstMessage.trim() !== "" && session.firstMessage !== "(no messages)",
		)
		.sort((a, b) => b.created.getTime() - a.created.getTime() || b.path.localeCompare(a.path))
		.map((session) => session.firstMessage);
}

/** Separate browsing state; never add cross-session entries to Pi's history. */
export class OpeningPromptHistory {
	private index = -1;

	constructor(private readonly prompts: readonly string[]) {}

	move(direction: "previous" | "next", text: string): string | undefined {
		// Editing or clearing a recalled prompt ends browsing. Never replace a
		// manually typed draft, even when its cursor is on the first line.
		if (this.index >= 0 && text !== this.prompts[this.index]) this.index = -1;
		if (this.index < 0 && (text !== "" || direction === "next")) return undefined;
		if (this.prompts.length === 0) return undefined;

		if (direction === "previous") {
			this.index = Math.min(this.index + 1, this.prompts.length - 1);
		} else {
			this.index--;
		}
		return this.index < 0 ? "" : this.prompts[this.index];
	}
}

function hasUserMessage(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getEntries().some((entry) =>
		entry.type === "message" && entry.message.role === "user",
	);
}

export default function projectInitialPromptHistory(pi: ExtensionAPI) {
	let restore: (() => void) | undefined;
	let generation = 0;
	let active = false;

	pi.on("session_start", async (_event, ctx) => {
		const currentGeneration = ++generation;
		restore?.();
		restore = undefined;
		active = false;
		if (ctx.mode !== "tui" || hasUserMessage(ctx)) return;

		let prompts: string[];
		try {
			const sessions = await SessionManager.list(
				ctx.sessionManager.getCwd(), ctx.sessionManager.getSessionDir(),
			);
			prompts = openingPrompts(sessions, ctx.sessionManager.getCwd(), ctx.sessionManager.getSessionId());
		} catch (error) {
			if (currentGeneration === generation) {
				ctx.ui.notify(`Could not load opening-prompt history: ${String(error)}`, "warning");
			}
			return;
		}
		// A reload, session switch, or first submission may have happened while
		// the saved sessions were being read.
		if (currentGeneration !== generation || hasUserMessage(ctx) || prompts.length === 0) return;
		active = true;

		const ui = ctx.ui;
		const originalSetter = ui.setEditorComponent;
		const wrappedFactories = new WeakSet<EditorFactory>();
		const wrapFactory = (factory: EditorFactory): EditorFactory => {
			if (wrappedFactories.has(factory)) return factory;
			const wrapped: EditorFactory = (tui, theme, keybindings) => {
				const editor = factory(tui, theme, keybindings);
				const history = new OpeningPromptHistory(prompts);
				const handleInput = editor.handleInput.bind(editor);
				editor.handleInput = (data) => {
					if (active && currentGeneration === generation && hasUserMessage(ctx)) active = false;
					if (!active || currentGeneration !== generation || isKeyRelease(data)) return handleInput(data);

					// Editors extending Pi's Editor expose this public method.
					// Leave autocomplete selection to them, not prompt history.
					const autocomplete = editor as typeof editor & { isShowingAutocomplete?: () => boolean };
					if (autocomplete.isShowingAutocomplete?.()) return handleInput(data);
					const previous = keybindings.matches(data, "tui.editor.historyPrevious") ||
						keybindings.matches(data, "tui.editor.cursorUp");
					const next = keybindings.matches(data, "tui.editor.historyNext") ||
						keybindings.matches(data, "tui.editor.cursorDown");
					if (previous || next) {
						const text = history.move(previous ? "previous" : "next", editor.getText());
						if (text !== undefined) {
							editor.setText(text);
							tui.requestRender();
							return;
						}
					}
					handleInput(data);
				};
				return editor;
			};
			wrappedFactories.add(wrapped);
			return wrapped;
		};

		// Compose with the current editor (including personal styling), and with
		// factories installed later by extensions such as pi-fff. Do not listen
		// to raw terminal input: Up in dialogs and selectors must stay untouched.
		const defaultFactory: EditorFactory = (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings);
		const setter: typeof originalSetter = (factory) => {
			originalSetter.call(ui, wrapFactory(factory ?? defaultFactory));
		};
		ui.setEditorComponent = setter;
		restore = () => {
			if (ui.setEditorComponent === setter) ui.setEditorComponent = originalSetter;
		};
		setter(ui.getEditorComponent());
	});

	// Unlike `input`, this only fires for an actual conversation prompt, not
	// local slash commands such as /model or /settings.
	pi.on("before_agent_start", () => { active = false; });
	pi.on("session_shutdown", () => {
		generation++;
		active = false;
		restore?.();
		restore = undefined;
	});
}
