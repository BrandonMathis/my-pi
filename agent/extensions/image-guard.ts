/**
 * image-guard — keep images away from models that reject them.
 *
 * Some catalog entries claim image input but the provider rejects it. For example,
 * Kimi and Grok on Bedrock fail with "This model doesn't support the image field
 * for user messages" when a `read` tool result has an image. The failed request
 * keeps the image in history, so every later request in the session fails too.
 *
 * For a model that cannot take images (its catalog entry has no "image" input, or
 * it is on the deny list), this extension:
 *   1. blocks `read` on image files before the tool runs. With a UI, it asks whether
 *      to skip the step, let the model work around it, or stop,
 *   2. replaces images in any tool result with a text note,
 *   3. removes images from the context before each provider request, which also
 *      fixes sessions that are already stuck, and
 *   4. watches for the provider's image rejection. On a match it adds the model
 *      to the deny list (saved in ~/.pi/agent/image-guard.json) and retries once.
 *
 * /image-guard [status|on|off|list]  — check or change the current model's entry.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ModelLike = { provider: string; id: string; input?: string[] } | undefined;
type Block = { type: string; [key: string]: unknown };

const STATE_FILE = join(getAgentDir(), "image-guard.json");

// Known offenders (matched after the Bedrock region prefix is stripped).
const SEED_DENY = [
	"amazon-bedrock/moonshotai.kimi-k3",
	"amazon-bedrock/moonshotai.kimi-k2.5",
	"amazon-bedrock/xai.grok-4.6",
];

const IMAGE_REJECTION =
	/(doesn'?t|does not|do not|don'?t) support (the )?image|image (field|input|content)s? (is |are )?not supported|unsupported (image|content type: ?image)|remove image/i;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|ico)$/i;
const BEDROCK_REGION_PREFIX = /^(us|eu|apac|global|jp|au|ca|in|us-gov|sa|me|af)\./;

export function modelKey(model: { provider: string; id: string }): string {
	const id = model.provider === "amazon-bedrock" ? model.id.replace(BEDROCK_REGION_PREFIX, "") : model.id;
	return `${model.provider}/${id}`;
}

type State = { deny: string[]; allow: string[] };

function loadState(): State {
	try {
		if (existsSync(STATE_FILE)) {
			const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
			return { deny: raw.deny ?? [], allow: raw.allow ?? [] };
		}
	} catch {
		// A corrupt state file falls back to the defaults below.
	}
	return { deny: [], allow: [] };
}

function saveState(state: State) {
	try {
		writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
	} catch {
		// Not saving only means the model is learned again next session.
	}
}

const PLACEHOLDER = "[image omitted by image-guard: the current model does not accept images]";

/** Replaces each image block with a text block. Returns undefined if there were no images. */
function stripImages(content: unknown): Block[] | undefined {
	if (!Array.isArray(content)) return undefined;
	if (!content.some((block: Block) => block?.type === "image")) return undefined;
	return content.map((block: Block) =>
		block?.type === "image" ? { type: "text", text: PLACEHOLDER } : block,
	);
}

const CHOICE_SKIP = "Skip this step and continue without the image";
const CHOICE_SKIP_ALL = "Always skip image steps in this session";
const CHOICE_BLOCK = "Block it and let the model work around it";
const CHOICE_STOP = "Stop so I can take over";

function skipReason(path: string) {
	return `image-guard: the user chose to skip this step. Do not try to view ${path} or any other image by any other means (no conversion, OCR, screenshots, or other tools). Continue the remaining work as if this step were not needed, and say in your final summary that it was skipped.`;
}

