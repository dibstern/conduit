// The compact breakpoint decides whether the session bar replaces the global
// header, so getting it wrong loses either the chrome or the way out of a
// session. These tests pin the query string, the initial read, live changes,
// and the teardown — the listener outliving the layout would keep writing to a
// store nobody is rendering.

import { beforeEach, describe, expect, it, vi } from "vitest";

const matchMediaState = vi.hoisted(() => {
	let matches = false;
	const listeners = new Set<(event: MediaQueryListEvent) => void>();
	const query = {
		get matches() {
			return matches;
		},
		media: "",
		onchange: null,
		addEventListener: vi.fn(
			(_type: "change", listener: (event: MediaQueryListEvent) => void) => {
				listeners.add(listener);
			},
		),
		removeEventListener: vi.fn(
			(_type: "change", listener: (event: MediaQueryListEvent) => void) => {
				listeners.delete(listener);
			},
		),
	};

	return {
		query,
		matchMedia: vi.fn(() => query as unknown as MediaQueryList),
		setMatches(next: boolean) {
			matches = next;
			for (const listener of listeners) {
				listener({ matches: next } as MediaQueryListEvent);
			}
		},
		get listenerCount() {
			return listeners.size;
		},
		reset() {
			matches = false;
			listeners.clear();
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
	noteSessionChanged,
	noteUserScroll,
	publishAtBottom,
	sessionViewState,
	watchCompactViewport,
} = await import("../../../src/lib/frontend/stores/session-view.svelte.js");

beforeEach(() => {
	matchMediaState.reset();
	sessionViewState.compact = false;
	publishAtBottom(true);
	noteSessionChanged();
	vi.clearAllMocks();
});

describe("session bar collapse", () => {
	beforeEach(() => {
		sessionViewState.compact = true;
		noteUserScroll();
	});

	it("collapses when compact, at the bottom, and not forced open", () => {
		expect(isBarCollapsed()).toBe(true);
	});

	it("desktop never collapses, even at the bottom with no force", () => {
		sessionViewState.compact = false;
		expect(sessionViewState.atBottom).toBe(true);
		expect(sessionViewState.forcedOpen).toBe(false);
		expect(isBarCollapsed()).toBe(false);
	});

	it("does not collapse when not at the bottom", () => {
		publishAtBottom(false);
		expect(isBarCollapsed()).toBe(false);
	});

	it("does not collapse when forced open", () => {
		forceBarOpen();
		expect(isBarCollapsed()).toBe(false);
	});

	it("forceBarOpen expands the bar while atBottom stays true for the chevron", () => {
		expect(isBarCollapsed()).toBe(true);
		forceBarOpen();
		expect(isBarCollapsed()).toBe(false);
		expect(sessionViewState.atBottom).toBe(true);
	});

	it("publishAtBottom(true) from false clears forcedOpen", () => {
		publishAtBottom(false);
		forceBarOpen();
		publishAtBottom(true);
		expect(sessionViewState.atBottom).toBe(true);
		expect(sessionViewState.forcedOpen).toBe(false);
		expect(isBarCollapsed()).toBe(true);
	});

	it("publishAtBottom(true) when already at the bottom does not clear forcedOpen", () => {
		forceBarOpen();
		publishAtBottom(true);
		expect(sessionViewState.forcedOpen).toBe(true);
		expect(isBarCollapsed()).toBe(false);
	});

	it("publishAtBottom(false) leaves forcedOpen alone", () => {
		forceBarOpen();
		publishAtBottom(false);
		expect(sessionViewState.atBottom).toBe(false);
		expect(sessionViewState.forcedOpen).toBe(true);
		noteUserScroll();
		publishAtBottom(false);
		expect(sessionViewState.forcedOpen).toBe(false);
	});

	it("noteUserScroll clears forcedOpen", () => {
		forceBarOpen();
		noteUserScroll();
		expect(sessionViewState.forcedOpen).toBe(false);
	});

	it("noteSessionChanged sets forcedOpen so a session switch arrives expanded", () => {
		expect(isBarCollapsed()).toBe(true);
		noteSessionChanged();
		expect(sessionViewState.forcedOpen).toBe(true);
		expect(isBarCollapsed()).toBe(false);
	});

	it("collapses after arrival and a sub-threshold user scroll while still at the bottom", () => {
		noteSessionChanged();
		expect(isBarCollapsed()).toBe(false);
		noteUserScroll();
		expect(sessionViewState.atBottom).toBe(true);
		expect(isBarCollapsed()).toBe(true);
	});
});

describe("watchCompactViewport", () => {
	it("agrees with Tailwind's md breakpoint", () => {
		watchCompactViewport()();

		// 767px, not 768: an ad-hoc `<= 768` check disagrees with every `md:`
		// utility by exactly one pixel, which is how a phone layout leaks onto a
		// tablet-width viewport.
		expect(matchMediaState.matchMedia).toHaveBeenCalledWith(
			"(max-width: 767px)",
		);
	});

	it("adopts the current viewport immediately rather than waiting for a change", () => {
		matchMediaState.setMatches(true);

		const stop = watchCompactViewport();

		expect(sessionViewState.compact).toBe(true);
		stop();
	});

	it("follows the viewport across the breakpoint in both directions", () => {
		const stop = watchCompactViewport();
		expect(sessionViewState.compact).toBe(false);

		matchMediaState.setMatches(true);
		expect(sessionViewState.compact).toBe(true);

		matchMediaState.setMatches(false);
		expect(sessionViewState.compact).toBe(false);

		stop();
	});

	it("stops listening once torn down", () => {
		const stop = watchCompactViewport();
		stop();

		expect(matchMediaState.listenerCount).toBe(0);

		matchMediaState.setMatches(true);
		expect(sessionViewState.compact).toBe(false);
	});
});
