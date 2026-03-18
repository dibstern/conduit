// ─── Metamorphic Tests: Event Translator (Ticket 1.3) ───────────────────────
//
// Metamorphic properties test relationships between different inputs/executions
// rather than checking absolute outputs. This catches subtle ordering bugs,
// state leaks, and non-determinism.
//
// Properties:
// M1: Translating events through two fresh translators produces same results
//     (determinism / no hidden global state)
// M2: Order of independent events doesn't affect final translator state
//     (independent events for DIFFERENT partIDs commute)
// M3: Reset followed by same event sequence produces identical output
//     (reset truly clears all state)
// M4: Adding more unknown events doesn't affect outputs for known events
//     (unknown events are transparent)
// M5: mapToolName applied twice is same as applied once (idempotence when
//     the output is not a known lowercase key)

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TranslateResult } from "../../../src/lib/relay/event-translator.js";
import {
	createTranslator,
	mapToolName,
} from "../../../src/lib/relay/event-translator.js";
import type { OpenCodeEvent } from "../../../src/lib/types.js";

const SEED = 42;
const NUM_RUNS = 200;

// ─── Helpers ────────────────────────────────────────────────────────────────

function collectResults(events: OpenCodeEvent[]): TranslateResult[] {
	const translator = createTranslator();
	return events.map((e) => translator.translate(e));
}

function makeToolEvent(
	partID: string,
	tool: string,
	status: "pending" | "running" | "completed" | "error",
): OpenCodeEvent {
	return {
		type: "message.part.updated",
		properties: {
			partID,
			part: {
				type: "tool",
				callID: partID,
				tool,
				state: { status },
			},
		},
	};
}

function makeReasoningEvent(partID: string, end?: number): OpenCodeEvent {
	return {
		type: "message.part.updated",
		properties: {
			partID,
			part: {
				type: "reasoning",
				...(end !== undefined ? { time: { end } } : {}),
			},
		},
	};
}

function makeDeltaEvent(partID: string, text: string): OpenCodeEvent {
	return {
		type: "message.part.delta",
		properties: { partID, field: "text", delta: text },
	};
}

// ─── M1: Determinism ────────────────────────────────────────────────────────

