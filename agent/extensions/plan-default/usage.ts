export type Availability = {
	status: "available" | "exhausted" | "unknown" | "unavailable";
	available: boolean;
	summary: string;
};
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as RecordValue : undefined;
}

function percentage(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
		? value : undefined;
}

function windowsResult(windows: Array<[string, number]>, minimum: number): Availability {
	if (windows.length === 0) return { status: "unknown", available: false, summary: "usage unknown" };
	const available = windows.every(([, used]) => 100 - used > minimum);
	return {
		status: available ? "available" : "exhausted",
		available,
		summary: windows.map(([label, used]) => `${label}: ${Math.round((100 - used) * 10) / 10}% left`).join(", "),
	};
}

export function codexAvailability(data: unknown, modelId: string, minimum = 0): Availability {
	const payload = record(data);
	const limits: Array<[string, RecordValue | undefined]> = [["Codex", record(payload?.rate_limit)]];
	// Extra limits can belong to unrelated models (e.g. Spark). Only use a
	// model-specific limit when its advertised name actually matches this model.
	if (Array.isArray(payload?.additional_rate_limits)) {
		for (const item of payload.additional_rate_limits) {
			const entry = record(item);
			const names = [entry?.limit_name, entry?.metered_feature].filter((v): v is string => typeof v === "string");
			if (names.some((name) => name.toLowerCase() === modelId.toLowerCase())) {
				limits.push([modelId, record(entry?.rate_limit)]);
			}
		}
	}
	const windows: Array<[string, number]> = [];
	for (const [label, limit] of limits) {
		if (!limit) return { status: "unknown", available: false, summary: "usage unknown" };
		if (limit.allowed === false || limit.limit_reached === true) {
			return { status: "exhausted", available: false, summary: `${label}: usage limit reached` };
		}
		for (const key of ["primary_window", "secondary_window"]) {
			if (limit[key] == null) continue;
			const window = record(limit[key]);
			const used = percentage(window?.used_percent);
			if (used === undefined) return { status: "unknown", available: false, summary: "usage unknown" };
			const seconds = window?.limit_window_seconds;
			const period = typeof seconds === "number" && seconds > 0 ? `${seconds / 3600}h` : key;
			windows.push([`${label} ${period}`, used]);
		}
	}
	return windowsResult(windows, minimum);
}

export function anthropicAvailability(data: unknown, modelId: string, minimum = 0): Availability {
	const payload = record(data);
	const family = /^claude-([a-z]+)/i.exec(modelId)?.[1]?.toLowerCase();
	const keys = ["five_hour", "seven_day", "seven_day_oauth_apps"];
	if (family) keys.push(`seven_day_${family}`);
	const windows: Array<[string, number]> = [];
	for (const key of keys) {
		if (payload?.[key] == null) continue; // null is an inapplicable/unlimited window.
		const used = percentage(record(payload[key])?.utilization);
		if (used === undefined) return { status: "unknown", available: false, summary: "usage unknown" };
		windows.push([key, used]);
	}
	// Extra-usage billing is deliberately not counted as subscription capacity.
	return windowsResult(windows, minimum);
}

export function codexAccountId(token: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" && id ? id : undefined;
	} catch {
		return undefined;
	}
}

export function hasExplicitModel(args: string[]): boolean {
	return args.some((arg) => arg === "--model" || arg === "--provider" || arg === "-m"
		|| arg.startsWith("--model=") || arg.startsWith("--provider=") || /^-m[^-]/.test(arg));
}
