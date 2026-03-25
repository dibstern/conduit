// ─── Version Check Tests (Ticket 3.4) ──────────────────────────────────────────
// Tests for VersionChecker: semver comparison, npm registry fetch, periodic
// checking, event emission, error resilience, and property-based tests.

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import {
	fetchLatestVersion,
	isNewer,
	VersionChecker,
} from "../../../src/lib/daemon/version-check.js";

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Create a mock fetch that returns a given version. */
function mockFetchOk(version: string): typeof globalThis.fetch {
	return vi.fn(
		async () =>
			new Response(JSON.stringify({ version }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
	) as unknown as typeof globalThis.fetch;
}

/** Create a mock fetch that returns an HTTP error. */
function mockFetchError(status: number): typeof globalThis.fetch {
	return vi.fn(
		async () => new Response("Not Found", { status }),
	) as unknown as typeof globalThis.fetch;
}

/** Create a mock fetch that rejects with a network error. */
function mockFetchNetworkError(
	message = "Network error",
): typeof globalThis.fetch {
	return vi.fn(async () => {
		throw new Error(message);
	}) as unknown as typeof globalThis.fetch;
}

// ─── isNewer() ─────────────────────────────────────────────────────────────────

describe("Ticket 3.4 — isNewer()", () => {
	it("returns false for equal versions", () => {
		expect(isNewer("1.0.0", "1.0.0")).toBe(false);
	});

	it("returns true when latest has newer major", () => {
		expect(isNewer("1.0.0", "2.0.0")).toBe(true);
	});

	it("returns true when latest has newer minor", () => {
		expect(isNewer("1.0.0", "1.1.0")).toBe(true);
	});

	it("returns true when latest has newer patch", () => {
		expect(isNewer("1.0.0", "1.0.1")).toBe(true);
	});

	it("returns false when current is newer (major)", () => {
		expect(isNewer("2.0.0", "1.0.0")).toBe(false);
	});

	it("returns false when current is newer (minor)", () => {
		expect(isNewer("1.2.0", "1.1.0")).toBe(false);
	});

	it("returns false when current is newer (patch)", () => {
		expect(isNewer("1.0.2", "1.0.1")).toBe(false);
	});

	it("handles leading 'v' prefix on current", () => {
		expect(isNewer("v1.0.0", "1.1.0")).toBe(true);
	});

	it("handles leading 'v' prefix on latest", () => {
		expect(isNewer("1.0.0", "v1.1.0")).toBe(true);
	});

	it("handles leading 'v' on both", () => {
		expect(isNewer("v1.0.0", "v1.0.0")).toBe(false);
		expect(isNewer("v1.0.0", "v2.0.0")).toBe(true);
	});

	// Pre-release tags
	it("pre-release is older than release with same version", () => {
		expect(isNewer("1.0.0-beta", "1.0.0")).toBe(true);
	});

	it("release is not newer than itself as pre-release", () => {
		expect(isNewer("1.0.0", "1.0.0-beta")).toBe(false);
	});

	it("pre-release with same base: beta < rc", () => {
		expect(isNewer("1.0.0-beta", "1.0.0-rc")).toBe(true);
	});

	it("pre-release with same base: alpha < beta", () => {
		expect(isNewer("1.0.0-alpha", "1.0.0-beta")).toBe(true);
	});

	it("numeric pre-release comparison: 1 < 2", () => {
		expect(isNewer("1.0.0-1", "1.0.0-2")).toBe(true);
	});

	it("pre-release with dots: alpha.1 < alpha.2", () => {
		expect(isNewer("1.0.0-alpha.1", "1.0.0-alpha.2")).toBe(true);
	});

	it("returns false for invalid versions", () => {
		expect(isNewer("not-a-version", "1.0.0")).toBe(false);
		expect(isNewer("1.0.0", "not-a-version")).toBe(false);
	});

	// parseSemver edge cases
	it("returns false for version with only 2 segments (e.g. '1.0')", () => {
		expect(isNewer("1.0", "2.0.0")).toBe(false);
		expect(isNewer("2.0.0", "1.0")).toBe(false);
	});

	it("returns false for version with 4 segments (e.g. '1.0.0.0')", () => {
		expect(isNewer("1.0.0.0", "2.0.0")).toBe(false);
		expect(isNewer("2.0.0", "1.0.0.0")).toBe(false);
	});

	// Downgrade detection
	it("returns false when latest is a downgrade (current=2.0.0, latest=1.0.0)", () => {
		expect(isNewer("2.0.0", "1.0.0")).toBe(false);
	});
});

// ─── fetchLatestVersion() ──────────────────────────────────────────────────────

describe("Ticket 3.4 — fetchLatestVersion()", () => {
	it("returns version from registry response", async () => {
		const fetcher = mockFetchOk("2.5.0");
		const version = await fetchLatestVersion(
			"conduit",
			"https://registry.npmjs.org",
			fetcher,
		);
		expect(version).toBe("2.5.0");
	});

	it("calls the correct URL", async () => {
		const fetcher = mockFetchOk("1.0.0");
		await fetchLatestVersion(
			"my-package",
			"https://registry.npmjs.org",
			fetcher,
		);

		expect(fetcher).toHaveBeenCalledWith(
			"https://registry.npmjs.org/my-package/latest",
			expect.objectContaining({ headers: { Accept: "application/json" } }),
		);
	});

	it("throws on 404 response", async () => {
		const fetcher = mockFetchError(404);
		await expect(
			fetchLatestVersion(
				"nonexistent-pkg",
				"https://registry.npmjs.org",
				fetcher,
			),
		).rejects.toThrow(/404/);
	});

	it("throws on 500 response", async () => {
		const fetcher = mockFetchError(500);
		await expect(
			fetchLatestVersion("conduit", "https://registry.npmjs.org", fetcher),
		).rejects.toThrow(/500/);
	});

	it("throws on network error", async () => {
		const fetcher = mockFetchNetworkError("DNS lookup failed");
		await expect(
			fetchLatestVersion("conduit", "https://registry.npmjs.org", fetcher),
		).rejects.toThrow(/DNS lookup failed/);
	});

	it("throws if response has no version field", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(JSON.stringify({ name: "conduit" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as typeof globalThis.fetch;

		await expect(
			fetchLatestVersion("conduit", "https://registry.npmjs.org", fetcher),
		).rejects.toThrow(/no version field/);
	});
});

// ─── VersionChecker.check() ────────────────────────────────────────────────────

describe("Ticket 3.4 — VersionChecker.check()", () => {
	it("returns correct result shape when no update", async () => {
		const fetcher = mockFetchOk("1.0.0");
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			_fetch: fetcher,
		});

		const result = await checker.check();
		expect(result).toEqual({
			current: "1.0.0",
			latest: "1.0.0",
			updateAvailable: false,
		});
	});

	it("returns correct result shape when update available", async () => {
		const fetcher = mockFetchOk("2.0.0");
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			_fetch: fetcher,
		});

		const result = await checker.check();
		expect(result).toEqual({
			current: "1.0.0",
			latest: "2.0.0",
			updateAvailable: true,
		});
	});

	it("emits update_available when newer version found", async () => {
		const fetcher = mockFetchOk("2.0.0");
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			_fetch: fetcher,
		});

		const events: Array<{ current: string; latest: string }> = [];
		checker.on("update_available", (data) => events.push(data));

		await checker.check();

		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({ current: "1.0.0", latest: "2.0.0" });
	});

	it("does not emit update_available when no update", async () => {
		const fetcher = mockFetchOk("1.0.0");
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			_fetch: fetcher,
		});

		const events: unknown[] = [];
		checker.on("update_available", (data) => events.push(data));

		await checker.check();

		expect(events).toHaveLength(0);
	});

	it("throws on network error (check does not catch)", async () => {
		const fetcher = mockFetchNetworkError("Connection refused");
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			_fetch: fetcher,
		});

		await expect(checker.check()).rejects.toThrow(/Connection refused/);
	});

	it("downgrade detection: current=2.0.0, latest=1.0.0 returns updateAvailable: false", async () => {
		const fetcher = mockFetchOk("1.0.0");
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "2.0.0",
			_fetch: fetcher,
		});

		const events: unknown[] = [];
		checker.on("update_available", (data) => events.push(data));

		const result = await checker.check();

		expect(result.updateAvailable).toBe(false);
		expect(result.current).toBe("2.0.0");
		expect(result.latest).toBe("1.0.0");
		// Should not emit update_available for a downgrade
		expect(events).toHaveLength(0);
	});
});

