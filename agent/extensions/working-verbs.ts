import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export const ROTATION_INTERVAL_MS = 8000;
export const APPEND_ELLIPSIS = true;
export const MESSAGE_SUFFIX = "...";

const FIXED_PHRASES_RAW = [
	"Proving P = NP",
	"Computing 6 x 9",
	"Computing 6 x 7",
	"Mining crypto",
	"Dividing by 0",
	"Initialising killbot",
	"Downloading RAM",
  "Hacking the mainframe",
  "Rebooting the matrix",
	"Ordering 1s and 0s",
	"Navigating neural network",
	"Importing machine learning",
	"Creating unresolved tension",
	"Symlinking emacs and vim to ed",
	"Training branch predictor",
	"Timing cache hits",
	"Hacking",
	"Hacking the net",
  "Consulting a higher power",
  "Consulting the dark lord",
  "Consulting sacred texts",
  "Finding deeper understanding",
  "Opening dark portal",
  "Performing arcane ritual",
  "Uncovering ancient secrets",
  "Uncovering forbidden knowledge",
  "Uncovering hidden truths",
  "Uncovering lost wisdom",
  "Uncovering forbidden lore",
  "Uncovering hidden dimensions",
  "Enscribing runes",
  "Calculating airspeed velocity",
	"Gathering entropy",
	"Hacking 127.0.0.1",
	"Breaking AES-256",
	"Recovering original plaintext from SHA-512 hashes",
	"Spicing up passwords with salt and pepper",
	"Peeling onion routes",
	"Wrapping packets",
	"Resurrecting dead code",
	"Using default credentials",
	"Treating all user input as benign",
	"Fixing the world's problems with blockchain",
	"Installing Gentoo",
  "Installing Arch Linux",
  "Installing from source",
	"Reserving disk space for spaces instead of tabs",
	"Initializing bugs",
	"Using hard-coded secrets",
	"Granting highest privileges for simplicity",
	"Hiding keys for backdoor",
	"Stealing user data",
	"Setting up trackers",
	"Dereferencing NULL pointers",
	"Training AI with cat pictures",
	"Scanning port 65536",
	"Deleting system32",
	"Pushing secrets to public git repository",
	"Extinguishing Firewall",
	"Listening on 0.0.0.0",
	"Encrypting with SHA-256",
	"Releasing ransomware into the network",
	"Adjusting bell curves",
	"Aligning covariance matrices",
	"Applying feng shui shaders",
	"Asserting packed exemplars",
	"Attempting to lock back-buffer",
	"Binding sapling root system",
	"Building data trees",
	"Bureacritizing bureaucracies",
	"Calculating inverse probability matrices",
	"Calculating llama expectoration trajectory",
	"Cohorting exemplars",
	"Compounding inert tessellations",
	"Computing optimal bin packing",
	"Concatenating sub-contractors",
	"Containing existential buffer",
	"Debarking ark ramp",
	"Debunching unionized commercial services",
	"Deciding what message to display next",
	"Decomposing singular values",
	"Depixelating inner surface back faces",
	"Depositing slush funds",
	"Destabilizing economic indicators",
	"Determining width of blast fronts",
	"Deunionizing bulldozers",
	"Dicing models",
	"Downloading satellite terrain data",
	"Exposing flash variables to streak system",
	"Extracting resources",
	"Factoring pay scale",
	"Fixing election outcome matrix",
	"Flushing pipe network",
	"Gathering particle sources",
	"Gesticulating mimes",
	"Hiding willio webnet mask",
	"Increasing accuracy of RCI simulators",
	"Increasing magmafacation",
	"Initializing robotic click-path AI",
	"Inserting sublimated messages",
	"Integrating curves",
	"Integrating illumination form factors",
	"Integrating population graphs",
	"Iterating cellular automata",
	"Lecturing errant subsystems",
	"Modeling object components",
	"Mopping occupant leaks",
	"Normalizing power",
	"Obfuscating quigley matrix",
	"Perturbing matrices",
	"Populating lot templates",
	"Preparing sprites for random walks",
	"Realigning alternate time frames",
	"Reconfiguring user mental processes",
	"Removing texture gradients",
	"Resolving GUID conflict",
	"Reticulating splines",
	"Retracting phong shader",
	"Retrieving from back store",
	"Routing neural network infanstructure",
	"Seeding simulation parameters",
	"Sequencing particles",
	"Setting advisor moods",
	"Setting universal physical constants",
	"Sonically enhancing occupant-free timber",
	"Speculating stock market indices",
	"Splatting transforms",
	"Stratifying ground layers",
	"Synthesizing wavelets",
	"Time-compressing simulator clock",
	"Unable to reveal current activity",
	"Rolling dice",
	"Expanding the space-time continuum",
	"Engaging",
	"Electrifying the crystals",
	"Summoning dark forces",
	"Powers the banks",
	"Sorting the bits",
	"Deferring to higher powers",
	"Praying",
	"Sending thoughts and prayers",
	"Unraving the code",
  "Expanding the universe",
  "Reheating logs",
] as const;

