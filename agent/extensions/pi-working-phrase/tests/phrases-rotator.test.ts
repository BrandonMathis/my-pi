import { afterEach, describe, expect, it, vi } from "vitest";
import { createPhraseRotator } from "../src/phrases-rotator";

describe("createPhraseRotator", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("trims phrases, removes empty values, and appends the configured suffix", () => {
		const rotator = createPhraseRotator(["  Reticulating splines  ", "", "   "], {
			appendEllipsis: true,
			suffix: "...",
		});

		expect(rotator.nextMessage()).toBe("Reticulating splines...");
	});

	it("removes trailing ASCII and Unicode ellipses before formatting", () => {
		const ascii = createPhraseRotator(["Working..."], { appendEllipsis: true, suffix: "..." });
		const unicode = createPhraseRotator(["Thinking…"], { appendEllipsis: true, suffix: "..." });

		expect(ascii.nextMessage()).toBe("Working...");
		expect(unicode.nextMessage()).toBe("Thinking...");
	});

	it("can disable suffix appending", () => {
		const rotator = createPhraseRotator(["Working..."], { appendEllipsis: false, suffix: "..." });

		expect(rotator.nextMessage()).toBe("Working");
	});

	it("handles an empty phrase list with a Working fallback", () => {
		const rotator = createPhraseRotator(["", "   "], { appendEllipsis: true, suffix: "..." });

		expect(rotator.nextMessage()).toBe("Working...");
	});

	it("avoids immediate repeats when more than one phrase is available", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		const rotator = createPhraseRotator(["A", "B"], { appendEllipsis: false, suffix: "..." });

		const messages = [rotator.nextMessage(), rotator.nextMessage(), rotator.nextMessage(), rotator.nextMessage()];

		expect(messages).toEqual(["A", "B", "A", "B"]);
		for (let index = 1; index < messages.length; index += 1) {
			expect(messages[index]).not.toBe(messages[index - 1]);
		}
	});
});
