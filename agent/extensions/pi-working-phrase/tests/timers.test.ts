import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkingStatusController } from "../src/timers";

type FakeContext = {
	hasUI: boolean;
	ui: {
		setWorkingIndicator: ReturnType<typeof vi.fn>;
		setWorkingMessage: ReturnType<typeof vi.fn>;
	};
};

function createContext(hasUI = true): FakeContext {
	return {
		hasUI,
		ui: {
			setWorkingIndicator: vi.fn(),
			setWorkingMessage: vi.fn(),
		},
	};
}

describe("createWorkingStatusController", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("start() sets spinner and first message immediately", () => {
		const controller = createWorkingStatusController();
		const ctx = createContext();

		controller.start(ctx as never);

		expect(ctx.ui.setWorkingIndicator).toHaveBeenCalledWith({
			frames: expect.arrayContaining([expect.stringContaining("⠋")]),
			intervalMs: 80,
		});
		expect(ctx.ui.setWorkingMessage).toHaveBeenCalledWith(expect.stringContaining("\x1b[38;2;"));
	});

	it("start() clears previous timers before creating new timers", () => {
		const controller = createWorkingStatusController();
		const ctx = createContext();

		controller.start(ctx as never);
		controller.start(ctx as never);
		const callCountAfterRestart = ctx.ui.setWorkingMessage.mock.calls.length;

		vi.advanceTimersByTime(60);

		expect(ctx.ui.setWorkingMessage.mock.calls.length).toBe(callCountAfterRestart + 1);
	});

	it("stop() clears timers", () => {
		const controller = createWorkingStatusController();
		const ctx = createContext();

		controller.start(ctx as never);
		controller.stop(ctx as never);
		const callCountAfterStop = ctx.ui.setWorkingMessage.mock.calls.length;

		vi.advanceTimersByTime(8000);

		expect(ctx.ui.setWorkingMessage.mock.calls.length).toBe(callCountAfterStop);
	});

	it("stop(ctx) restores the default working message and indicator", () => {
		const controller = createWorkingStatusController();
		const ctx = createContext();

		controller.start(ctx as never);
		controller.stop(ctx as never);

		expect(ctx.ui.setWorkingMessage).toHaveBeenLastCalledWith();
		expect(ctx.ui.setWorkingIndicator).toHaveBeenLastCalledWith();
	});

	it("start(ctx) does nothing UI-specific when ctx.hasUI is false", () => {
		const controller = createWorkingStatusController();
		const ctx = createContext(false);

		controller.start(ctx as never);

		expect(ctx.ui.setWorkingIndicator).not.toHaveBeenCalled();
		expect(ctx.ui.setWorkingMessage).not.toHaveBeenCalled();
	});
});
