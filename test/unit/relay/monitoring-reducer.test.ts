import { describe, expect, it } from "vitest";
import {
	assembleContext,
	evaluateAll,
	evaluateSession,
	initialMonitoringState,
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

describe("evaluateAll", () => {
	it("new sessions default to idle and evaluate normally", () => {
		const contexts = new Map([
			["s1", ctx({ status: { type: "busy" } })],
		]);
		const result = evaluateAll(initialMonitoringState(), contexts, DEFAULT_CONFIG);
		expect(result.state.sessions.get("s1")?.phase).toBe("busy-grace");
		expect(result.effects).toContainEqual({ effect: "notify-busy", sessionId: "s1" });
	});

	it("deleted session with active poller emits stop-poller(session-deleted) and notify-idle", () => {
		const state = {
			sessions: new Map([
				["s1", { phase: "busy-polling" as const, busySince: 0, pollerStartedAt: 100 }],
			]),
		};
		const result = evaluateAll(state, new Map(), DEFAULT_CONFIG);
		expect(result.effects).toContainEqual({
			effect: "stop-poller",
			sessionId: "s1",
			reason: "session-deleted",
		});
		expect(result.effects).toContainEqual({
			effect: "notify-idle",
			sessionId: "s1",
			isSubagent: false,
		});
		expect(result.state.sessions.has("s1")).toBe(false);
	});

	it("deleted session in busy-sse-covered emits notify-idle", () => {
		const state = {
			sessions: new Map([
				["s1", { phase: "busy-sse-covered" as const, busySince: 0, lastSSEAt: 500 }],
			]),
		};
		const result = evaluateAll(state, new Map(), DEFAULT_CONFIG);
		expect(result.effects).toContainEqual({
			effect: "notify-idle",
			sessionId: "s1",
			isSubagent: false,
		});
		expect(result.effects.filter((e) => e.effect === "stop-poller")).toEqual([]);
	});

	it("deleted session in busy-grace emits notify-idle", () => {
		const state = {
			sessions: new Map([
				["s1", { phase: "busy-grace" as const, busySince: 0 }],
			]),
		};
		const result = evaluateAll(state, new Map(), DEFAULT_CONFIG);
		expect(result.effects).toContainEqual({
			effect: "notify-idle",
			sessionId: "s1",
			isSubagent: false,
		});
	});

	it("deleted session in busy-capped emits notify-idle", () => {
		const state = {
			sessions: new Map([
				["s1", { phase: "busy-capped" as const, busySince: 0, cappedAt: 100 }],
			]),
		};
		const result = evaluateAll(state, new Map(), DEFAULT_CONFIG);
		expect(result.effects).toContainEqual({
			effect: "notify-idle",
			sessionId: "s1",
			isSubagent: false,
		});
	});

	it("steady state produces no effects", () => {
		const state = {
			sessions: new Map([
				["s1", { phase: "idle" as const }],
			]),
		};
		const contexts = new Map([
			["s1", ctx({ status: { type: "idle" } })],
		]);
		const result = evaluateAll(state, contexts, DEFAULT_CONFIG);
		expect(result.effects).toEqual([]);
		expect(result.state.sessions.get("s1")).toEqual({ phase: "idle" });
	});

	it("safety cap drops excess start-poller effects and sets busy-capped phase", () => {
		const config = { ...DEFAULT_CONFIG, maxPollers: 1 };
		const contexts = new Map([
			["s1", ctx({ now: 5000, status: { type: "busy" } })],
			["s2", ctx({ now: 5000, status: { type: "busy" } })],
		]);
		const state = {
			sessions: new Map<string, SessionMonitorPhase>([
				["s1", { phase: "busy-grace", busySince: 0 }],
				["s2", { phase: "busy-grace", busySince: 0 }],
			]),
		};
		const result = evaluateAll(state, contexts, config);
		const starts = result.effects.filter((e) => e.effect === "start-poller");
		expect(starts).toHaveLength(1);
		const phases = [...result.state.sessions.values()];
		const capped = phases.filter((p) => p.phase === "busy-capped");
		expect(capped).toHaveLength(1);
		expect(capped[0]).toHaveProperty("busySince", 0);
		expect(capped[0]).toHaveProperty("cappedAt", 5000);
	});

	it("safety cap correctly counts continuing pollers (no double-counting)", () => {
		const config = { ...DEFAULT_CONFIG, maxPollers: 2 };
		const contexts = new Map([
			["s1", ctx({ now: 5000, status: { type: "busy" } })],
			["s2", ctx({ now: 5000, status: { type: "busy" } })],
			["s3", ctx({ now: 5000, status: { type: "busy" } })],
		]);
		const state = {
			sessions: new Map<string, SessionMonitorPhase>([
				["s1", { phase: "busy-polling", busySince: 0, pollerStartedAt: 100 }],
				["s2", { phase: "busy-grace", busySince: 0 }],
				["s3", { phase: "busy-grace", busySince: 0 }],
			]),
		};
		const result = evaluateAll(state, contexts, config);
		const starts = result.effects.filter((e) => e.effect === "start-poller");
		expect(starts).toHaveLength(1);
		const capped = [...result.state.sessions.values()].filter(
			(p) => p.phase === "busy-capped",
		);
		expect(capped).toHaveLength(1);
	});

	it("busy-capped sessions are promoted when cap has room", () => {
		const config = { ...DEFAULT_CONFIG, maxPollers: 2 };
		const contexts = new Map([
			["s1", ctx({ now: 5000, status: { type: "busy" } })],
			["s2", ctx({ now: 5000, status: { type: "busy" } })],
		]);
		const state = {
			sessions: new Map<string, SessionMonitorPhase>([
				["s1", { phase: "busy-polling", busySince: 0, pollerStartedAt: 100 }],
				["s2", { phase: "busy-capped", busySince: 0, cappedAt: 4000 }],
			]),
		};
		const result = evaluateAll(state, contexts, config);
		expect(result.state.sessions.get("s2")?.phase).toBe("busy-polling");
		const starts = result.effects.filter((e) => e.effect === "start-poller");
		expect(starts).toContainEqual(
			expect.objectContaining({ sessionId: "s2" }),
		);
	});
});
