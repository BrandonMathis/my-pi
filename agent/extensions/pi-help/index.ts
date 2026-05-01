import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function findPiPackageRoot(startPath?: string) {
	if (!startPath) return undefined;

	let currentDir = dirname(realpathSync(startPath));

	while (true) {
		const packageJsonPath = join(currentDir, "package.json");

		if (existsSync(packageJsonPath)) {
			try {
				const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
				if (packageJson.name === "@mariozechner/pi-coding-agent") return currentDir;
			} catch {
				// Ignore invalid package.json files while walking up.
			}
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return undefined;
		currentDir = parentDir;
	}
}

function resolvePiPackageRoot() {
	try {
		const require = createRequire(import.meta.url);
		return dirname(require.resolve("@mariozechner/pi-coding-agent/package.json"));
	} catch {
		const fromProcess = findPiPackageRoot(process.argv[1]);
		if (fromProcess) return fromProcess;
		throw new Error("Could not locate the installed @mariozechner/pi-coding-agent package.");
	}
}

function buildHelpPrompt(question: string) {
	const packageRoot = resolvePiPackageRoot();
	const readmePath = join(packageRoot, "README.md");
	const docsDir = join(packageRoot, "docs");
	const examplesDir = join(packageRoot, "examples");

	return [
		"You are answering a question about pi itself.",
		"",
		"Before answering:",
		`- Read pi's installed local README first: ${readmePath}`,
		`- Use pi's local docs directory to find the most relevant docs: ${docsDir}`,
		`- Use pi's local examples directory when examples would help: ${examplesDir}`,
		"- Follow markdown cross-references to related docs and examples before answering.",
		"- Do not answer from memory when the docs are available.",
		"- In the final answer, mention which file paths you inspected.",
		"",
		"Helpful topic guide:",
		`- extensions: ${join(docsDir, "extensions.md")}`,
		`- themes: ${join(docsDir, "themes.md")}`,
		`- skills: ${join(docsDir, "skills.md")}`,
		`- prompt templates: ${join(docsDir, "prompt-templates.md")}`,
		`- TUI/components: ${join(docsDir, "tui.md")}`,
		`- keybindings: ${join(docsDir, "keybindings.md")}`,
		`- SDK/integrations: ${join(docsDir, "sdk.md")}`,
		`- custom providers: ${join(docsDir, "custom-provider.md")}`,
		`- adding models: ${join(docsDir, "models.md")}`,
		`- packages: ${join(docsDir, "packages.md")}`,
		"",
		`Question: ${question}`,
	].join("\n");
}

export default function (pi: ExtensionAPI) {

	pi.registerCommand("help", {
		description: "Ask a question about pi and have pi inspect its own docs before answering",
		handler: async (args, ctx) => {
			let question = args.trim();

			if (!question) {
				if (!ctx.hasUI) return;

				const value = await ctx.ui.input("Ask pi a question about pi", "How do I create an extension?");
				question = value?.trim() ?? "";

				if (!question) {
					ctx.ui.notify("Help request cancelled", "info");
					return;
				}
			}

			const message = buildHelpPrompt(question);

			if (ctx.isIdle()) {
				pi.sendUserMessage(message);
				return;
			}

			pi.sendUserMessage(message, { deliverAs: "followUp" });
			ctx.ui.notify("Queued pi help as a follow-up", "info");
		},
	});
}