export default function imageGuard(pi: ExtensionAPI) {
	let state = loadState();
	let retryPending = false;
	let skipAllThisSession = false;

	pi.on("session_start", () => {
		skipAllThisSession = false;
	});

	const blocked = (model: ModelLike): boolean => {
		if (!model) return false;
		const key = modelKey(model);
		if (state.allow.includes(key)) return false;
		if (state.deny.includes(key) || SEED_DENY.includes(key)) return true;
		return Array.isArray(model.input) && !model.input.includes("image");
	};

	const deny = (model: NonNullable<ModelLike>) => {
		const key = modelKey(model);
		state.allow = state.allow.filter((k) => k !== key);
		if (!state.deny.includes(key) && !SEED_DENY.includes(key)) state.deny.push(key);
		saveState(state);
	};

	// 1. Block reads of image files before the tool runs, and ask the user what to do.
	pi.on("tool_call", async (event, ctx) => {
		if (!blocked(ctx.model)) return;
		if (!isToolCallEventType("read", event)) return;
		const path = String(event.input.path ?? "");
		if (!IMAGE_EXT.test(path)) return;

		const modelName = `${ctx.model!.provider}/${ctx.model!.id}`;
		const blockResult = {
			block: true,
			reason: `image-guard: ${modelName} cannot take images, so ${path} was not read. Describe the image some other way, or switch to a vision model.`,
		};

		if (skipAllThisSession) return { block: true, reason: skipReason(path) };
		if (!ctx.hasUI) return blockResult;

		const choice = await ctx.ui.select(
			`image-guard: ${modelName} can't take images. The agent wants to read ${path}.`,
			[CHOICE_SKIP, CHOICE_SKIP_ALL, CHOICE_BLOCK, CHOICE_STOP],
			{ signal: ctx.signal },
		);
		switch (choice) {
			case CHOICE_SKIP_ALL:
				skipAllThisSession = true;
				return { block: true, reason: skipReason(path) };
			case CHOICE_SKIP:
				return { block: true, reason: skipReason(path) };
			case CHOICE_STOP:
				return {
					block: true,
					reason: `image-guard: the user stopped the run instead of reading ${path}. Wait for their instructions.`,
					terminate: true,
				};
			default: // CHOICE_BLOCK, or the dialog was dismissed
				return blockResult;
		}
	});

	// 2. Replace images in tool results with text (read, MCP, codemode image(), etc.).
	pi.on("tool_result", (event, ctx) => {
		if (!blocked(ctx.model)) return;
		const content = stripImages(event.content);
		if (content) return { content, details: event.details };
	});

	// 3. Remove images from every request, including images already in history.
	pi.on("context", (event, ctx) => {
		if (!blocked(ctx.model)) return;
		let changed = false;
		const messages = event.messages.map((msg: any) => {
			if (msg.role === "assistant") return msg;
			const content = stripImages(msg.content);
			if (!content) return msg;
			changed = true;
			return { ...msg, content };
		});
		if (changed) return { messages };
	});

	// 4. When the provider rejects images, add the model to the deny list and retry once.
	pi.on("message_end", (event, ctx) => {
		const msg: any = event.message;
		if (msg?.role !== "assistant" || msg.stopReason !== "error") return;
		if (!IMAGE_REJECTION.test(String(msg.errorMessage ?? ""))) return;
		const model = ctx.model ?? (msg.provider ? { provider: msg.provider, id: msg.model } : undefined);
		if (!model) return;
		const wasBlocked = blocked(model);
		deny(model);
		if (wasBlocked) return; // Already stripping; do not loop.
		retryPending = true;
		ctx.ui?.notify?.(
			`image-guard: ${model.provider}/${model.id} rejects images. It will no longer get images, and the request will be retried.`,
			"warning",
		);
	});

	pi.on("agent_settled", (event: any) => {
		if (!retryPending) return;
		retryPending = false;
		if (event?.aborted) return;
		pi.sendMessage(
			{
				customType: "image-guard",
				content:
					"The previous request failed because this model does not accept images. Images have been removed from the conversation and replaced with notes. Continue from where you left off, and do not read image files.",
				display: true,
			},
			{ triggerTurn: true },
		);
	});

	pi.registerCommand("image-guard", {
		description: "Check or change image blocking for the current model: status | on | off | list",
		handler: async (args, ctx) => {
			state = loadState();
			const arg = String(args ?? "").trim().toLowerCase() || "status";
			const model = ctx.model;
			if (arg === "list") {
				const lines = [
					`deny (learned): ${state.deny.join(", ") || "none"}`,
					`deny (built-in): ${SEED_DENY.join(", ")}`,
					`allow (manual): ${state.allow.join(", ") || "none"}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (!model) {
				ctx.ui.notify("image-guard: no model selected", "warning");
				return;
			}
			const key = modelKey(model);
			if (arg === "on") {
				deny(model);
			} else if (arg === "off") {
				state.deny = state.deny.filter((k) => k !== key);
				if (!state.allow.includes(key)) state.allow.push(key);
				saveState(state);
			}
			ctx.ui.notify(
				`image-guard: ${key} → images ${blocked(model) ? "BLOCKED" : "allowed"}`,
				"info",
			);
		},
	});
}
