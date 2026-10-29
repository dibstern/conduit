// State the session's own chrome needs but the transcript owns. Kept in one
// place so the bar and the message list cannot disagree.

import { tick, untrack } from "svelte";
import { classifyDuoPose, type DuoPose } from "../utils/duo-pose.js";

/**
 * 767px is Tailwind's `md` breakpoint minus one, so this agrees with every
 * `md:` utility rather than with the app's older ad-hoc `<= 768` checks.
 */
const COMPACT_QUERY = "(max-width: 767px)";
const RIGHT_PANE_STORAGE_KEY = "files-pane-by-session";
const RIGHT_PANE_MEMORY_LIMIT = 100;
export const RIGHT_PANE_MIN_WIDTH = 280;

export type ComposerTier = "wide" | "narrow" | "thin" | "phone";
export type Pose = "desktop" | "phone" | DuoPose;

/** Unfolded landscape is the Duo's desktop; its other poses are phone-sized. */
const isCompactPose = (pose: Pose): boolean =>
	pose !== "desktop" && pose !== "duo-unfolded-landscape";

const initiallyCompact =
	typeof matchMedia === "function" && matchMedia(COMPACT_QUERY).matches;

export type RightPaneView = "files" | "diff" | "closed";

type RightPaneMemory = { view: RightPaneView; width: number | null };
let rightPaneMemory: Map<string, RightPaneMemory> | undefined;
let activeSessionId: string | null = null;

function storedPaneView(
	entry: Record<string, unknown>,
): RightPaneView | undefined {
	const view = entry["view"];
	if (view === "files" || view === "diff" || view === "closed") return view;
	if (view !== undefined || typeof entry["filesOpen"] !== "boolean")
		return undefined;
	return entry["filesOpen"] ? "files" : "closed";
}

function storedPaneMemory(value: unknown): RightPaneMemory | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const entry = value as Record<string, unknown>;
	const view = storedPaneView(entry);
	if (!view) return undefined;
	const width = entry["width"];
	if (width === null) return { view, width };
	if (
		typeof width !== "number" ||
		!Number.isFinite(width) ||
		width < RIGHT_PANE_MIN_WIDTH
	)
		return undefined;
	return { view, width };
}

function trimPaneMemory(memory: Map<string, RightPaneMemory>): void {
	while (memory.size > RIGHT_PANE_MEMORY_LIMIT)
		memory.delete(memory.keys().next().value ?? "");
}

function loadRightPaneMemory(): Map<string, RightPaneMemory> {
	if (rightPaneMemory) return rightPaneMemory;
	rightPaneMemory = new Map();
	try {
		const raw: unknown = JSON.parse(
			localStorage.getItem(RIGHT_PANE_STORAGE_KEY) ?? "{}",
		);
		if (raw === null || typeof raw !== "object" || Array.isArray(raw))
			return rightPaneMemory;
		for (const [id, value] of Object.entries(raw)) {
			const entry = storedPaneMemory(value);
			if (entry) rightPaneMemory.set(id, entry);
		}
		trimPaneMemory(rightPaneMemory);
	} catch {
		// Storage is optional; malformed data falls back to the defaults.
	}
	return rightPaneMemory;
}

