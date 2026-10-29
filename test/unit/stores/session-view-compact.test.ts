// @vitest-environment jsdom
// The compact breakpoint decides whether the session bar replaces the global
// header, so getting it wrong loses either the chrome or the way out of a
// session. These tests pin the query string, the initial read, live changes,
// and the teardown — the listener outliving the layout would keep writing to a
// store nobody is rendering. Duo poses are covered by duo-pose.test.ts and the
// duo-pose acceptance feature.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const matchMediaState = vi.hoisted(() => {
	let matches = false;
	const query = {
		get matches() {
			return matches;
		},
		media: "",
		onchange: null,
	};

	return {
		matchMedia: vi.fn(() => query as unknown as MediaQueryList),
		/** Crossing the breakpoint resizes the window, which the pose follows. */
		setMatches(next: boolean) {
			matches = next;
			window.dispatchEvent(new Event("resize"));
		},
		reset() {
			matches = false;
		},
	};
});

vi.hoisted(() => {
	Object.defineProperty(globalThis, "matchMedia", {
		value: matchMediaState.matchMedia,
		configurable: true,
	});
});

const {
	forceBarOpen,
	isBarCollapsed,
	isDuoChipRowFolded,
	noteScrollGesture,
	noteSessionChanged,
	publishAtBottom,
	sessionViewState,
	watchViewportPose,
} = await import("../../../src/lib/frontend/stores/session-view.svelte.js");
const { closePanel, openPanel, terminalState } = await import(
	"../../../src/lib/frontend/stores/terminal.svelte.js"
);

beforeEach(() => {
	matchMediaState.reset();
	sessionViewState.compact = false;
	publishAtBottom(true);
	noteSessionChanged();
	closePanel();
	sessionViewState.filePreview = null;
	vi.clearAllMocks();
});

describe("session bar collapse", () => {
	beforeEach(() => {
		sessionViewState.compact = true;
	});

	it("arrives expanded, then follows the scroll gesture anywhere in the transcript", () => {
		publishAtBottom(false);
		expect(isBarCollapsed()).toBe(false);
		noteScrollGesture("down");
		expect(isBarCollapsed()).toBe(true);
		noteScrollGesture("up");
		expect(isBarCollapsed()).toBe(false);
	});

	it("desktop never collapses", () => {
		noteScrollGesture("down");
		sessionViewState.compact = false;
		expect(isBarCollapsed()).toBe(false);
	});

	it("reaching the bottom without a gesture collapses it", () => {
		publishAtBottom(false);
		publishAtBottom(true);
		expect(isBarCollapsed()).toBe(true);
	});

	it("staying at the bottom or leaving it does not change it", () => {
		publishAtBottom(true);
		expect(isBarCollapsed()).toBe(false);
		noteScrollGesture("down");
		publishAtBottom(false);
		expect(isBarCollapsed()).toBe(true);
	});

	it("the chevron expands it until the next downward gesture", () => {
		noteScrollGesture("down");
		forceBarOpen();
		expect(isBarCollapsed()).toBe(false);
		expect(sessionViewState.atBottom).toBe(true);
		noteScrollGesture("down");
		expect(isBarCollapsed()).toBe(true);
	});

	it("a session switch arrives expanded, even from a session scrolled up", () => {
		noteScrollGesture("down");
		publishAtBottom(false);
		noteSessionChanged();
		publishAtBottom(true);
		expect(isBarCollapsed()).toBe(false);
	});
});

describe("folded Duo chip row", () => {
	beforeEach(() => {
		sessionViewState.compact = true;
		sessionViewState.pose = "duo-folded-portrait";
		sessionViewState.keyboardOpen = false;
	});
	afterEach(() => {
		sessionViewState.pose = "desktop";
		sessionViewState.keyboardOpen = false;
	});

	it("folds on a downward gesture and unfolds on an upward one", () => {
		expect(isDuoChipRowFolded()).toBe(false);
		noteScrollGesture("down");
		expect(isDuoChipRowFolded()).toBe(true);
		noteScrollGesture("up");
		expect(isDuoChipRowFolded()).toBe(false);
	});

	it("folds while the keyboard is open, even after an upward gesture", () => {
		noteScrollGesture("up");
		sessionViewState.keyboardOpen = true;
		expect(isDuoChipRowFolded()).toBe(true);
		sessionViewState.keyboardOpen = false;
		expect(isDuoChipRowFolded()).toBe(false);
	});

	it("never folds outside the folded portrait", () => {
		noteScrollGesture("down");
		sessionViewState.keyboardOpen = true;
		sessionViewState.pose = "phone";
		expect(isDuoChipRowFolded()).toBe(false);
	});
});

describe("watchViewportPose", () => {
	it("agrees with Tailwind's md breakpoint", () => {
		watchViewportPose()();

		// 767px, not 768: an ad-hoc `<= 768` check disagrees with every `md:`
		// utility by exactly one pixel, which is how a phone layout leaks onto a
		// tablet-width viewport.
		expect(matchMediaState.matchMedia).toHaveBeenCalledWith(
			"(max-width: 767px)",
		);
	});

	it("adopts the current viewport immediately rather than waiting for a change", () => {
		matchMediaState.setMatches(true);

		const stop = watchViewportPose();

		expect(sessionViewState.compact).toBe(true);
		stop();
	});

	it("follows the viewport across the breakpoint in both directions", () => {
		const stop = watchViewportPose();
		expect(sessionViewState.compact).toBe(false);

		matchMediaState.setMatches(true);
		expect(sessionViewState.compact).toBe(true);

		matchMediaState.setMatches(false);
		expect(sessionViewState.compact).toBe(false);

		stop();
	});

	it("keeps open views and the file preview across the breakpoint", () => {
		const stop = watchViewportPose();
		sessionViewState.rightPaneView = "files";
		openPanel();
		sessionViewState.filePreview = { path: "src/index.ts", root: null };
		matchMediaState.setMatches(true);
		matchMediaState.setMatches(false);
		expect(sessionViewState.rightPaneView).toBe("files");
		expect(terminalState.panelOpen).toBe(true);
		expect(sessionViewState.filePreview?.path).toBe("src/index.ts");
		stop();
	});

	it("stops listening once torn down", () => {
		const stop = watchViewportPose();
		stop();

		expect(document.body.childElementCount).toBe(0);

		matchMediaState.setMatches(true);
		expect(sessionViewState.compact).toBe(false);
	});
});