// ─── VersionChecker.start() / stop() ──────────────────────────────────────────

describe("Ticket 3.4 — VersionChecker.start() / stop()", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("performs immediate check on start", async () => {
		const fetcher = mockFetchOk("2.0.0");
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			checkInterval: 60_000,
			_fetch: fetcher,
		});

		const events: unknown[] = [];
		checker.on("update_available", (data) => events.push(data));

		checker.start();

		// Advance just enough for the initial async check to resolve
		await vi.advanceTimersByTimeAsync(1);

		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(events).toHaveLength(1);

		checker.stop();
	});

	it("performs periodic checks at the configured interval", async () => {
		const fetcher = mockFetchOk("2.0.0");
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			checkInterval: 60_000,
			_fetch: fetcher,
		});

		checker.start();

		// Initial check
		await vi.advanceTimersByTimeAsync(1);
		expect(fetcher).toHaveBeenCalledTimes(1);

		// Advance by one interval
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetcher).toHaveBeenCalledTimes(2);

		// Advance by another interval
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetcher).toHaveBeenCalledTimes(3);

		checker.stop();
	});

	it("stop() clears the interval", async () => {
		const fetcher = mockFetchOk("2.0.0");
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			checkInterval: 60_000,
			_fetch: fetcher,
		});

		checker.start();
		await vi.advanceTimersByTimeAsync(1);
		expect(fetcher).toHaveBeenCalledTimes(1);

		checker.stop();

		// Advance time — no more calls
		await vi.advanceTimersByTimeAsync(120_000);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("stop() is safe to call multiple times", () => {
		const fetcher = mockFetchOk("1.0.0");
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			_fetch: fetcher,
		});

		checker.start();
		checker.stop();
		checker.stop(); // Should not throw
	});

	it("stop() is safe before start", () => {
		const fetcher = mockFetchOk("1.0.0");
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			_fetch: fetcher,
		});

		checker.stop(); // Should not throw
	});
});

