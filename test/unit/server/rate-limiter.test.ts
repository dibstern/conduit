// ─── RateLimiter Unit Tests ──────────────────────────────────────────────────
// Tests for the sliding-window rate limiter utility.
// Verifies: allow/reject behavior, retryAfterMs, independent client tracking,
// remaining count, cleanup of stale entries, edge cases.

import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../../src/lib/server/rate-limiter.js";

describe("RateLimiter", () => {
	// ─── Allows messages under the limit ────────────────────────────────────

	it("allows messages under the limit", () => {
		let clock = 0;
		const limiter = new RateLimiter({ now: () => clock });

		for (let i = 0; i < 5; i++) {
			const result = limiter.check("client-a");
			expect(result.allowed).toBe(true);
			expect(result.retryAfterMs).toBeUndefined();
			clock += 100; // small time increments within window
		}
	});

	// ─── Rejects the 6th message within the window ──────────────────────────

	it("rejects the 6th message with correct retryAfterMs", () => {
		let clock = 0;
		const limiter = new RateLimiter({ now: () => clock });

		// Send 5 messages at known times
		for (let i = 0; i < 5; i++) {
			limiter.check("client-a");
			clock += 100; // messages at t=0, 100, 200, 300, 400
		}

		// clock is now 500; 6th message should be rejected
		const result = limiter.check("client-a");
		expect(result.allowed).toBe(false);
		// Oldest message is at t=0, window is 10_000ms.
		// retryAfterMs = (0 + 10_000) - 500 = 9500
		expect(result.retryAfterMs).toBe(9500);
	});

	// ─── After the window expires, allows messages again ────────────────────

	it("allows messages again after the window expires", () => {
		let clock = 0;
		const limiter = new RateLimiter({ now: () => clock });

		// Fill up the limit
		for (let i = 0; i < 5; i++) {
			limiter.check("client-a");
			clock += 100;
		}

		// Rejected at t=500
		expect(limiter.check("client-a").allowed).toBe(false);

		// Advance past the window for the oldest message (t=0 + 10_000 = 10_000)
		clock = 10_001;
		const result = limiter.check("client-a");
		expect(result.allowed).toBe(true);
	});

	// ─── Independent client tracking ────────────────────────────────────────

	it("tracks clients independently", () => {
		let clock = 0;
		const limiter = new RateLimiter({ now: () => clock });

		// Fill up client A
		for (let i = 0; i < 5; i++) {
			limiter.check("client-a");
			clock += 10;
		}

		// Client A is at limit
		expect(limiter.check("client-a").allowed).toBe(false);

		// Client B should still be allowed
		const result = limiter.check("client-b");
		expect(result.allowed).toBe(true);
	});

	// ─── remaining() ────────────────────────────────────────────────────────

	it("remaining() returns correct count", () => {
		let clock = 0;
		const limiter = new RateLimiter({ now: () => clock });

		expect(limiter.remaining("client-a")).toBe(5);

		limiter.check("client-a");
		clock += 10;
		expect(limiter.remaining("client-a")).toBe(4);

		limiter.check("client-a");
		clock += 10;
		expect(limiter.remaining("client-a")).toBe(3);

		limiter.check("client-a");
		clock += 10;
		limiter.check("client-a");
		clock += 10;
		limiter.check("client-a");
		clock += 10;
		expect(limiter.remaining("client-a")).toBe(0);
	});

	// ─── remaining() for new/empty client ───────────────────────────────────

	it("remaining() returns full count for unknown client", () => {
		const limiter = new RateLimiter({ now: () => 0 });
		expect(limiter.remaining("never-seen")).toBe(5);
	});

	// ─── cleanup() ──────────────────────────────────────────────────────────

	it("cleanup() removes stale clients", () => {
		let clock = 0;
		const limiter = new RateLimiter({ now: () => clock });

		// Client A sends a message at t=0
		limiter.check("client-a");
		// Client B sends a message at t=0
		limiter.check("client-b");

		// Advance past the window
		clock = 11_000;

		// Client B sends another message — keeps it alive
		limiter.check("client-b");

		limiter.cleanup();

		// Client A should have been cleaned up — remaining returns full count
		expect(limiter.remaining("client-a")).toBe(5);

		// Client B still tracked — just sent at t=11_000
		expect(limiter.remaining("client-b")).toBe(4);
	});

	// ─── Custom config ──────────────────────────────────────────────────────

	it("respects custom maxMessages and windowMs", () => {
		let clock = 0;
		const limiter = new RateLimiter({
			maxMessages: 2,
			windowMs: 1000,
			now: () => clock,
		});

		expect(limiter.check("c").allowed).toBe(true);
		clock += 10;
		expect(limiter.check("c").allowed).toBe(true);
		clock += 10;

		const rejected = limiter.check("c");
		expect(rejected.allowed).toBe(false);
		// Oldest at t=0, window=1000 → retryAfterMs = (0 + 1000) - 20 = 980
		expect(rejected.retryAfterMs).toBe(980);
	});

	// ─── retryAfterMs decreases as time passes ──────────────────────────────

	it("retryAfterMs decreases as time passes", () => {
		let clock = 0;
		const limiter = new RateLimiter({ now: () => clock });

		for (let i = 0; i < 5; i++) {
			limiter.check("c");
		}

		// All 5 at t=0; rejected at t=0
		const r1 = limiter.check("c");
		expect(r1.allowed).toBe(false);
		expect(r1.retryAfterMs).toBe(10_000);

		// Advance 3 seconds
		clock = 3000;
		const r2 = limiter.check("c");
		expect(r2.allowed).toBe(false);
		expect(r2.retryAfterMs).toBe(7000);
	});

	// ─── Sliding window slides correctly ────────────────────────────────────

	it("slides the window — only oldest message expires first", () => {
		let clock = 0;
		const limiter = new RateLimiter({
			maxMessages: 3,
			windowMs: 1000,
			now: () => clock,
		});

		// Messages at t=0, 200, 400
		limiter.check("c");
		clock = 200;
		limiter.check("c");
		clock = 400;
		limiter.check("c");

		// At t=400 — full
		expect(limiter.check("c").allowed).toBe(false);

		// At t=1001 — oldest (t=0) expires, so one slot opens
		clock = 1001;
		expect(limiter.check("c").allowed).toBe(true);

		// Now window has: t=200, 400, 1001 — full again
		expect(limiter.check("c").allowed).toBe(false);
	});
});
