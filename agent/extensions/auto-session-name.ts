import { basename } from "node:path";
import { complete } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

type SessionEntryLike = {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		content?: unknown;
	};
};

type AutoSessionNameEntry = {
	version?: number;
	title?: string;
	prompt?: string;
	generatedAt?: string;
};

type ModelCandidate = {
	provider: string;
	id: string;
};

type TitlePhrasePattern = {
	pattern: RegExp;
	title: string;
	weight: number;
};

const MODEL_CANDIDATES: readonly ModelCandidate[] = [
	{ provider: "openai-codex", id: "gpt-5" },
	{ provider: "openai", id: "gpt-5.4" },
	{ provider: "openai", id: "gpt-5.2" },
	{ provider: "openai", id: "gpt-5-mini" },
	{ provider: "openai", id: "gpt-4.1" },
];
const MAX_WORDS = 6;
const MAX_PROMPT_CHARS = 4_000;
const AUTO_TITLE_ENTRY_TYPE = "auto-session-name";

const GENERIC_TITLE_WORDS = new Set([
	"create",
	"build",
	"make",
	"write",
	"generate",
	"add",
	"implement",
	"help",
	"fix",
	"debug",
	"diagnose",
	"investigate",
	"review",
	"explain",
	"update",
	"refactor",
	"my",
	"your",
	"our",
]);

const TITLE_STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"can",
	"could",
	"do",
	"does",
	"for",
	"from",
	"given",
	"have",
	"how",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"lets",
	"let's",
	"me",
	"my",
	"of",
	"on",
	"or",
	"our",
	"see",
	"show",
	"so",
	"that",
	"the",
	"this",
	"to",
	"type",
	"update",
	"want",
	"when",
	"with",
	"would",
	"you",
	"your",
]);

const LEADING_NOISE_PATTERNS = [
	/^(?:please\s+)?(?:help\s+me|can\s+you|could\s+you|would\s+you)\s+(?:to\s+)?/i,
	/^(?:please\s+)?(?:i\s+need|i\s+want)\s+(?:to\s+)?/i,
	/^(?:please\s+)?(?:create|build|make|write|generate|add|implement|fix|debug|diagnose|investigate|review|explain|update|refactor)\s+/i,
	/^(?:let'?s|lets)\s+/i,
];

const TITLE_PHRASE_PATTERNS: readonly TitlePhrasePattern[] = [
	{ pattern: /\bauto\s+session\s+name(?:\s+generator)?\b/i, title: "Session Naming", weight: 60 },
	{ pattern: /\bsession\s+names?\b/i, title: "Session Naming", weight: 58 },
	{ pattern: /\bsession\s+naming\b/i, title: "Session Naming", weight: 58 },
	{ pattern: /\bbottom\s+bar\b/i, title: "Footer", weight: 34 },
	{ pattern: /\bfooter\b/i, title: "Footer", weight: 34 },
	{ pattern: /\/resume\b/i, title: "/resume", weight: 40 },
	{ pattern: /\bfull\s+prompt\b/i, title: "Prompt History", weight: 36 },
	{ pattern: /\bpast\s+sessions?\b/i, title: "Session History", weight: 35 },
	{ pattern: /\bsession\s+selector\b/i, title: "Session Selector", weight: 30 },
	{ pattern: /\bextension\b/i, title: "Extension", weight: 16 },
	{ pattern: /\bprompt\s+template\b/i, title: "Prompt Template", weight: 24 },
	{ pattern: /\bgithub\s+actions\b/i, title: "GitHub Actions", weight: 28 },
	{ pattern: /\bplaywright\b/i, title: "Playwright", weight: 28 },
	{ pattern: /\bneovim\b/i, title: "Neovim", weight: 28 },
	{ pattern: /\bmarkdown\b/i, title: "Markdown", weight: 24 },
	{ pattern: /\btreesitter\b/i, title: "Treesitter", weight: 24 },
	{ pattern: /\bnode\b/i, title: "Node", weight: 22 },
	{ pattern: /\bpnpm\b/i, title: "pnpm", weight: 22 },
	{ pattern: /\bci\b/i, title: "CI", weight: 20 },
	{ pattern: /\bapi\b/i, title: "API", weight: 20 },
	{ pattern: /\bdocs?\b/i, title: "Docs", weight: 18 },
	{ pattern: /\berror\b/i, title: "Error", weight: 20 },
	{ pattern: /\bfail(?:ing|ure)?\b/i, title: "Failure", weight: 20 },
	{ pattern: /\b(?:flake|flaky)\b/i, title: "Flake", weight: 18 },
];

const TITLE_SYSTEM_PROMPT = [
	"You generate concise, high-signal session titles for technical work.",
	"Infer the real task, bug, feature, subsystem, or UX change and name that directly.",
	"Do not echo the opening words of the prompt or lightly rewrite the first few words.",
	"Synthesize a title from the important concepts instead of clipping a prompt prefix.",
	"Avoid generic leading verbs such as Help, Create, Build, Make, Write, Generate, Add, Implement, Fix, Debug, or Investigate.",
	"Avoid first-person phrasing like My, I, We, or Can You.",
	"Prefer concrete technical keywords like frameworks, files, APIs, errors, commands, tools, and UI surfaces.",
	"Use short abstractions like UX, CI, API, CLI, or Docs when they clearly improve the title.",
	"Write a compact title-case noun phrase suitable for a sidebar label.",
	`Use 3 to ${MAX_WORDS} words when possible, never more than ${MAX_WORDS}.`,
	"Return only the title. No quotes, bullets, labels, or commentary.",
].join("\n");

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function tokenizeForComparison(value: string): string[] {
	return normalizeWhitespace(value)
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s/_-]+/gu, " ")
		.split(/\s+/)
		.filter(Boolean);
}

