import { describe, expect, it } from "vitest";
import { createShineAnimator } from "../src/shine";

function createAnimator() {
	return createShineAnimator({
		baseColor: "#9776c7",
		frameMs: 60,
		pauseMs: 120,
		trailRadius: 2,
		step: 1,
	});
}

describe("createShineAnimator", () => {
	it("renders ANSI-colored output", () => {
		const animator = createAnimator();
		animator.reset("Hello");

		const output = animator.render("Hello");

		expect(output).toContain("\x1b[38;2;");
		expect(output).toContain("H");
		expect(output).toContain("\x1b[39m");
	});

	it("preserves spaces", () => {
		const animator = createAnimator();
		animator.reset("A B");

		const output = animator.render("A B");

		expect(output).toContain("A\x1b[39m \x1b[38;2;");
	});

	it("handles empty messages", () => {
		const animator = createAnimator();
		animator.reset("");

		expect(animator.render("")).toBe("");
		expect(() => animator.advance("")).not.toThrow();
	});

	it("advances forward and reverse without throwing", () => {
		const animator = createAnimator();
		animator.reset("Hello");

		for (let index = 0; index < 40; index += 1) {
			expect(() => animator.advance("Hello")).not.toThrow();
		}
	});

	it("resets cleanly when the message changes", () => {
		const animator = createAnimator();
		animator.reset("First");
		animator.advance("First");
		animator.reset("Second");

		expect(animator.render("Second")).toContain("S");
	});
});
