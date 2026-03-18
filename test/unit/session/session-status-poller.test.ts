import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../../../src/lib/instance/opencode-client.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import {
	SessionStatusPoller,
	type SessionStatusPollerOptions,
} from "../../../src/lib/session/session-status-poller.js";

function createMockClient(statuses: Record<string, SessionStatus> = {}) {
	return {
		getSessionStatuses: vi.fn().mockResolvedValue(statuses),
	};
}

describe("SessionStatusPoller", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("emits 'changed' when a session transitions from idle to busy", async () => {
		const client = createMockClient({ sess_1: { type: "idle" } });
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// First poll: establishes baseline
		await vi.advanceTimersByTimeAsync(500);
		expect(changed).not.toHaveBeenCalled();

		// Session becomes busy
		client.getSessionStatuses.mockResolvedValue({ sess_1: { type: "busy" } });
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).toHaveBeenCalledTimes(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const statuses = changed.mock.calls[0]![0] as Record<string, SessionStatus>;
		expect(statuses["sess_1"]).toEqual({ type: "busy" });

		poller.stop();
	});

	it("emits 'changed' when a session transitions from busy to idle", async () => {
		const client = createMockClient({ sess_1: { type: "busy" } });
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// First poll: baseline
		await vi.advanceTimersByTimeAsync(500);
		expect(changed).not.toHaveBeenCalled();

		// Session becomes idle
		client.getSessionStatuses.mockResolvedValue({ sess_1: { type: "idle" } });
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).toHaveBeenCalledTimes(1);
		poller.stop();
	});

	it("does NOT emit 'changed' when statuses are unchanged", async () => {
		const client = createMockClient({ sess_1: { type: "busy" } });
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// First poll
		await vi.advanceTimersByTimeAsync(500);
		// Second poll, same state
		await vi.advanceTimersByTimeAsync(500);
		// Third poll, same state
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).not.toHaveBeenCalled();
		poller.stop();
	});

	it("emits 'changed' when a new session appears", async () => {
		const client = createMockClient({ sess_1: { type: "idle" } });
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// Baseline
		await vi.advanceTimersByTimeAsync(500);

		// New session appears
		client.getSessionStatuses.mockResolvedValue({
			sess_1: { type: "idle" },
			sess_2: { type: "busy" },
		});
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).toHaveBeenCalledTimes(1);
		poller.stop();
	});

	it("emits 'changed' when a session disappears", async () => {
		const client = createMockClient({
			sess_1: { type: "idle" },
			sess_2: { type: "busy" },
		});
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// Baseline
		await vi.advanceTimersByTimeAsync(500);

		// sess_2 disappears
		client.getSessionStatuses.mockResolvedValue({ sess_1: { type: "idle" } });
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).toHaveBeenCalledTimes(1);
		poller.stop();
	});

	it("keeps last known state on poll failure (stale > empty)", async () => {
		const client = createMockClient({ sess_1: { type: "busy" } });
		const warnSpy = vi.fn();
		const log = { ...createSilentLogger(), warn: warnSpy };
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log,
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// Baseline
		await vi.advanceTimersByTimeAsync(500);

		// API fails
		client.getSessionStatuses.mockRejectedValue(new Error("network error"));
		await vi.advanceTimersByTimeAsync(500);

		// Should NOT emit changed (stale state preserved)
		expect(changed).not.toHaveBeenCalled();
		// Should still have old state
		expect(poller.getCurrentStatuses()).toEqual({ sess_1: { type: "busy" } });
		// Should have logged the error
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("poll failed"),
		);

		poller.stop();
	});

	it("getCurrentStatuses() returns current state", async () => {
		const client = createMockClient({ sess_1: { type: "busy" } });
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		poller.start();

		// Before first poll
		expect(poller.getCurrentStatuses()).toEqual({});

		// After first poll
		await vi.advanceTimersByTimeAsync(500);
		expect(poller.getCurrentStatuses()).toEqual({ sess_1: { type: "busy" } });

		poller.stop();
	});

	it("isProcessing() returns true for busy and retry sessions", async () => {
		const client = createMockClient({
			sess_1: { type: "busy" },
			sess_2: {
				type: "retry",
				attempt: 1,
				message: "rate limited",
				next: Date.now() + 5000,
			},
			sess_3: { type: "idle" },
		});
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		poller.start();
		await vi.advanceTimersByTimeAsync(500);

		expect(poller.isProcessing("sess_1")).toBe(true);
		expect(poller.isProcessing("sess_2")).toBe(true);
		expect(poller.isProcessing("sess_3")).toBe(false);
		expect(poller.isProcessing("nonexistent")).toBe(false);

		poller.stop();
	});

	it("stop() clears the timer and prevents further polls", async () => {
		const client = createMockClient({});
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		poller.start();
		// Immediate poll + one interval poll = 2 calls
		await vi.advanceTimersByTimeAsync(500);
		const callsBeforeStop = client.getSessionStatuses.mock.calls.length;
		expect(callsBeforeStop).toBeGreaterThanOrEqual(1);

		poller.stop();
		await vi.advanceTimersByTimeAsync(2000);
		// No additional calls after stop
		expect(client.getSessionStatuses).toHaveBeenCalledTimes(callsBeforeStop);
	});

	it("handles retry status type in diff detection", async () => {
		const client = createMockClient({
			sess_1: {
				type: "retry",
				attempt: 1,
				message: "rate limited",
				next: 1000,
			},
		});
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// Baseline
		await vi.advanceTimersByTimeAsync(500);

		// retry → busy (still processing but status type changed)
		client.getSessionStatuses.mockResolvedValue({ sess_1: { type: "busy" } });
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).toHaveBeenCalledTimes(1);
		poller.stop();
	});

	// ─── Transition events (became_busy / became_idle) ──────────────────────

	it("emits 'became_busy' when a session transitions from idle to busy", async () => {
		const client = createMockClient({ sess_1: { type: "idle" } });
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const becameBusy = vi.fn();
		poller.on("became_busy", becameBusy);
		poller.start();

		// First poll: establishes baseline — no transition events
		await vi.advanceTimersByTimeAsync(500);
		expect(becameBusy).not.toHaveBeenCalled();

		// Session becomes busy
		client.getSessionStatuses.mockResolvedValue({ sess_1: { type: "busy" } });
		await vi.advanceTimersByTimeAsync(500);

		expect(becameBusy).toHaveBeenCalledTimes(1);
		expect(becameBusy).toHaveBeenCalledWith(["sess_1"]);

		poller.stop();
	});

	it("emits 'became_idle' when a session transitions from busy to idle", async () => {
		const client = createMockClient({ sess_1: { type: "busy" } });
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const becameIdle = vi.fn();
		poller.on("became_idle", becameIdle);
		poller.start();

		// First poll: baseline (busy) — no transition events
		await vi.advanceTimersByTimeAsync(500);
		expect(becameIdle).not.toHaveBeenCalled();

		// Session becomes idle
		client.getSessionStatuses.mockResolvedValue({ sess_1: { type: "idle" } });
		await vi.advanceTimersByTimeAsync(500);

		expect(becameIdle).toHaveBeenCalledTimes(1);
		expect(becameIdle).toHaveBeenCalledWith(["sess_1"]);

		poller.stop();
	});

	it("does NOT emit transition events on first poll (baseline)", async () => {
		// Start with a busy session — should NOT emit became_busy on init
		const client = createMockClient({ sess_1: { type: "busy" } });
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const becameBusy = vi.fn();
		const becameIdle = vi.fn();
		poller.on("became_busy", becameBusy);
		poller.on("became_idle", becameIdle);
		poller.start();

		// First poll establishes baseline
		await vi.advanceTimersByTimeAsync(500);

		expect(becameBusy).not.toHaveBeenCalled();
		expect(becameIdle).not.toHaveBeenCalled();

		poller.stop();
	});

	it("notifySSEIdle triggers an immediate poll", async () => {
		const client = createMockClient({ sess_1: { type: "busy" } });
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		poller.start();
		// First poll: baseline
		await vi.advanceTimersByTimeAsync(500);

		const callsBefore = client.getSessionStatuses.mock.calls.length;

		// Update mock to return idle, then notify SSE idle
		client.getSessionStatuses.mockResolvedValue({ sess_1: { type: "idle" } });

		const becameIdle = vi.fn();
		poller.on("became_idle", becameIdle);

		poller.notifySSEIdle("sess_1");

		// Let the immediate poll resolve (microtask)
		await vi.advanceTimersByTimeAsync(0);

		// Should have polled again immediately
		expect(client.getSessionStatuses.mock.calls.length).toBeGreaterThan(
			callsBefore,
		);
		// And detected the idle transition
		expect(becameIdle).toHaveBeenCalledWith(["sess_1"]);

		poller.stop();
	});

	it("handles multiple sessions transitioning simultaneously", async () => {
		const client = createMockClient({
			sess_1: { type: "idle" },
			sess_2: { type: "idle" },
			sess_3: { type: "busy" },
		});
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const becameBusy = vi.fn();
		const becameIdle = vi.fn();
		poller.on("became_busy", becameBusy);
		poller.on("became_idle", becameIdle);
		poller.start();

		// First poll: baseline
		await vi.advanceTimersByTimeAsync(500);

		// sess_1 & sess_2 become busy, sess_3 becomes idle
		client.getSessionStatuses.mockResolvedValue({
			sess_1: { type: "busy" },
			sess_2: { type: "busy" },
			sess_3: { type: "idle" },
		});
		await vi.advanceTimersByTimeAsync(500);

		expect(becameBusy).toHaveBeenCalledTimes(1);
		const busyIds = becameBusy.mock.calls[0]?.[0] as string[];
		expect(busyIds).toContain("sess_1");
		expect(busyIds).toContain("sess_2");
		expect(busyIds).toHaveLength(2);

		expect(becameIdle).toHaveBeenCalledTimes(1);
		expect(becameIdle).toHaveBeenCalledWith(["sess_3"]);

		poller.stop();
	});
});
