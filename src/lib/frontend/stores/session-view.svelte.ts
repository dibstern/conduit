// State the session's own chrome needs but the transcript owns. Kept in one
// place so the bar and the message list cannot disagree.

/**
 * 767px is Tailwind's `md` breakpoint minus one, so this agrees with every
 * `md:` utility rather than with the app's older ad-hoc `<= 768` checks.
 */
const COMPACT_QUERY = "(max-width: 767px)";
const FILES_PANE_STORAGE_KEY = "files-pane-by-session";
const FILES_PANE_MEMORY_LIMIT = 100;
export const FILES_PANE_MIN_WIDTH = 280;

type FilesPaneMemory = { filesOpen: boolean; width: number | null };
let filesPaneMemory: Map<string, FilesPaneMemory> | undefined;
let activeSessionId: string | null = null;

function loadFilesPaneMemory(): Map<string, FilesPaneMemory> {
	if (filesPaneMemory) return filesPaneMemory;
	filesPaneMemory = new Map();
	try {
		const raw: unknown = JSON.parse(
			localStorage.getItem(FILES_PANE_STORAGE_KEY) ?? "{}",
		);
		if (raw === null || typeof raw !== "object" || Array.isArray(raw))
			return filesPaneMemory;
		for (const [id, value] of Object.entries(raw)) {
			if (!value || typeof value !== "object" || Array.isArray(value)) continue;
			const entry = value as Record<string, unknown>;
			const filesOpen = entry["filesOpen"];
			const width = entry["width"];
			if (typeof filesOpen !== "boolean") continue;
			if (
				width !== null &&
				(typeof width !== "number" ||
					!Number.isFinite(width) ||
					width < FILES_PANE_MIN_WIDTH)
			)
				continue;
			filesPaneMemory.set(id, { filesOpen, width });
		}
		while (filesPaneMemory.size > FILES_PANE_MEMORY_LIMIT)
			filesPaneMemory.delete(filesPaneMemory.keys().next().value ?? "");
	} catch {
		// Storage is optional; malformed data falls back to the defaults.
	}
	return filesPaneMemory;
}

function rememberFilesPane(): void {
	if (!activeSessionId || sessionViewState.compact) return;
	const memory = loadFilesPaneMemory();
	memory.delete(activeSessionId);
	memory.set(activeSessionId, {
		filesOpen: sessionViewState.filesOpen,
		width: sessionViewState.filesPaneWidth,
	});
	if (memory.size > FILES_PANE_MEMORY_LIMIT)
		memory.delete(memory.keys().next().value ?? "");
	try {
		localStorage.setItem(
			FILES_PANE_STORAGE_KEY,
			JSON.stringify(Object.fromEntries(memory)),
		);
	} catch {
		// Keep the in-memory preference if storage is unavailable.
	}
}

export const sessionViewState = $state({
	/** Published by MessageList from its scroll controller. Loading
	 *  counts as at-bottom while the transcript is hydrating. */
	atBottom: true,
	/** Composer requests; MessageList owns following and scroll placement. */
	followRequest: 0,

	/** The chevron's override: the bar stays expanded even at the bottom. Starts
	 *  true so a fresh load arrives with the full bar on screen. */
	forcedOpen: true,
	/** Files view, rendered as an overlay on phones and a pane on desktop. */
	filesOpen: false,
	filesEverOpened: false,
	filesPaneWidth: null as number | null,
	filesPaneExpanded: false,

	/** Phone-width viewport: the session bar replaces the global header. */
	compact:
		typeof matchMedia === "function"
			? matchMedia(COMPACT_QUERY).matches
			: false,
});

/**
 * The collapse rule, derived rather than stored so the bar and the transcript
 * cannot disagree about it. `forcedOpen` is its only mutable input.
 */
export function isBarCollapsed(): boolean {
	return (
		sessionViewState.compact &&
		sessionViewState.atBottom &&
		!sessionViewState.forcedOpen
	);
}

/**
 * The only path by which `atBottom` is written from outside the store. It exists
 * because the false->true edge is what clears the force, and an edge cannot be
 * observed by a plain assignment at the call site.
 *
 * The edge is read off a private non-reactive copy, not off `atBottom` itself:
 * the caller is a Svelte `$effect`, and reading the same state it writes would
 * make that effect re-run itself once on every publish.
 */
let lastAtBottom = true;
export function publishAtBottom(next: boolean): void {
	if (next && !lastAtBottom) sessionViewState.forcedOpen = false;
	lastAtBottom = next;
	sessionViewState.atBottom = next;
}

export function requestTranscriptFollow(): void {
	sessionViewState.followRequest++;
}

/** The chevron. Expands the bar without moving the transcript. */
export function forceBarOpen(): void {
	sessionViewState.forcedOpen = true;
}

// A scroll-up smaller than the controller's 50px detach threshold never flips
// atBottom. Without this, a small nudge could leave a forced-open bar stuck open
// indefinitely, because there is no rising edge to clear the force.
export function noteUserScroll(): void {
	sessionViewState.forcedOpen = false;
}

/** Arrive at a new session with the full bar open, whatever the last one did. */
export function noteSessionChanged(sessionId: string | null = null): void {
	sessionViewState.forcedOpen = true;
	activeSessionId = sessionId;
	const memory =
		sessionId && !sessionViewState.compact
			? loadFilesPaneMemory().get(sessionId)
			: undefined;
	sessionViewState.filesOpen = memory?.filesOpen ?? false;
	sessionViewState.filesEverOpened = memory?.filesOpen ?? false;
	sessionViewState.filesPaneWidth = memory?.width ?? null;
	sessionViewState.filesPaneExpanded = false;
	if (memory) rememberFilesPane();
}

export function setFilesOpen(open: boolean): void {
	sessionViewState.filesOpen = open;
	if (!open) sessionViewState.filesPaneExpanded = false;
	rememberFilesPane();
}

export function setFilesPaneWidth(width: number): void {
	if (!Number.isFinite(width)) return;
	sessionViewState.filesPaneWidth = Math.max(
		FILES_PANE_MIN_WIDTH,
		Math.round(width),
	);
	rememberFilesPane();
}

/**
 * Track the compact breakpoint. One listener for the whole app — call it from
 * the layout and dispose with the returned teardown.
 */
export function watchCompactViewport(): () => void {
	if (typeof matchMedia !== "function") return () => {};
	const query = matchMedia(COMPACT_QUERY);
	sessionViewState.compact = query.matches;
	const onChange = (event: MediaQueryListEvent) => {
		sessionViewState.compact = event.matches;
	};
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}
