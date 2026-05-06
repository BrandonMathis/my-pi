import { colorize, getShineColor } from "./colors";

type ShinePhase = "forward" | "pause-after-forward" | "reverse" | "pause-after-reverse";

type ShineAnimatorOptions = {
	baseColor: string;
	frameMs: number;
	pauseMs: number;
	trailRadius: number;
	step: number;
};

function getCharacters(message: string): string[] {
	return [...message];
}

function getBounds(message: string, trailRadius: number): { min: number; max: number } {
	const lastCharacterIndex = Math.max(0, getCharacters(message).length - 1);
	return {
		min: -trailRadius,
		max: lastCharacterIndex + trailRadius,
	};
}

export function createShineAnimator(options: ShineAnimatorOptions): {
	reset(message: string): void;
	advance(message: string): void;
	render(message: string): string;
} {
	const frameMs = Math.max(1, options.frameMs);
	const pauseFrames = Math.max(1, Math.ceil(Math.max(0, options.pauseMs) / frameMs));
	const trailRadius = Math.max(0, Math.floor(options.trailRadius));
	const step = Math.max(1, Math.floor(options.step));

	let phase: ShinePhase = "forward";
	let position = -trailRadius;
	let pauseFrame = 0;

	function reset(message: string): void {
		const { min } = getBounds(message, trailRadius);
		phase = "forward";
		position = min;
		pauseFrame = 0;
	}

	function currentPeak(): number | undefined {
		return phase === "forward" || phase === "reverse" ? position : undefined;
	}

	return {
		reset,
		advance(message: string): void {
			const { min, max } = getBounds(message, trailRadius);

			switch (phase) {
				case "forward":
					position += step;
					if (position > max) {
						phase = "pause-after-forward";
						pauseFrame = 0;
					}
					break;
				case "pause-after-forward":
					pauseFrame += 1;
					if (pauseFrame >= pauseFrames) {
						phase = "reverse";
						position = max;
					}
					break;
				case "reverse":
					position -= step;
					if (position < min) {
						phase = "pause-after-reverse";
						pauseFrame = 0;
					}
					break;
				case "pause-after-reverse":
					pauseFrame += 1;
					if (pauseFrame >= pauseFrames) {
						phase = "forward";
						position = min;
					}
					break;
			}
		},
		render(message: string): string {
			const peak = currentPeak();
			return getCharacters(message)
				.map((character, index) => {
					if (character === " ") return character;

					const distance = peak === undefined ? Number.POSITIVE_INFINITY : Math.abs(index - peak);
					const color = distance <= trailRadius ? getShineColor(options.baseColor, distance) : options.baseColor;
					return colorize(character, color);
				})
				.join("");
		},
	};
}
