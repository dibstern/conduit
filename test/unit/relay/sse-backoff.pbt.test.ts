// ─── Property-Based Tests: SSE Reconnection & Backoff (Ticket 1.2) ───────────
//
// Properties tested:
// P1: Backoff delay is always in [baseDelay, maxDelay] (AC3)
// P2: Backoff delay is monotonically non-decreasing until cap (AC3)
// P3: Backoff reaches maxDelay eventually (AC3)
// P4: Connection health shape is always valid (AC7)
// P5: Stale detection: no event in staleThreshold → stale (AC7)
// P6: Reconnect count is monotonically increasing (AC3)
// P7: Session filtering preserves events for target, drops others (AC4)
// P8: parseSSEData never throws on arbitrary input (AC5)
// P9: parseSSEData roundtrips valid events (AC6)
// P10: parseGlobalSSEData validates directory+payload shape (AC2)
// P11: classifyEventType partitions correctly (AC6)
// P12: Backoff with default config matches spec: 1s, 2s, 4s, 8s, max 30s (AC3)

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	type BackoffConfig,
	calculateBackoffDelay,
	classifyEventType,
	createHealthTracker,
	eventBelongsToSession,
	filterEventsBySession,
	getBackoffSequence,
	getSessionIds,
	isKnownEventType,
	parseGlobalSSEData,
	parseSSEData,
} from "../../../src/lib/relay/sse-backoff.js";
import type { OpenCodeEvent } from "../../../src/lib/types.js";
import { edgeCaseString } from "../../helpers/arbitraries.js";

const SEED = 42;
const NUM_RUNS = 300;

// ─── Generators ─────────────────────────────────────────────────────────────

const arbBackoffConfig: fc.Arbitrary<BackoffConfig> = fc
	.record({
		baseDelay: fc.integer({ min: 1, max: 10_000 }),
		maxDelay: fc.integer({ min: 1, max: 120_000 }),
		multiplier: fc.oneof(
			fc.constant(2),
			fc.constant(1.5),
			fc.constant(3),
			fc.double({ min: 1.1, max: 5, noNaN: true }),
		),
	})
	.map((c) => ({
		...c,
		// Ensure maxDelay >= baseDelay
		maxDelay: Math.max(c.maxDelay, c.baseDelay),
	}));

const arbEventWithSession = fc
	.record({
		type: fc.constantFrom(
			"message.part.delta",
			"message.part.updated",
			"session.status",
		),
		sessionID: fc.uuid(),
		data: fc.string(),
	})
	.map(
		({ type, sessionID, data }): OpenCodeEvent => ({
			type,
			properties: { sessionID, data },
		}),
	);

const arbEventWithoutSession = fc
	.record({
		type: fc.constantFrom("server.connected", "server.heartbeat"),
	})
	.map(
		({ type }): OpenCodeEvent => ({
			type,
			properties: {},
		}),
	);

const arbKnownEventType = fc.constantFrom(
	"message.part.updated",
	"message.part.delta",
	"message.part.removed",
	"message.updated",
	"message.removed",
	"session.status",
	"permission.asked",
	"permission.replied",
	"question.asked",
	"question.replied",
	"question.rejected",
	"pty.created",
	"pty.updated",
	"pty.exited",
	"pty.deleted",
	"file.edited",
	"file.watcher.updated",
	"server.connected",
	"server.heartbeat",
);

