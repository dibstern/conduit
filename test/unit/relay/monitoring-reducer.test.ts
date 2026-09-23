import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SessionStatus } from "../../../src/lib/instance/sdk-types.js";
import {
	assembleContext,
	evaluateAll,
	evaluateSession,
	initialMonitoringState,
	selectMonitoringCandidates,
} from "../../../src/lib/relay/monitoring-reducer.js";
import type {
	PollerGatingConfig,
	SessionEvalContext,
	SessionMonitorPhase,
} from "../../../src/lib/relay/monitoring-types.js";
import type { SessionSSETracker } from "../../../src/lib/relay/session-sse-tracker.js";
import { computeAugmentedStatuses } from "../../../src/lib/session/status-augmentation.js";

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

describe("selectMonitoringCandidates", () => {
	it("keeps grace, SSE deadlines, capped sessions and deletions on the worklist", () => {
		const state = {
			sessions: new Map<string, SessionMonitorPhase>([
				["grace", { phase: "busy-grace", busySince: 0 }],
				["covered", { phase: "busy-sse-covered", busySince: 0, lastSSEAt: 0 }],
				["capped", { phase: "busy-capped", busySince: 0, cappedAt: 1 }],
				[
					"deleted",
					{ phase: "busy-polling", busySince: 0, pollerStartedAt: 1 },
				],
			]),
		};
		const statuses = {
			covered: { type: "busy" as const },
			grace: { type: "busy" as const },
			capped: { type: "busy" as const },
		};
		expect(selectMonitoringCandidates(state, statuses)).toEqual([
			"covered",
			"grace",
			"capped",
			"deleted",
		]);
		const contexts = new Map(
			Object.entries(statuses).map(
				([id, status]) =>
					[
						id,
						ctx({
							status,
							now: 6000,
							lastSSEEventAt: id === "covered" ? 0 : undefined,
						}),
					] as const,
			),
		);
		const result = evaluateAll(state, contexts, DEFAULT_CONFIG);
		expect(result.effects).toContainEqual({
			effect: "stop-poller",
			sessionId: "deleted",
			reason: "session-deleted",
		});
		expect(result.effects).toContainEqual({
			effect: "notify-idle",
			sessionId: "deleted",
			isSubagent: false,
		});
		expect(result.state.sessions.has("deleted")).toBe(false);
		expect(result.state.sessions.get("grace")?.phase).toBe("busy-polling");
		expect(result.effects).toContainEqual({
			effect: "start-poller",
			sessionId: "covered",
			reason: "sse-stale",
		});
	});

	it("includes a parent made busy by its child", () => {
		const { augmented } = computeAugmentedStatuses({
			raw: { parent: { type: "idle" }, child: { type: "busy" } },
			parentMap: new Map([["child", "parent"]]),
			childToParentResolved: new Map(),
			messageActivityTimestamps: new Map(),
			sseIdleSessions: new Set(),
			now: 1,
			messageActivityTtlMs: 10000,
		});
		expect(
			selectMonitoringCandidates(initialMonitoringState(), augmented),
		).toEqual(["parent", "child"]);
	});

	it("matches full evaluation across snapshots, deadlines, viewers and SSE changes", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						elapsed: fc.constantFrom(0, 1, 3000, 3001, 4999, 5000, 10000),
						connected: fc.boolean(),
						entries: fc.uniqueArray(
							fc.record({
								id: fc.constantFrom("a", "b", "c", "d", "parent"),
								status: fc.constantFrom<"idle" | "busy" | "retry">(
									"idle",
									"busy",
									"retry",
								),
								viewers: fc.boolean(),
								sse: fc.boolean(),
								subagent: fc.boolean(),
							}),
							{ selector: (entry) => entry.id, maxLength: 5 },
						),
					}),
					{ minLength: 1, maxLength: 80 },
				),
				fc.integer({ min: 0, max: 3 }),
				(ticks, maxPollers) => {
					let full = initialMonitoringState();
					let filtered = initialMonitoringState();
					let now = 0;
					const lastSSE = new Map<string, number>();
					const config = { ...DEFAULT_CONFIG, maxPollers };
					for (const tick of ticks) {
						now += tick.elapsed;
						const statuses: Record<string, SessionStatus> = {};
						const contexts = new Map<string, SessionEvalContext>();
						for (const entry of tick.entries) {
							const status: SessionStatus =
								entry.status === "retry"
									? {
											type: "retry",
											attempt: 1,
											message: "retry",
											next: now + 1,
										}
									: { type: entry.status };
							statuses[entry.id] = status;
							if (entry.sse) lastSSE.set(entry.id, now);
							contexts.set(
								entry.id,
								ctx({
									status,
									now,
									sseConnected: tick.connected,
									lastSSEEventAt: lastSSE.get(entry.id),
									hasViewers: entry.viewers,
									isSubagent: entry.subagent,
								}),
							);
						}
						const selected = new Map<string, SessionEvalContext>();
						for (const id of selectMonitoringCandidates(filtered, statuses)) {
							const context = contexts.get(id);
							if (context) selected.set(id, context);
						}
						const expected = evaluateAll(full, contexts, config);
						const actual = evaluateAll(filtered, selected, config);
						expect(actual.effects).toEqual(expected.effects);
						expect([...actual.state.sessions]).toEqual([
							...expected.state.sessions,
						]);
						full = expected.state;
						filtered = actual.state;
					}
				},
			),
			{ numRuns: 200 },
		);
	});
	it("evaluates completion once, then retires the session", () => {
		const state = {
			sessions: new Map<string, SessionMonitorPhase>([
				["s1", { phase: "busy-polling", busySince: 0, pollerStartedAt: 1 }],
			]),
		};
		const statuses = { s1: { type: "idle" as const } };
		expect(selectMonitoringCandidates(state, statuses)).toEqual(["s1"]);
		const result = evaluateAll(state, new Map([["s1", ctx()]]), DEFAULT_CONFIG);
		expect(result.effects).toEqual([
			{ effect: "stop-poller", sessionId: "s1", reason: "idle-no-viewers" },
			{ effect: "notify-idle", sessionId: "s1", isSubagent: false },
		]);
		expect(result.state.sessions.size).toBe(0);
		expect(selectMonitoringCandidates(result.state, statuses)).toEqual([]);
	});
	it("skips thousands of settled sessions and reactivates an old idle session", () => {
		const statuses = Object.fromEntries(
			Array.from({ length: 4000 }, (_, i) => [
				`s${i}`,
				{ type: "idle" as const },
			]),
		);
		expect(
			selectMonitoringCandidates(initialMonitoringState(), statuses),
		).toEqual([]);
		expect(
			selectMonitoringCandidates(initialMonitoringState(), {
				...statuses,
				s0: { type: "busy" },
			}),
		).toEqual(["s0"]);
	});
});

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
		const result = evaluateSession(
			"s1",
			{ phase: "idle" },
			ctx(),
			DEFAULT_CONFIG,
		);
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
		expect(result.effects).toEqual([
			{ effect: "notify-busy", sessionId: "s1" },
		]);
	});

	it("idle + busy + no SSE → busy-grace + notify-busy", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "idle" },
			ctx({ status: { type: "busy" } }),
			DEFAULT_CONFIG,
		);
		expect(result.phase).toEqual({ phase: "busy-grace", busySince: 1000 });
		expect(result.effects).toEqual([
			{ effect: "notify-busy", sessionId: "s1" },
		]);
	});

	it("idle + retry status → treated as busy", () => {
		const result = evaluateSession(
			"s1",
			{ phase: "idle" },
			ctx({
				status: { type: "retry", attempt: 1, message: "err", next: 2000 },
			}),
			DEFAULT_CONFIG,
		);
		expect(result.phase.phase).toBe("busy-grace");
		expect(result.effects).toContainEqual({
			effect: "notify-busy",
			sessionId: "s1",
		});
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
		const contexts = new Map([["s1", ctx({ status: { type: "busy" } })]]);
		const result = evaluateAll(
			initialMonitoringState(),
			contexts,
			DEFAULT_CONFIG,
		);
		expect(result.state.sessions.get("s1")?.phase).toBe("busy-grace");
		expect(result.effects).toContainEqual({
			effect: "notify-busy",
			sessionId: "s1",
		});
	});

	it("deleted session with active poller emits stop-poller(session-deleted) and notify-idle", () => {
		const state = {
			sessions: new Map([
				[
					"s1",
					{
						phase: "busy-polling" as const,
						busySince: 0,
						pollerStartedAt: 100,
					},
				],
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
				[
					"s1",
					{ phase: "busy-sse-covered" as const, busySince: 0, lastSSEAt: 500 },
				],
			]),
		};
		const result = evaluateAll(state, new Map(), DEFAULT_CONFIG);
		expect(result.effects).toContainEqual({
			effect: "notify-idle",
			sessionId: "s1",
			isSubagent: false,
		});
		expect(result.effects.filter((e) => e.effect === "stop-poller")).toEqual(
			[],
		);
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
			sessions: new Map([["s1", { phase: "idle" as const }]]),
		};
		const contexts = new Map([["s1", ctx({ status: { type: "idle" } })]]);
		const result = evaluateAll(state, contexts, DEFAULT_CONFIG);
		expect(result.effects).toEqual([]);
		expect(result.state.sessions.has("s1")).toBe(false);
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
		expect(starts).toContainEqual(expect.objectContaining({ sessionId: "s2" }));
	});
});