function normalizePhrase(phrase: string): string {
	const trimmed = phrase.trim();
	if (!trimmed) return "";
	return trimmed.replace(/\s*\.\.\.\s*$/, "");
}

function formatWorkingMessage(phrase: string): string {
	const base = phrase.trim();
	if (!base) {
		return APPEND_ELLIPSIS ? `Working${MESSAGE_SUFFIX}` : "Working";
	}
	return APPEND_ELLIPSIS ? `${base}${MESSAGE_SUFFIX}` : base;
}

const FIXED_PHRASES = FIXED_PHRASES_RAW.map(normalizePhrase).filter((phrase) => phrase.length > 0);

function shuffledCopy<T>(items: readonly T[]): T[] {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

function createFixedPhraseRotator(phrases: readonly string[]) {
	let queue: string[] = [];
	let currentIndex = 0;
	let lastPhrase: string | undefined;

	function refillQueue(): void {
		if (phrases.length === 0) {
			queue = [];
			currentIndex = 0;
			return;
		}

		queue = shuffledCopy(phrases);
		currentIndex = 0;

		if (lastPhrase && queue.length > 1 && queue[0] === lastPhrase) {
			const swapIndex = queue.findIndex((phrase, index) => index > 0 && phrase !== lastPhrase);
			if (swapIndex > 0) {
				[queue[0], queue[swapIndex]] = [queue[swapIndex], queue[0]];
			}
		}
	}

	return {
		nextMessage(): string {
			if (phrases.length === 0) return formatWorkingMessage("Working");
			if (currentIndex >= queue.length) refillQueue();
			const phrase = queue[currentIndex] ?? "Working";
			currentIndex += 1;
			lastPhrase = phrase;
			return formatWorkingMessage(phrase);
		},
		reset(): void {
			lastPhrase = undefined;
			refillQueue();
		},
	};
}

const phraseRotator = createFixedPhraseRotator(FIXED_PHRASES);

let rotationTimer: ReturnType<typeof setInterval> | undefined;

function stopRotation(ctx?: ExtensionContext): void {
	if (rotationTimer) {
		clearInterval(rotationTimer);
		rotationTimer = undefined;
	}

	if (ctx?.hasUI) {
		ctx.ui.setWorkingMessage();
	}
}

function startRotation(ctx: ExtensionContext): void {
	stopRotation();
	phraseRotator.reset();

	if (!ctx.hasUI) return;

	ctx.ui.setWorkingMessage(phraseRotator.nextMessage());
	rotationTimer = setInterval(() => {
		ctx.ui.setWorkingMessage(phraseRotator.nextMessage());
	}, ROTATION_INTERVAL_MS);
}

export default function workingVerbsExtension(pi: ExtensionAPI) {
	pi.on("agent_start", async (_event, ctx) => {
		startRotation(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopRotation(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopRotation();
	});
}
