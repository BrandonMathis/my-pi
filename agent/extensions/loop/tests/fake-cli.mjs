// Disposable CLI double. Never imports Pi or makes a model request.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = args[args.indexOf("--session-dir") + 1];
const prompt = args.at(-1);
writeFileSync(join(dir, `${randomUUID()}.jsonl`), `${JSON.stringify({ type: "session", id: randomUUID(), cwd: process.cwd() })}\n`);
writeFileSync(join(dir, "invocation.json"), JSON.stringify({ args, worker: process.env.PI_LOOP_WORKER, cwd: process.cwd() }));

if (prompt === "hang") {
	setInterval(() => {}, 1_000);
} else if (prompt === "fail") {
	console.error("simulated provider failure");
	process.exitCode = 1;
} else if (prompt === "empty") {
	// Successful command dispatch without a model response must not be treated as success.
} else {
	console.log(prompt === "large" ? "x".repeat(20_000) : "fresh-session result");
}
