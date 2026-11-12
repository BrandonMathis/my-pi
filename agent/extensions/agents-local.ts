/**
 * agents-local: load AGENTS.local.md context files.
 *
 * Discovers `AGENTS.local.md` in the working directory and every parent
 * directory (mirroring Pi's AGENTS.md discovery) and injects the contents
 * into the system prompt as a custom section. Outermost directories come
 * first, so more specific (deeper) instructions appear later and win.
 *
 * Keep AGENTS.local.md out of version control (e.g. via .gitignore) for
 * machine- or user-local project instructions shared across agent tools.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FILE_NAME = "AGENTS.local.md";
const SECTION_TAG = "local_project_instructions";

function discoverLocalContextFiles(cwd: string): string[] {
  const found: string[] = [];
  let dir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(dir, FILE_NAME);
    try {
      if (fs.statSync(candidate).isFile()) found.push(candidate);
    } catch {
      // not present or unreadable; skip
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found.reverse(); // root-first, cwd last
}

function buildSection(files: string[]): string | undefined {
  const parts: string[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8").trim();
    } catch {
      continue;
    }
    if (!content) continue;
    parts.push(`<local_instructions path="${file}">\n${content}\n</local_instructions>`);
  }
  if (parts.length === 0) return undefined;
  return [
    "Local (untracked) project instructions from AGENTS.local.md files.",
    "Treat them like AGENTS.md instructions; deeper directories take precedence.",
    "",
    ...parts,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const section = buildSection(discoverLocalContextFiles(ctx.cwd));
    if (section) {
      event.systemPromptOptions.sections[SECTION_TAG] = section;
    }
  });

  pi.registerCommand("agents-local", {
    description: "List AGENTS.local.md files loaded for this directory",
    handler: async (_args, ctx) => {
      const files = discoverLocalContextFiles(ctx.cwd);
      if (files.length === 0) {
        ctx.ui.notify(`No ${FILE_NAME} found from ${ctx.cwd} upward`, "info");
      } else {
        ctx.ui.notify(`Loaded ${FILE_NAME} files:\n${files.join("\n")}`, "info");
      }
    },
  });
}
