import { describe, expect, it } from "vitest";
import {
	assembleContext,
	evaluateSession,
} from "../../../src/lib/relay/monitoring-reducer.js";
import type {
	MonitoringEffect,
	PollerGatingConfig,
	SessionEvalContext,
	SessionMonitorPhase,
} from "../../../src/lib/relay/monitoring-types.js";
import type { SessionSSETracker } from "../../../src/lib/relay/session-sse-tracker.js";

// Minimal SSE tracker stub for tests
function stubTracker(data: Record<string, number> = {}): SessionSSETracker {
	return {
		recordEvent() {},
		getLastEventAt(id) {
			return data[id];
		},
		remove() {},
	};
}

describe("assembleContext", () => {
	it("assembles all fields from data sources", () => {
		const ctx = assembleContext(
			"s1",
			{ type: "busy" },
			{ connected: true },
			stubTracker({ s1: 900 }),
			new Map([["s1", "parent1"]]),
			(sid) => sid === "s1",
			1000,
		);
		expect(ctx).toEqual({
			now: 1000,
			status: { type: "busy" },
			sseConnected: true,
			lastSSEEventAt: 900,
			isSubagent: true,
			hasViewers: true,
		});
	});

	it("isSubagent is false when session not in parent map", () => {
		const ctx = assembleContext(
			"s2",
			{ type: "idle" },
			{ connected: false },
			stubTracker(),
			new Map(),
			() => false,
			2000,
		);
		expect(ctx.isSubagent).toBe(false);
		expect(ctx.lastSSEEventAt).toBeUndefined();
		expect(ctx.hasViewers).toBe(false);
	});
});

const DEFAULT_CONFIG: PollerGatingConfig = {
	sseActiveThresholdMs: 5_000,
	sseGracePeriodMs: 3_000,
	maxPollers: 50,
};

// Helper to build a minimal SessionEvalContext
function ctx(overrides: Partial<SessionEvalContext> = {}): SessionEvalContext {
	return {
		now: 1000,
		status: { type: "idle" },
		sseConnected: true,
		lastSSEEventAt: undefined,
		isSubagent: false,
		hasViewers: false,
		...overrides,
	};
}

