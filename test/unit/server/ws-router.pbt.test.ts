// Property-Based Tests: WebSocket Message Router (Ticket 2.2)
//
// Properties tested:
// P3: parseIncomingMessage never throws on arbitrary strings (AC7)
// P4: Client count tracks connects/disconnects correctly (AC4)
// P5: Broadcast targets exclude the specified sender (AC2)
// P6: Client tracker is idempotent for duplicate adds (AC1)
// P7: buildNewClientMessages always includes status + client_count (AC5)  [REMOVED — dead code removed from ws-router.ts]
// P8: State snapshot preserves pending state (AC5)                         [REMOVED — dead code removed from ws-router.ts]
// P10: createClientCountMessage shape                                    [REMOVED — client count is a project fact (conduit-test-ni8.15)]
// P12: parseIncomingMessage returns null for valid JSON without type field
// (P1, P2, P9, P11 retired with message routing — conduit-test-ni8.11)
// P13: buildNewClientMessages output shape verification                    [REMOVED — dead code removed from ws-router.ts]

import fc from "fast-check";
import { assert, describe, expect, it } from "vitest";
import {
	createClientTracker,
	parseIncomingMessage,
} from "../../../src/lib/server/ws-router.js";
import { edgeCaseString } from "../../helpers/arbitraries.js";

const SEED = 42;
const NUM_RUNS = 300;

const arbClientId = fc.oneof(
	{ weight: 5, arbitrary: fc.uuid() },
	{ weight: 2, arbitrary: fc.stringMatching(/^client-[0-9]{1,5}$/) },
	{ weight: 1, arbitrary: fc.constant("admin") },
);

