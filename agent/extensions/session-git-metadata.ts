/**
 * Session git metadata extension.
 *
 * Captures the current git branch and HEAD SHA once per persisted pi session,
 * stores that metadata as a custom session entry, and provides a command to
 * export the current conversation branch using the saved git metadata.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type SessionGitMetadata = {
	branch: string | null;
	sha: string | null;
	worktree: string | null;
	capturedAt: string;
	cwd: string;
};

type SessionEntryLike = {
	type: string;
	id?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role: string;
		content?: unknown;
		toolName?: string;
		toolCallId?: string;
		details?: unknown;
		isError?: boolean;
		command?: string;
		output?: string;
		exitCode?: number;
		summary?: string;
		customType?: string;
		display?: boolean;
	};
	summary?: string;
	fromId?: string;
	label?: string;
	targetId?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	timestamp?: string;
	content?: unknown;
	display?: boolean;
};

const CUSTOM_TYPE = "session-git-metadata";
const DEFAULT_EXPORT_DIR = ".pi/exports";
const EXPORT_COMMAND = "export-branch-conversation";

/**
 * Returns the latest metadata entry already stored for this session, if any.
 */
function getExistingMetadata(entries: SessionEntryLike[]): SessionGitMetadata | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		return entry.data as SessionGitMetadata | undefined;
	}
	return undefined;
}

/**
 * Runs a git command and returns trimmed stdout, or undefined on failure.
 */
async function getGitOutput(
	pi: ExtensionAPI,
	args: string[],
	signal?: AbortSignal,
): Promise<string | undefined> {
	const result = await pi.exec("git", args, { signal, timeout: 5_000 });
	if (result.code !== 0) return undefined;
	const value = result.stdout.trim();
	return value.length > 0 ? value : undefined;
}

/**
 * Detects the current git branch, HEAD SHA, and worktree path for the session working tree.
 */
async function readGitMetadata(
	pi: ExtensionAPI,
	cwd: string,
	signal?: AbortSignal,
): Promise<SessionGitMetadata | undefined> {
	const isInsideWorkTree = await getGitOutput(pi, ["rev-parse", "--is-inside-work-tree"], signal);
	if (isInsideWorkTree !== "true") return undefined;

	const sha = await getGitOutput(pi, ["rev-parse", "HEAD"], signal);
	const branch =
		(await getGitOutput(pi, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal)) ??
		(await getGitOutput(pi, ["branch", "--show-current"], signal)) ??
		"(detached HEAD)";
	const gitDir = await getGitOutput(pi, ["rev-parse", "--git-dir"], signal);
	const commonDir = await getGitOutput(pi, ["rev-parse", "--git-common-dir"], signal);
	const worktree = gitDir && commonDir && gitDir !== commonDir ? cwd : null;

	if (!sha) return undefined;

	return {
		branch,
		sha,
		worktree,
		capturedAt: new Date().toISOString(),
		cwd,
	};
}

/**
 * Converts a branch name into a filesystem-safe filename segment.
 */
function sanitizeFileSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/**
 * Returns text from a session content payload.
 */
function renderContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			const block = item as Record<string, unknown>;
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "thinking" && typeof block.thinking === "string") {
				return `[thinking]\n${block.thinking}`;
			}
			if (block.type === "toolCall") {
				const name = typeof block.name === "string" ? block.name : "unknown";
				const args = JSON.stringify(block.arguments ?? {}, null, 2);
				return `Tool call: ${name}\n\n\`\`\`json\n${args}\n\`\`\``;
			}
			if (block.type === "image") return "[image omitted]";
			return "";
		})
		.filter((value) => value.length > 0)
		.join("\n\n");
}

/**
 * Renders one session entry into markdown for export.
 */
