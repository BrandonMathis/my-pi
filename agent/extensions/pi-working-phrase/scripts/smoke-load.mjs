import { createJiti } from "@mariozechner/jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: false,
});

const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const extensionFactory = await jiti.import(extensionPath, { default: true });

if (typeof extensionFactory !== "function") {
	throw new TypeError("Expected src/index.ts to default-export an extension factory function.");
}

const handlers = new Map();
const pi = {
	on(eventName, handler) {
		const eventHandlers = handlers.get(eventName) ?? [];
		eventHandlers.push(handler);
		handlers.set(eventName, eventHandlers);
	},
};

extensionFactory(pi);

for (const eventName of ["agent_start", "agent_end", "session_shutdown"]) {
	if (!handlers.has(eventName)) {
		throw new Error(`Expected extension to register ${eventName}.`);
	}
}

const ctx = {
	hasUI: true,
	ui: {
		setWorkingMessage() {},
		setWorkingIndicator() {},
	},
};

for (const handler of handlers.get("agent_start")) {
	await handler({}, ctx);
}
for (const handler of handlers.get("agent_end")) {
	await handler({}, ctx);
}
for (const handler of handlers.get("session_shutdown")) {
	await handler({}, ctx);
}

console.log("Smoke load passed.");