function stripLeadingNoise(value: string): string {
	let cleaned = normalizeWhitespace(value);

	while (true) {
		const next = LEADING_NOISE_PATTERNS.reduce(
			(result, pattern) => result.replace(pattern, ""),
			cleaned,
		);
		if (next === cleaned) return cleaned;
		cleaned = normalizeWhitespace(next);
	}
}

function toTitleCaseWord(word: string): string {
	if (!word) return word;
	if (word.startsWith("/") && word.length > 1) return word;
	if (word.toUpperCase() === word && /[A-Z]/.test(word)) return word;
	if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$/.test(word)) return word;
	if (word.toLowerCase() === "pi") return "Pi";
	return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function toTitleCase(value: string): string {
	return value
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => {
			if (word.startsWith("/")) {
				return word.toLowerCase();
			}
			if (word.includes("/")) {
				return word
					.split("/")
					.map((part, index) => (index === 0 && word.startsWith("/") ? part : toTitleCaseWord(part)))
					.join("/");
			}
			if (word.includes("-")) {
				return word
					.split("-")
					.map((part) => toTitleCaseWord(part))
					.join("-");
			}
			return toTitleCaseWord(word);
		})
		.join(" ");
}

function hasConversationHistory(entries: SessionEntryLike[]): boolean {
	return entries.some((entry) => {
		if (entry.type !== "message") return false;
		const role = entry.message?.role;
		return role === "user" || role === "assistant" || role === "toolResult";
	});
}

function truncateWords(value: string, maxWords: number): string {
	const words = value.split(/\s+/).filter(Boolean).slice(0, maxWords);
	return words.join(" ");
}

function normalizeTitle(rawTitle: string): string | undefined {
	let title = rawTitle.trim();
	if (!title) return undefined;

	title =
		title
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";

	title = title
		.replace(/^[-*•]\s*/, "")
		.replace(/^title\s*:\s*/i, "")
		.replace(/^good\s*:\s*/i, "")
		.replace(/^bad\s*:\s*/i, "")
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/[.?!,:;]+$/g, "");

	title = normalizeWhitespace(title);
	title = truncateWords(title, MAX_WORDS);
	title = toTitleCase(title);

	return title.length > 0 ? title : undefined;
}

