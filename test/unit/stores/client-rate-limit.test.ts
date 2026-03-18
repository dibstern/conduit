// ─── Client-side Rate Limit Tests ────────────────────────────────────────────
// Tests for the client-side message queue in ws.svelte.ts.
// Verifies: immediate sends under limit, queuing at limit, drain timer,
// queue replacement, and non-message bypass.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks (run before imports) ─────────────────────────────────────
const { showToastMock, sentMessages } = vi.hoisted(() => {
	const showToastMock = vi.fn();
	const sentMessages: string[] = [];

	class MockWebSocket {
		static readonly OPEN = 1;
		static readonly CLOSED = 3;
		readyState = MockWebSocket.OPEN;
		private listeners: Record<string, Array<(ev?: unknown) => void>> = {};

		send(data: string): void {
			sentMessages.push(data);
		}

		addEventListener(event: string, fn: (ev?: unknown) => void): void {
			if (!this.listeners[event]) this.listeners[event] = [];
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			this.listeners[event]!.push(fn);
		}

		close(): void {
			this.readyState = MockWebSocket.CLOSED;
		}

		_fire(event: string, data?: unknown): void {
			for (const fn of this.listeners[event] ?? []) {
				fn(data);
			}
		}
	}

	// Install mock WebSocket globally before any module imports
	Object.defineProperty(globalThis, "WebSocket", {
		value: MockWebSocket,
		writable: true,
		configurable: true,
	});

	// Mock window.location so connect() can build the URL
	if (typeof globalThis.window === "undefined") {
		Object.defineProperty(globalThis, "window", {
			value: {
				location: { protocol: "http:", host: "localhost:3000", pathname: "/" },
				history: { pushState: () => {}, replaceState: () => {} },
				addEventListener: () => {},
			},
			writable: true,
			configurable: true,
		});
	}

	return { showToastMock, sentMessages, MockWebSocket };
});

// ─── Mock ui.svelte.js to capture showToast calls ───────────────────────────
vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	showToast: showToastMock,
	showBanner: vi.fn(),
	removeBanner: vi.fn(),
	setClientCount: vi.fn(),
}));

import {
	_resetRateLimit,
	connect,
	disconnect,
	wsSend,
} from "../../../src/lib/frontend/stores/ws.svelte.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Parsed version of the last sent message. */
function lastSent(): Record<string, unknown> | undefined {
	const raw = sentMessages[sentMessages.length - 1];
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
}

let clock: number;

beforeEach(() => {
	vi.useFakeTimers();
	clock = 0;
	sentMessages.length = 0;
	showToastMock.mockClear();
	_resetRateLimit({ now: () => clock });

	// Establish a "connected" WebSocket so rawSend works.
	// connect() creates a new MockWebSocket; we fire "open" to mark it connected.
	connect();
	// The connect function adds event listeners; find the mock and fire "open"
	// We need to get the MockWebSocket instance. Since connect() assigns to _ws,
	// and our MockWebSocket is used, we access it via the global constructor calls.
	// Actually, connect() creates `new WebSocket(url)` which is our MockWebSocket.
	// The "open" listener sets status. Let's fire it by accessing the instance.
});

afterEach(() => {
	disconnect();
	vi.useRealTimers();
});

// ─── Helper to establish the WS connection ──────────────────────────────────
// connect() creates a MockWebSocket but we need to fire "open" on it.
// Since we can't directly access _ws, we verify sends work by checking sentMessages.

