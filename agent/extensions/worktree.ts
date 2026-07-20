/**
 * /worktree - Create or switch to a git worktree and rebind pi to it.
 * /worktree-remove - Remove a worktree (and optionally its branch).
 *
 * Create/switch flow:
 *   1. /worktree [branch]  (branch arg optional; otherwise a compact action picker is shown)
 *   2. By default, enter a worktree name to create its branch from the tip of master.
 *      An alternate action lets you explicitly choose another base branch/ref.
 *   3. Worktree is created at <main-repo-root>/.pi/worktrees/<branch>.
 *   4. Choose to keep the current conversation context (session is forked into
 *      the worktree) or start fresh (empty session in the worktree).
 *   5. pi switches sessions; the new session's cwd is the worktree directory,
 *      so all tools/discovery now operate inside the worktree.
 *
 * Remove flow:
 *   1. /worktree-remove [branch]  (or pick "Remove a worktree..." in /worktree)
 *   2. Pick a worktree; dirty worktrees require a force-remove confirmation.
 *   3. If you are currently inside that worktree, the session moves back to the
 *      main repo first (keep or clear context), then the worktree is removed.
 *   4. Optionally delete the branch as well.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

interface WorktreeInfo {
	path: string;
	branch?: string; // short branch name, e.g. "main"
}

/** Context passed to switchSession's withSession callback (not exported from the package root). */
type ReplacedCtx = Parameters<
	NonNullable<NonNullable<Parameters<ExtensionCommandContext["switchSession"]>[1]>["withSession"]>
>[0];

const EXCLUDE_PATTERN = ".pi/worktrees/";
const CREATE_FROM_MASTER = "+ Create new worktree (from master)";
const CREATE_FROM_OTHER = "+ Create new worktree from another branch...";
const REMOVE_WORKTREE = "- Remove a worktree...";
const KEEP_CONTEXT = "Keep conversation context (fork session)";
const CLEAR_CONTEXT = "Start fresh (clear session context)";

/**
 * Context-independent git runner. Safe to call from `withSession` callbacks
 * after a session switch, where the captured extension API may be stale.
 */
function gitSync(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15000 });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			(result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `git ${args.join(" ")} failed`,
		);
	}
	return (result.stdout ?? "").trim();
}

function isInsideDir(path: string, dir: string): boolean {
	const p = resolve(path);
	const d = resolve(dir);
	return p === d || p.startsWith(d + sep);
}

