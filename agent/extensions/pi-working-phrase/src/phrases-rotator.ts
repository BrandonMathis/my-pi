type PhraseRotatorOptions = {
	appendEllipsis: boolean;
	suffix: string;
};

function normalizePhrase(phrase: string): string {
	return phrase.trim().replace(/\s*(?:\.\.\.|…)\s*$/, "");
}

function formatMessage(phrase: string, options: PhraseRotatorOptions): string {
	const base = phrase.trim() || "Working";
	return options.appendEllipsis ? `${base}${options.suffix}` : base;
}

function shuffledCopy<T>(items: readonly T[]): T[] {
	const copy = [...items];
	for (let index = copy.length - 1; index > 0; index -= 1) {
		const swapIndex = Math.floor(Math.random() * (index + 1));
		[copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
	}
	return copy;
}

export function createPhraseRotator(
	phrases: readonly string[],
	options: PhraseRotatorOptions,
): {
	nextMessage(): string;
	reset(): void;
} {
	const normalizedPhrases = phrases.map(normalizePhrase).filter((phrase) => phrase.length > 0);
	let queue: string[] = [];
	let currentIndex = 0;
	let lastPhrase: string | undefined;

	function refillQueue(): void {
		queue = shuffledCopy(normalizedPhrases);
		currentIndex = 0;

		if (!lastPhrase || queue.length <= 1 || queue[0] !== lastPhrase) return;

		const swapIndex = queue.findIndex((phrase, index) => index > 0 && phrase !== lastPhrase);
		if (swapIndex > 0) {
			[queue[0], queue[swapIndex]] = [queue[swapIndex], queue[0]];
		}
	}

	function nextPhrase(): string {
		if (normalizedPhrases.length === 0) return "Working";
		if (currentIndex >= queue.length) refillQueue();

		const phrase = queue[currentIndex] ?? "Working";
		currentIndex += 1;
		lastPhrase = phrase;
		return phrase;
	}

	return {
		nextMessage(): string {
			return formatMessage(nextPhrase(), options);
		},
		reset(): void {
			lastPhrase = undefined;
			refillQueue();
		},
	};
}
