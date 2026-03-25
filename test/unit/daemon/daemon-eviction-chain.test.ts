// ─── Daemon Eviction Chain Test (Gap 5) ──────────────────────────────────────
// Tests the full chain: StorageMonitor emits low_disk_space → daemon handler
// calls MessageCache.evictOldestSession() → sessions are actually evicted.
//
// Uses real StorageMonitor (with injected _statfs) and real MessageCache
// (backed by a temp directory) to verify the integration works end-to-end.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { StorageMonitor } from "../../../src/lib/daemon/storage-monitor.js";
import { MessageCache } from "../../../src/lib/relay/message-cache.js";
import type { RelayMessage } from "../../../src/lib/types.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

let testDir: string;

function createTestDir(): string {
	const dir = join(
		tmpdir(),
		`eviction-chain-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Seed a MessageCache session with some events */
function seedSession(cache: MessageCache, sessionId: string, count = 3): void {
	for (let i = 0; i < count; i++) {
		cache.recordEvent(sessionId, {
			type: "delta",
			text: `event-${i}`,
		} as RelayMessage);
	}
}

beforeEach(() => {
	testDir = createTestDir();
});

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		// Best effort cleanup
	}
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("StorageMonitor → daemon → MessageCache eviction chain (AC8)", () => {
	it("evicts oldest session from real MessageCache when low_disk_space fires", async () => {
		// Set up a real MessageCache with multiple sessions
		const cacheDir = join(testDir, "cache");
		const cache = new MessageCache(cacheDir);

		// Seed sessions with staggered access times
		seedSession(cache, "session-old", 2);
		// Small delay so "session-old" has an earlier lastAccessedAt
		await new Promise((resolve) => setTimeout(resolve, 10));
		seedSession(cache, "session-new", 2);

		expect(cache.sessionCount()).toBe(2);
		expect(cache.has("session-old")).toBe(true);
		expect(cache.has("session-new")).toBe(true);

		// Set up StorageMonitor with injected _statfs that reports low space
		const threshold = 100 * 1024 * 1024; // 100MB
		const lowSpace = threshold - 1;

		const statfs = vi.fn(async (_path: string) => ({
			available: lowSpace,
		}));

		const monitor = new StorageMonitor(new ServiceRegistry(), {
			path: testDir,
			thresholdBytes: threshold,
			intervalMs: 60_000, // Won't fire — we control checks manually
			_statfs: statfs,
		});

		// Wire up the daemon's eviction handler (mirrors daemon.ts logic)
		const MAX_EVICTIONS = 3;
		const evictedSessions: string[] = [];

		monitor.on("low_disk_space", () => {
			for (let i = 0; i < MAX_EVICTIONS; i++) {
				const evicted = cache.evictOldestSession();
				if (!evicted) break;
				evictedSessions.push(evicted);
			}
		});

		// Start the monitor — first check runs immediately
		monitor.start();

		// Wait for the async check to complete
		await vi.waitFor(() => {
			expect(statfs).toHaveBeenCalled();
		});

		// Wait for the event handler to run and evict
		await vi.waitFor(() => {
			expect(evictedSessions.length).toBeGreaterThanOrEqual(1);
		});

		monitor.stop();

		// The oldest session should have been evicted
		expect(evictedSessions).toContain("session-old");
		expect(cache.has("session-old")).toBe(false);

		// The newer session may also be evicted (MAX_EVICTIONS=3, 2 sessions)
		// but the key assertion is that eviction actually happened
		expect(evictedSessions.length).toBeGreaterThanOrEqual(1);
	});

	it("evicts up to MAX_EVICTIONS per relay when multiple sessions exist", async () => {
		const cacheDir = join(testDir, "cache2");
		const cache = new MessageCache(cacheDir);

		// Seed 5 sessions with staggered access times
		for (let i = 0; i < 5; i++) {
			seedSession(cache, `session-${i}`, 2);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		expect(cache.sessionCount()).toBe(5);

		const threshold = 100 * 1024 * 1024;
		const statfs = vi.fn(async (_path: string) => ({
			available: threshold - 1,
		}));

		const monitor = new StorageMonitor(new ServiceRegistry(), {
			path: testDir,
			thresholdBytes: threshold,
			intervalMs: 60_000,
			_statfs: statfs,
		});

		const MAX_EVICTIONS = 3;
		const evictedSessions: string[] = [];

		monitor.on("low_disk_space", () => {
			for (let i = 0; i < MAX_EVICTIONS; i++) {
				const evicted = cache.evictOldestSession();
				if (!evicted) break;
				evictedSessions.push(evicted);
			}
		});

		monitor.start();
		await vi.waitFor(() => {
			expect(statfs).toHaveBeenCalled();
		});
		await vi.waitFor(() => {
			expect(evictedSessions).toHaveLength(3);
		});
		monitor.stop();

		// Exactly 3 sessions evicted (MAX_EVICTIONS_PER_RELAY)
		expect(evictedSessions).toHaveLength(3);
		// The 3 oldest (session-0, session-1, session-2) should be gone
		expect(evictedSessions).toContain("session-0");
		expect(evictedSessions).toContain("session-1");
		expect(evictedSessions).toContain("session-2");

		// The 2 newest should still exist
		expect(cache.has("session-3")).toBe(true);
		expect(cache.has("session-4")).toBe(true);
		expect(cache.sessionCount()).toBe(2);
	});

	it("does not evict when disk space is above threshold", async () => {
		const cacheDir = join(testDir, "cache3");
		const cache = new MessageCache(cacheDir);

		seedSession(cache, "keep-me", 3);
		expect(cache.sessionCount()).toBe(1);

		const threshold = 100 * 1024 * 1024;
		const statfs = vi.fn(async (_path: string) => ({
			available: threshold + 1_000_000, // Well above threshold
		}));

		const monitor = new StorageMonitor(new ServiceRegistry(), {
			path: testDir,
			thresholdBytes: threshold,
			intervalMs: 60_000,
			_statfs: statfs,
		});

		const evictedSessions: string[] = [];
		monitor.on("low_disk_space", () => {
			const evicted = cache.evictOldestSession();
			if (evicted) evictedSessions.push(evicted);
		});

		monitor.start();
		await vi.waitFor(() => {
			expect(statfs).toHaveBeenCalled();
		});
		monitor.stop();

		// No eviction — space is fine
		expect(evictedSessions).toHaveLength(0);
		expect(cache.has("keep-me")).toBe(true);
		expect(cache.sessionCount()).toBe(1);
	});

	it("handles empty cache gracefully when low_disk_space fires", async () => {
		const cacheDir = join(testDir, "cache4");
		const cache = new MessageCache(cacheDir);

		// No sessions seeded
		expect(cache.sessionCount()).toBe(0);

		const threshold = 100 * 1024 * 1024;
		const statfs = vi.fn(async (_path: string) => ({
			available: threshold - 1,
		}));

		const monitor = new StorageMonitor(new ServiceRegistry(), {
			path: testDir,
			thresholdBytes: threshold,
			intervalMs: 60_000,
			_statfs: statfs,
		});

		const evictedSessions: (string | null)[] = [];
		monitor.on("low_disk_space", () => {
			const evicted = cache.evictOldestSession();
			evictedSessions.push(evicted);
		});

		monitor.start();
		await vi.waitFor(() => {
			expect(statfs).toHaveBeenCalled();
		});
		await vi.waitFor(() => {
			expect(evictedSessions).toEqual([null]);
		});
		monitor.stop();
	});
});