export default function (pi: ExtensionAPI) {
	// Branch cache for /worktree <tab> completion
	let branchCache: string[] = [];
	// Branches of removable (non-main) worktrees, for /worktree-remove completion
	let worktreeCache: string[] = [];

	async function git(cwd: string, args: string[]): Promise<string> {
		const result = await pi.exec("git", args, { cwd, timeout: 15000 });
		if (result.code !== 0) {
			throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
		}
		return result.stdout.trim();
	}

	async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
		try {
			return await git(cwd, args);
		} catch {
			return undefined;
		}
	}

	/** Main repo root (works when invoked from inside another worktree too). */
	async function getMainRepoRoot(cwd: string): Promise<string> {
		const commonDir = await git(cwd, ["rev-parse", "--git-common-dir"]);
		const absCommonDir = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
		return dirname(absCommonDir);
	}

	async function listBranches(cwd: string): Promise<{ local: string[]; remote: string[] }> {
		const localRaw = (await tryGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])) ?? "";
		const remoteRaw = (await tryGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"])) ?? "";
		const local = localRaw.split("\n").filter(Boolean);
		const remote = remoteRaw
			.split("\n")
			.filter(Boolean)
			.filter((r) => !r.endsWith("/HEAD"));
		return { local, remote };
	}

	async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
		const raw = (await tryGit(cwd, ["worktree", "list", "--porcelain"])) ?? "";
		const worktrees: WorktreeInfo[] = [];
		let current: WorktreeInfo | undefined;
		for (const line of raw.split("\n")) {
			if (line.startsWith("worktree ")) {
				current = { path: line.slice("worktree ".length) };
				worktrees.push(current);
			} else if (line.startsWith("branch ") && current) {
				current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
			}
		}
		return worktrees;
	}

	/** Short description of a ref: "a1b2c3d  subject of latest commit". */
	async function describeRef(cwd: string, ref: string): Promise<string | undefined> {
		const raw = await tryGit(cwd, ["log", "-1", "--format=%h  %s", ref]);
		return raw || undefined;
	}

	/** Keep the worktrees dir out of git status without dirtying the repo. */
	async function ensureExcluded(cwd: string): Promise<void> {
		try {
			const commonDir = await git(cwd, ["rev-parse", "--git-common-dir"]);
			const absCommonDir = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
			const infoDir = join(absCommonDir, "info");
			const excludeFile = join(infoDir, "exclude");
			mkdirSync(infoDir, { recursive: true });
			const existing = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
			if (!existing.split("\n").some((l) => l.trim() === EXCLUDE_PATTERN)) {
				writeFileSync(excludeFile, `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}${EXCLUDE_PATTERN}\n`);
			}
		} catch {
			// non-fatal
		}
	}

	function remoteRefToLocalBranch(ref: string): string {
		return ref.replace(/^[^/]+\//, "");
	}

	function remoteRefsForLocalBranch(remote: string[], branch: string): string[] {
		return remote.filter((ref) => remoteRefToLocalBranch(ref) === branch);
	}

	function buildBranchCache(local: string[], remote: string[]): string[] {
		const remoteLocalNames = remote
			.map(remoteRefToLocalBranch)
			.filter((branch) => !local.includes(branch));
		return [...new Set([...local, ...remoteLocalNames, ...remote])];
	}

	function sanitizeBranchForPath(branch: string): string {
		return branch.replace(/[^A-Za-z0-9._-]+/g, "-");
	}

	/** Create a session file bound to `targetDir`, then switch pi to it. */
	async function switchPiToDir(
		ctx: ExtensionCommandContext,
		targetDir: string,
		keepContext: boolean,
		afterSwitch?: (newCtx: ReplacedCtx) => Promise<void>,
	): Promise<void> {
		const currentSessionFile = ctx.sessionManager.getSessionFile();
		let targetSessionFile: string;

		if (keepContext && currentSessionFile && existsSync(currentSessionFile)) {
			// Fork the full session history into a new session whose cwd is the target dir
			const forked = SessionManager.forkFrom(currentSessionFile, targetDir);
			const file = forked.getSessionFile();
			if (!file) throw new Error("Failed to fork session");
			targetSessionFile = file;
		} else {
			// Fresh, empty session bound to the target dir
			const fresh = SessionManager.create(targetDir);
			const file = fresh.getSessionFile();
			const header = fresh.getHeader();
			if (!file || !header) throw new Error("Failed to create session");
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: "wx" });
			targetSessionFile = file;
		}

		const result = await ctx.switchSession(targetSessionFile, {
			withSession: async (newCtx) => {
				newCtx.ui.notify(`Now working in: ${targetDir}`, "info");
				await afterSwitch?.(newCtx);
			},
		});
		if (result.cancelled) {
			ctx.ui.notify("Session switch was cancelled by another extension", "warning");
		}
	}

	/**
	 * Remove a worktree (context-independent core). Returns a status message.
	 * Caller is responsible for confirmations and for not being inside the worktree.
	 */
	function removeWorktreeNow(mainRoot: string, worktreePath: string, force: boolean): string {
		gitSync(mainRoot, ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath]);
		gitSync(mainRoot, ["worktree", "prune"]);
		return `Removed worktree: ${worktreePath}`;
	}

	/** Shared /worktree-remove flow (also reachable from the /worktree picker). */
	async function removeWorktreeFlow(ctx: ExtensionCommandContext, arg?: string): Promise<void> {
		const inRepo = await tryGit(ctx.cwd, ["rev-parse", "--is-inside-work-tree"]);
		if (inRepo !== "true") {
			ctx.ui.notify("Not inside a git repository", "error");
			return;
		}

		const mainRoot = await getMainRepoRoot(ctx.cwd);
		const removable = (await listWorktrees(ctx.cwd)).filter(
			(wt) => resolve(wt.path) !== resolve(mainRoot),
		);
		worktreeCache = removable.map((wt) => wt.branch).filter((b): b is string => !!b);

		if (removable.length === 0) {
			ctx.ui.notify("No worktrees to remove", "info");
			return;
		}

		// --- Pick the worktree ---
		let target: WorktreeInfo | undefined;
		if (arg?.trim()) {
			const needle = arg.trim();
			target = removable.find(
				(wt) => wt.branch === needle || resolve(wt.path) === resolve(needle),
			);
			if (!target) {
				ctx.ui.notify(`No worktree found for '${needle}'`, "error");
				return;
			}
		} else {
			const optionToWt = new Map<string, WorktreeInfo>();
			for (const wt of removable) {
				const dirty = ((await tryGit(wt.path, ["status", "--porcelain"])) ?? "") !== "";
				const markers = [
					isInsideDir(ctx.cwd, wt.path) ? "current" : undefined,
					dirty ? "dirty" : undefined,
				].filter(Boolean);
				const suffix = markers.length > 0 ? `  [${markers.join(", ")}]` : "";
				optionToWt.set(`${wt.branch ?? "(detached)"} — ${wt.path}${suffix}`, wt);
			}
			const selected = await ctx.ui.select("Remove which worktree?", [...optionToWt.keys()]);
			if (!selected) return;
			target = optionToWt.get(selected);
			if (!target) return;
		}

		const targetPath = target.path;
		const targetBranch = target.branch;

		// --- Dirty check ---
		const dirtyStatus = (await tryGit(targetPath, ["status", "--porcelain"])) ?? "";
		const isDirty = dirtyStatus !== "";
		const confirmed = await ctx.ui.confirm(
			"Remove worktree?",
			`${targetBranch ? `Branch: ${targetBranch}\n` : ""}Path: ${targetPath}` +
				(isDirty
					? `\n\nWARNING: this worktree has uncommitted changes that will be LOST:\n${dirtyStatus
							.split("\n")
							.slice(0, 10)
							.join("\n")}`
					: ""),
		);
		if (!confirmed) return;

		const insideTarget = isInsideDir(ctx.cwd, targetPath);

		if (insideTarget) {
			// Must move the session out of the worktree before deleting it.
			const contextChoice = await ctx.ui.select(
				`You are inside this worktree. Move back to ${mainRoot} with:`,
				[KEEP_CONTEXT, CLEAR_CONTEXT],
			);
			if (!contextChoice) return;

			await ctx.waitForIdle();
			await switchPiToDir(ctx, mainRoot, contextChoice === KEEP_CONTEXT, async (newCtx) => {
				// Old extension context is stale here; use gitSync + newCtx only.
				try {
					newCtx.ui.notify(removeWorktreeNow(mainRoot, targetPath, isDirty), "info");
				} catch (err) {
					newCtx.ui.notify(
						`Failed to remove worktree: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
					return;
				}
				if (targetBranch) {
					const deleteBranch = await newCtx.ui.confirm(
						"Delete branch too?",
						`Also delete branch '${targetBranch}'? (git branch -D)`,
					);
					if (deleteBranch) {
						try {
							gitSync(mainRoot, ["branch", "-D", targetBranch]);
							newCtx.ui.notify(`Deleted branch '${targetBranch}'`, "info");
						} catch (err) {
							newCtx.ui.notify(
								`Failed to delete branch: ${err instanceof Error ? err.message : String(err)}`,
								"error",
							);
						}
					}
				}
			});
			return;
		}

		// Not inside the worktree: remove directly.
		try {
			ctx.ui.notify(removeWorktreeNow(mainRoot, targetPath, isDirty), "info");
		} catch (err) {
			ctx.ui.notify(
				`Failed to remove worktree: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			return;
		}
		worktreeCache = worktreeCache.filter((b) => b !== targetBranch);

		if (targetBranch) {
			const deleteBranch = await ctx.ui.confirm(
				"Delete branch too?",
				`Also delete branch '${targetBranch}'? (git branch -D)`,
			);
			if (deleteBranch) {
				try {
					gitSync(mainRoot, ["branch", "-D", targetBranch]);
					ctx.ui.notify(`Deleted branch '${targetBranch}'`, "info");
				} catch (err) {
					ctx.ui.notify(
						`Failed to delete branch: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
				}
			}
		}
	}

	pi.registerCommand("worktree", {
		description: "Create/switch to a git worktree (in .pi/worktrees) and work there",
		getArgumentCompletions: (prefix: string) => {
			const items = branchCache
				.filter((b) => b.startsWith(prefix))
				.map((b) => ({ value: b, label: b }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/worktree requires an interactive UI", "error");
				return;
			}

			// --- Validate git repo ---
			const inRepo = await tryGit(ctx.cwd, ["rev-parse", "--is-inside-work-tree"]);
			if (inRepo !== "true") {
				ctx.ui.notify("Not inside a git repository", "error");
				return;
			}

			const mainRoot = await getMainRepoRoot(ctx.cwd);
			const worktreesBase = join(mainRoot, ".pi", "worktrees");
			const { local, remote } = await listBranches(ctx.cwd);
			const worktrees = await listWorktrees(ctx.cwd);
			branchCache = buildBranchCache(local, remote);

			const checkedOut = new Map<string, string>(); // branch -> worktree path
			for (const wt of worktrees) {
				if (wt.branch) checkedOut.set(wt.branch, wt.path);
			}

			// --- Pick an action without dumping every local and remote branch into the default UI ---
			let choice = args?.trim() || undefined;
			let creationBase: "master" | "choose" | undefined;
			if (!choice) {
				const existingWorktreeOptions = new Map<string, string>();
				for (const wt of worktrees) {
					if (!wt.branch || resolve(wt.path) === resolve(mainRoot)) continue;
					existingWorktreeOptions.set(`${wt.branch}  (worktree exists)`, wt.branch);
				}

				const selected = await ctx.ui.select("Worktree:", [
					CREATE_FROM_MASTER,
					CREATE_FROM_OTHER,
					...existingWorktreeOptions.keys(),
					REMOVE_WORKTREE,
				]);
				if (!selected) return; // cancelled
				if (selected === REMOVE_WORKTREE) {
					await removeWorktreeFlow(ctx);
					return;
				}

				if (selected === CREATE_FROM_MASTER || selected === CREATE_FROM_OTHER) {
					creationBase = selected === CREATE_FROM_MASTER ? "master" : "choose";
					const name = await ctx.ui.input("New worktree name:", "feature/my-worktree");
					if (!name?.trim()) return;
					choice = name.trim();
				} else {
					choice = existingWorktreeOptions.get(selected);
					if (!choice) return;
				}
			}

			// --- Resolve branch / create new ---
			let branch: string;
			let createArgs: string[] | undefined; // extra args for `git worktree add`
			let baseDescription: string | undefined; // e.g. "master — a1b2c3d  fix: ..."

			if (local.includes(choice)) {
				branch = choice;
				if (creationBase) {
					ctx.ui.notify(`Branch '${branch}' already exists; using it`, "info");
				}
			} else if (creationBase) {
				branch = choice;
				let baseRef: string | undefined;

				if (creationBase === "master") {
					const remoteMasters = remoteRefsForLocalBranch(remote, "master");
					baseRef = local.includes("master")
						? "master"
						: remoteMasters.includes("origin/master")
							? "origin/master"
							: remoteMasters.length === 1
								? remoteMasters[0]
								: undefined;
					if (!baseRef) {
						ctx.ui.notify(
							"No unambiguous master branch was found. Choose 'Create new worktree from another branch...' instead.",
							"error",
						);
						return;
					}
					const detail = await describeRef(ctx.cwd, baseRef);
					baseDescription = detail ? `${baseRef} — ${detail}` : baseRef;
				} else {
					const optionToRef = new Map<string, string>();
					for (const ref of [...local, ...remote]) {
						const detail = await describeRef(ctx.cwd, ref);
						optionToRef.set(detail ? `${ref} — ${detail}` : ref, ref);
					}
					const selectedBase = await ctx.ui.select(
						`Base '${branch}' on which branch/ref?`,
						[...optionToRef.keys()],
					);
					if (!selectedBase) return;
					baseRef = optionToRef.get(selectedBase);
					if (!baseRef) return;
					baseDescription = selectedBase;
				}

				createArgs = ["-b", branch, baseRef];
			} else if (remote.includes(choice)) {
				// Fully-qualified remote branch, e.g. origin/feature/foo.
				branch = remoteRefToLocalBranch(choice);
				if (!local.includes(branch)) {
					createArgs = ["-b", branch, "--track", choice];
					const detail = await describeRef(ctx.cwd, choice);
					baseDescription = detail ? `${choice} — ${detail}` : choice;
				}
			} else {
				// Unqualified remote branch, e.g. /worktree feature/foo when only origin/feature/foo exists.
				const matchingRemoteRefs = remoteRefsForLocalBranch(remote, choice);
				if (matchingRemoteRefs.length === 1) {
					branch = choice;
					const remoteRef = matchingRemoteRefs[0];
					createArgs = ["-b", branch, "--track", remoteRef];
					const detail = await describeRef(ctx.cwd, remoteRef);
					baseDescription = detail ? `${remoteRef} — ${detail}` : remoteRef;
				} else if (matchingRemoteRefs.length > 1) {
					ctx.ui.notify(
						`Ambiguous remote branch '${choice}'; use one of: ${matchingRemoteRefs.join(", ")}`,
						"error",
					);
					return;
				} else {
					ctx.ui.notify(`Unknown branch: ${choice}`, "error");
					return;
				}
			}

			// --- Determine worktree path ---
			const existingWtPath = checkedOut.get(branch);
			let worktreePath: string;

			if (existingWtPath && resolve(existingWtPath) === resolve(mainRoot)) {
				ctx.ui.notify(`'${branch}' is checked out in the main working tree (${mainRoot})`, "error");
				return;
			}

			if (existingWtPath) {
				// Branch already has a worktree somewhere; just switch to it
				worktreePath = existingWtPath;
				ctx.ui.notify(`Using existing worktree for '${branch}'`, "info");
			} else {
				worktreePath = join(worktreesBase, sanitizeBranchForPath(branch));
				if (existsSync(worktreePath)) {
					ctx.ui.notify(`Path exists but is not a worktree for '${branch}': ${worktreePath}`, "error");
					return;
				}
				mkdirSync(worktreesBase, { recursive: true });
				await ensureExcluded(ctx.cwd);

				ctx.ui.setStatus("worktree", `Creating worktree for ${branch}...`);
				try {
					const addArgs = createArgs
						? ["worktree", "add", worktreePath, ...createArgs]
						: ["worktree", "add", worktreePath, branch];
					await git(ctx.cwd, addArgs);
				} catch (err) {
					ctx.ui.notify(`git worktree add failed: ${err instanceof Error ? err.message : String(err)}`, "error");
					return;
				} finally {
					ctx.ui.setStatus("worktree", undefined);
				}
				ctx.ui.notify(
					baseDescription
						? `Created worktree at ${worktreePath}\nNew branch '${branch}' based on: ${baseDescription}`
						: `Created worktree at ${worktreePath}`,
					"info",
				);
			}

			if (resolve(ctx.cwd) === resolve(worktreePath)) {
				ctx.ui.notify("Already working in this worktree", "info");
				return;
			}

			// --- Keep or clear context ---
			const contextChoice = await ctx.ui.select("Session context for the worktree:", [
				KEEP_CONTEXT,
				CLEAR_CONTEXT,
			]);
			if (!contextChoice) return; // cancelled

			// --- Switch ---
			await ctx.waitForIdle();
			try {
				await switchPiToDir(ctx, worktreePath, contextChoice === KEEP_CONTEXT);
			} catch (err) {
				ctx.ui.notify(`Failed to switch session: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("worktree-remove", {
		description: "Remove a git worktree (and optionally its branch)",
		getArgumentCompletions: (prefix: string) => {
			const items = worktreeCache
				.filter((b) => b.startsWith(prefix))
				.map((b) => ({ value: b, label: b }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/worktree-remove requires an interactive UI", "error");
				return;
			}
			await removeWorktreeFlow(ctx, args);
		},
	});

	// Warm the branch + worktree caches for autocompletion
	pi.on("session_start", async (_event, ctx) => {
		try {
			const { local, remote } = await listBranches(ctx.cwd);
			branchCache = buildBranchCache(local, remote);
			const mainRoot = await getMainRepoRoot(ctx.cwd);
			worktreeCache = (await listWorktrees(ctx.cwd))
				.filter((wt) => resolve(wt.path) !== resolve(mainRoot))
				.map((wt) => wt.branch)
				.filter((b): b is string => !!b);
		} catch {
			branchCache = [];
			worktreeCache = [];
		}
	});
}
