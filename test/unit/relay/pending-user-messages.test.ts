import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingUserMessages } from "../../../src/lib/relay/pending-user-messages.js";

describe("PendingUserMessages", () => {
	let tracker: PendingUserMessages;

	beforeEach(() => {
		tracker = new PendingUserMessages();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("consume returns true for a recorded message", () => {
		tracker.record("ses_1", "hello world");
		expect(tracker.consume("ses_1", "hello world")).toBe(true);
	});

	it("consume returns false for an unknown message", () => {
		expect(tracker.consume("ses_1", "hello world")).toBe(false);
	});

	it("consume removes the entry after first match", () => {
		tracker.record("ses_1", "hello");
		expect(tracker.consume("ses_1", "hello")).toBe(true);
		// Second consume should return false — already consumed
		expect(tracker.consume("ses_1", "hello")).toBe(false);
	});

	it("does not match across different sessions", () => {
		tracker.record("ses_1", "hello");
		expect(tracker.consume("ses_2", "hello")).toBe(false);
		// Original session should still match
		expect(tracker.consume("ses_1", "hello")).toBe(true);
	});

	it("handles multiple pending messages for same session", () => {
		tracker.record("ses_1", "first");
		tracker.record("ses_1", "second");
		expect(tracker.size).toBe(2);

		expect(tracker.consume("ses_1", "second")).toBe(true);
		expect(tracker.size).toBe(1);

		expect(tracker.consume("ses_1", "first")).toBe(true);
		expect(tracker.size).toBe(0);
	});

	it("handles duplicate text in same session (consumes one at a time)", () => {
		tracker.record("ses_1", "hello");
		tracker.record("ses_1", "hello");
		expect(tracker.size).toBe(2);

		expect(tracker.consume("ses_1", "hello")).toBe(true);
		expect(tracker.size).toBe(1);

		expect(tracker.consume("ses_1", "hello")).toBe(true);
		expect(tracker.size).toBe(0);

		expect(tracker.consume("ses_1", "hello")).toBe(false);
	});

	it("evicts expired entries on consume", () => {
		vi.useFakeTimers();
		tracker.record("ses_1", "old message");

		// Advance past TTL (30s)
		vi.advanceTimersByTime(31_000);

		// Should not match — expired
		expect(tracker.consume("ses_1", "old message")).toBe(false);
		expect(tracker.size).toBe(0);

		vi.useRealTimers();
	});

	it("fresh entries survive within TTL", () => {
		vi.useFakeTimers();
		tracker.record("ses_1", "recent");

		// Advance within TTL
		vi.advanceTimersByTime(10_000);

		expect(tracker.consume("ses_1", "recent")).toBe(true);

		vi.useRealTimers();
	});

	it("FIFO evicts when exceeding max entries", () => {
		// Record 101 entries (cap is 100)
		for (let i = 0; i < 101; i++) {
			tracker.record("ses_1", `msg-${i}`);
		}

		// First entry should have been evicted
		expect(tracker.consume("ses_1", "msg-0")).toBe(false);

		// Last entry should still be there
		expect(tracker.consume("ses_1", "msg-100")).toBe(true);
	});

	it("size reflects current count after eviction", () => {
		vi.useFakeTimers();
		tracker.record("ses_1", "a");
		tracker.record("ses_1", "b");

		vi.advanceTimersByTime(31_000);

		tracker.record("ses_1", "c");
		expect(tracker.size).toBe(1); // a and b expired, c is fresh
		vi.useRealTimers();
	});
});
