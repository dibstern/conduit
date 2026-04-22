import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import type { SessionStatus } from "../../../src/lib/instance/sdk-types.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import {
	SessionStatusPoller,
	type SessionStatusPollerOptions,
} from "../../../src/lib/session/session-status-poller.js";

function createMockClient(
	statuses: Record<string, SessionStatus> = {},
	sessionDetail: { id: string; parentID?: string } = { id: "unknown" },
) {
	return {
		session: {
			statuses: vi.fn().mockResolvedValue(statuses),
			get: vi.fn().mockResolvedValue(sessionDetail),
		},
	};
}

describe("SessionStatusPoller — augmentation features", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ─── Helper: run the immediate first poll (baseline) ───────────────────
	async function establishBaseline() {
		// The immediate poll in start() is a microtask — flush it
		await vi.advanceTimersByTimeAsync(0);
	}

	// ─── 1. Subagent fast path ────────────────────────────────────────────
	describe("subagent busy propagation (fast path — session parent map)", () => {
		it("marks the parent busy when a child is busy and in the parent map", async () => {
			const parentMap = new Map<string, string>([["child_1", "parent_1"]]);
			const client = createMockClient({ child_1: { type: "busy" } });
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log: createSilentLogger(),
				getSessionParentMap: () => parentMap,
			});

			const changed = vi.fn();
			poller.on("changed", changed);
			poller.start();

			// First poll: baseline (child_1 busy, parent_1 injected as busy)
			await establishBaseline();

			// Change child to idle — parent should also disappear → changed emitted
			client.session.statuses.mockResolvedValue({
				child_1: { type: "idle" },
			});
			await vi.advanceTimersByTimeAsync(500);

			expect(changed).toHaveBeenCalledTimes(1);
			// Baseline had parent_1: busy, now it's gone → changed

			// Verify the baseline included the parent
			const baselineStatuses = poller.getCurrentStatuses();
			// After the change, parent_1 should no longer be present
			expect(baselineStatuses["parent_1"]).toBeUndefined();

			// getSession should NOT have been called (fast path)
			expect(client.session.get).not.toHaveBeenCalled();

			poller.stop();
		});

		it("includes the propagated parent in the changed event", async () => {
			const parentMap = new Map<string, string>([["child_1", "parent_1"]]);
			// Start idle, then go busy
			const client = createMockClient({ child_1: { type: "idle" } });
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log: createSilentLogger(),
				getSessionParentMap: () => parentMap,
			});

			const changed = vi.fn();
			poller.on("changed", changed);
			poller.start();
			await establishBaseline();

			// Child becomes busy → parent should also appear as busy
			client.session.statuses.mockResolvedValue({
				child_1: { type: "busy" },
			});
			await vi.advanceTimersByTimeAsync(500);

			expect(changed).toHaveBeenCalledTimes(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const statuses = changed.mock.calls[0]![0] as Record<
				string,
				SessionStatus
			>;
			expect(statuses["child_1"]).toEqual({ type: "busy" });
			expect(statuses["parent_1"]).toEqual({ type: "busy" });

			poller.stop();
		});
	});

	// ─── 2. Subagent slow path ────────────────────────────────────────────
	describe("subagent busy propagation (slow path — API lookup)", () => {
		it("calls getSession() for a busy child not in parent map, then marks parent busy", async () => {
			const parentMap = new Map<string, string>(); // empty — no fast path
			const client = createMockClient(
				{ child_1: { type: "idle" } },
				{ id: "child_1", parentID: "parent_1" },
			);
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log: createSilentLogger(),
				getSessionParentMap: () => parentMap,
			});

			const changed = vi.fn();
			poller.on("changed", changed);
			poller.start();
			await establishBaseline();

			// Child becomes busy — not in parentMap, so getSession() is called
			client.session.statuses.mockResolvedValue({
				child_1: { type: "busy" },
			});
			await vi.advanceTimersByTimeAsync(500);

			expect(client.session.get).toHaveBeenCalledWith("child_1");
			expect(changed).toHaveBeenCalledTimes(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const statuses = changed.mock.calls[0]![0] as Record<
				string,
				SessionStatus
			>;
			expect(statuses["parent_1"]).toEqual({ type: "busy" });

			poller.stop();
		});
	});

	// ─── 3. Subagent cache ────────────────────────────────────────────────
	describe("subagent propagation caching", () => {
		it("does NOT call getSession() again after the first lookup (uses cache)", async () => {
			const parentMap = new Map<string, string>();
			const client = createMockClient(
				{ child_1: { type: "idle" } },
				{ id: "child_1", parentID: "parent_1" },
			);
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log: createSilentLogger(),
				getSessionParentMap: () => parentMap,
			});

			poller.start();
			await establishBaseline();

			// First poll with child busy — triggers getSession()
			client.session.statuses.mockResolvedValue({
				child_1: { type: "busy" },
			});
			await vi.advanceTimersByTimeAsync(500);
			expect(client.session.get).toHaveBeenCalledTimes(1);

			// Second poll with child still busy — should use cache
			await vi.advanceTimersByTimeAsync(500);
			expect(client.session.get).toHaveBeenCalledTimes(1); // still 1

			// Third poll — still cached
			await vi.advanceTimersByTimeAsync(500);
			expect(client.session.get).toHaveBeenCalledTimes(1); // still 1

			poller.stop();
		});
	});

	// ─── 4. Subagent no parent ────────────────────────────────────────────
	describe("subagent — no parentID from API", () => {
		it("does not propagate and caches null when getSession() returns no parentID", async () => {
			const parentMap = new Map<string, string>();
			const client = createMockClient(
				{ child_1: { type: "idle" } },
				{ id: "child_1" }, // no parentID
			);
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log: createSilentLogger(),
				getSessionParentMap: () => parentMap,
			});

			const changed = vi.fn();
			poller.on("changed", changed);
			poller.start();
			await establishBaseline();

			// Child becomes busy — getSession returns no parentID
			client.session.statuses.mockResolvedValue({
				child_1: { type: "busy" },
			});
			await vi.advanceTimersByTimeAsync(500);

			expect(client.session.get).toHaveBeenCalledTimes(1);
			// Changed fires because child_1 idle → busy, but no parent injected
			expect(changed).toHaveBeenCalledTimes(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const statuses = changed.mock.calls[0]![0] as Record<
				string,
				SessionStatus
			>;
			expect(statuses["child_1"]).toEqual({ type: "busy" });
			expect(statuses["parent_1"]).toBeUndefined();

			// Second poll — should NOT call getSession() again (cached as null)
			await vi.advanceTimersByTimeAsync(500);
			expect(client.session.get).toHaveBeenCalledTimes(1);

			poller.stop();
		});
	});

	// ─── 5. Subagent API failure ──────────────────────────────────────────
	describe("subagent — getSession() API failure", () => {
		it("handles gracefully and caches null on getSession() error", async () => {
			const parentMap = new Map<string, string>();
			const client = createMockClient({ child_1: { type: "idle" } });
			client.session.get.mockRejectedValue(new Error("session not found"));
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log: createSilentLogger(),
				getSessionParentMap: () => parentMap,
			});

			const changed = vi.fn();
			poller.on("changed", changed);
			poller.start();
			await establishBaseline();

			// Child becomes busy — getSession() will throw
			client.session.statuses.mockResolvedValue({
				child_1: { type: "busy" },
			});
			await vi.advanceTimersByTimeAsync(500);

			// Should not crash — changed still fires for the child transition
			expect(changed).toHaveBeenCalledTimes(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const statuses = changed.mock.calls[0]![0] as Record<
				string,
				SessionStatus
			>;
			expect(statuses["child_1"]).toEqual({ type: "busy" });
			expect(statuses["parent_1"]).toBeUndefined();

			// Cached as null — second poll should NOT call getSession() again
			await vi.advanceTimersByTimeAsync(500);
			expect(client.session.get).toHaveBeenCalledTimes(1);

			poller.stop();
		});
	});

	// ─── 6. markMessageActivity ───────────────────────────────────────────
	describe("markMessageActivity", () => {
		it("injects a synthetic busy status for a session not in /session/status", async () => {
			const client = createMockClient({}); // API returns no sessions
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log: createSilentLogger(),
			});

			const changed = vi.fn();
			poller.on("changed", changed);
			poller.start();
			await establishBaseline();

			// Mark a session as having message activity
			poller.markMessageActivity("cli_sess_1");
			// markMessageActivity triggers an immediate poll
			await vi.advanceTimersByTimeAsync(0);

			expect(changed).toHaveBeenCalledTimes(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const statuses = changed.mock.calls[0]![0] as Record<
				string,
				SessionStatus
			>;
			expect(statuses["cli_sess_1"]).toEqual({ type: "busy" });

			poller.stop();
		});
	});

	// ─── 7. clearMessageActivity ──────────────────────────────────────────
	describe("clearMessageActivity", () => {
		it("removes the synthetic busy status after clearing", async () => {
			const client = createMockClient({});
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log: createSilentLogger(),
			});

			const changed = vi.fn();
			poller.on("changed", changed);
			poller.start();
			await establishBaseline();

			// Mark activity → triggers poll
			poller.markMessageActivity("cli_sess_1");
			await vi.advanceTimersByTimeAsync(0);
			expect(changed).toHaveBeenCalledTimes(1);

			// Clear activity
			poller.clearMessageActivity("cli_sess_1");
			// Next scheduled poll
			await vi.advanceTimersByTimeAsync(500);

			expect(changed).toHaveBeenCalledTimes(2);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const statuses = changed.mock.calls[1]![0] as Record<
				string,
				SessionStatus
			>;
			// cli_sess_1 should no longer appear
			expect(statuses["cli_sess_1"]).toBeUndefined();

			poller.stop();
		});
	});

	// ─── 8. markMessageActivity triggers immediate poll ───────────────────
	describe("markMessageActivity triggers immediate poll", () => {
		it("does not wait for the next interval to poll", async () => {
			const client = createMockClient({});
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 5000, // very long interval
				log: createSilentLogger(),
			});

			poller.start();
			await establishBaseline(); // immediate first poll
			const callsAfterBaseline = client.session.statuses.mock.calls.length;

			// markMessageActivity should trigger an immediate poll
			poller.markMessageActivity("cli_sess_1");
			await vi.advanceTimersByTimeAsync(0); // flush microtasks only

			// Should have polled again without waiting for the 5s interval
			expect(client.session.statuses.mock.calls.length).toBe(
				callsAfterBaseline + 1,
			);

			poller.stop();
		});
	});

	// ─── 9. Combined: subagent + message activity ─────────────────────────
	describe("combined: subagent propagation + message activity", () => {
		it("both augmentations appear in the same changed event", async () => {
			const parentMap = new Map<string, string>([["subagent_1", "parent_1"]]);
			const client = createMockClient({ sess_idle: { type: "idle" } });
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log: createSilentLogger(),
				getSessionParentMap: () => parentMap,
			});

			const changed = vi.fn();
			poller.on("changed", changed);
			poller.start();
			await establishBaseline();

			// Subagent becomes busy (parent should propagate)
			// AND mark a CLI session with message activity
			client.session.statuses.mockResolvedValue({
				sess_idle: { type: "idle" },
				subagent_1: { type: "busy" },
			});
			poller.markMessageActivity("cli_sess_1");
			await vi.advanceTimersByTimeAsync(0); // flush the immediate poll

			expect(changed).toHaveBeenCalledTimes(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const statuses = changed.mock.calls[0]![0] as Record<
				string,
				SessionStatus
			>;

			// Subagent busy propagated to parent
			expect(statuses["subagent_1"]).toEqual({ type: "busy" });
			expect(statuses["parent_1"]).toEqual({ type: "busy" });
			// Message activity injected
			expect(statuses["cli_sess_1"]).toEqual({ type: "busy" });
			// Original idle session still present
			expect(statuses["sess_idle"]).toEqual({ type: "idle" });

			poller.stop();
		});
	});

	// ─── 10. Immediate first poll on start() ──────────────────────────────
	describe("immediate first poll on start()", () => {
		it("polls immediately on start() before the first interval fires", async () => {
			const client = createMockClient({ sess_1: { type: "busy" } });
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 5000, // very long interval
				log: createSilentLogger(),
			});

			poller.start();
			// Flush microtasks — the immediate poll should resolve
			await vi.advanceTimersByTimeAsync(0);

			// getSessionStatuses should have been called once (the immediate poll)
			expect(client.session.statuses).toHaveBeenCalledTimes(1);

			// Baseline established — getCurrentStatuses should reflect the data
			expect(poller.getCurrentStatuses()).toEqual({
				sess_1: { type: "busy" },
			});

			poller.stop();
		});

		it("establishes baseline without emitting changed", async () => {
			const client = createMockClient({ sess_1: { type: "busy" } });
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log: createSilentLogger(),
			});

			const changed = vi.fn();
			poller.on("changed", changed);
			poller.start();
			await vi.advanceTimersByTimeAsync(0);

			// Baseline poll should NOT emit changed
			expect(changed).not.toHaveBeenCalled();
			// But data should be available
			expect(poller.getCurrentStatuses()).toEqual({
				sess_1: { type: "busy" },
			});

			poller.stop();
		});
	});

	// ─── 11. Message activity TTL / time-decay ───────────────────────────
	describe("message activity TTL (time-decay)", () => {
		it("message activity expires after 10s of no new calls", async () => {
			const client = createMockClient({});
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log: createSilentLogger(),
			});

			const changed = vi.fn();
			poller.on("changed", changed);
			poller.start();
			await establishBaseline();

			// Mark activity → triggers immediate poll → busy
			poller.markMessageActivity("cli_sess_1");
			await vi.advanceTimersByTimeAsync(0);
			expect(changed).toHaveBeenCalledTimes(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(changed.mock.calls[0]![0]["cli_sess_1"]).toEqual({
				type: "busy",
			});

			// Advance past the 10s TTL without calling markMessageActivity again
			await vi.advanceTimersByTimeAsync(10_500);

			// The status poller should have detected the expiry and emitted changed
			const lastCall = changed.mock.calls[changed.mock.calls.length - 1];
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const lastStatuses = lastCall![0] as Record<string, SessionStatus>;
			expect(lastStatuses["cli_sess_1"]).toBeUndefined();

			poller.stop();
		});

		it("repeated markMessageActivity refreshes the TTL", async () => {
			const client = createMockClient({});
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log: createSilentLogger(),
			});

			const changed = vi.fn();
			poller.on("changed", changed);
			poller.start();
			await establishBaseline();

			// Mark activity
			poller.markMessageActivity("cli_sess_1");
			await vi.advanceTimersByTimeAsync(0);
			expect(changed).toHaveBeenCalledTimes(1);

			// Refresh activity every 5s (well within 10s TTL)
			await vi.advanceTimersByTimeAsync(5000);
			poller.markMessageActivity("cli_sess_1");
			await vi.advanceTimersByTimeAsync(5000);
			poller.markMessageActivity("cli_sess_1");
			await vi.advanceTimersByTimeAsync(5000);

			// Session should STILL be busy since we keep refreshing
			const statuses = poller.getCurrentStatuses();
			expect(statuses["cli_sess_1"]).toEqual({ type: "busy" });

			poller.stop();
		});
	});
});
