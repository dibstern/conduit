// ─── Unit Tests: MessagePollerManager ─────────────────────────────────────────

import { describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { MessagePollerManager } from "../../../src/lib/relay/message-poller-manager.js";

/**
 * Create a mock OpenCode client for testing.
 * getMessages returns empty array by default.
 */
function makeMockClient() {
	return {
		getMessages: vi.fn().mockResolvedValue([]),
	};
}

describe("MessagePollerManager", () => {
	it("starts independent pollers for different sessions", () => {
		const mgr = new MessagePollerManager(new ServiceRegistry(), {
			client: makeMockClient(),
			log: createSilentLogger(),
			interval: 60_000, // Long interval to prevent actual polling
		});
		mgr.startPolling("sess-1");
		mgr.startPolling("sess-2");
		expect(mgr.isPolling("sess-1")).toBe(true);
		expect(mgr.isPolling("sess-2")).toBe(true);
		expect(mgr.size).toBe(2);
		mgr.stopAll();
	});

	it("isPolling() without arg returns true when any poller is active", () => {
		const mgr = new MessagePollerManager(new ServiceRegistry(), {
			client: makeMockClient(),
			log: createSilentLogger(),
			interval: 60_000,
		});
		expect(mgr.isPolling()).toBe(false);
		mgr.startPolling("sess-1");
		expect(mgr.isPolling()).toBe(true);
		mgr.stopAll();
	});

	it("stops only the specified session's poller", () => {
		const mgr = new MessagePollerManager(new ServiceRegistry(), {
			client: makeMockClient(),
			log: createSilentLogger(),
			interval: 60_000,
		});
		mgr.startPolling("sess-1");
		mgr.startPolling("sess-2");
		mgr.stopPolling("sess-1");
		expect(mgr.isPolling("sess-1")).toBe(false);
		expect(mgr.isPolling("sess-2")).toBe(true);
		expect(mgr.size).toBe(1);
		mgr.stopAll();
	});

	it("allows unlimited concurrent pollers (capacity gated by reducer)", () => {
		const mgr = new MessagePollerManager(new ServiceRegistry(), {
			client: makeMockClient(),
			log: createSilentLogger(),
			interval: 60_000,
		});
		for (let i = 0; i < 11; i++) mgr.startPolling(`sess-${i}`);
		expect(mgr.isPolling("sess-10")).toBe(true);
		expect(mgr.size).toBe(11);
		mgr.stopAll();
	});

	it("allows up to 10 concurrent pollers", () => {
		const mgr = new MessagePollerManager(new ServiceRegistry(), {
			client: makeMockClient(),
			log: createSilentLogger(),
			interval: 60_000,
		});
		for (let i = 1; i <= 10; i++) {
			mgr.startPolling(`session-${i}`);
		}
		expect(mgr.size).toBe(10);
		mgr.stopAll();
	});

	it("allows more than 10 concurrent pollers (capacity gated upstream)", () => {
		const mgr = new MessagePollerManager(new ServiceRegistry(), {
			client: makeMockClient(),
			log: createSilentLogger(),
			interval: 60_000,
		});
		for (let i = 1; i <= 15; i++) {
			mgr.startPolling(`session-${i}`);
		}
		expect(mgr.size).toBe(15);
		mgr.stopAll();
	});

	it("no-op when starting a poller that already exists", () => {
		const mgr = new MessagePollerManager(new ServiceRegistry(), {
			client: makeMockClient(),
			log: createSilentLogger(),
			interval: 60_000,
		});
		mgr.startPolling("sess-1");
		mgr.startPolling("sess-1"); // Should be a no-op
		expect(mgr.size).toBe(1);
		mgr.stopAll();
	});

	it("stopAll clears all pollers", () => {
		const mgr = new MessagePollerManager(new ServiceRegistry(), {
			client: makeMockClient(),
			log: createSilentLogger(),
			interval: 60_000,
		});
		mgr.startPolling("sess-1");
		mgr.startPolling("sess-2");
		mgr.startPolling("sess-3");
		expect(mgr.size).toBe(3);
		mgr.stopAll();
		expect(mgr.size).toBe(0);
		expect(mgr.isPolling()).toBe(false);
	});

	it("stopPolling is no-op for unknown session", () => {
		const mgr = new MessagePollerManager(new ServiceRegistry(), {
			client: makeMockClient(),
			log: createSilentLogger(),
			interval: 60_000,
		});
		// Should not throw
		mgr.stopPolling("nonexistent");
		expect(mgr.size).toBe(0);
	});

	it("notifySSEEvent and emitDone are no-ops for unknown sessions", () => {
		const mgr = new MessagePollerManager(new ServiceRegistry(), {
			client: makeMockClient(),
			log: createSilentLogger(),
			interval: 60_000,
		});
		// Should not throw
		mgr.notifySSEEvent("nonexistent");
		mgr.emitDone("nonexistent");
	});

	it("getPollingSessionIds returns all active session IDs", () => {
		const mgr = new MessagePollerManager(new ServiceRegistry(), {
			client: makeMockClient(),
			log: createSilentLogger(),
			interval: 60_000,
		});
		mgr.startPolling("sess-a");
		mgr.startPolling("sess-b");
		const ids = mgr.getPollingSessionIds();
		expect(ids.sort()).toEqual(["sess-a", "sess-b"]);
		mgr.stopAll();
	});

	it("can restart a session after stopping it", () => {
		const mgr = new MessagePollerManager(new ServiceRegistry(), {
			client: makeMockClient(),
			log: createSilentLogger(),
			interval: 60_000,
		});
		mgr.startPolling("sess-1");
		expect(mgr.isPolling("sess-1")).toBe(true);
		mgr.stopPolling("sess-1");
		expect(mgr.isPolling("sess-1")).toBe(false);
		mgr.startPolling("sess-1");
		expect(mgr.isPolling("sess-1")).toBe(true);
		mgr.stopAll();
	});

	it("emits events with sessionId when poller finds content", async () => {
		const mockClient = makeMockClient();
		// Return a message with text content on the first poll
		mockClient.getMessages.mockResolvedValue([
			{
				id: "msg-1",
				role: "user",
				parts: [{ id: "p-1", type: "text", text: "Hello" }],
			},
		]);

		const mgr = new MessagePollerManager(new ServiceRegistry(), {
			client: mockClient,
			log: createSilentLogger(),
			interval: 50, // Fast polling for test
		});

		const received: Array<{ events: unknown[]; sessionId: string }> = [];
		mgr.on("events", (events, sessionId) =>
			received.push({ events, sessionId }),
		);

		mgr.startPolling("sess-1");

		// Wait for at least one poll cycle
		await new Promise((r) => setTimeout(r, 200));

		expect(received.length).toBeGreaterThan(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(received[0]!.sessionId).toBe("sess-1");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(received[0]!.events.length).toBeGreaterThan(0);

		mgr.stopAll();
	});

	// ─── Viewer tracking (delegated to external hasViewers function) ────

	describe("viewer tracking", () => {
		it("hasViewers delegates to injected function", () => {
			const viewers = new Set<string>();
			const mgr = new MessagePollerManager(new ServiceRegistry(), {
				client: makeMockClient(),
				log: createSilentLogger(),
				interval: 60_000,
				hasViewers: (sid) => viewers.has(sid),
			});

			expect(mgr.hasViewers("sess-1")).toBe(false);
			viewers.add("sess-1");
			expect(mgr.hasViewers("sess-1")).toBe(true);
			mgr.stopAll();
		});

		it("hasViewers returns false when no function is injected", () => {
			const mgr = new MessagePollerManager(new ServiceRegistry(), {
				client: makeMockClient(),
				log: createSilentLogger(),
				interval: 60_000,
			});

			// Without hasViewers callback, always returns false
			expect(mgr.hasViewers("sess-1")).toBe(false);
			mgr.stopAll();
		});

		it("hasViewers reflects external state changes", () => {
			const viewers = new Set<string>();
			const mgr = new MessagePollerManager(new ServiceRegistry(), {
				client: makeMockClient(),
				log: createSilentLogger(),
				interval: 60_000,
				hasViewers: (sid) => viewers.has(sid),
			});

			viewers.add("sess-1");
			viewers.add("sess-2");

			expect(mgr.hasViewers("sess-1")).toBe(true);
			expect(mgr.hasViewers("sess-2")).toBe(true);
			expect(mgr.hasViewers("sess-3")).toBe(false);

			viewers.delete("sess-1");
			expect(mgr.hasViewers("sess-1")).toBe(false);
			expect(mgr.hasViewers("sess-2")).toBe(true);

			mgr.stopAll();
		});

		it("passes hasViewers callback to individual pollers", async () => {
			const mockClient = makeMockClient();
			const viewers = new Set(["sess-1"]);
			const mgr = new MessagePollerManager(new ServiceRegistry(), {
				client: mockClient,
				log: createSilentLogger(),
				interval: 50,
				hasViewers: (sid) => viewers.has(sid),
			});

			// Start polling — the poller should receive hasViewers callback
			mgr.startPolling("sess-1");

			// Verify the wiring works — the poller.test.ts tests cover the
			// actual timeout behavior with fake timers
			expect(mgr.isPolling("sess-1")).toBe(true);
			expect(mgr.hasViewers("sess-1")).toBe(true);

			mgr.stopAll();
		});
	});

	// ─── drain() ───────────────────────────────────────────────────────

	describe("drain", () => {
		it("stops all child pollers and completes drain", async () => {
			const registry = new ServiceRegistry();
			const mgr = new MessagePollerManager(registry, {
				client: makeMockClient(),
				log: createSilentLogger(),
				interval: 60_000,
			});

			mgr.startPolling("sess-1");
			mgr.startPolling("sess-2");
			mgr.startPolling("sess-3");
			expect(mgr.size).toBe(3);

			await mgr.drain();

			expect(mgr.size).toBe(0);
			expect(mgr.isPolling()).toBe(false);
			expect(mgr.isPolling("sess-1")).toBe(false);
			expect(mgr.isPolling("sess-2")).toBe(false);
			expect(mgr.isPolling("sess-3")).toBe(false);
		});

		it("drain is safe to call with no active pollers", async () => {
			const registry = new ServiceRegistry();
			const mgr = new MessagePollerManager(registry, {
				client: makeMockClient(),
				log: createSilentLogger(),
				interval: 60_000,
			});

			// Should not throw
			await mgr.drain();
			expect(mgr.size).toBe(0);
		});
	});
});
