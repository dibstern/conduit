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

const { sessionViewState, watchCompactViewport } = await import(
	"../../../src/lib/frontend/stores/session-view.svelte.js"
);

beforeEach(() => {
	matchMediaState.reset();
	sessionViewState.compact = false;
	vi.clearAllMocks();
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