function rememberRightPane(): void {
	if (!activeSessionId || sessionViewState.compact) return;
	const memory = loadRightPaneMemory();
	memory.delete(activeSessionId);
	memory.set(activeSessionId, {
		view: sessionViewState.rightPaneView,
		width: sessionViewState.rightPaneWidth,
	});
	trimPaneMemory(memory);
	try {
		localStorage.setItem(
			RIGHT_PANE_STORAGE_KEY,
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
	/** One pane selection and one preview, shared by desktop and phone. */
	rightPaneView: "closed" as RightPaneView,
	filePreview: null as { path: string; root: string | null } | null,
	rightPaneWidth: null as number | null,
	rightPaneExpanded: false,

	/** Written only by watchViewportPose; every pose-specific layout reads it. */
	pose: (initiallyCompact ? "phone" : "desktop") as Pose,
	/** Phone-sized pose: the session bar replaces the global header. */
	compact: initiallyCompact,
	/** Written only by watchKeyboard; rendered as #layout[data-keyboard="open"]. */
	keyboardOpen: false,

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

/** The folded Duo's header stays put: its controls live in the side rail. */
export function isBarCollapsed(): boolean {
	return (
		sessionViewState.compact &&
		!sessionViewState.barOpen &&
		sessionViewState.pose !== "duo-folded-portrait"
	);
}

/** The folded Duo's goal and task chips fold into its header while reading down or typing. */
export function isDuoChipRowFolded(): boolean {
	return (
		sessionViewState.pose === "duo-folded-portrait" &&
		(!sessionViewState.barOpen || sessionViewState.keyboardOpen)
	);
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
			? loadRightPaneMemory().get(sessionId)
			: undefined;
	sessionViewState.rightPaneView = memory?.view ?? "closed";
	sessionViewState.filePreview = null;
	sessionViewState.rightPaneWidth = memory?.width ?? null;
	sessionViewState.rightPaneExpanded = false;
	if (memory) rememberRightPane();
}

export function setRightPaneView(view: RightPaneView): void {
	sessionViewState.rightPaneView = view;
	if (view === "closed") {
		sessionViewState.rightPaneExpanded = false;
		closeFileViewer();
	}
	rememberRightPane();
}

export function openFileViewer(path: string, root?: string): void {
	setRightPaneView("files");
	sessionViewState.filePreview = { path, root: root ?? null };
}

export function closeFileViewer(): void {
	sessionViewState.filePreview = null;
}

export function setRightPaneWidth(width: number): void {
	if (!Number.isFinite(width)) return;
	sessionViewState.rightPaneWidth = Math.max(
		RIGHT_PANE_MIN_WIDTH,
		Math.round(width),
	);
	rememberRightPane();
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

/** Runs before the keyboard flips and returns what to run once the flip renders. */
type KeyboardHandoff = (open: boolean) => () => void;
const noHandoff: KeyboardHandoff = () => () => {};
let keyboardHandoff = noHandoff;

/** Lets the composer measure its controls on both sides of the flip (FLIP). */
export function setKeyboardHandoff(handoff: KeyboardHandoff): () => void {
	keyboardHandoff = handoff;
	return () => {
		if (keyboardHandoff === handoff) keyboardHandoff = noHandoff;
	};
}

function setKeyboardOpen(open: boolean): void {
	if (open === sessionViewState.keyboardOpen) return;
	const play = keyboardHandoff(open);
	sessionViewState.keyboardOpen = open;
	// tick resolves after the DOM update and before the next paint.
	void tick().then(play);
}

const raisesKeyboard = (target: EventTarget | null) =>
	target instanceof Element && target.matches(":read-write");
// A blur names the field that takes focus next, so moving between fields never
// flickers the keyboard closed.
const followFocus = (event: FocusEvent) =>
	setKeyboardOpen(
		raisesKeyboard(
			event.type === "focusin" ? event.target : event.relatedTarget,
		),
	);

/**
 * Track whether the on-screen keyboard is up. iOS shows it exactly while a
 * field that takes typing has focus, and these devices have no hardware
 * keyboard, so focus on a `:read-write` element is the signal. Not
 * visualViewport heights: they lag the keyboard's slide, and the pose keeps
 * reading the layout viewport. Any field counts, not only the composer: the
 * keyboard covers the same screen whichever field raised it.
 */
export function watchKeyboard(): () => void {
	const reconcile = () =>
		setKeyboardOpen(raisesKeyboard(document.activeElement));
	// Untracked, so the effect that calls this does not re-run on every flip.
	untrack(reconcile);
	document.addEventListener("focusin", followFocus);
	document.addEventListener("focusout", followFocus);
	// Removing the focused field (a rename committing on Return) moves focus to
	// the body without a focusout. Always on: when nothing changed, a batch costs
	// one :read-write match and an early return.
	const removals = new MutationObserver(reconcile);
	removals.observe(document.body, { childList: true, subtree: true });
	return () => {
		document.removeEventListener("focusin", followFocus);
		document.removeEventListener("focusout", followFocus);
		removals.disconnect();
		setKeyboardOpen(false);
	};
}
