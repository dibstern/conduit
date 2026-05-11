import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TTLCache } from "../../../../src/lib/provider/claude/ttl-cache.js";

describe("TTLCache", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("invokes lookup on first call", async () => {
		const lookup = vi.fn().mockResolvedValue("v1");
		const cache = new TTLCache(1000, lookup);
		await expect(cache.get()).resolves.toBe("v1");
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it("returns cached value within TTL without re-invoking lookup", async () => {
		const lookup = vi.fn().mockResolvedValue("v1");
		const cache = new TTLCache(1000, lookup);
		await cache.get();
		vi.advanceTimersByTime(999);
		await expect(cache.get()).resolves.toBe("v1");
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it("re-invokes lookup after TTL elapses", async () => {
		const lookup = vi
			.fn()
			.mockResolvedValueOnce("v1")
			.mockResolvedValueOnce("v2");
		const cache = new TTLCache(1000, lookup);
		await expect(cache.get()).resolves.toBe("v1");
		vi.advanceTimersByTime(1001);
		await expect(cache.get()).resolves.toBe("v2");
		expect(lookup).toHaveBeenCalledTimes(2);
	});

	it("deduplicates concurrent in-flight lookups", async () => {
		let resolveLookup: (v: string) => void = () => {};
		const lookup = vi.fn().mockImplementation(
			() =>
				new Promise<string>((r) => {
					resolveLookup = r;
				}),
		);
		const cache = new TTLCache(1000, lookup);
		const a = cache.get();
		const b = cache.get();
		const c = cache.get();
		resolveLookup("v1");
		await expect(a).resolves.toBe("v1");
		await expect(b).resolves.toBe("v1");
		await expect(c).resolves.toBe("v1");
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it("does not cache failed lookups (next call retries)", async () => {
		const lookup = vi
			.fn()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce("v2");
		const cache = new TTLCache(1000, lookup);
		await expect(cache.get()).rejects.toThrow("boom");
		await expect(cache.get()).resolves.toBe("v2");
		expect(lookup).toHaveBeenCalledTimes(2);
	});

	it("invalidate() forces next call to re-invoke lookup", async () => {
		const lookup = vi
			.fn()
			.mockResolvedValueOnce("v1")
			.mockResolvedValueOnce("v2");
		const cache = new TTLCache(1000, lookup);
		await cache.get();
		cache.invalidate();
		await expect(cache.get()).resolves.toBe("v2");
		expect(lookup).toHaveBeenCalledTimes(2);
	});
});
