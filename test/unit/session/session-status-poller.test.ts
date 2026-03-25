import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
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

	it("emits 'changed' with statusesChanged=true on idle→busy transition", async () => {
		const client = createMockClient({ sess_1: { type: "idle" } });
		const poller = new SessionStatusPoller(new ServiceRegistry(), {
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// start() fires immediate init poll (no emit), then timer poll emits steady-state
		await vi.advanceTimersByTimeAsync(500);
		changed.mockClear();

		// Session becomes busy
		client.getSessionStatuses.mockResolvedValue({ sess_1: { type: "busy" } });
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).toHaveBeenCalledTimes(1);
		// biome-ignore lint/style/noNonNullAssertion: length-checked
		const statuses = changed.mock.calls[0]![0] as Record<string, SessionStatus>;
		expect(statuses["sess_1"]).toEqual({ type: "busy" });
		// biome-ignore lint/style/noNonNullAssertion: length-checked
		expect(changed.mock.calls[0]![1]).toBe(true);

		poller.stop();
	});

	it("emits 'changed' with statusesChanged=true on busy→idle transition", async () => {
		const client = createMockClient({ sess_1: { type: "busy" } });
		const poller = new SessionStatusPoller(new ServiceRegistry(), {
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// start() fires immediate init poll, then timer poll emits steady-state
		await vi.advanceTimersByTimeAsync(500);
		changed.mockClear();

		// Session becomes idle
		client.getSessionStatuses.mockResolvedValue({ sess_1: { type: "idle" } });
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).toHaveBeenCalledTimes(1);
		// biome-ignore lint/style/noNonNullAssertion: length-checked
		expect(changed.mock.calls[0]![1]).toBe(true);
		poller.stop();
	});

	it("emits 'changed' on every poll cycle with statusesChanged flag", async () => {
		const client = createMockClient({ sess_1: { type: "busy" } });
		const poller = new SessionStatusPoller(new ServiceRegistry(), {
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// start() fires immediate init (no emit), then first timer fires
		await vi.advanceTimersByTimeAsync(500);
		// Timer poll emits with statusesChanged=false (same state as init)
		expect(changed).toHaveBeenCalledTimes(1);
		// biome-ignore lint/style/noNonNullAssertion: length-checked
		expect(changed.mock.calls[0]![1]).toBe(false);

		// Next poll — same state, emits again
		await vi.advanceTimersByTimeAsync(500);
		expect(changed).toHaveBeenCalledTimes(2);
		// biome-ignore lint/style/noNonNullAssertion: length-checked
		expect(changed.mock.calls[1]![1]).toBe(false);

		// Status changes, emits with statusesChanged=true
		client.getSessionStatuses.mockResolvedValue({
			sess_1: { type: "idle" },
		});
		await vi.advanceTimersByTimeAsync(500);
		expect(changed).toHaveBeenCalledTimes(3);
		// biome-ignore lint/style/noNonNullAssertion: length-checked
		expect(changed.mock.calls[2]![1]).toBe(true);

		poller.stop();
	});

	it("emits with statusesChanged=true when a new session appears", async () => {
		const client = createMockClient({ sess_1: { type: "idle" } });
		const poller = new SessionStatusPoller(new ServiceRegistry(), {
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();
		await vi.advanceTimersByTimeAsync(500);
		changed.mockClear();

		// New session appears
		client.getSessionStatuses.mockResolvedValue({
			sess_1: { type: "idle" },
			sess_2: { type: "busy" },
		});
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).toHaveBeenCalledTimes(1);
		// biome-ignore lint/style/noNonNullAssertion: length-checked
		expect(changed.mock.calls[0]![1]).toBe(true);
		poller.stop();
	});

	it("emits with statusesChanged=true when a session disappears", async () => {
		const client = createMockClient({
			sess_1: { type: "idle" },
			sess_2: { type: "busy" },
		});
		const poller = new SessionStatusPoller(new ServiceRegistry(), {
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();
		await vi.advanceTimersByTimeAsync(500);
		changed.mockClear();

		// sess_2 disappears
		client.getSessionStatuses.mockResolvedValue({ sess_1: { type: "idle" } });
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).toHaveBeenCalledTimes(1);
		// biome-ignore lint/style/noNonNullAssertion: length-checked
		expect(changed.mock.calls[0]![1]).toBe(true);
		poller.stop();
	});

	it("keeps last known state on poll failure (stale > empty)", async () => {
		const client = createMockClient({ sess_1: { type: "busy" } });
		const warnSpy = vi.fn();
		const log = { ...createSilentLogger(), warn: warnSpy };
		const poller = new SessionStatusPoller(new ServiceRegistry(), {
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log,
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// Baseline (init + first timer)
		await vi.advanceTimersByTimeAsync(500);
		changed.mockClear();

		// API fails
		client.getSessionStatuses.mockRejectedValue(new Error("network error"));
		await vi.advanceTimersByTimeAsync(500);

		// Should NOT emit changed on failure (stale state preserved)
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
		const poller = new SessionStatusPoller(new ServiceRegistry(), {
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
		const poller = new SessionStatusPoller(new ServiceRegistry(), {
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
		const poller = new SessionStatusPoller(new ServiceRegistry(), {
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
		const poller = new SessionStatusPoller(new ServiceRegistry(), {
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();
		await vi.advanceTimersByTimeAsync(500);
		changed.mockClear();

		// retry → busy (still processing but status type changed)
		client.getSessionStatuses.mockResolvedValue({ sess_1: { type: "busy" } });
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).toHaveBeenCalledTimes(1);
		// biome-ignore lint/style/noNonNullAssertion: length-checked
		expect(changed.mock.calls[0]![1]).toBe(true);
		poller.stop();
	});

	it("drain() stops the timer and settles in-flight polls", async () => {
		const registry = new ServiceRegistry();
		const client = createMockClient({ sess_1: { type: "busy" } });
		const poller = new SessionStatusPoller(registry, {
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: createSilentLogger(),
		});

		poller.start();
		await vi.advanceTimersByTimeAsync(500);
		const callsBeforeDrain = client.getSessionStatuses.mock.calls.length;

		// Drain via registry
		await registry.drainAll();

		// Advance time — no new polls should fire
		await vi.advanceTimersByTimeAsync(2000);
		expect(client.getSessionStatuses).toHaveBeenCalledTimes(callsBeforeDrain);
	});

	it("notifySSEIdle triggers an immediate poll", async () => {
		const client = createMockClient({ sess_1: { type: "busy" } });
		const poller = new SessionStatusPoller(new ServiceRegistry(), {
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

		poller.notifySSEIdle("sess_1");

		// Let the immediate poll resolve (microtask)
		await vi.advanceTimersByTimeAsync(0);

		// Should have polled again immediately
		expect(client.getSessionStatuses.mock.calls.length).toBeGreaterThan(
			callsBefore,
		);

		poller.stop();
	});
});
