import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import type { SessionStatus } from "../../../src/lib/instance/opencode-client.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import {
	SessionStatusPoller,
	type SessionStatusPollerOptions,
} from "../../../src/lib/session/session-status-poller.js";
import { SessionStatusSqliteReader } from "../../../src/lib/session/session-status-sqlite.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockClient(statuses: Record<string, SessionStatus> = {}) {
	return {
		getSessionStatuses: vi.fn().mockResolvedValue(statuses),
		getSession: vi.fn().mockResolvedValue({ id: "unknown" }),
	};
}

/** Seed a session in SQLite with a given status. */
function seedSession(
	layer: PersistenceLayer,
	sessionId: string,
	status: string,
	updatedAt?: number,
) {
	const now = Date.now();

	// First, create the sessions row directly (like SessionSeeder does)
	// so the FK constraint on the events table is satisfied.
	layer.db.execute(
		`INSERT OR IGNORE INTO sessions (id, provider, title, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[sessionId, "opencode", "Test", "idle", now, now],
	);

	// Insert session.created event
	const created = canonicalEvent("session.created", sessionId, {
		sessionId,
		title: "Test",
		provider: "opencode",
	});
	const storedCreated = layer.eventStore.append(created);
	layer.projectionRunner.projectEvent(storedCreated);

	// Insert session.status event with optional custom timestamp
	const statusEvt = canonicalEvent(
		"session.status",
		sessionId,
		{
			sessionId,
			status: status as "idle" | "busy" | "retry" | "error",
		},
		{
			...(updatedAt != null && { createdAt: updatedAt }),
		},
	);
	const storedStatus = layer.eventStore.append(statusEvt);
	layer.projectionRunner.projectEvent(storedStatus);
}

describe("SessionStatusPoller — reconciliation", () => {
	let layer: PersistenceLayer;

	beforeEach(() => {
		vi.useFakeTimers();
		layer = PersistenceLayer.memory();
		layer.projectionRunner.recover();
	});

	afterEach(() => {
		vi.useRealTimers();
		layer.close();
	});

	// ─── Helper: run the immediate first poll (baseline) ───────────────────
	async function establishBaseline() {
		await vi.advanceTimersByTimeAsync(0);
	}

	// ─── 1. Default interval is now 7 seconds ──────────────────────────────
	describe("default interval", () => {
		it("uses 7000ms as default interval instead of 500ms", async () => {
			const client = createMockClient({ sess_1: { type: "idle" } });
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				log: createSilentLogger(),
			});

			const changed = vi.fn();
			poller.on("changed", changed);
			poller.start();
			await establishBaseline();

			// After 500ms — no timer poll should have fired yet (init already happened)
			await vi.advanceTimersByTimeAsync(500);
			expect(changed).not.toHaveBeenCalled();

			// After 7000ms from start — first timer poll fires
			await vi.advanceTimersByTimeAsync(6500);
			expect(changed).toHaveBeenCalledTimes(1);

			poller.stop();
		});
	});

	// ─── 2. REST reconciliation corrects status mismatch ────────────────────
	describe("REST reconciliation", () => {
		it("injects corrective event when REST says idle but projection says busy", async () => {
			// Seed a "busy" session in SQLite
			seedSession(layer, "sess_1", "busy");

			const readQuery = new ReadQueryService(layer.db);
			const sqliteReader = new SessionStatusSqliteReader(readQuery);

			// REST API says idle (SSE missed the idle transition)
			const client = createMockClient({ sess_1: { type: "idle" } });

			const warnSpy = vi.fn();
			const log = { ...createSilentLogger(), warn: warnSpy };

			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log,
				sqliteReader,
				readQuery,
				persistence: {
					eventStore: layer.eventStore,
					projectionRunner: layer.projectionRunner,
				},
			});

			poller.start();
			await establishBaseline();

			// Wait for one poll cycle to trigger reconciliation
			await vi.advanceTimersByTimeAsync(500);

			// Verify corrective event was injected — session should now be idle
			const sessionStatus = readQuery.getSessionStatus("sess_1");
			expect(sessionStatus).toBe("idle");

			// Verify a warning was logged about the mismatch
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("reconciliation: status mismatch"),
			);

			poller.stop();
		});

		it("does NOT inject corrective event when REST and projection agree", async () => {
			// Both say idle
			seedSession(layer, "sess_1", "idle");

			const readQuery = new ReadQueryService(layer.db);
			const sqliteReader = new SessionStatusSqliteReader(readQuery);

			const client = createMockClient({ sess_1: { type: "idle" } });

			const warnSpy = vi.fn();
			const log = { ...createSilentLogger(), warn: warnSpy };

			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log,
				sqliteReader,
				readQuery,
				persistence: {
					eventStore: layer.eventStore,
					projectionRunner: layer.projectionRunner,
				},
			});

			poller.start();
			await establishBaseline();
			await vi.advanceTimersByTimeAsync(500);

			// No mismatch warning
			const reconciliationWarns = warnSpy.mock.calls.filter(
				(call: unknown[]) =>
					typeof call[0] === "string" &&
					(call[0] as string).includes("reconciliation: status mismatch"),
			);
			expect(reconciliationWarns).toHaveLength(0);

			poller.stop();
		});

		it("handles REST busy → projection idle mismatch (corrects to busy)", async () => {
			// Projection says idle, REST says busy
			seedSession(layer, "sess_1", "idle");

			const readQuery = new ReadQueryService(layer.db);
			const sqliteReader = new SessionStatusSqliteReader(readQuery);

			const client = createMockClient({ sess_1: { type: "busy" } });

			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log: createSilentLogger(),
				sqliteReader,
				readQuery,
				persistence: {
					eventStore: layer.eventStore,
					projectionRunner: layer.projectionRunner,
				},
			});

			poller.start();
			await establishBaseline();
			await vi.advanceTimersByTimeAsync(500);

			// Corrective event should have updated projection to busy
			const sessionStatus = readQuery.getSessionStatus("sess_1");
			expect(sessionStatus).toBe("busy");

			poller.stop();
		});
	});

	// ─── 3. Staleness detection ─────────────────────────────────────────────
	describe("staleness detection", () => {
		it("marks a session as idle when busy for >30 minutes with no events", async () => {
			const thirtyOneMinutesAgo = Date.now() - 31 * 60 * 1000;

			// Seed a session that has been busy since 31 minutes ago
			seedSession(layer, "sess_stale", "busy", thirtyOneMinutesAgo);

			const readQuery = new ReadQueryService(layer.db);
			const sqliteReader = new SessionStatusSqliteReader(readQuery);

			// REST is also stuck on busy (both SSE and REST failed to detect idle).
			// The REST reconciliation agrees with the projection (both say busy),
			// so it won't correct anything. The staleness check then fires and
			// forces the session to idle as a safety net.
			//
			// To test staleness in isolation, make REST fail so reconciliation
			// is skipped entirely. Staleness then catches the stuck session.
			const client = createMockClient({});
			client.getSessionStatuses.mockRejectedValue(
				new Error("REST unavailable"),
			);

			const warnSpy = vi.fn();
			const log = { ...createSilentLogger(), warn: warnSpy };

			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log,
				sqliteReader,
				readQuery,
				persistence: {
					eventStore: layer.eventStore,
					projectionRunner: layer.projectionRunner,
				},
			});

			poller.start();
			await establishBaseline();
			await vi.advanceTimersByTimeAsync(500);

			// Staleness check should have injected an idle event
			const sessionStatus = readQuery.getSessionStatus("sess_stale");
			expect(sessionStatus).toBe("idle");

			// Verify stale warning was logged
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("has been busy for"),
			);

			poller.stop();
		});

		it("does NOT flag a recently-busy session as stale", async () => {
			const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

			// Seed a session that has been busy for 5 minutes (well under 30)
			seedSession(layer, "sess_recent", "busy", fiveMinutesAgo);

			const readQuery = new ReadQueryService(layer.db);
			const sqliteReader = new SessionStatusSqliteReader(readQuery);

			// REST unavailable — isolate the staleness check
			const client = createMockClient({});
			client.getSessionStatuses.mockRejectedValue(
				new Error("REST unavailable"),
			);

			const warnSpy = vi.fn();
			const log = { ...createSilentLogger(), warn: warnSpy };

			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log,
				sqliteReader,
				readQuery,
				persistence: {
					eventStore: layer.eventStore,
					projectionRunner: layer.projectionRunner,
				},
			});

			poller.start();
			await establishBaseline();
			await vi.advanceTimersByTimeAsync(500);

			// Session should still be busy
			const sessionStatus = readQuery.getSessionStatus("sess_recent");
			expect(sessionStatus).toBe("busy");

			// No stale warning
			const staleWarns = warnSpy.mock.calls.filter(
				(call: unknown[]) =>
					typeof call[0] === "string" &&
					(call[0] as string).includes("has been busy for"),
			);
			expect(staleWarns).toHaveLength(0);

			poller.stop();
		});

		it("does NOT flag idle sessions as stale", async () => {
			const thirtyOneMinutesAgo = Date.now() - 31 * 60 * 1000;

			// Seed an idle session that was updated 31 minutes ago — not stale because it's idle
			seedSession(layer, "sess_idle_old", "idle", thirtyOneMinutesAgo);

			const readQuery = new ReadQueryService(layer.db);
			const sqliteReader = new SessionStatusSqliteReader(readQuery);

			// REST unavailable — isolate the staleness check
			const client = createMockClient({});
			client.getSessionStatuses.mockRejectedValue(
				new Error("REST unavailable"),
			);

			const warnSpy = vi.fn();
			const log = { ...createSilentLogger(), warn: warnSpy };

			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log,
				sqliteReader,
				readQuery,
				persistence: {
					eventStore: layer.eventStore,
					projectionRunner: layer.projectionRunner,
				},
			});

			poller.start();
			await establishBaseline();
			await vi.advanceTimersByTimeAsync(500);

			// No stale warning
			const staleWarns = warnSpy.mock.calls.filter(
				(call: unknown[]) =>
					typeof call[0] === "string" &&
					(call[0] as string).includes("has been busy for"),
			);
			expect(staleWarns).toHaveLength(0);

			poller.stop();
		});
	});

	// ─── 4. reconcileNow() one-shot ─────────────────────────────────────────
	describe("reconcileNow()", () => {
		it("runs a one-shot reconciliation on demand", async () => {
			// Seed a "busy" session in SQLite
			seedSession(layer, "sess_1", "busy");

			const readQuery = new ReadQueryService(layer.db);

			// REST says idle
			const client = createMockClient({ sess_1: { type: "idle" } });

			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 60_000, // very long — reconcileNow should work without waiting
				log: createSilentLogger(),
				readQuery,
				persistence: {
					eventStore: layer.eventStore,
					projectionRunner: layer.projectionRunner,
				},
			});

			// Don't start the poller — just call reconcileNow directly
			await poller.reconcileNow();

			// Should have corrected the status
			const sessionStatus = readQuery.getSessionStatus("sess_1");
			expect(sessionStatus).toBe("idle");

			poller.stop();
		});

		it("is a no-op when persistence is not configured", async () => {
			const client = createMockClient({ sess_1: { type: "idle" } });

			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				log: createSilentLogger(),
			});

			// Should not throw
			await poller.reconcileNow();

			// getSessionStatuses should NOT have been called (no persistence = skip)
			expect(client.getSessionStatuses).not.toHaveBeenCalled();

			poller.stop();
		});
	});

	// ─── 5. Corrective events have synthetic metadata ───────────────────────
	describe("corrective event metadata", () => {
		it("marks corrective events as synthetic with source=reconciliation-loop", async () => {
			seedSession(layer, "sess_1", "busy");

			const readQuery = new ReadQueryService(layer.db);
			const sqliteReader = new SessionStatusSqliteReader(readQuery);

			const client = createMockClient({ sess_1: { type: "idle" } });

			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log: createSilentLogger(),
				sqliteReader,
				readQuery,
				persistence: {
					eventStore: layer.eventStore,
					projectionRunner: layer.projectionRunner,
				},
			});

			poller.start();
			await establishBaseline();
			await vi.advanceTimersByTimeAsync(500);

			// Find the corrective event in the event store
			const events = layer.eventStore.readBySession("sess_1");
			const correctiveEvents = events.filter(
				(e) =>
					e.type === "session.status" &&
					(e.metadata as { synthetic?: boolean })?.synthetic === true,
			);

			expect(correctiveEvents).toHaveLength(1);
			expect(
				(correctiveEvents[0]?.metadata as { source?: string })?.source,
			).toBe("reconciliation-loop");

			poller.stop();
		});
	});

	// ─── 6. Graceful handling of reconciliation errors ──────────────────────
	describe("reconciliation error handling", () => {
		it("does not crash when REST fetch fails during reconciliation", async () => {
			seedSession(layer, "sess_1", "busy");

			const readQuery = new ReadQueryService(layer.db);
			const sqliteReader = new SessionStatusSqliteReader(readQuery);

			const client = createMockClient({ sess_1: { type: "busy" } });
			// Make the second getSessionStatuses call (reconciliation) fail
			let callCount = 0;
			client.getSessionStatuses.mockImplementation(async () => {
				callCount++;
				if (callCount > 1) throw new Error("network error");
				return { sess_1: { type: "busy" } };
			});

			const warnSpy = vi.fn();
			const log = { ...createSilentLogger(), warn: warnSpy };

			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log,
				sqliteReader,
				readQuery,
				persistence: {
					eventStore: layer.eventStore,
					projectionRunner: layer.projectionRunner,
				},
			});

			const changed = vi.fn();
			poller.on("changed", changed);
			poller.start();
			await establishBaseline();

			// The reconciliation REST call fails, but the poller should still work
			await vi.advanceTimersByTimeAsync(500);

			// Changed should still fire (the poll itself succeeded)
			expect(changed).toHaveBeenCalled();

			// Warning about reconciliation failure
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("reconciliation check failed"),
			);

			poller.stop();
		});
	});

	// ─── 7. Without persistence, reconciliation is skipped ──────────────────
	describe("without persistence", () => {
		it("still works as a basic status poller without reconciliation", async () => {
			const client = createMockClient({ sess_1: { type: "idle" } });
			const poller = new SessionStatusPoller(new ServiceRegistry(), {
				client: client as unknown as SessionStatusPollerOptions["client"],
				interval: 500,
				log: createSilentLogger(),
				// No persistence, no readQuery, no sqliteReader
			});

			const changed = vi.fn();
			poller.on("changed", changed);
			poller.start();
			await establishBaseline();

			// Transition
			client.getSessionStatuses.mockResolvedValue({
				sess_1: { type: "busy" },
			});
			await vi.advanceTimersByTimeAsync(500);

			expect(changed).toHaveBeenCalledTimes(1);
			const statuses = changed.mock.calls[0]?.[0] as Record<
				string,
				SessionStatus
			>;
			expect(statuses["sess_1"]).toEqual({ type: "busy" });

			poller.stop();
		});
	});
});
