import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Text } from "@earendil-works/pi-tui";

const MAX_TRANSCRIPT_CHARS = 60_000;

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : part?.type === "image" ? "[image]" : ""))
		.filter(Boolean)
		.join("\n");
}

function transcriptFrom(ctx: any): string {
	const lines: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "compaction") {
			const summary = (entry as any).summary;
			if (summary) lines.push(`PRIOR CONVERSATION SUMMARY:\n${summary}`);
			continue;
		}
		if (entry.type !== "message") continue;
		const message = (entry as any).message;
		if (!message || !["user", "assistant", "tool"].includes(message.role)) continue;
		const text = messageText(message.content).trim();
		if (!text) continue;
		const label = message.role === "tool" ? `TOOL RESULT (${message.toolName ?? "tool"})` : message.role.toUpperCase();
		lines.push(`${label}:\n${text}`);
	}
	let transcript = lines.join("\n\n");
	if (transcript.length > MAX_TRANSCRIPT_CHARS) {
		transcript = `[Earlier conversation omitted for length; showing the most recent ${MAX_TRANSCRIPT_CHARS} characters.]\n\n${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
	}
	return transcript;
}

async function createHandoff(model: Model<any>, transcript: string, ctx: any): Promise<string> {
	if (!transcript.trim()) return "No user/assistant conversation was found in this session.";
	const prompt = `Create a concise but complete handoff report for another AI assistant taking over this conversation. Include:\n- The user's goal and relevant context\n- Decisions, constraints, and preferences\n- Work completed and important findings\n- Current state, unresolved issues, and exact next steps\n- Relevant file paths, commands, or technical details\nDo not invent facts. Clearly mark anything uncertain. Preserve important specifics. Output only the report.\n\nConversation transcript:\n${transcript}`;
	let report = "";
	const stream = ctx.modelRegistry.streamSimple(model, {
		messages: [{ role: "user", content: prompt }],
	});
	for await (const event of stream) {
		if (event.type === "text_delta") report += event.delta;
		if (event.type === "error") throw new Error(event.error.message);
	}
	return report.trim();
}

export default function handoffExtension(pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Summarize this conversation and hand it off to another model",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/handoff requires an interactive UI.", "warning");
				return;
			}
			const models = ctx.modelRegistry.getAvailable();
			if (models.length === 0) {
				ctx.ui.notify("No models with configured authentication are available.", "error");
				return;
			}
			const sortedModels = models
				.slice()
				.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
			const selected = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
				const container = new Container();
				const search = new Input({ placeholder: "Type to filter by provider or model…" });
				search.focused = true;
				const items = sortedModels.map((model) => ({
					value: `${model.provider}/${model.id}`,
					label: `${model.provider}/${model.id}`,
					description: `${model.name}${ctx.model?.id === model.id && ctx.model?.provider === model.provider ? " · current" : ""}`,
				}));
				const list = new SelectList(items, 10, {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);
				container.addChild(new Text(theme.fg("accent", theme.bold("Choose handoff model"))));
				container.addChild(search);
				container.addChild(list);
				container.addChild(new Text(theme.fg("dim", "Type to filter · ↑↓ navigate · enter select · esc cancel")));
				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput(data: string) {
						if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
							list.handleInput(data);
						} else if (keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "tui.select.cancel")) {
							list.handleInput(data);
						} else {
							search.handleInput(data);
							list.setFilter(search.getValue().trim());
						}
						tui.requestRender();
					},
				};
			});
			if (!selected) return;
			const model = sortedModels.find((candidate) => `${candidate.provider}/${candidate.id}` === selected);
			if (!model) return;

			const transcript = transcriptFrom(ctx);
			ctx.ui.setWorkingMessage("Preparing handoff summary…");
			let report: string;
			try {
				report = await createHandoff(model, transcript, ctx);
				if (!report) throw new Error("The selected model returned an empty handoff summary.");
			} catch (error) {
				ctx.ui.notify(`Handoff failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			} finally {
				ctx.ui.setWorkingMessage();
			}

			// Intentionally do not set parentSession: the handoff destination is a new,
			// independent session. Only this plain-text report is placed in its editor.
			await ctx.newSession({
				withSession: async (newCtx) => {
					const switched = await pi.setModel(model);
					if (!switched) {
						newCtx.ui.notify(`Could not switch to ${model.provider}/${model.id}; check provider authentication.`, "error");
						return;
					}
					newCtx.ui.setEditorText(`${report}\n\n`);
					newCtx.ui.notify(`Fresh handoff session ready on ${model.provider}/${model.id}. Only the handoff report is in the input; review it, add instructions, and press Enter.`, "info");
				},
			});
		},
	});
}
