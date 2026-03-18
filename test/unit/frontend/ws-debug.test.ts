import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ─── localStorage mock (needed by feature-flags module) ─────────────────────
const storage = new Map<string, string>();
beforeAll(() => {
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, val: string) => storage.set(key, val),
		removeItem: (key: string) => storage.delete(key),
		clear: () => storage.clear(),
	});
});

import { featureFlags } from "../../../src/lib/frontend/stores/feature-flags.svelte.js";
import {
	clearDebugLog,
	getDebugEvents,
	getDebugSnapshot,
	wsDebugLog,
	wsDebugLogMessage,
	wsDebugResetMessageCount,
	wsDebugState,
} from "../../../src/lib/frontend/stores/ws-debug.svelte.js";

describe("ws-debug", () => {
	beforeEach(() => {
		clearDebugLog();
		featureFlags.debug = false;
		wsDebugState.verboseMessages = false;
	});

	describe("wsDebugLog", () => {
		it("pushes events to the ring buffer", () => {
			wsDebugLog("connect", "connecting", "slug=test");
			const events = getDebugEvents();
			expect(events).toHaveLength(1);
			expect(events[0]!.event).toBe("connect");
			expect(events[0]!.state).toBe("connecting");
			expect(events[0]!.detail).toBe("slug=test");
			expect(events[0]!.time).toBeGreaterThan(0);
		});

		it("caps ring buffer at 50 events", () => {
			for (let i = 0; i < 60; i++) {
				wsDebugLog(`event-${i}`, "connected");
			}
			const events = getDebugEvents();
			expect(events).toHaveLength(50);
			expect(events[0]!.event).toBe("event-10");
			expect(events[49]!.event).toBe("event-59");
		});

		it("updates wsDebugState.eventCount reactively", () => {
			wsDebugLog("connect", "connecting");
			expect(wsDebugState.eventCount).toBe(1);
			wsDebugLog("ws:open", "connected");
			expect(wsDebugState.eventCount).toBe(2);
		});

		it("updates lastTransitionTime for transition events", () => {
			const before = Date.now();
			wsDebugLog("connect", "connecting");
			expect(wsDebugState.lastTransitionTime).toBeGreaterThanOrEqual(before);
		});

		it("does NOT update lastTransitionTime for non-transition events", () => {
			wsDebugLog("connect", "connecting");
			const afterConnect = wsDebugState.lastTransitionTime;
			// Small delay to ensure different timestamp
			wsDebugLog("relay:status", "connecting", "status=ready");
			expect(wsDebugState.lastTransitionTime).toBe(afterConnect);
		});

		it("calls console.debug when featureFlags.debug is true", () => {
			const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
			featureFlags.debug = true;
			wsDebugLog("connect", "connecting", "slug=test");
			expect(spy).toHaveBeenCalledWith("[ws] connect", "slug=test");
			spy.mockRestore();
		});

		it("does NOT call console.debug when featureFlags.debug is false", () => {
			const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
			featureFlags.debug = false;
			wsDebugLog("connect", "connecting");
			expect(spy).not.toHaveBeenCalled();
			spy.mockRestore();
		});

		it("logs without detail when detail is omitted", () => {
			const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
			featureFlags.debug = true;
			wsDebugLog("ws:open", "connected");
			expect(spy).toHaveBeenCalledWith("[ws] ws:open");
			spy.mockRestore();
		});
	});

	describe("wsDebugLogMessage", () => {
		it("logs first message without msgType", () => {
			wsDebugLogMessage("connected");
			expect(getDebugEvents()).toHaveLength(1);
			expect(getDebugEvents()[0]?.detail).toBe("#1");
		});

		it("logs first message with msgType", () => {
			wsDebugLogMessage("connected", "event");
			expect(getDebugEvents()).toHaveLength(1);
			expect(getDebugEvents()[0]?.detail).toBe("#1 event");
		});

		it("throttles: does not log messages 2-99", () => {
			for (let i = 0; i < 99; i++) {
				wsDebugLogMessage("connected", "event");
			}
			// Only message #1 logged
			expect(getDebugEvents()).toHaveLength(1);
		});

		it("logs every 100th message with msgType", () => {
			for (let i = 0; i < 100; i++) {
				wsDebugLogMessage("connected", "event");
			}
			expect(getDebugEvents()).toHaveLength(2);
			expect(getDebugEvents()[1]?.detail).toBe("#100 event");
		});

		it("verbose mode logs every message", () => {
			wsDebugState.verboseMessages = true;
			for (let i = 0; i < 5; i++) {
				wsDebugLogMessage("connected", "event");
			}
			expect(getDebugEvents()).toHaveLength(5);
		});

		it("disabling verbose mode restores throttle", () => {
			wsDebugState.verboseMessages = true;
			wsDebugLogMessage("connected", "event"); // #1
			wsDebugLogMessage("connected", "event"); // #2 — logged in verbose
			wsDebugState.verboseMessages = false;
			wsDebugLogMessage("connected", "event"); // #3 — throttled, not logged
			// #1 (first) + #2 (verbose) logged; #3 skipped
			expect(getDebugEvents()).toHaveLength(2);
		});
	});

	describe("wsDebugResetMessageCount", () => {
		it("resets so next message is logged as #1", () => {
			wsDebugLogMessage("connected"); // #1
			wsDebugResetMessageCount();
			wsDebugLogMessage("connected"); // #1 again
			const events = getDebugEvents();
			expect(events).toHaveLength(2);
			expect(events[1]!.detail).toBe("#1");
		});
	});

	describe("getDebugSnapshot", () => {
		it("returns a serializable snapshot", () => {
			wsDebugLog("connect", "connecting", "slug=test");
			const snap = getDebugSnapshot();
			expect(snap.eventCount).toBe(1);
			expect(snap.timeInState).toBeGreaterThanOrEqual(0);
			expect(snap.events).toHaveLength(1);
			// Verify it's a copy (not same reference)
			expect(snap.events).not.toBe(getDebugEvents());
		});
	});

	describe("clearDebugLog", () => {
		it("empties the buffer and resets counters", () => {
			wsDebugLog("connect", "connecting");
			wsDebugLogMessage("connected");
			clearDebugLog();
			expect(getDebugEvents()).toHaveLength(0);
			expect(wsDebugState.eventCount).toBe(0);
			// After clear, message count resets
			wsDebugLogMessage("connected");
			expect(getDebugEvents()[0]!.detail).toBe("#1");
		});
	});
});