function sanitizePromptText(prompt: string): string {
	return normalizeWhitespace(
		prompt
			.replace(/```[\s\S]*?```/g, " ")
			.replace(/`[^`]*`/g, " ")
			.replace(/https?:\/\/\S+/g, " ")
			.replace(/[“”]/g, '"')
			.replace(/[‘’]/g, "'"),
	);
}

function simpleFallbackTitle(prompt: string): string | undefined {
	const cleaned = stripLeadingNoise(
		sanitizePromptText(prompt)
			.replace(/[^\p{L}\p{N}\s/_-]+/gu, " ")
			.trim(),
	);
	if (!cleaned) return undefined;

	const title = truncateWords(cleaned, MAX_WORDS);
	if (!title) return undefined;

	return toTitleCase(title);
}

function matchTitlePhrases(prompt: string): string[] {
	const matches = TITLE_PHRASE_PATTERNS.map((entry) => {
		const match = entry.pattern.exec(prompt);
		if (!match) return undefined;
		return {
			title: entry.title,
			weight: entry.weight,
			index: match.index,
		};
	}).filter(
		(
			entry,
		): entry is {
			title: string;
			weight: number;
			index: number;
		} => Boolean(entry),
	);

	matches.sort((a, b) => b.weight - a.weight || a.index - b.index);

	const seen = new Set<string>();
	const phrases: string[] = [];
	for (const match of matches) {
		const key = match.title.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		phrases.push(match.title);
	}
	return phrases;
}

function extractKeywordTokens(prompt: string): string[] {
	const rawTokens = sanitizePromptText(prompt).match(/\/[a-z][\w-]*|[A-Za-z][A-Za-z0-9]*(?:[._/-][A-Za-z0-9]+)*/g) ?? [];
	const tokens: string[] = [];
	const seen = new Set<string>();

	for (const rawToken of rawTokens) {
		const token = rawToken.trim();
		if (!token) continue;
		const lower = token.toLowerCase();
		if (TITLE_STOP_WORDS.has(lower) || GENERIC_TITLE_WORDS.has(lower)) continue;
		if (/^\d+$/.test(token)) continue;

		const normalized = token.startsWith("/")
			? token.toLowerCase()
			: lower === "pi"
				? "Pi"
				: /^[A-Z0-9._/-]+$/.test(token)
					? token
					: toTitleCaseWord(token);
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		tokens.push(normalized);
	}

	return tokens;
}

function heuristicFallbackTitle(prompt: string): string | undefined {
	const phrases = matchTitlePhrases(prompt);
	const keywordTokens = extractKeywordTokens(prompt);
	const hasPi = keywordTokens.some((token) => token.toLowerCase() === "pi");
	const hasSessionNaming = phrases.includes("Session Naming");
	const hasFooter = phrases.includes("Footer");
	const hasResume = phrases.includes("/resume");
	const hasPromptHistory = phrases.includes("Prompt History") || phrases.includes("Session History");

	if (hasSessionNaming && hasFooter && (hasResume || hasPromptHistory)) {
		return normalizeTitle(`${hasPi ? "Pi " : ""}Session Naming UX`);
	}
	if (hasSessionNaming && hasResume) {
		return normalizeTitle(`${hasPi ? "Pi " : ""}Session Naming /resume`);
	}
	if (hasSessionNaming && hasFooter) {
		return normalizeTitle(`${hasPi ? "Pi " : ""}Session Naming Footer`);
	}

	const parts: string[] = [];
	if (hasPi) parts.push("Pi");

	for (const phrase of phrases) {
		if (phrase === "Pi") continue;
		const candidate = normalizeWhitespace([...parts, phrase].join(" "));
		if (tokenizeForComparison(candidate).length > MAX_WORDS) continue;
		parts.push(phrase);
		if (tokenizeForComparison(parts.join(" ")).length >= MAX_WORDS) break;
	}

	for (const token of keywordTokens) {
		if (parts.some((part) => tokenizeForComparison(part).includes(token.toLowerCase()))) continue;
		const candidate = normalizeWhitespace([...parts, token].join(" "));
		if (tokenizeForComparison(candidate).length > MAX_WORDS) continue;
		parts.push(token);
		if (tokenizeForComparison(parts.join(" ")).length >= MAX_WORDS) break;
	}

	const title = normalizeTitle(parts.join(" "));
	if (title) return title;

	return simpleFallbackTitle(prompt);
}

function fallbackTitle(prompt: string): string | undefined {
	return heuristicFallbackTitle(prompt) ?? simpleFallbackTitle(prompt);
}

function isPromptPrefixTitle(title: string, prompt: string): boolean {
	const titleWords = tokenizeForComparison(title);
	if (titleWords.length === 0) return false;

	for (const variant of [prompt, stripLeadingNoise(prompt)]) {
		const promptWords = tokenizeForComparison(variant);
		if (promptWords.length < titleWords.length) continue;
		if (titleWords.every((word, index) => word === promptWords[index])) return true;
	}

	return false;
}

function isGenericTitle(title: string): boolean {
	const [firstWord] = tokenizeForComparison(title);
	return firstWord ? GENERIC_TITLE_WORDS.has(firstWord) : false;
}

function isUsableTitle(title: string, prompt: string): boolean {
	return !isPromptPrefixTitle(title, prompt) && !isGenericTitle(title);
}

function isCommandLikePrompt(prompt: string): boolean {
	return prompt.startsWith("/") || prompt.startsWith("!");
}

function readTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			const block = item as Record<string, unknown>;
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function getFirstUserPrompt(entries: SessionEntryLike[]): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const prompt = normalizeWhitespace(readTextContent(entry.message.content));
		if (prompt) return prompt;
	}
	return undefined;
}

function getStoredAutoTitle(entries: SessionEntryLike[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== AUTO_TITLE_ENTRY_TYPE) continue;
		const data = entry.data as AutoSessionNameEntry | undefined;
		if (typeof data?.title !== "string") continue;
		const title = normalizeTitle(data.title);
		if (title) return title;
	}
	return undefined;
}

function findTitleModel(ctx: ExtensionContext) {
	const candidates: ModelCandidate[] = [];
	if (ctx.model) {
		candidates.push({ provider: ctx.model.provider, id: ctx.model.id });
	}
	candidates.push(...MODEL_CANDIDATES);

	const seen = new Set<string>();
	for (const candidate of candidates) {
		const key = `${candidate.provider}:${candidate.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const model = ctx.modelRegistry.find(candidate.provider, candidate.id);
		if (model) return model;
	}
	return undefined;
}

function buildTitlePrompt(prompt: string): string {
	return [
		"Create the best session title for this first user prompt.",
		"Target the actual work to be done, not the conversational phrasing.",
		"If the prompt asks for debugging, name the system plus the bug, error, or symptom.",
		"If the prompt asks to build something, name the artifact, feature, or integration being built.",
		"If the prompt asks for explanation or planning, name the topic or decision being explored.",
		"If the prompt asks for a UI or workflow change, name the affected feature or UX area.",
		"Prefer a synthesized noun phrase over a prompt snippet.",
		"Avoid titles that start with My, I, We, Help, Create, Build, Make, Fix, or Update.",
		"Using short abstractions like UX, CI, API, CLI, or Docs is encouraged when accurate.",
		"Good titles often sound like feature names, bug labels, or ticket titles.",
		"",
		"Good vs bad examples:",
		"Prompt: I get this error when I open a markdown file in neovim. Diagnose my configs and versions, I recently updated neovim, this may be some incompatibility issue.",
		"Bad: I Get This Error When",
		"Good: Neovim Markdown Treesitter Error",
		"",
		"Prompt: Create an extension that allows me to run /help and ask a question about pi and pi will inspect its own internal docs then produce an answer.",
		"Bad: Create An Extension That Allows",
		"Good: Pi Help Docs Extension",
		"",
		"Prompt: Help me debug a failing GitHub Actions deploy after upgrading Node.",
		"Bad: Help Me Debug A Failing",
		"Good: GitHub Actions Deploy Failure",
		"",
		"Prompt: Can you help me fix flaky Playwright tests in CI after switching the repo to pnpm?",
		"Bad: Can You Help Me Fix",
		"Good: Playwright CI Flake Debug",
		"",
		"Prompt: Update my pi auto session name generator extension to update the session name in the bottom bar but allow me to see the full prompt given when I type /resume to see past sessions.",
		"Bad: My Pi Auto Session Name Generator",
		"Good: Pi Session Naming UX",
		"",
		"Return only the title.",
		"",
		"<prompt>",
		normalizeWhitespace(prompt).slice(0, MAX_PROMPT_CHARS),
		"</prompt>",
	].join("\n");
}

async function generateTitle(prompt: string, ctx: ExtensionContext): Promise<string | undefined> {
	const fallback = fallbackTitle(prompt);
	const model = findTitleModel(ctx);
	if (!model) return fallback;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return fallback;

	const response = await complete(
		model,
		{
			systemPrompt: TITLE_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: buildTitlePrompt(prompt) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			temperature: 0.4,
			maxTokens: 32,
			reasoningEffort: "low",
		},
	);

	const rawTitle = response.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n");

	const title = normalizeTitle(rawTitle);
	return title && isUsableTitle(title, prompt) ? title : fallback;
}

export default function autoSessionNameExtension(pi: ExtensionAPI) {
	let namingResolved = false;
	let footerTitle: string | undefined;
	let lastCtx: ExtensionContext | undefined;
	let activeSessionId: string | undefined;
	let generationEpoch = 0;

	function getDisplayedTitle(ctx?: ExtensionContext): string | undefined {
		const currentCtx = ctx ?? lastCtx;
		const sessionName = currentCtx?.sessionManager.getSessionName() ?? pi.getSessionName();
		if (sessionName) return sessionName;
		const storedAutoTitle = currentCtx
			? getStoredAutoTitle(currentCtx.sessionManager.getEntries() as SessionEntryLike[])
			: undefined;
		return storedAutoTitle ?? footerTitle;
	}

	function resetSessionState(ctx: ExtensionContext): void {
		activeSessionId = ctx.sessionManager.getSessionId();
		lastCtx = ctx;
		namingResolved = false;
		footerTitle = undefined;
	}

	function refreshDisplay(ctx: ExtensionContext): void {
		lastCtx = ctx;
		if (!ctx.hasUI) return;

		const cwdBase = basename(ctx.cwd || process.cwd());
		const title = getDisplayedTitle(ctx);
		ctx.ui.setTitle(title ? `π - ${title} - ${cwdBase}` : `π - ${cwdBase}`);
	}

	function persistAutoTitle(title: string, prompt: string, ctx: ExtensionContext): void {
		const storedTitle = getStoredAutoTitle(ctx.sessionManager.getEntries() as SessionEntryLike[]);
		if (storedTitle) {
			const normalizedStoredTitle = normalizeTitle(storedTitle);
			const normalizedNextTitle = normalizeTitle(title);
			if (normalizedStoredTitle && normalizedNextTitle && normalizedStoredTitle === normalizedNextTitle) {
				return;
			}
			if (isUsableTitle(storedTitle, prompt)) return;
		}

		pi.appendEntry<AutoSessionNameEntry>(AUTO_TITLE_ENTRY_TYPE, {
			version: 1,
			title,
			prompt,
			generatedAt: new Date().toISOString(),
		});
	}

	async function applyAutoTitle(prompt: string, ctx: ExtensionContext, epoch: number): Promise<void> {
		try {
			const title = await generateTitle(prompt, ctx);
			if (epoch !== generationEpoch || !title) return;
			footerTitle = title;
			persistAutoTitle(title, prompt, ctx);
			refreshDisplay(ctx);
		} catch {
			if (epoch !== generationEpoch) return;
			const title = fallbackTitle(prompt);
			if (!title) return;
			footerTitle = title;
			persistAutoTitle(title, prompt, ctx);
			refreshDisplay(ctx);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		generationEpoch += 1;
		resetSessionState(ctx);

		const branchEntries = ctx.sessionManager.getBranch() as SessionEntryLike[];
		const sessionName = ctx.sessionManager.getSessionName() ?? pi.getSessionName();
		const storedAutoTitle = getStoredAutoTitle(ctx.sessionManager.getEntries() as SessionEntryLike[]);
		const firstPrompt = getFirstUserPrompt(branchEntries);
		const hasUsableStoredAutoTitle = storedAutoTitle
			? firstPrompt
				? isUsableTitle(storedAutoTitle, firstPrompt)
				: true
			: false;

		footerTitle = storedAutoTitle;
		refreshDisplay(ctx);

		if (sessionName || hasUsableStoredAutoTitle) {
			namingResolved = true;
			return;
		}

		if (!hasConversationHistory(branchEntries)) {
			namingResolved = false;
			return;
		}

		namingResolved = true;
		if (!firstPrompt || isCommandLikePrompt(firstPrompt)) return;
		void applyAutoTitle(firstPrompt, ctx, generationEpoch);
	});

	pi.on("input", async (event, ctx) => {
		lastCtx = ctx;
		if (activeSessionId !== ctx.sessionManager.getSessionId()) {
			generationEpoch += 1;
			resetSessionState(ctx);
			refreshDisplay(ctx);
		}
		if (event.source === "extension") return { action: "continue" as const };
		if (namingResolved) return { action: "continue" as const };
		if (ctx.sessionManager.getSessionName() ?? pi.getSessionName()) {
			namingResolved = true;
			refreshDisplay(ctx);
			return { action: "continue" as const };
		}
		if (getStoredAutoTitle(ctx.sessionManager.getEntries() as SessionEntryLike[])) {
			namingResolved = true;
			refreshDisplay(ctx);
			return { action: "continue" as const };
		}

		const branchEntries = ctx.sessionManager.getBranch() as SessionEntryLike[];
		if (hasConversationHistory(branchEntries)) {
			namingResolved = true;
			const firstPrompt = getFirstUserPrompt(branchEntries);
			if (!getDisplayedTitle(ctx) && firstPrompt && !isCommandLikePrompt(firstPrompt)) {
				generationEpoch += 1;
				void applyAutoTitle(firstPrompt, ctx, generationEpoch);
			} else {
				refreshDisplay(ctx);
			}
			return { action: "continue" as const };
		}

		const prompt = normalizeWhitespace(event.text);
		if (!prompt) return { action: "continue" as const };
		if (isCommandLikePrompt(prompt)) {
			return { action: "continue" as const };
		}

		namingResolved = true;
		generationEpoch += 1;
		void applyAutoTitle(prompt, ctx, generationEpoch);

		return { action: "continue" as const };
	});
}