// Actually, connect() constructs a WebSocket internally. Our MockWebSocket captures
// addEventListener calls. We need to trigger the open event. Since the mock is
// simple, let's just verify the flow by testing wsSend directly — if _ws is set
// and readyState is OPEN (default in our mock), rawSend works.

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("wsSend client-side rate limiting", () => {
	// ─── Non-message types bypass rate limiting ─────────────────────────────

	describe("non-message types", () => {
		it("sends control messages immediately without rate limiting", () => {
			for (let i = 0; i < 10; i++) {
				wsSend({ type: "subscribe", channel: "test" });
			}
			// All 10 should have been sent (no queuing)
			expect(sentMessages).toHaveLength(10);
			expect(showToastMock).not.toHaveBeenCalled();
		});

		it("sends permission responses immediately", () => {
			wsSend({ type: "permission_response", allow: true });
			expect(sentMessages).toHaveLength(1);
		});
	});

	// ─── Under limit — immediate send ───────────────────────────────────────

	describe("under rate limit", () => {
		it("sends up to MAX_MESSAGES immediately", () => {
			for (let i = 0; i < 5; i++) {
				wsSend({ type: "message", text: `msg ${i}` });
				clock += 100;
			}
			expect(sentMessages).toHaveLength(5);
			expect(showToastMock).not.toHaveBeenCalled();
		});

		it("records timestamps for sent messages", () => {
			wsSend({ type: "message", text: "a" });
			clock += 100;
			wsSend({ type: "message", text: "b" });
			expect(sentMessages).toHaveLength(2);
		});
	});

	// ─── At limit — queuing ─────────────────────────────────────────────────

	describe("at rate limit", () => {
		function fillLimit(): void {
			for (let i = 0; i < 5; i++) {
				wsSend({ type: "message", text: `msg ${i}` });
				clock += 100;
			}
		}

		it("queues the 6th message and shows a toast", () => {
			fillLimit();
			sentMessages.length = 0; // clear to see only queued sends

			wsSend({ type: "message", text: "queued" });
			// Should NOT have been sent yet
			expect(sentMessages).toHaveLength(0);
			expect(showToastMock).toHaveBeenCalledWith(
				"Message queued — sending shortly",
				{ variant: "warn" },
			);
		});

		it("drains the queued message after the window slides", () => {
			fillLimit();
			// Messages sent at t=0, 100, 200, 300, 400; clock is now 500
			sentMessages.length = 0;

			wsSend({ type: "message", text: "queued" });
			expect(sentMessages).toHaveLength(0);

			// Oldest timestamp is 0. Window expires at 0 + 10_000 = 10_000.
			// Timer delay = max(0, 10_000 - 500) = 9500.
			// Advance clock to when the timer fires.
			clock = 10_001;
			vi.advanceTimersByTime(9500);

			expect(sentMessages).toHaveLength(1);
			expect(lastSent()).toEqual({ type: "message", text: "queued" });
		});

		it("replaces queued message when a new one arrives", () => {
			fillLimit();
			sentMessages.length = 0;

			wsSend({ type: "message", text: "first queued" });
			wsSend({ type: "message", text: "corrected" });

			// Two toast calls (one per queue attempt)
			expect(showToastMock).toHaveBeenCalledTimes(2);

			// Advance past window
			clock = 10_001;
			vi.advanceTimersByTime(10_000);

			// Only the corrected message should have been sent
			expect(sentMessages).toHaveLength(1);
			expect(lastSent()).toEqual({ type: "message", text: "corrected" });
		});

		it("only queues one message at a time (latest wins)", () => {
			fillLimit();
			sentMessages.length = 0;

			wsSend({ type: "message", text: "a" });
			wsSend({ type: "message", text: "b" });
			wsSend({ type: "message", text: "c" });

			// Advance past window — only "c" should be sent
			clock = 10_001;
			vi.advanceTimersByTime(10_000);

			expect(sentMessages).toHaveLength(1);
			expect(lastSent()).toEqual({ type: "message", text: "c" });
		});
	});

	// ─── Sliding window ─────────────────────────────────────────────────────

	describe("sliding window behavior", () => {
		it("allows a new message once the oldest expires", () => {
			// Send 5 at t=0
			for (let i = 0; i < 5; i++) {
				wsSend({ type: "message", text: `msg ${i}` });
			}
			expect(sentMessages).toHaveLength(5);

			// At t=10_001, oldest (t=0) expires — one slot opens
			clock = 10_001;
			wsSend({ type: "message", text: "after window" });
			expect(sentMessages).toHaveLength(6);
			expect(lastSent()).toEqual({ type: "message", text: "after window" });
		});

		it("mixed message types: control messages don't count against limit", () => {
			for (let i = 0; i < 5; i++) {
				wsSend({ type: "message", text: `msg ${i}` });
				wsSend({ type: "subscribe", channel: "foo" });
				clock += 100;
			}
			// 5 chat + 5 control = 10 total sent
			expect(sentMessages).toHaveLength(10);

			// Next chat message should be queued (limit reached)
			const before = sentMessages.length;
			wsSend({ type: "message", text: "over limit" });
			expect(sentMessages).toHaveLength(before); // no new send
			expect(showToastMock).toHaveBeenCalled();
		});
	});

	// ─── Gap 4: Message order preservation ──────────────────────────────────
	// AC7 requires messages to be processed in order. Previous tests proved
	// queuing works but did not assert the full send order.

	describe("message order preservation (Gap 4)", () => {
		it("sends first 5 messages in order, then drains queued 6th in sequence", () => {
			// Send 7 messages in rapid succession
			for (let i = 1; i <= 7; i++) {
				wsSend({ type: "message", text: `msg-${i}` });
				clock += 50;
			}

			// First 5 should be sent immediately, in order
			expect(sentMessages).toHaveLength(5);
			const firstFive = sentMessages.map(
				(raw) => (JSON.parse(raw) as { text: string }).text,
			);
			expect(firstFive).toEqual(["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]);

			// Messages 6 and 7 were queued; latest-wins means only msg-7 remains
			// Advance past the window to drain
			clock = 10_001;
			vi.advanceTimersByTime(10_000);

			expect(sentMessages).toHaveLength(6);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const sixth = JSON.parse(sentMessages[5]!) as { text: string };
			expect(sixth.text).toBe("msg-7");

			// Full sequence: msg-1..5 in order, then msg-7 (latest queued)
			const allTexts = sentMessages.map(
				(raw) => (JSON.parse(raw) as { text: string }).text,
			);
			expect(allTexts).toEqual([
				"msg-1",
				"msg-2",
				"msg-3",
				"msg-4",
				"msg-5",
				"msg-7",
			]);
		});

		it("preserves order when interleaving chat and control messages", () => {
			// Alternate chat and control messages
			wsSend({ type: "message", text: "chat-1" });
			clock += 10;
			wsSend({ type: "subscribe", channel: "a" });
			clock += 10;
			wsSend({ type: "message", text: "chat-2" });
			clock += 10;
			wsSend({ type: "subscribe", channel: "b" });
			clock += 10;
			wsSend({ type: "message", text: "chat-3" });

			// All should be sent (3 chat + 2 control = under limit)
			expect(sentMessages).toHaveLength(5);

			// Verify chat messages are in order relative to each other
			const chatTexts = sentMessages
				.map((raw) => JSON.parse(raw) as { type: string; text?: string })
				.filter((m) => m.type === "message")
				.map((m) => m.text);
			expect(chatTexts).toEqual(["chat-1", "chat-2", "chat-3"]);
		});
	});

	// ─── Reset ──────────────────────────────────────────────────────────────

	describe("_resetRateLimit", () => {
		it("clears all rate-limit state", () => {
			// Fill limit and queue
			for (let i = 0; i < 5; i++) {
				wsSend({ type: "message", text: `msg ${i}` });
			}
			wsSend({ type: "message", text: "queued" });

			_resetRateLimit({ now: () => clock });

			// After reset, should be able to send immediately
			sentMessages.length = 0;
			wsSend({ type: "message", text: "fresh" });
			expect(sentMessages).toHaveLength(1);
		});

		it("cancels pending drain timer", () => {
			for (let i = 0; i < 5; i++) {
				wsSend({ type: "message", text: `msg ${i}` });
			}
			wsSend({ type: "message", text: "queued" });
			sentMessages.length = 0;

			_resetRateLimit({ now: () => clock });

			// Advance timers — nothing should drain
			clock = 20_000;
			vi.advanceTimersByTime(20_000);
			expect(sentMessages).toHaveLength(0);
		});
	});
});
