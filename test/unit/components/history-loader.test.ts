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
import {
	beginReplayBatch,
	chatState,
	clearMessages,
	commitReplayFinal,
	getMessages,
	getReplayBuffer,
	historyState,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import type { ChatMessage } from "../../../src/lib/frontend/types.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

// ─── Per-session tiers for handler calls ────────────────────────────────────
let ta: SessionActivity;
let tm: SessionMessages;

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

// ─── Buffer exhaustion → server fallback ────────────────────────────────────
// When a session is loaded from the event cache with >50 messages, older
// messages go into a local replay buffer. HistoryLoader should consume this
// buffer first, then fall through to a server request when the buffer is
// exhausted — the event cache may not cover the full session.

function makeUserMessages(count: number): ChatMessage[] {
	return Array.from({ length: count }, (_, i) => ({
		type: "user" as const,
		uuid: `uuid-${i}`,
		text: `message-${i}`,
	}));
}

describe("HistoryLoader buffer → server fallback", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		observerCallback = null;
		observedElements = [];
		clearMessages();
		ta = testActivity();
		tm = testMessages();
		historyState.hasMore = false;
		historyState.loading = false;
		historyState.messageCount = 0;
		sessionState.currentId = "buf-session";
	});

	afterEach(() => {
		cleanup();
		clearMessages();
	});

	it("sends load_more_history after replay buffer is fully consumed", async () => {
		// Setup: simulate commitReplayFinal with 100 messages.
		// This puts 50 in the replay buffer and 50 in chatState.messages.
		beginReplayBatch(ta, tm);
		for (const m of makeUserMessages(100)) {
			getMessages(tm).push(m);
		}
		commitReplayFinal(ta, tm, "buf-session");

		// Verify initial state
		expect(chatState.messages).toHaveLength(50);
		expect(getReplayBuffer(ta, tm, "buf-session")).toHaveLength(50);
		expect(historyState.hasMore).toBe(true);

		// Render the HistoryLoader
		const sentinel = document.createElement("div");
		render(HistoryLoader, { props: { sentinelEl: sentinel } });
		flushSync();
		await tick();

		// First intersection: consumes 50 from buffer (exactly exhausts it)
		observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry]);

		// Buffer should be fully consumed now
		expect(getReplayBuffer(ta, tm, "buf-session")).toBeUndefined();
		// All 100 messages should be displayed
		expect(chatState.messages).toHaveLength(100);

		// KEY ASSERTION: After buffer exhaustion, HistoryLoader should send
		// a server request (load_more_history) — NOT just set hasMore=false.
		// The event cache may not cover the full session.
		expect(wsSendSpy).toHaveBeenCalledTimes(1);
		expect(wsSendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "load_more_history",
				sessionId: "buf-session",
			}),
		);
		expect(historyState.loading).toBe(true);
	});

	it("consumes buffer pages before falling through to server", async () => {
		// Setup: 200 messages → 150 in buffer, 50 displayed
		beginReplayBatch(ta, tm);
		for (const m of makeUserMessages(200)) {
			getMessages(tm).push(m);
		}
		commitReplayFinal(ta, tm, "buf-session");

		expect(getReplayBuffer(ta, tm, "buf-session")).toHaveLength(150);

		const sentinel = document.createElement("div");
		render(HistoryLoader, { props: { sentinelEl: sentinel } });
		flushSync();
		await tick();

		// First intersection: consumes 50 from buffer (100 remaining)
		observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry]);
		expect(wsSendSpy).not.toHaveBeenCalled(); // still consuming buffer

		// Second intersection: consumes 50 from buffer (50 remaining)
		observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry]);
		expect(wsSendSpy).not.toHaveBeenCalled(); // still consuming buffer

		// Third intersection: consumes last 50 from buffer (exhausted)
		observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry]);
		expect(getReplayBuffer(ta, tm, "buf-session")).toBeUndefined();

		// NOW it should fall through to server
		expect(wsSendSpy).toHaveBeenCalledTimes(1);
		expect(wsSendSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "load_more_history",
				sessionId: "buf-session",
			}),
		);
	});
});
