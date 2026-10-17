import { cleanup, render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy mode keeps the real exports: selection reads the transcript's saved
// draw, and a factory awaiting the original deadlocks on the import cycle
// through turn control's stop flow.
vi.mock("../../../src/lib/frontend/stores/transcript.svelte.js", {
	spy: true,
});

import HistoryLoader from "../../../src/lib/frontend/components/chat/HistoryLoader.svelte";
import {
	getOrCreateSessionMessages,
	getOrCreateSessionSlot,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	loadOlderTranscript,
	placedSessionId,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";

vi.mocked(loadOlderTranscript).mockImplementation(() => Promise.resolve());
vi.mocked(placedSessionId).mockImplementation(() => sessionState.currentId);

let observerCallback: IntersectionObserverCallback | null = null;
const disconnect = vi.fn();
class MockIntersectionObserver {
	constructor(callback: IntersectionObserverCallback) {
		observerCallback = callback;
	}
	observe() {}
	unobserve() {}
	disconnect() {
		disconnect();
	}
}
vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

const intersect = (isIntersecting = true) =>
	observerCallback?.(
		[{ isIntersecting } as IntersectionObserverEntry],
		{} as IntersectionObserver,
	);

beforeEach(() => {
	vi.clearAllMocks();
	observerCallback = null;
	sessionState.currentId = "test-session";
	const { messages } = getOrCreateSessionSlot("test-session");
	messages.historyHasMore = false;
	messages.historyLoading = false;
});
afterEach(cleanup);

describe("HistoryLoader", () => {
	it("observes and disconnects its sentinel", () => {
		getOrCreateSessionMessages("test-session").historyHasMore = true;
		const { unmount } = render(HistoryLoader, {
			props: { sentinelEl: document.createElement("div") },
		});
		expect(observerCallback).not.toBeNull();
		unmount();
		expect(disconnect).toHaveBeenCalledOnce();
	});

	it("loads an older transcript page when the sentinel intersects", () => {
		getOrCreateSessionMessages("test-session").historyHasMore = true;
		render(HistoryLoader, {
			props: { sentinelEl: document.createElement("div") },
		});
		flushSync();
		intersect();
		expect(loadOlderTranscript).toHaveBeenCalledExactlyOnceWith("test-session");
	});

	it.each([
		["no older page", false, false, true],
		["already loading", true, true, true],
		["not intersecting", true, false, false],
	])("does not load with %s", (_name, hasMore, loading, isIntersecting) => {
		const messages = getOrCreateSessionMessages("test-session");
		messages.historyHasMore = hasMore;
		messages.historyLoading = loading;
		render(HistoryLoader, {
			props: { sentinelEl: document.createElement("div") },
		});
		flushSync();
		intersect(isIntersecting);
		expect(loadOlderTranscript).not.toHaveBeenCalled();
	});

	it("does not load without an active session", () => {
		getOrCreateSessionMessages("test-session").historyHasMore = true;
		render(HistoryLoader, {
			props: { sentinelEl: document.createElement("div") },
		});
		flushSync();
		sessionState.currentId = null;
		intersect();
		expect(loadOlderTranscript).not.toHaveBeenCalled();
	});
});