function renderEntry(entry: SessionEntryLike): string | undefined {
	if (entry.type === "message" && entry.message) {
		const { message } = entry;
		if (message.role === "user") {
			return `## User\n\n${renderContent(message.content).trim() || "[no text content]"}`;
		}
		if (message.role === "assistant") {
			return `## Assistant\n\n${renderContent(message.content).trim() || "[no text content]"}`;
		}
		if (message.role === "toolResult") {
			const body = renderContent(message.content).trim() || "[no text content]";
			const status = message.isError ? "error" : "ok";
			return `## Tool Result: ${message.toolName ?? "unknown"} (${status})\n\n${body}`;
		}
		if (message.role === "bashExecution") {
			const command = typeof message.command === "string" ? message.command : "";
			const output = typeof message.output === "string" ? message.output : "";
			const exitCode = typeof message.exitCode === "number" ? message.exitCode : "unknown";
			return `## Bash Execution\n\n### Command\n\n\`\`\`bash\n${command}\n\`\`\`\n\n### Output\n\n\`\`\`text\n${output}\n\`\`\`\n\nExit code: ${exitCode}`;
		}
		if (message.role === "custom" && message.customType !== CUSTOM_TYPE && message.display !== false) {
			return `## Custom: ${message.customType ?? "unknown"}\n\n${renderContent(message.content).trim() || "[no text content]"}`;
		}
		return undefined;
	}

	if (entry.type === "custom_message" && entry.customType !== CUSTOM_TYPE && entry.display !== false) {
		const content = renderContent(entry.content).trim() || "[no text content]";
		return `## Custom: ${entry.customType ?? "unknown"}\n\n${content}`;
	}

	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		return `## Branch Summary\n\n${entry.summary}`;
	}

	if (entry.type === "compaction" && typeof entry.summary === "string") {
		return `## Compaction Summary\n\n${entry.summary}`;
	}

	if (entry.type === "model_change") {
		return `## Model Change\n\n${entry.provider ?? "unknown"}/${entry.modelId ?? "unknown"}`;
	}

	if (entry.type === "thinking_level_change") {
		return `## Thinking Level Change\n\n${entry.thinkingLevel ?? "unknown"}`;
	}

	if (entry.type === "label") {
		return `## Label\n\n${entry.label ?? "[cleared]"}`;
	}

	return undefined;
}

/**
 * Builds markdown for the current session branch plus saved git metadata.
 */
function buildMarkdownExport(metadata: SessionGitMetadata, entries: SessionEntryLike[]): string {
	const headerLines = [
		"# Pi Conversation Export",
		"",
		`- branch: ${metadata.branch ?? "unknown"}`,
		`- sha: ${metadata.sha ?? "unknown"}`,
		`- worktree: ${metadata.worktree ?? "none"}`,
		`- capturedAt: ${metadata.capturedAt}`,
		`- cwd: ${metadata.cwd}`,
		"",
		"---",
		"",
	];

	const body = entries
		.map((entry) => renderEntry(entry))
		.filter((section): section is string => Boolean(section))
		.join("\n\n---\n\n");

	return `${headerLines.join("\n")}${body}`.trimEnd() + "\n";
}

/**
 * Resolves the destination path for a conversation export.
 */
function resolveExportPath(cwd: string, branch: string | null, rawArgs: string): string {
	const trimmedArgs = rawArgs.trim();
	if (trimmedArgs.length > 0) return resolve(cwd, trimmedArgs);

	const branchSegment = sanitizeFileSegment(branch ?? "unknown-branch");
	const timestampSegment = new Date().toISOString().replace(/[:.]/g, "-");
	return resolve(cwd, DEFAULT_EXPORT_DIR, `${branchSegment}-${timestampSegment}.md`);
}

export default function sessionGitMetadataExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;

		const existing = getExistingMetadata(ctx.sessionManager.getEntries() as SessionEntryLike[]);
		if (existing) return;

		const metadata = await readGitMetadata(pi, ctx.cwd, ctx.signal);
		if (!metadata) return;

		pi.appendEntry(CUSTOM_TYPE, metadata);
	});

	pi.registerCommand(EXPORT_COMMAND, {
		description: "Export the current session branch conversation as markdown for the saved git branch",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const entries = ctx.sessionManager.getEntries() as SessionEntryLike[];
			const metadata = getExistingMetadata(entries);
			if (!metadata) {
				ctx.ui.notify("No saved git session metadata found for this session", "error");
				return;
			}

			const branchEntries = ctx.sessionManager.getBranch() as SessionEntryLike[];
			const markdown = buildMarkdownExport(metadata, branchEntries);
			const outputPath = resolveExportPath(ctx.cwd, metadata.branch, args);

			await mkdir(dirname(outputPath), { recursive: true });
			await writeFile(outputPath, markdown, "utf8");

			ctx.ui.notify(`Exported branch conversation to ${outputPath}`, "success");
		},
	});
}
