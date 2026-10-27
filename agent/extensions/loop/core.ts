export const DEFAULT_INTERVAL_MS = 5 * 60_000;
export const MAX_INTERVAL_MS = 7 * 24 * 60 * 60_000;

export function parseInterval(value: string): number {
	const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/i.exec(value);
	if (!match) throw new Error("Use an interval such as 30s, 5m, 2h, or 1d.");
	const units: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
	const ms = Number(match[1]) * units[match[2].toLowerCase()];
	if (!Number.isSafeInteger(ms) || ms < 1_000 || ms > MAX_INTERVAL_MS) {
		throw new Error("Interval must be between 1 second and 7 days, in whole milliseconds.");
	}
	return ms;
}

export function formatInterval(ms: number): string {
	for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1_000]] as const) {
		if (ms % size === 0) return `${ms / size}${unit}`;
	}
	return `${ms / 1_000}s`;
}

export type LoopCommand =
	| { type: "help" | "status" | "stop" }
	| { type: "default"; intervalMs?: number }
	| { type: "start"; task: string; intervalMs: number };

export function parseCommand(args: string, defaultIntervalMs = DEFAULT_INTERVAL_MS): LoopCommand {
	const input = args.trim();
	if (!input || input === "help") return { type: "help" };
	if (input === "status" || input === "stop") return { type: input };
	if (input === "default") return { type: "default" };
	if (input.startsWith("default ")) {
		return { type: "default", intervalMs: parseInterval(input.slice(8).trim()) };
	}
	// -- forces task-only parsing, including tasks named "stop" or starting with numbers.
	if (input.startsWith("-- ")) {
		const task = input.slice(3).trim();
		if (!task) throw new Error("Provide a task after --.");
		return { type: "start", task, intervalMs: defaultIntervalMs };
	}
	const [first] = input.split(/\s+/, 1);
	if (/^[\d.+-]/.test(first)) {
		const intervalMs = parseInterval(first);
		const task = input.slice(first.length).trim();
		if (!task) throw new Error("Provide a task after the interval.");
		return { type: "start", task, intervalMs };
	}
	return { type: "start", task: input, intervalMs: defaultIntervalMs };
}

export interface LoopState {
	task: string;
	intervalMs: number;
	nextRunAt: number | null;
	runs: number;
	running: boolean;
	lastError?: string;
}

export interface Clock {
	now(): number;
	setTimeout(callback: () => void, delay: number): unknown;
	clearTimeout(timer: unknown): void;
}

const systemClock: Clock = {
	now: () => Date.now(),
	setTimeout: (callback, delay) => {
		const timer = setTimeout(callback, delay);
		timer.unref();
		return timer;
	},
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** One loop per owning Pi session. Delays are measured from completion, not start. */
export class LoopScheduler {
	private state?: LoopState;
	private timer?: unknown;
	private controller?: AbortController;
	private pending?: Promise<void>;

	constructor(private readonly options: {
		canRun: () => boolean;
		run: (iteration: number, signal: AbortSignal) => Promise<void>;
		onChange: (state: LoopState | undefined) => void;
		clock?: Clock;
	}) {}

	get snapshot(): LoopState | undefined {
		return this.state ? { ...this.state } : undefined;
	}

	get isActive(): boolean { return Boolean(this.state || this.pending); }

	private get clock(): Clock { return this.options.clock ?? systemClock; }

	start(task: string, intervalMs: number): void {
		if (this.isActive) throw new Error("A loop is already active. Use /loop stop first.");
		if (!task.trim() || !Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > MAX_INTERVAL_MS) {
			throw new Error("Invalid task or interval.");
		}
		this.state = { task, intervalMs, nextRunAt: this.clock.now() + intervalMs, runs: 0, running: false };
		this.schedule(intervalMs);
		this.options.onChange(this.snapshot);
	}

	private schedule(delay: number): void {
		this.timer = this.clock.setTimeout(() => {
			this.timer = undefined;
			if (!this.state) return;
			if (!this.options.canRun()) {
				this.schedule(1_000); // Coalesce missed runs while the parent is busy.
				return;
			}
			this.pending = this.execute();
		}, delay);
	}

	private async execute(): Promise<void> {
		// Let the timer callback store pending before even a synchronous run can finish.
		await Promise.resolve();
		const state = this.state;
		if (!state) {
			this.pending = undefined;
			return;
		}
		const controller = new AbortController();
		this.controller = controller;
		state.running = true;
		state.nextRunAt = null;
		state.runs++;
		try {
			this.options.onChange(this.snapshot);
			await this.options.run(state.runs, controller.signal);
			state.lastError = undefined;
		} catch (error) {
			state.lastError = error instanceof Error ? error.message : String(error);
		} finally {
			this.controller = undefined;
			// The promise is cleared before scheduling another turn, including after cancellation.
			this.pending = undefined;
			if (this.state === state) {
				state.running = false;
				state.nextRunAt = this.clock.now() + state.intervalMs;
				this.schedule(state.intervalMs);
				this.options.onChange(this.snapshot);
			}
		}
	}

	async stop(): Promise<void> {
		this.state = undefined;
		if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
		this.timer = undefined;
		this.controller?.abort();
		await this.pending;
		this.options.onChange(undefined);
	}
}