describe("Ticket 2.2 — WebSocket Message Router PBT", () => {
	describe("P3: parseIncomingMessage never throws on arbitrary input (AC7)", () => {
		it("property: arbitrary strings never throw", () => {
			fc.assert(
				fc.property(edgeCaseString, (raw) => {
					const result = parseIncomingMessage(raw);
					// Result is either null or has a type field
					if (result !== null) {
						expect(typeof result.type).toBe("string");
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: valid JSON with type always parses", () => {
			fc.assert(
				fc.property(
					fc.string({ minLength: 1, maxLength: 30 }),
					fc.dictionary(
						fc.string({ minLength: 1, maxLength: 10 }),
						fc.jsonValue(),
					),
					(type, extra) => {
						const raw = JSON.stringify({ type, ...extra });
						const result = parseIncomingMessage(raw);
						expect(result).not.toBeNull();
						if (result === null) throw new Error("unreachable");
						expect(result.type).toBe(type);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: non-object JSON returns null", () => {
			fc.assert(
				fc.property(
					fc.oneof(
						fc.constant("42"),
						fc.constant('"string"'),
						fc.constant("true"),
						fc.constant("null"),
						fc.constant("[1,2,3]"),
					),
					(raw) => {
						const result = parseIncomingMessage(raw);
						expect(result).toBeNull();
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	describe("P4: Client count tracks connects/disconnects (AC4)", () => {
		it("property: add N unique clients → count is N", () => {
			fc.assert(
				fc.property(
					fc.array(arbClientId, { minLength: 0, maxLength: 20 }),
					(clientIds) => {
						const tracker = createClientTracker();
						for (const id of clientIds) {
							tracker.addClient(id);
						}
						const unique = new Set(clientIds);
						expect(tracker.getClientCount()).toBe(unique.size);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: add then remove → count goes down", () => {
			fc.assert(
				fc.property(
					fc.array(arbClientId, { minLength: 1, maxLength: 10 }),
					fc.nat({ max: 9 }),
					(clientIds, removeIdx) => {
						const tracker = createClientTracker();
						const unique = [...new Set(clientIds)];
						for (const id of unique) {
							tracker.addClient(id);
						}
						const countBefore = tracker.getClientCount();
						const idxToRemove = removeIdx % unique.length;
						const client = unique[idxToRemove];
						assert.exists(client, "expected tracked client");
						tracker.removeClient(client);
						expect(tracker.getClientCount()).toBe(countBefore - 1);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: removing non-existent client doesn't change count", () => {
			fc.assert(
				fc.property(
					fc.array(arbClientId, { minLength: 0, maxLength: 10 }),
					arbClientId,
					(clientIds, nonExistent) => {
						const tracker = createClientTracker();
						for (const id of clientIds) {
							tracker.addClient(id);
						}
						const unique = new Set(clientIds);
						fc.pre(!unique.has(nonExistent));
						const countBefore = tracker.getClientCount();
						tracker.removeClient(nonExistent);
						expect(tracker.getClientCount()).toBe(countBefore);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	describe("P5: Broadcast targets exclude sender (AC2)", () => {
		it("property: sender is never in broadcast targets", () => {
			fc.assert(
				fc.property(
					fc.array(arbClientId, { minLength: 1, maxLength: 10 }),
					fc.nat({ max: 9 }),
					(clientIds, senderIdx) => {
						const tracker = createClientTracker();
						const unique = [...new Set(clientIds)];
						for (const id of unique) {
							tracker.addClient(id);
						}
						const sender = unique[senderIdx % unique.length];
						const targets = tracker.getBroadcastTargets(sender);
						expect(targets).not.toContain(sender);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: all non-sender clients are in broadcast targets", () => {
			fc.assert(
				fc.property(
					fc.array(arbClientId, { minLength: 2, maxLength: 10 }),
					fc.nat({ max: 9 }),
					(clientIds, senderIdx) => {
						const tracker = createClientTracker();
						const unique = [...new Set(clientIds)];
						if (unique.length < 2) return;
						for (const id of unique) {
							tracker.addClient(id);
						}
						const sender = unique[senderIdx % unique.length];
						const targets = tracker.getBroadcastTargets(sender);
						const expected = unique.filter((id) => id !== sender);
						expect(targets).toEqual(expected);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: broadcast without exclusion returns all clients", () => {
			fc.assert(
				fc.property(
					fc.array(arbClientId, { minLength: 0, maxLength: 10 }),
					(clientIds) => {
						const tracker = createClientTracker();
						const unique = [...new Set(clientIds)];
						for (const id of unique) {
							tracker.addClient(id);
						}
						const targets = tracker.getBroadcastTargets();
						expect(targets).toEqual(unique);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	describe("P6: Client tracker is idempotent for duplicate adds (AC1)", () => {
		it("property: adding same client twice → count stays 1", () => {
			fc.assert(
				fc.property(arbClientId, (clientId) => {
					const tracker = createClientTracker();
					tracker.addClient(clientId);
					tracker.addClient(clientId);
					expect(tracker.getClientCount()).toBe(1);
					expect(tracker.hasClient(clientId)).toBe(true);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	describe("P12: parseIncomingMessage returns null for valid JSON without type field", () => {
		it("returns null for JSON object with no type field", () => {
			const result = parseIncomingMessage('{"foo": "bar", "baz": 42}');
			expect(result).toBeNull();
		});

		it("returns null for empty JSON object", () => {
			const result = parseIncomingMessage("{}");
			expect(result).toBeNull();
		});

		it("returns null when type is a number instead of a string", () => {
			const result = parseIncomingMessage('{"type": 42}');
			expect(result).toBeNull();
		});

		it("returns null when type is null", () => {
			const result = parseIncomingMessage('{"type": null}');
			expect(result).toBeNull();
		});

		it("returns null when type is boolean", () => {
			const result = parseIncomingMessage('{"type": true}');
			expect(result).toBeNull();
		});

		it("property: JSON objects without string type always return null", () => {
			fc.assert(
				fc.property(
					fc.dictionary(
						fc
							.string({ minLength: 1, maxLength: 10 })
							.filter((k) => k !== "type"),
						fc.jsonValue(),
					),
					(obj) => {
						const raw = JSON.stringify(obj);
						const result = parseIncomingMessage(raw);
						expect(result).toBeNull();
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});
});
