const RESET_FG = "\x1b[39m";
const ANSI_RGB_PREFIX = "\x1b[38;2;";
const MAX_COLOR_VALUE = 255;
const SHINE_LIGHTEN_STRENGTHS = [0.42, 0.32, 0.22, 0.12] as const;

type Rgb = {
	r: number;
	g: number;
	b: number;
};

function clampColorValue(value: number): number {
	return Math.max(0, Math.min(MAX_COLOR_VALUE, Math.round(value)));
}

function normalizeHexColor(hexColor: string): string {
	const hex = hexColor.trim().replace(/^#/, "");

	if (/^[0-9a-fA-F]{3}$/.test(hex)) {
		return [...hex].map((character) => `${character}${character}`).join("");
	}

	if (/^[0-9a-fA-F]{6}$/.test(hex)) {
		return hex;
	}

	return "ffffff";
}

function hexToRgb(hexColor: string): Rgb {
	const hex = normalizeHexColor(hexColor);
	return {
		r: Number.parseInt(hex.slice(0, 2), 16),
		g: Number.parseInt(hex.slice(2, 4), 16),
		b: Number.parseInt(hex.slice(4, 6), 16),
	};
}

function rgbToHex({ r, g, b }: Rgb): string {
	return `#${[r, g, b]
		.map((value) => clampColorValue(value).toString(16).padStart(2, "0"))
		.join("")}`;
}

function lighten({ r, g, b }: Rgb, strength: number): Rgb {
	return {
		r: r + (MAX_COLOR_VALUE - r) * strength,
		g: g + (MAX_COLOR_VALUE - g) * strength,
		b: b + (MAX_COLOR_VALUE - b) * strength,
	};
}

function ansiForeground(hexColor: string): string {
	const { r, g, b } = hexToRgb(hexColor);
	return `${ANSI_RGB_PREFIX}${r};${g};${b}m`;
}

export function colorize(text: string, hexColor: string): string {
	return `${ansiForeground(hexColor)}${text}${RESET_FG}`;
}

export function getShineColor(baseColor: string, distance: number): string {
	const strength = SHINE_LIGHTEN_STRENGTHS[Math.max(0, distance)] ?? 0;
	return rgbToHex(lighten(hexToRgb(baseColor), strength));
}