// ─── enabled: false (--no-update) ──────────────────────────────────────────────

describe("Ticket 3.4 — enabled: false (--no-update)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("start() is a no-op when enabled is false", async () => {
		const fetcher = mockFetchOk("2.0.0");
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			enabled: false,
			_fetch: fetcher,
		});

		checker.start();
		await vi.advanceTimersByTimeAsync(1);

		expect(fetcher).not.toHaveBeenCalled();
	});

	it("does not set up an interval when disabled", async () => {
		const fetcher = mockFetchOk("2.0.0");
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			enabled: false,
			checkInterval: 1_000,
			_fetch: fetcher,
		});

		checker.start();

		await vi.advanceTimersByTimeAsync(10_000);

		expect(fetcher).not.toHaveBeenCalled();
	});
});

// ─── Accessor methods ──────────────────────────────────────────────────────────

describe("Ticket 3.4 — isUpdateAvailable() / getLatestVersion()", () => {
	it("isUpdateAvailable() returns false before any check", () => {
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			_fetch: mockFetchOk("1.0.0"),
		});
		expect(checker.isUpdateAvailable()).toBe(false);
	});

	it("getLatestVersion() returns null before any check", () => {
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			_fetch: mockFetchOk("1.0.0"),
		});
		expect(checker.getLatestVersion()).toBeNull();
	});

	it("isUpdateAvailable() returns true after check finds update", async () => {
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			_fetch: mockFetchOk("2.0.0"),
		});

		await checker.check();
		expect(checker.isUpdateAvailable()).toBe(true);
	});

	it("isUpdateAvailable() returns false after check finds no update", async () => {
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			_fetch: mockFetchOk("1.0.0"),
		});

		await checker.check();
		expect(checker.isUpdateAvailable()).toBe(false);
	});

	it("getLatestVersion() returns version after check", async () => {
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			_fetch: mockFetchOk("3.1.4"),
		});

		await checker.check();
		expect(checker.getLatestVersion()).toBe("3.1.4");
	});
});

