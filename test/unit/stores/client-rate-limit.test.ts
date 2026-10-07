// Tests for the client-side chat RPC rate limit.
// Verifies: immediate sends under limit, queuing at limit, drain timer,
// and queue replacement.

import {
	afterEach,
	assert,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// Hoisted mocks (run before imports)
const { showToastMock, sentMessages } = vi.hoisted(() => ({
	showToastMock: vi.fn(),
	sentMessages: [] as string[],
}));

vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	showToast: showToastMock,
	showBanner: vi.fn(),
	removeBanner: vi.fn(),
	setClientCount: vi.fn(),
}));

import {
	_resetRateLimit,
	rateLimitChatSend,
} from "../../../src/lib/frontend/stores/ws-send.svelte.js";

/** Parsed version of the last sent message. */
function lastSent(): Record<string, unknown> | undefined {
	const raw = sentMessages[sentMessages.length - 1];
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
}

function sendChat(text: string): void {
	rateLimitChatSend(() => {
		sentMessages.push(JSON.stringify({ type: "message", text }));
	});
}

let clock: number;

beforeEach(() => {
	vi.useFakeTimers();
	clock = 0;
	sentMessages.length = 0;
	showToastMock.mockClear();
	_resetRateLimit({ now: () => clock });
});

afterEach(() => {
	_resetRateLimit();
	vi.useRealTimers();
});

describe("chat RPC client-side rate limiting", () => {
	describe("under rate limit", () => {
		it("sends up to MAX_MESSAGES immediately", () => {
			for (let i = 0; i < 5; i++) {
				sendChat(`msg ${i}`);
				clock += 100;
			}
			expect(sentMessages).toHaveLength(5);
			expect(showToastMock).not.toHaveBeenCalled();
		});

		it("records timestamps for sent messages", () => {
			sendChat("a");
			clock += 100;
			sendChat("b");
			expect(sentMessages).toHaveLength(2);
		});
	});

	describe("at rate limit", () => {
		function fillLimit(): void {
			for (let i = 0; i < 5; i++) {
				sendChat(`msg ${i}`);
				clock += 100;
			}
		}

		it("queues the 6th message and shows a toast", () => {
			fillLimit();
			sentMessages.length = 0; // clear to see only queued sends

			sendChat("queued");
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

			sendChat("queued");
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

			sendChat("first queued");
			sendChat("corrected");

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

			sendChat("a");
			sendChat("b");
			sendChat("c");

			// Advance past window — only "c" should be sent
			clock = 10_001;
			vi.advanceTimersByTime(10_000);

			expect(sentMessages).toHaveLength(1);
			expect(lastSent()).toEqual({ type: "message", text: "c" });
		});
	});

	describe("sliding window behavior", () => {
		it("allows a new message once the oldest expires", () => {
			// Send 5 at t=0
			for (let i = 0; i < 5; i++) {
				sendChat(`msg ${i}`);
			}
			expect(sentMessages).toHaveLength(5);

			// At t=10_001, oldest (t=0) expires — one slot opens
			clock = 10_001;
			sendChat("after window");
			expect(sentMessages).toHaveLength(6);
			expect(lastSent()).toEqual({ type: "message", text: "after window" });
		});
	});

	// AC7 requires messages to be processed in order. Previous tests proved
	// queuing works but did not assert the full send order.

	describe("message order preservation (Gap 4)", () => {
		it("sends first 5 messages in order, then drains queued 6th in sequence", () => {
			// Send 7 messages in rapid succession
			for (let i = 1; i <= 7; i++) {
				sendChat(`msg-${i}`);
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
			const sixthMessage = sentMessages[5];
			assert.exists(sixthMessage, "expected sixth sent message");
			const sixth = JSON.parse(sixthMessage) as { text: string };
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
	});

	describe("_resetRateLimit", () => {
		it("clears all rate-limit state", () => {
			// Fill limit and queue
			for (let i = 0; i < 5; i++) {
				sendChat(`msg ${i}`);
			}
			sendChat("queued");

			_resetRateLimit({ now: () => clock });

			// After reset, should be able to send immediately
			sentMessages.length = 0;
			sendChat("fresh");
			expect(sentMessages).toHaveLength(1);
		});

		it("cancels pending drain timer", () => {
			for (let i = 0; i < 5; i++) {
				sendChat(`msg ${i}`);
			}
			sendChat("queued");
			sentMessages.length = 0;

			_resetRateLimit({ now: () => clock });

			// Advance timers — nothing should drain
			clock = 20_000;
			vi.advanceTimersByTime(20_000);
			expect(sentMessages).toHaveLength(0);
		});
	});
});
