// ─── HistoryLoader Component Test ─────────────────────────────────────────────
// Tests that HistoryLoader correctly:
// 1. Sets up IntersectionObserver on mount and disconnects on destroy
// 2. Calls wsSend with the right payload when sentinel becomes visible
// 3. Guards against loading when historyState.hasMore is false
// 4. Guards against double-loading when historyState.loading is true
// 5. Guards against loading when there's no active session
//
// Uses @testing-library/svelte + jsdom (vitest "components" project).

import { cleanup, render } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock IntersectionObserver ────────────────────────────────────────────────
// jsdom doesn't implement IntersectionObserver. We provide a mock that captures
// the callback so tests can trigger intersection entries manually.

type IntersectionCallback = (entries: IntersectionObserverEntry[]) => void;

let observerCallback: IntersectionCallback | null = null;
let observedElements: Element[] = [];
const disconnectSpy = vi.fn();

class MockIntersectionObserver {
	constructor(
		callback: IntersectionCallback,
		_options?: IntersectionObserverInit,
	) {
		observerCallback = callback;
	}
	observe(el: Element) {
		observedElements.push(el);
	}
	unobserve(_el: Element) {}
	disconnect() {
		disconnectSpy();
	}
}

vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

// ─── Mock stores ─────────────────────────────────────────────────────────────

const wsSendSpy = vi.fn();

vi.mock("../../../src/lib/frontend/stores/ws.svelte.ts", () => ({
	wsSend: (...args: unknown[]) => wsSendSpy(...args),
}));

import HistoryLoader from "../../../src/lib/frontend/components/chat/HistoryLoader.svelte";
// We need real stores for historyState and sessionState so we can set values
// and have the component read them.
import { historyState } from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("HistoryLoader component", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		observerCallback = null;
		observedElements = [];
		// Reset state
		historyState.hasMore = false;
		historyState.loading = false;
		historyState.messageCount = 0;
		sessionState.currentId = "test-session";
	});

	afterEach(() => {
		cleanup();
	});

	it("observes the sentinel element on mount", () => {
		const sentinel = document.createElement("div");
		render(HistoryLoader, { props: { sentinelEl: sentinel } });

		expect(observedElements).toContain(sentinel);
		expect(observerCallback).not.toBeNull();
	});

	it("disconnects observer on destroy", () => {
		const sentinel = document.createElement("div");
		const { unmount } = render(HistoryLoader, {
			props: { sentinelEl: sentinel },
		});

		unmount();

		expect(disconnectSpy).toHaveBeenCalledTimes(1);
	});

	it("sends load_more_history when sentinel intersects and hasMore is true", async () => {
		const sentinel = document.createElement("div");
		historyState.hasMore = true;
		historyState.messageCount = 50;

		render(HistoryLoader, { props: { sentinelEl: sentinel } });
		flushSync();
		await tick();

		// Simulate sentinel becoming visible
		observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry]);

		expect(wsSendSpy).toHaveBeenCalledTimes(1);
		expect(wsSendSpy).toHaveBeenCalledWith({
			type: "load_more_history",
			sessionId: "test-session",
			offset: 50,
		});
		expect(historyState.loading).toBe(true);
	});

	it("does NOT send when hasMore is false", async () => {
		const sentinel = document.createElement("div");
		historyState.hasMore = false;

		render(HistoryLoader, { props: { sentinelEl: sentinel } });
		flushSync();
		await tick();

		observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry]);

		expect(wsSendSpy).not.toHaveBeenCalled();
	});

	it("does NOT send when already loading", async () => {
		const sentinel = document.createElement("div");
		historyState.hasMore = true;
		historyState.loading = true;

		render(HistoryLoader, { props: { sentinelEl: sentinel } });
		flushSync();
		await tick();

		observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry]);

		expect(wsSendSpy).not.toHaveBeenCalled();
	});

	it("does NOT send when no active session", async () => {
		const sentinel = document.createElement("div");
		historyState.hasMore = true;
		sessionState.currentId = null;

		render(HistoryLoader, { props: { sentinelEl: sentinel } });
		flushSync();
		await tick();

		observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry]);

		expect(wsSendSpy).not.toHaveBeenCalled();
	});

	it("does NOT send when entry is not intersecting", async () => {
		const sentinel = document.createElement("div");
		historyState.hasMore = true;

		render(HistoryLoader, { props: { sentinelEl: sentinel } });
		flushSync();
		await tick();

		observerCallback?.([
			{ isIntersecting: false } as IntersectionObserverEntry,
		]);

		expect(wsSendSpy).not.toHaveBeenCalled();
	});

	it("does not observe when sentinelEl is undefined", () => {
		render(HistoryLoader, { props: { sentinelEl: undefined } });

		expect(observedElements).toHaveLength(0);
	});

	it("uses correct offset from historyState.messageCount", async () => {
		const sentinel = document.createElement("div");
		historyState.hasMore = true;
		historyState.messageCount = 150; // 3 pages loaded already

		render(HistoryLoader, { props: { sentinelEl: sentinel } });
		flushSync();
		await tick();

		observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry]);

		expect(wsSendSpy).toHaveBeenCalledWith(
			expect.objectContaining({ offset: 150 }),
		);
	});
});