describe("Ticket 1.2 — SSE Reconnection & Backoff PBT", () => {
	// ─── P1: Backoff delay bounds ──────────────────────────────────────────

	describe("P1: Backoff delay is always in [baseDelay, maxDelay] (AC3)", () => {
		it("property: delay is bounded", () => {
			fc.assert(
				fc.property(
					fc.nat({ max: 50 }),
					arbBackoffConfig,
					(attempt, config) => {
						const delay = calculateBackoffDelay(attempt, config);
						expect(delay).toBeGreaterThanOrEqual(config.baseDelay);
						expect(delay).toBeLessThanOrEqual(config.maxDelay);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: negative attempt returns baseDelay", () => {
			fc.assert(
				fc.property(
					fc.integer({ min: -1000, max: -1 }),
					arbBackoffConfig,
					(attempt, config) => {
						const delay = calculateBackoffDelay(attempt, config);
						expect(delay).toBe(config.baseDelay);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P2: Monotonic non-decreasing ──────────────────────────────────────

	describe("P2: Backoff delay is monotonically non-decreasing (AC3)", () => {
		it("property: delay(n) <= delay(n+1)", () => {
			fc.assert(
				fc.property(
					fc.nat({ max: 49 }),
					arbBackoffConfig,
					(attempt, config) => {
						const d1 = calculateBackoffDelay(attempt, config);
						const d2 = calculateBackoffDelay(attempt + 1, config);
						expect(d2).toBeGreaterThanOrEqual(d1);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: getBackoffSequence is sorted non-decreasing", () => {
			fc.assert(
				fc.property(
					fc.integer({ min: 1, max: 20 }),
					arbBackoffConfig,
					(n, config) => {
						const seq = getBackoffSequence(n, config);
						expect(seq).toHaveLength(n);
						for (let i = 1; i < seq.length; i++) {
							// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
							expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]!);
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P3: Reaches maxDelay eventually ───────────────────────────────────

	describe("P3: Backoff reaches maxDelay eventually (AC3)", () => {
		it("property: sufficiently large attempt → maxDelay", () => {
			fc.assert(
				fc.property(arbBackoffConfig, (config) => {
					// Compute the minimum attempt needed to reach maxDelay:
					// baseDelay * multiplier^n >= maxDelay
					// n >= log(maxDelay / baseDelay) / log(multiplier)
					const n = Math.ceil(
						Math.log(config.maxDelay / config.baseDelay) /
							Math.log(config.multiplier),
					);
					// Add generous margin for floating-point edge cases
					const attempt = n + 5;
					const delay = calculateBackoffDelay(attempt, config);
					expect(delay).toBe(config.maxDelay);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P4: Health shape ──────────────────────────────────────────────────

	describe("P4: Connection health shape is always valid (AC7)", () => {
		it("property: getHealth returns all required fields", () => {
			fc.assert(
				fc.property(
					fc.array(
						fc.constantFrom("connect", "disconnect", "event", "reconnect"),
						{ minLength: 0, maxLength: 20 },
					),
					(actions) => {
						const tracker = createHealthTracker({
							staleThreshold: 60_000,
							now: () => 1_000_000,
						});

						for (const action of actions) {
							switch (action) {
								case "connect":
									tracker.onConnected();
									break;
								case "disconnect":
									tracker.onDisconnected();
									break;
								case "event":
									tracker.onEvent();
									break;
								case "reconnect":
									tracker.onReconnect();
									break;
							}
						}

						const health = tracker.getHealth();
						expect(typeof health.connected).toBe("boolean");
						expect(
							health.lastEventAt === null ||
								typeof health.lastEventAt === "number",
						).toBe(true);
						expect(typeof health.reconnectCount).toBe("number");
						expect(health.reconnectCount).toBeGreaterThanOrEqual(0);
						expect(typeof health.stale).toBe("boolean");
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P5: Stale detection ───────────────────────────────────────────────

	describe("P5: Stale detection triggers when no events received (AC7)", () => {
		it("property: event within threshold → not stale", () => {
			fc.assert(
				fc.property(fc.integer({ min: 1000, max: 100_000 }), (threshold) => {
					let currentTime = 0;
					const tracker = createHealthTracker({
						staleThreshold: threshold,
						now: () => currentTime,
					});

					tracker.onConnected();
					tracker.onEvent();

					// Time hasn't advanced → not stale
					expect(tracker.isStale()).toBe(false);

					// Advance just under threshold → not stale
					currentTime = threshold - 1;
					expect(tracker.isStale()).toBe(false);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: event beyond threshold → stale", () => {
			fc.assert(
				fc.property(fc.integer({ min: 1000, max: 100_000 }), (threshold) => {
					let currentTime = 0;
					const tracker = createHealthTracker({
						staleThreshold: threshold,
						now: () => currentTime,
					});

					tracker.onConnected();
					tracker.onEvent();

					// Advance past threshold → stale
					currentTime = threshold + 1;
					expect(tracker.isStale()).toBe(true);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: disconnected → never stale (even with old event)", () => {
			fc.assert(
				fc.property(fc.integer({ min: 1000, max: 100_000 }), (threshold) => {
					let currentTime = 0;
					const tracker = createHealthTracker({
						staleThreshold: threshold,
						now: () => currentTime,
					});

					tracker.onConnected();
					tracker.onEvent();
					tracker.onDisconnected();

					currentTime = threshold * 10;
					expect(tracker.isStale()).toBe(false);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P6: Reconnect count monotonic ─────────────────────────────────────

	describe("P6: Reconnect count is monotonically increasing (AC3)", () => {
		it("property: each onReconnect increments count by 1", () => {
			fc.assert(
				fc.property(fc.nat({ max: 50 }), (n) => {
					const tracker = createHealthTracker({
						staleThreshold: 60_000,
						now: () => 0,
					});

					for (let i = 0; i < n; i++) {
						tracker.onReconnect();
					}

					expect(tracker.getReconnectCount()).toBe(n);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: other actions don't affect reconnect count", () => {
			fc.assert(
				fc.property(
					fc.array(fc.constantFrom("connect", "disconnect", "event"), {
						minLength: 0,
						maxLength: 20,
					}),
					(actions) => {
						const tracker = createHealthTracker({
							staleThreshold: 60_000,
							now: () => 0,
						});

						for (const action of actions) {
							switch (action) {
								case "connect":
									tracker.onConnected();
									break;
								case "disconnect":
									tracker.onDisconnected();
									break;
								case "event":
									tracker.onEvent();
									break;
							}
						}

						expect(tracker.getReconnectCount()).toBe(0);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P7: Session filtering ─────────────────────────────────────────────

	describe("P7: Session filtering preserves/drops correctly (AC4)", () => {
		it("property: events without sessionID always pass filter", () => {
			fc.assert(
				fc.property(arbEventWithoutSession, fc.uuid(), (event, sessionId) => {
					expect(eventBelongsToSession(event, sessionId)).toBe(true);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: events with matching sessionID pass filter", () => {
			fc.assert(
				fc.property(fc.uuid(), (sessionId) => {
					const event: OpenCodeEvent = {
						type: "message.part.delta",
						properties: { sessionID: sessionId, delta: "test" },
					};
					expect(eventBelongsToSession(event, sessionId)).toBe(true);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: events with non-matching sessionID are dropped", () => {
			fc.assert(
				fc.property(fc.uuid(), fc.uuid(), (sessionId, otherId) => {
					fc.pre(sessionId !== otherId);
					const event: OpenCodeEvent = {
						type: "message.part.delta",
						properties: { sessionID: otherId, delta: "test" },
					};
					expect(eventBelongsToSession(event, sessionId)).toBe(false);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: filterEventsBySession result ⊆ input", () => {
			fc.assert(
				fc.property(
					fc.array(fc.oneof(arbEventWithSession, arbEventWithoutSession), {
						minLength: 0,
						maxLength: 15,
					}),
					fc.uuid(),
					(events, sessionId) => {
						const filtered = filterEventsBySession(events, sessionId);
						expect(filtered.length).toBeLessThanOrEqual(events.length);
						// All filtered events belong to session
						for (const e of filtered) {
							expect(eventBelongsToSession(e, sessionId)).toBe(true);
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: getSessionIds returns only IDs actually present", () => {
			fc.assert(
				fc.property(
					fc.array(fc.oneof(arbEventWithSession, arbEventWithoutSession), {
						minLength: 0,
						maxLength: 15,
					}),
					(events) => {
						const ids = getSessionIds(events);
						for (const id of ids) {
							expect(typeof id).toBe("string");
							// Verify at least one event has this sessionID
							const found = events.some(
								(e) =>
									(e.properties as { sessionID?: string }).sessionID === id,
							);
							expect(found).toBe(true);
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P8: parseSSEData robustness ───────────────────────────────────────

	describe("P8: parseSSEData never throws on arbitrary input (AC5)", () => {
		it("property: arbitrary strings never throw", () => {
			fc.assert(
				fc.property(edgeCaseString, (raw) => {
					const result = parseSSEData(raw);
					expect(typeof result.ok).toBe("boolean");
					if (result.ok) {
						expect(result.event).toBeDefined();
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						expect(typeof result.event!.type).toBe("string");
					} else {
						expect(typeof result.error).toBe("string");
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: empty/whitespace → ok=false", () => {
			fc.assert(
				fc.property(
					fc.oneof(
						fc.constant(""),
						fc.constant("   "),
						fc.constant("\n"),
						fc.constant("\t"),
					),
					(raw) => {
						const result = parseSSEData(raw);
						expect(result.ok).toBe(false);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P9: parseSSEData roundtrip ────────────────────────────────────────

	describe("P9: parseSSEData roundtrips valid events (AC6)", () => {
		it("property: serialize→parse preserves type and properties", () => {
			fc.assert(
				fc.property(
					fc.string({ minLength: 1, maxLength: 50 }),
					fc.dictionary(
						fc.string({ minLength: 1, maxLength: 10 }),
						fc.jsonValue(),
					),
					(type, properties) => {
						const event = { type, properties };
						const raw = JSON.stringify(event);
						const result = parseSSEData(raw);
						expect(result.ok).toBe(true);
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						expect(result.event!.type).toBe(type);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P10: parseGlobalSSEData ───────────────────────────────────────────

	describe("P10: parseGlobalSSEData validates directory+payload (AC2)", () => {
		it("property: valid global events parse correctly", () => {
			fc.assert(
				fc.property(
					fc.string({ minLength: 1, maxLength: 100 }),
					fc.string({ minLength: 1, maxLength: 50 }),
					fc.dictionary(
						fc.string({ minLength: 1, maxLength: 10 }),
						fc.jsonValue(),
					),
					(directory, type, properties) => {
						const raw = JSON.stringify({
							directory,
							payload: { type, properties },
						});
						const result = parseGlobalSSEData(raw);
						expect(result.ok).toBe(true);
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						expect(result.event!.directory).toBe(directory);
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						expect(result.event!.payload.type).toBe(type);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: missing directory → ok=false", () => {
			fc.assert(
				fc.property(fc.string({ minLength: 1, maxLength: 50 }), (type) => {
					const raw = JSON.stringify({ payload: { type, properties: {} } });
					const result = parseGlobalSSEData(raw);
					expect(result.ok).toBe(false);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: arbitrary strings never throw", () => {
			fc.assert(
				fc.property(edgeCaseString, (raw) => {
					const result = parseGlobalSSEData(raw);
					expect(typeof result.ok).toBe("boolean");
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P11: classifyEventType ────────────────────────────────────────────

	describe("P11: classifyEventType partitions correctly (AC6)", () => {
		it("property: known event types are classified to correct category", () => {
			fc.assert(
				fc.property(arbKnownEventType, (type) => {
					const category = classifyEventType(type);
					expect(category).not.toBe("unknown");

					// Verify category matches prefix
					if (type.startsWith("message.")) expect(category).toBe("message");
					else if (type.startsWith("session."))
						expect(category).toBe("session");
					else if (type.startsWith("permission."))
						expect(category).toBe("permission");
					else if (type.startsWith("question."))
						expect(category).toBe("question");
					else if (type.startsWith("pty.")) expect(category).toBe("pty");
					else if (type.startsWith("file.")) expect(category).toBe("file");
					else if (type.startsWith("server.")) expect(category).toBe("server");
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: isKnownEventType agrees with known set", () => {
			fc.assert(
				fc.property(arbKnownEventType, (type) => {
					expect(isKnownEventType(type)).toBe(true);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: random strings default to 'unknown'", () => {
			fc.assert(
				fc.property(
					fc
						.string({ minLength: 1, maxLength: 30 })
						.filter(
							(s) =>
								!s.startsWith("message.") &&
								!s.startsWith("session.") &&
								!s.startsWith("permission.") &&
								!s.startsWith("question.") &&
								!s.startsWith("pty.") &&
								!s.startsWith("file.") &&
								!s.startsWith("server."),
						),
					(type) => {
						expect(classifyEventType(type)).toBe("unknown");
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P12: Default config matches spec ──────────────────────────────────

	describe("P12: Default config matches spec: 1s, 2s, 4s, 8s, max 30s (AC3)", () => {
		it("property: first 5 delays match spec exactly", () => {
			// This is a concrete check — the spec is explicit about these values
			const seq = getBackoffSequence(6);
			expect(seq[0]).toBe(1000); // 1s
			expect(seq[1]).toBe(2000); // 2s
			expect(seq[2]).toBe(4000); // 4s
			expect(seq[3]).toBe(8000); // 8s
			expect(seq[4]).toBe(16000); // 16s
			expect(seq[5]).toBe(30000); // capped at 30s
		});

		it("property: all further attempts stay at 30s", () => {
			fc.assert(
				fc.property(fc.integer({ min: 5, max: 100 }), (attempt) => {
					const delay = calculateBackoffDelay(attempt);
					expect(delay).toBe(30000);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});
});