describe("Ticket 1.3 — Event Translator Metamorphic PBT", () => {
	describe("M1: Two fresh translators produce identical results (determinism)", () => {
		it("property: same event sequence → same output sequence", () => {
			const arbEventSeq = fc.array(
				fc.oneof(
					fc
						.tuple(fc.uuid(), fc.constantFrom("bash", "read", "edit"))
						.map(([id, tool]) => makeToolEvent(id, tool, "pending")),
					fc.tuple(fc.uuid()).map(([id]) => makeReasoningEvent(id)),
					fc
						.tuple(fc.uuid(), fc.string({ minLength: 1, maxLength: 50 }))
						.map(([id, text]) => makeDeltaEvent(id, text)),
					fc.constant({
						type: "session.status",
						properties: { status: { type: "busy" } },
					} as OpenCodeEvent),
					fc.constant({
						type: "session.status",
						properties: { status: { type: "idle" } },
					} as OpenCodeEvent),
				),
				{ minLength: 1, maxLength: 15 },
			);

			fc.assert(
				fc.property(arbEventSeq, (events) => {
					const results1 = collectResults(events);
					const results2 = collectResults(events);

					expect(results1).toEqual(results2);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── M2: Independent events commute ─────────────────────────────────────

	describe("M2: Independent events for different partIDs commute", () => {
		it("property: two independent tool_start events — either order yields same seenParts size", () => {
			fc.assert(
				fc.property(
					fc.uuid(),
					fc.uuid(),
					fc.constantFrom("bash", "read", "edit"),
					fc.constantFrom("write", "glob", "grep"),
					(idA, idB, toolA, toolB) => {
						fc.pre(idA !== idB);

						const eventA = makeToolEvent(idA, toolA, "pending");
						const eventB = makeToolEvent(idB, toolB, "pending");

						// Order A then B
						const t1 = createTranslator();
						t1.translate(eventA);
						t1.translate(eventB);

						// Order B then A
						const t2 = createTranslator();
						t2.translate(eventB);
						t2.translate(eventA);

						// Final state should be identical
						expect(t1.getSeenParts()?.size ?? 0).toBe(
							t2.getSeenParts()?.size ?? 0,
						);
						expect(t1.getSeenParts()?.size ?? 0).toBe(2);

						// Both parts tracked in both
						expect(t1.getSeenParts()?.has(idA)).toBe(true);
						expect(t1.getSeenParts()?.has(idB)).toBe(true);
						expect(t2.getSeenParts()?.has(idA)).toBe(true);
						expect(t2.getSeenParts()?.has(idB)).toBe(true);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── M3: Reset + replay = fresh run ───────────────────────────────────

	describe("M3: Reset then replay produces identical output to fresh translator", () => {
		it("property: translate(events), reset, translate(events) === fresh translate(events)", () => {
			const arbEvents = fc.array(
				fc
					.tuple(fc.uuid(), fc.constantFrom("bash", "read"))
					.map(([id, tool]) => makeToolEvent(id, tool, "pending")),
				{ minLength: 1, maxLength: 10 },
			);

			fc.assert(
				fc.property(arbEvents, (events) => {
					// Fresh run
					const fresh = createTranslator();
					const freshResults = events.map((e) => fresh.translate(e));

					// Reset run: translate once, reset, translate again
					const resetT = createTranslator();
					for (const e of events) resetT.translate(e); // pollute state
					resetT.reset(); // clear
					const resetResults = events.map((e) => resetT.translate(e)); // replay

					// Should produce same results
					expect(resetResults).toEqual(freshResults);
					expect(resetT.getSeenParts()?.size ?? 0).toBe(
						fresh.getSeenParts()?.size ?? 0,
					);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── M4: Unknown events are transparent ───────────────────────────────

	describe("M4: Interleaving unknown events doesn't affect known event outputs", () => {
		it("property: known events produce same output with or without unknown events interleaved", () => {
			const arbKnownEvents = fc.array(
				fc.oneof(
					fc
						.tuple(fc.uuid(), fc.constantFrom("bash", "read"))
						.map(([id, tool]) => makeToolEvent(id, tool, "pending")),
					fc.uuid().map((id) => makeReasoningEvent(id)),
				),
				{ minLength: 1, maxLength: 8 },
			);

			const arbUnknownEvents = fc.array(
				fc.constant({
					type: "some.unknown.event",
					properties: { data: "ignored" },
				} as OpenCodeEvent),
				{ minLength: 1, maxLength: 5 },
			);

			fc.assert(
				fc.property(
					arbKnownEvents,
					arbUnknownEvents,
					(knownEvents, unknownEvents) => {
						// Without unknowns
						const clean = createTranslator();
						const cleanResults = knownEvents.map((e) => clean.translate(e));

						// With unknowns interleaved before each known event
						const dirty = createTranslator();
						const dirtyResults: ReturnType<typeof dirty.translate>[] = [];
						for (let i = 0; i < knownEvents.length; i++) {
							// Inject unknown events
							if (i < unknownEvents.length) {
								// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
								dirty.translate(unknownEvents[i]!);
							}
							// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
							dirtyResults.push(dirty.translate(knownEvents[i]!));
						}

						// Known event results should be identical
						expect(dirtyResults).toEqual(cleanResults);

						// State should be identical
						expect(dirty.getSeenParts()?.size ?? 0).toBe(
							clean.getSeenParts()?.size ?? 0,
						);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── M5: mapToolName stability ────────────────────────────────────────

	describe("M5: mapToolName(mapToolName(x)) is stable for non-self-referential mappings", () => {
		it("property: applying mapToolName twice is safe (no known key maps to another known key)", () => {
			const allTools = fc.oneof(
				fc.constantFrom(
					"read",
					"edit",
					"write",
					"bash",
					"glob",
					"grep",
					"webfetch",
					"websearch",
					"todowrite",
					"todoread",
					"question",
					"lsp",
					"patch",
					"skill",
					"list",
				),
				fc.string({ minLength: 1, maxLength: 20 }),
			);

			fc.assert(
				fc.property(allTools, (name) => {
					const once = mapToolName(name);
					const twice = mapToolName(once);

					// If the first mapping changed the name, applying again should NOT
					// change it further (the mapped PascalCase names like "Read" are
					// not keys in the lowercase→PascalCase map)
					if (once !== name) {
						expect(twice).toBe(once);
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});
});