describe("evaluateSession", () => {
	// ── from idle ────────────────────────────────────────────────────────

	it("idle + idle status → idle, no effects", () => {
		const result = evaluateSession("s1", { phase: "idle" }, ctx(), DEFAULT_CONFIG);
		expect(result.phase).toEqual({ phase: "idle" });
		expect(result.effects).toEqual([]);
	});

	it("idle + busy + SSE active → busy-sse-covered + notify-busy", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "idle" },
			ctx({ status: { type: "busy" }, lastSSEEventAt: 900 }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-sse-covered",
			busySince: 1000,
			lastSSEAt: 900,
		});
		expect(result.effects).toEqual([{ effect: "notify-busy", sessionId: "s1" }]);
	});

	it("idle + busy + no SSE → busy-grace + notify-busy", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "idle" },
			ctx({ status: { type: "busy" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({ phase: "busy-grace", busySince: 1000 });
		expect(result.effects).toEqual([{ effect: "notify-busy", sessionId: "s1" }]);
	});

	it("idle + retry status → treated as busy", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "idle" },
			ctx({ status: { type: "retry", attempt: 1, message: "err", next: 2000 } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase.phase).toBe("busy-grace");
		expect(result.effects).toContainEqual({ effect: "notify-busy", sessionId: "s1" });
	});

	// ── from busy-grace ──────────────────────────────────────────────────

	it("busy-grace + idle → idle + notify-idle", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ now: 1000, status: { type: "idle" }, isSubagent: false }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({ phase: "idle" });
		expect(result.effects).toEqual([
			{ effect: "notify-idle", sessionId: "s1", isSubagent: false },
		]);
	});

	it("busy-grace + idle (subagent) → notify-idle with isSubagent=true", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ status: { type: "idle" }, isSubagent: true }),
			DEFAULT_CONFIG,
		);
		expect(result.effects).toEqual([
			{ effect: "notify-idle", sessionId: "s1", isSubagent: true },
		]);
	});

	it("busy-grace + SSE active → busy-sse-covered, no effects", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ status: { type: "busy" }, lastSSEEventAt: 800 }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-sse-covered",
			busySince: 0,
			lastSSEAt: 800,
		});
		expect(result.effects).toEqual([]);
	});

	it("busy-grace + grace expired + SSE disconnected → busy-polling + start-poller(sse-disconnected)", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ now: 5000, status: { type: "busy" }, sseConnected: false }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-polling",
			busySince: 0,
			pollerStartedAt: 5000,
		});
		expect(result.effects).toEqual([
			{ effect: "start-poller", sessionId: "s1", reason: "sse-disconnected" },
		]);
	});

	it("busy-grace + grace expired + SSE never-seen → busy-polling + start-poller(no-sse-history)", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ now: 5000, status: { type: "busy" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase.phase).toBe("busy-polling");
		expect(result.effects).toContainEqual({
			effect: "start-poller",
			sessionId: "s1",
			reason: "no-sse-history",
		});
	});

	it("busy-grace + grace NOT expired + no SSE → stays busy-grace", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ now: 2000, status: { type: "busy" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({ phase: "busy-grace", busySince: 0 });
		expect(result.effects).toEqual([]);
	});

	it("busy-grace + grace expiry exact boundary (now - busySince === gracePeriodMs) → stays busy-grace (check is >)", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ now: 3000, status: { type: "busy" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({ phase: "busy-grace", busySince: 0 });
		expect(result.effects).toEqual([]);
	});

	it("busy-grace + grace expired + SSE stale → busy-polling + start-poller(sse-grace-expired)", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-grace", busySince: 0 },
			ctx({ now: 10000, status: { type: "busy" }, lastSSEEventAt: 100 }),
			DEFAULT_CONFIG,
		);
		expect(result.phase.phase).toBe("busy-polling");
		expect(result.effects).toContainEqual({
			effect: "start-poller",
			sessionId: "s1",
			reason: "sse-grace-expired",
		});
	});

	// ── from busy-sse-covered ────────────────────────────────────────────

	it("busy-sse-covered + idle → idle + notify-idle", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-sse-covered", busySince: 0, lastSSEAt: 500 },
			ctx({ status: { type: "idle" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({ phase: "idle" });
		expect(result.effects).toEqual([
			{ effect: "notify-idle", sessionId: "s1", isSubagent: false },
		]);
	});

	it("busy-sse-covered + SSE disconnected → busy-polling + start-poller(sse-disconnected)", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-sse-covered", busySince: 0, lastSSEAt: 500 },
			ctx({ now: 1000, status: { type: "busy" }, sseConnected: false }),
			DEFAULT_CONFIG,
		);
		expect(result.phase.phase).toBe("busy-polling");
		expect(result.effects).toContainEqual({
			effect: "start-poller",
			sessionId: "s1",
			reason: "sse-disconnected",
		});
	});

	it("busy-sse-covered + SSE stale → busy-polling + start-poller(sse-stale)", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-sse-covered", busySince: 0, lastSSEAt: 500 },
			ctx({ now: 10000, status: { type: "busy" }, lastSSEEventAt: 500 }),
			DEFAULT_CONFIG,
		);
		expect(result.phase.phase).toBe("busy-polling");
		expect(result.effects).toContainEqual({
			effect: "start-poller",
			sessionId: "s1",
			reason: "sse-stale",
		});
	});

	it("busy-sse-covered + SSE active → stays, updates lastSSEAt", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-sse-covered", busySince: 0, lastSSEAt: 500 },
			ctx({ now: 2000, status: { type: "busy" }, lastSSEEventAt: 1800 }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-sse-covered",
			busySince: 0,
			lastSSEAt: 1800,
		});
		expect(result.effects).toEqual([]);
	});

	// ── from busy-polling ────────────────────────────────────────────────

	it("busy-polling + idle + no viewers → stop-poller(idle-no-viewers) + notify-idle", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-polling", busySince: 0, pollerStartedAt: 100 },
			ctx({ now: 5000, status: { type: "idle" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({ phase: "idle" });
		expect(result.effects).toEqual([
			{ effect: "stop-poller", sessionId: "s1", reason: "idle-no-viewers" },
			{ effect: "notify-idle", sessionId: "s1", isSubagent: false },
		]);
	});

	it("busy-polling + idle + has viewers → stop-poller(idle-has-viewers) + notify-idle", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-polling", busySince: 0, pollerStartedAt: 100 },
			ctx({ now: 5000, status: { type: "idle" }, hasViewers: true }),
			DEFAULT_CONFIG,
		);
		expect(result.effects).toContainEqual({
			effect: "stop-poller",
			sessionId: "s1",
			reason: "idle-has-viewers",
		});
		expect(result.effects).toContainEqual({
			effect: "notify-idle",
			sessionId: "s1",
			isSubagent: false,
		});
	});

	it("busy-polling + SSE resumes → busy-sse-covered + stop-poller(sse-now-covering)", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-polling", busySince: 0, pollerStartedAt: 100 },
			ctx({ now: 5000, status: { type: "busy" }, lastSSEEventAt: 4900 }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-sse-covered",
			busySince: 0,
			lastSSEAt: 4900,
		});
		expect(result.effects).toEqual([
			{ effect: "stop-poller", sessionId: "s1", reason: "sse-now-covering" },
		]);
	});

	it("busy-polling + still busy + no SSE → stays busy-polling", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-polling", busySince: 0, pollerStartedAt: 100 },
			ctx({ now: 5000, status: { type: "busy" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-polling",
			busySince: 0,
			pollerStartedAt: 100,
		});
		expect(result.effects).toEqual([]);
	});

	// ── from busy-capped ────────────────────────────────────────────────

	it("busy-capped + idle → idle + notify-idle", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-capped", busySince: 0, cappedAt: 100 },
			ctx({ now: 5000, status: { type: "idle" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({ phase: "idle" });
		expect(result.effects).toEqual([
			{ effect: "notify-idle", sessionId: "s1", isSubagent: false },
		]);
	});

	it("busy-capped + SSE active → busy-sse-covered, no effects", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-capped", busySince: 0, cappedAt: 100 },
			ctx({ now: 2000, status: { type: "busy" }, lastSSEEventAt: 1800 }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-sse-covered",
			busySince: 0,
			lastSSEAt: 1800,
		});
		expect(result.effects).toEqual([]);
	});

	it("busy-capped + still busy + no SSE → stays busy-capped", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "busy-capped", busySince: 0, cappedAt: 100 },
			ctx({ now: 5000, status: { type: "busy" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({
			phase: "busy-capped",
			busySince: 0,
			cappedAt: 100,
		});
		expect(result.effects).toEqual([]);
	});
});
