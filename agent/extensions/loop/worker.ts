import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";

export const RUN_TIMEOUT_MS = 10 * 60_000;

/** Use the published executable, which may be bundled rather than dist/cli.js. */
export function resolveCliPath(packageDir: string): string {
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
	if (typeof entry !== "string") throw new Error("Cannot locate Pi's executable in its package manifest.");
	return resolve(packageDir, entry);
}

export interface RunOptions {
	cwd: string;
	runDir: string;
	cliPath: string;
	prompt: string;
	name: string;
	provider: string;
	model: string;
	thinking: string;
	trusted: boolean;
	signal: AbortSignal;
	timeoutMs?: number;
	killGraceMs?: number;
}

export function buildArgs(options: RunOptions): string[] {
	return [
		options.cliPath, "--print", "--session-dir", options.runDir,
		"--name", options.name, "--provider", options.provider, "--model", options.model,
		"--thinking", options.thinking, options.trusted ? "--approve" : "--no-approve",
		"--", options.prompt,
	];
}

async function tail(path: string, maxBytes: number): Promise<string> {
	const file = await open(path, "r");
	try {
		const { size } = await file.stat();
		const length = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(length);
		await file.read(buffer, 0, length, size - length);
		return `${size > maxBytes ? "[truncated; full output in run directory]\n" : ""}${buffer.toString("utf8").trim()}`;
	} finally {
		await file.close();
	}
}

/** Fresh CLI invocation, with no --continue, --resume, --fork, or parent history. */
export async function runFreshSession(options: RunOptions): Promise<{ output: string; runDir: string }> {
	options.signal.throwIfAborted();
	await mkdir(options.runDir, { recursive: true, mode: 0o700 });
	const stdoutPath = join(options.runDir, "stdout.txt");
	const stderrPath = join(options.runDir, "stderr.txt");
	const stdout = await open(stdoutPath, "w", 0o600);
	let stderr;
	try {
		stderr = await open(stderrPath, "w", 0o600);
		options.signal.throwIfAborted();
		const child = spawn(process.execPath, buildArgs(options), {
			cwd: options.cwd,
			env: { ...process.env, PI_LOOP_WORKER: "1" },
			stdio: ["ignore", stdout.fd, stderr.fd],
			// Own process group lets stop/timeout terminate tool subprocesses on Unix too.
			detached: process.platform !== "win32",
		});
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let terminating = false;
		let timedOut = false;
		const kill = (signal: NodeJS.Signals) => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		};
		const terminate = () => {
			if (terminating) return;
			terminating = true;
			kill("SIGTERM");
			killTimer = setTimeout(() => kill("SIGKILL"), options.killGraceMs ?? 2_000);
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			terminate();
		}, options.timeoutMs ?? RUN_TIMEOUT_MS);
		options.signal.addEventListener("abort", terminate, { once: true });
		try {
			const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code, signal) => resolve({ code, signal }));
			});
			if (options.signal.aborted) terminate();
			const result = await closed;
			if (terminating && process.platform !== "win32") {
				// The CLI may exit on TERM before one of its tool subprocesses does.
				kill("SIGKILL");
			}
			options.signal.throwIfAborted();
			if (timedOut) throw new Error(`Run timed out after ${(options.timeoutMs ?? RUN_TIMEOUT_MS) / 1_000}s.`);
			if (result.code !== 0) {
				const diagnostic = await tail(stderrPath, 2_000);
				throw new Error(`Pi exited with ${result.signal ?? result.code}. ${diagnostic}`.trim());
			}
			const output = await tail(stdoutPath, 4_000);
			if (!output) throw new Error("Pi produced no final response. Inspect the run logs.");
			return { output, runDir: options.runDir };
		} finally {
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			options.signal.removeEventListener("abort", terminate);
		}
	} finally {
		await stdout.close();
		await stderr?.close();
	}
}
