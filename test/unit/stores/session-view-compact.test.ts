// @vitest-environment jsdom
// The compact breakpoint decides whether the session bar replaces the global
// header, so getting it wrong loses either the chrome or the way out of a
// session. These tests pin the query string, the initial read, live changes,
// and the teardown — the listener outliving the layout would keep writing to a
// store nobody is rendering. Duo poses are covered by duo-pose.test.ts and the
// duo-pose acceptance feature.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
	noteScrollGesture,
	noteSessionChanged,
	publishAtBottom,
	sessionViewState,
	watchViewportPose,
} = await import("../../../src/lib/frontend/stores/session-view.svelte.js");
const { closePanel, openPanel, terminalState } = await import(
	"../../../src/lib/frontend/stores/terminal.svelte.js"
);
const { uiState } = await import(
	"../../../src/lib/frontend/stores/ui.svelte.js"
);

beforeEach(() => {
	matchMediaState.reset();
	sessionViewState.compact = false;
	publishAtBottom(true);
	noteSessionChanged();
	closePanel();
	uiState.fileViewerOpen = false;
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
		sessionViewState.filesOpen = true;
		openPanel();
		uiState.fileViewerOpen = true;
		matchMediaState.setMatches(true);
		matchMediaState.setMatches(false);
		expect(sessionViewState.filesOpen).toBe(true);
		expect(terminalState.panelOpen).toBe(true);
		expect(uiState.fileViewerOpen).toBe(true);
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
