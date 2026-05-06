import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { colorize } from "./colors";
import { config } from "./config";
import { workingPhrases } from "./phrases";
import { createPhraseRotator } from "./phrases-rotator";
import { createShineAnimator } from "./shine";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function intervalMs(value: number): number {
	return Math.max(1, Math.floor(value));
}

function applySpinnerColor(ctx: ExtensionContext): void {
	ctx.ui.setWorkingIndicator({
		frames: SPINNER_FRAMES.map((frame) => colorize(frame, config.spinnerColor)),
		intervalMs: intervalMs(config.spinnerFrameMs),
	});
}

export function createWorkingStatusController(): {
	start(ctx: ExtensionContext): void;
	stop(ctx?: ExtensionContext): void;
} {
	const phraseRotator = createPhraseRotator(workingPhrases, {
		appendEllipsis: config.appendEllipsis,
		suffix: config.messageSuffix,
	});
	const shineAnimator = createShineAnimator({
		baseColor: config.baseColor,
		frameMs: config.shineFrameMs,
		pauseMs: config.shinePauseMs,
		trailRadius: config.shineTrailRadius,
		step: config.shineStep,
	});

	let phraseTimer: ReturnType<typeof setInterval> | undefined;
	let shineTimer: ReturnType<typeof setInterval> | undefined;
	let currentMessage = "";

	function clearTimers(): void {
		if (phraseTimer) {
			clearInterval(phraseTimer);
			phraseTimer = undefined;
		}
		if (shineTimer) {
			clearInterval(shineTimer);
			shineTimer = undefined;
		}
	}

	function render(ctx: ExtensionContext): void {
		ctx.ui.setWorkingMessage(shineAnimator.render(currentMessage));
	}

	function stop(ctx?: ExtensionContext): void {
		clearTimers();

		if (ctx?.hasUI) {
			ctx.ui.setWorkingMessage();
			ctx.ui.setWorkingIndicator();
		}
	}

	return {
		start(ctx: ExtensionContext): void {
			stop(ctx);
			phraseRotator.reset();

			if (!ctx.hasUI) return;

			applySpinnerColor(ctx);
			currentMessage = phraseRotator.nextMessage();
			shineAnimator.reset(currentMessage);
			render(ctx);

			shineTimer = setInterval(() => {
				shineAnimator.advance(currentMessage);
				render(ctx);
			}, intervalMs(config.shineFrameMs));

			phraseTimer = setInterval(() => {
				currentMessage = phraseRotator.nextMessage();
				shineAnimator.reset(currentMessage);
				render(ctx);
			}, intervalMs(config.phrasesShuffleMs));
		},
		stop,
	};
}