// ─── Error resilience (AC6) ───────────────────────────────────────────────────

describe("Ticket 3.4 — Error resilience (AC6)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("emits check_error on network failure, does not throw", async () => {
		const fetcher = mockFetchNetworkError("ECONNREFUSED");
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			checkInterval: 60_000,
			_fetch: fetcher,
		});

		const errors: Array<{ error: Error }> = [];
		checker.on("check_error", (data) => errors.push(data));

		checker.start();
		await vi.advanceTimersByTimeAsync(1);

		expect(errors).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(errors[0]!.error.message).toMatch(/ECONNREFUSED/);

		checker.stop();
	});

	it("continues interval after error", async () => {
		let callCount = 0;
		const fetcher = vi.fn(async () => {
			callCount++;
			if (callCount === 1) {
				throw new Error("First call fails");
			}
			return new Response(JSON.stringify({ version: "2.0.0" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof globalThis.fetch;

		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			checkInterval: 60_000,
			_fetch: fetcher,
		});

		const errors: Array<{ error: Error }> = [];
		const updates: Array<{ current: string; latest: string }> = [];
		checker.on("check_error", (data) => errors.push(data));
		checker.on("update_available", (data) => updates.push(data));

		checker.start();

		// Initial check (fails)
		await vi.advanceTimersByTimeAsync(1);
		expect(errors).toHaveLength(1);
		expect(updates).toHaveLength(0);

		// Second check (succeeds)
		await vi.advanceTimersByTimeAsync(60_000);
		expect(updates).toHaveLength(1);

		checker.stop();
	});

	it("emits check_error on HTTP error, does not throw", async () => {
		const fetcher = mockFetchError(500);
		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			checkInterval: 60_000,
			_fetch: fetcher,
		});

		const errors: Array<{ error: Error }> = [];
		checker.on("check_error", (data) => errors.push(data));

		checker.start();
		await vi.advanceTimersByTimeAsync(1);

		expect(errors).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(errors[0]!.error.message).toMatch(/500/);

		checker.stop();
	});

	it("recovers after error: start() -> error on first check -> timer -> succeeds on second", async () => {
		let callCount = 0;
		const fetcher = vi.fn(async () => {
			callCount++;
			if (callCount === 1) {
				throw new Error("Temporary failure");
			}
			return new Response(JSON.stringify({ version: "3.0.0" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof globalThis.fetch;

		const checker = new VersionChecker(new ServiceRegistry(), {
			currentVersion: "1.0.0",
			checkInterval: 60_000,
			_fetch: fetcher,
		});

		const errors: Array<{ error: Error }> = [];
		const updates: Array<{ current: string; latest: string }> = [];
		checker.on("check_error", (data) => errors.push(data));
		checker.on("update_available", (data) => updates.push(data));

		checker.start();

		// Initial check (fails)
		await vi.advanceTimersByTimeAsync(1);
		expect(errors).toHaveLength(1);
		expect(checker.isUpdateAvailable()).toBe(false);
		expect(checker.getLatestVersion()).toBeNull();

		// Advance to next interval (succeeds)
		await vi.advanceTimersByTimeAsync(60_000);
		expect(updates).toHaveLength(1);
		expect(checker.isUpdateAvailable()).toBe(true);
		expect(checker.getLatestVersion()).toBe("3.0.0");

		checker.stop();
	});
});

// ─── TrackedService integration (drain) ────────────────────────────────────────

describe("Ticket 3.4 — TrackedService drain() integration", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("after drain(), interval no longer fires", async () => {
		const fetcher = mockFetchOk("2.0.0");
		const registry = new ServiceRegistry();
		const checker = new VersionChecker(registry, {
			currentVersion: "1.0.0",
			checkInterval: 60_000,
			_fetch: fetcher,
		});

		checker.start();

		// Initial check resolves
		await vi.advanceTimersByTimeAsync(1);
		expect(fetcher).toHaveBeenCalledTimes(1);

		// Drain the registry (clears all tracked timers/signals)
		await registry.drainAll();

		// Advance past several intervals — no more calls
		await vi.advanceTimersByTimeAsync(300_000);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("in-flight fetch is aborted by drain", async () => {
		let capturedSignal: AbortSignal | undefined;
		const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
			capturedSignal = init?.signal ?? undefined;
			// Simulate a slow response that rejects on abort
			return new Promise<Response>((resolve, reject) => {
				if (capturedSignal) {
					capturedSignal.addEventListener("abort", () => {
						reject(new DOMException("The operation was aborted", "AbortError"));
					});
				}
				// Resolve after a long delay (simulating slow network)
				setTimeout(
					() =>
						resolve(
							new Response(JSON.stringify({ version: "2.0.0" }), {
								status: 200,
								headers: { "Content-Type": "application/json" },
							}),
						),
					60_000,
				);
			});
		}) as unknown as typeof globalThis.fetch;

		const registry = new ServiceRegistry();
		const checker = new VersionChecker(registry, {
			currentVersion: "1.0.0",
			checkInterval: 300_000,
			_fetch: fetcher,
		});

		// Start triggers runCheck() which calls check() -> fetchLatestVersion()
		checker.start();

		// Let the microtask for runCheck start the fetch
		await vi.advanceTimersByTimeAsync(1);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(capturedSignal).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(capturedSignal!.aborted).toBe(false);

		// Drain aborts the signal
		await registry.drainAll();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(capturedSignal!.aborted).toBe(true);
	});
});

// ─── Property-based tests ──────────────────────────────────────────────────────

describe("Ticket 3.4 — PBT: isNewer() properties", () => {
	const semverArb = fc
		.tuple(fc.nat({ max: 99 }), fc.nat({ max: 99 }), fc.nat({ max: 99 }))
		.map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

	it("isNewer(v, v) is always false (irreflexivity)", () => {
		fc.assert(
			fc.property(semverArb, (v) => {
				expect(isNewer(v, v)).toBe(false);
			}),
		);
	});

	it("if isNewer(a, b) then !isNewer(b, a) (asymmetry)", () => {
		fc.assert(
			fc.property(semverArb, semverArb, (a, b) => {
				if (isNewer(a, b)) {
					expect(isNewer(b, a)).toBe(false);
				}
			}),
		);
	});

	it("isNewer is transitive", () => {
		fc.assert(
			fc.property(semverArb, semverArb, semverArb, (a, b, c) => {
				if (isNewer(a, b) && isNewer(b, c)) {
					expect(isNewer(a, c)).toBe(true);
				}
			}),
		);
	});

	it("v prefix does not change the result", () => {
		fc.assert(
			fc.property(semverArb, semverArb, (a, b) => {
				expect(isNewer(`v${a}`, b)).toBe(isNewer(a, b));
				expect(isNewer(a, `v${b}`)).toBe(isNewer(a, b));
			}),
		);
	});
});
