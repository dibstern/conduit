// State the session's own chrome needs but the transcript owns. Kept in one
// place so the bar and the message list cannot disagree.

import { classifyDuoPose, type DuoPose } from "../utils/duo-pose.js";

/**
 * 767px is Tailwind's `md` breakpoint minus one, so this agrees with every
 * `md:` utility rather than with the app's older ad-hoc `<= 768` checks.
 */
const COMPACT_QUERY = "(max-width: 767px)";
const FILES_PANE_STORAGE_KEY = "files-pane-by-session";
const FILES_PANE_MEMORY_LIMIT = 100;
export const FILES_PANE_MIN_WIDTH = 280;

export type ComposerTier = "wide" | "narrow" | "thin" | "phone";
export type Pose = "desktop" | "phone" | DuoPose;

/** Unfolded landscape is the Duo's desktop; its other poses are phone-sized. */
const isCompactPose = (pose: Pose): boolean =>
	pose !== "desktop" && pose !== "duo-unfolded-landscape";

const initiallyCompact =
	typeof matchMedia === "function" && matchMedia(COMPACT_QUERY).matches;

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

	/** The phone bar follows the reading direction: open after a scroll up into
	 *  history, closed to the island after a scroll down or on reaching the
	 *  bottom. Starts true so a fresh load arrives with the full bar on screen. */
	barOpen: true,
	/** Files view, rendered as an overlay on phones and a pane on desktop. */
	filesOpen: false,
	filesEverOpened: false,
	filesPaneWidth: null as number | null,
	filesPaneExpanded: false,

	/** Written only by watchViewportPose; every pose-specific layout reads it. */
	pose: (initiallyCompact ? "phone" : "desktop") as Pose,
	/** Phone-sized pose: the session bar replaces the global header. */
	compact: initiallyCompact,

	/** Measured only by the composer's input wrapper. */
	composerWidth: 0,
	get composerTier(): ComposerTier {
		return composerTier;
	},
});

// A composerWidth of 0 is unmeasured, so it keeps the fuller narrow controls.
const composerTier = $derived<ComposerTier>(
	sessionViewState.compact
		? "phone"
		: sessionViewState.composerWidth >= 600
			? "wide"
			: sessionViewState.composerWidth > 0 &&
					sessionViewState.composerWidth < 390
				? "thin"
				: "narrow",
);

export function isBarCollapsed(): boolean {
	return sessionViewState.compact && !sessionViewState.barOpen;
}

/**
 * The only path by which `atBottom` is written from outside the store. It exists
 * because the false->true edge closes the bar (jump-to-latest is not a scroll
 * gesture), and an edge cannot be observed by a plain assignment at the call site.
 *
 * The edge is read off a private non-reactive copy, not off `atBottom` itself:
 * the caller is a Svelte `$effect`, and reading the same state it writes would
 * make that effect re-run itself once on every publish.
 */
let lastAtBottom = true;
export function publishAtBottom(next: boolean): void {
	if (next && !lastAtBottom) sessionViewState.barOpen = false;
	lastAtBottom = next;
	sessionViewState.atBottom = next;
}

export function requestTranscriptFollow(): void {
	sessionViewState.followRequest++;
}

/** The chevron. Expands the bar without moving the transcript. */
export function forceBarOpen(): void {
	sessionViewState.barOpen = true;
}

export function noteScrollGesture(direction: "up" | "down"): void {
	sessionViewState.barOpen = direction === "up";
}

/** Arrive at a new session with the full bar open, whatever the last one did. */
export function noteSessionChanged(sessionId: string | null = null): void {
	sessionViewState.barOpen = true;
	// The new session's pin to the bottom is not a rising edge to close on.
	lastAtBottom = true;
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
 * Track the pose, and the compact flag that follows from it. One listener for
 * the whole app: call it from the layout and dispose with the returned teardown.
 * It reads the layout viewport, never the visual one, so the keyboard cannot
 * change the pose.
 */
export function watchViewportPose(): () => void {
	if (typeof matchMedia !== "function") return () => {};
	const compactQuery = matchMedia(COMPACT_QUERY);
	const standaloneQuery = matchMedia("(display-mode: standalone)");
	// The pose's only view of the safe-area insets: padding resolves each env().
	const probe = document.createElement("div");
	probe.setAttribute("aria-hidden", "true");
	probe.style.cssText =
		"position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;" +
		"padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
	document.body.append(probe);
	const measure = () => {
		const style = getComputedStyle(probe);
		const pose: Pose =
			classifyDuoPose({
				width: innerWidth,
				height: innerHeight,
				standalone:
					standaloneQuery.matches ||
					(navigator as Navigator & { standalone?: boolean }).standalone ===
						true,
				insets: {
					top: Number.parseFloat(style.paddingTop) || 0,
					right: Number.parseFloat(style.paddingRight) || 0,
					bottom: Number.parseFloat(style.paddingBottom) || 0,
					left: Number.parseFloat(style.paddingLeft) || 0,
				},
			}) ?? (compactQuery.matches ? "phone" : "desktop");
		sessionViewState.pose = pose;
		sessionViewState.compact = isCompactPose(pose);
	};
	measure();
	// Insets can change without a resize, e.g. env() resolving after first paint.
	// Padding moves only the border box; the default content box never changes.
	const insetObserver = new ResizeObserver(measure);
	insetObserver.observe(probe, { box: "border-box" });
	addEventListener("resize", measure);
	addEventListener("orientationchange", measure);
	return () => {
		insetObserver.disconnect();
		removeEventListener("resize", measure);
		removeEventListener("orientationchange", measure);
		probe.remove();
	};
}
