// ─── Property-Based Tests: WebSocket Message Router (Ticket 2.2) ─────────────
//
// Properties tested:
// P1: routeMessage dispatches known types to correct handler (AC3)
// P2: routeMessage returns error for unknown types (AC7)
// P3: parseIncomingMessage never throws on arbitrary strings (AC7)
// P4: Client count tracks connects/disconnects correctly (AC4)
// P5: Broadcast targets exclude the specified sender (AC2)
// P6: Client tracker is idempotent for duplicate adds (AC1)
// P7: buildNewClientMessages always includes status + client_count (AC5)  [REMOVED — dead code removed from ws-router.ts]
// P8: State snapshot preserves pending state (AC5)                         [REMOVED — dead code removed from ws-router.ts]
// P9: routeMessage + parseIncomingMessage roundtrip for valid messages (AC3)
// P10: createClientCountMessage shape
// P11: Test generators match production VALID_MESSAGE_TYPES (drift guard)
// P12: parseIncomingMessage returns null for valid JSON without type field
// P13: buildNewClientMessages output shape verification                    [REMOVED — dead code removed from ws-router.ts]

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MESSAGE_HANDLERS } from "../../../src/lib/handlers/index.js";
import {
	createClientCountMessage,
	createClientTracker,
	type IncomingMessage,
	type IncomingMessageType,
	isRouteError,
	parseIncomingMessage,
	routeMessage,
} from "../../../src/lib/server/ws-router.js";
import { edgeCaseString, idString } from "../../helpers/arbitraries.js";

const SEED = 42;
const NUM_RUNS = 300;

// ─── Generators ─────────────────────────────────────────────────────────────

const validMessageTypes: IncomingMessageType[] = [
	"message",
	"permission_response",
	"ask_user_response",
	"question_reject",
	"new_session",
	"switch_session",
	"view_session",
	"delete_session",
	"rename_session",
	"fork_session",
	"list_sessions",
	"search_sessions",
	"load_more_history",
	"terminal_command",
	"input_sync",
	"switch_agent",
	"switch_model",
	"set_default_model",
	"switch_variant",
	"get_todo",
	"get_agents",
	"get_models",
	"get_commands",
	"get_projects",
	"add_project",
	"list_directories",
	"remove_project",
	"rename_project",
	"get_file_list",
	"get_file_content",
	"get_file_tree",
	"get_tool_content",
	"pty_create",
	"pty_input",
	"pty_resize",
	"pty_close",
	"cancel",
	"rewind",
	"instance_add",
	"instance_remove",
	"instance_start",
	"instance_stop",
	"instance_update",
	"instance_rename",
	"set_project_instance",
	"proxy_detect",
	"scan_now",
	"reload_provider_session",
];

const arbValidMessageType: fc.Arbitrary<IncomingMessageType> = fc.constantFrom(
	...validMessageTypes,
);

const arbInvalidMessageType = fc
	.oneof(
		{ weight: 3, arbitrary: fc.string({ minLength: 1, maxLength: 30 }) },
		{
			weight: 2,
			arbitrary: fc.constantFrom(
				"unknown",
				"INVALID",
				"connect",
				"disconnect",
				"ping",
			),
		},
		{ weight: 1, arbitrary: edgeCaseString },
	)
	.filter((t) => !validMessageTypes.includes(t as IncomingMessageType));

const arbValidIncomingMessage: fc.Arbitrary<IncomingMessage> = fc
	.record({
		type: arbValidMessageType as fc.Arbitrary<string>,
		text: fc.oneof(fc.constant(undefined), fc.string()),
		requestId: fc.oneof(fc.constant(undefined), idString),
		id: fc.oneof(fc.constant(undefined), idString),
	})
	.map((r) => {
		const msg: IncomingMessage = { type: r.type };
		if (r.text !== undefined) msg["text"] = r.text;
		if (r.requestId !== undefined) msg["requestId"] = r.requestId;
		if (r.id !== undefined) msg["id"] = r.id;
		return msg;
	});

const arbClientId = fc.oneof(
	{ weight: 5, arbitrary: fc.uuid() },
	{ weight: 2, arbitrary: fc.stringMatching(/^client-[0-9]{1,5}$/) },
	{ weight: 1, arbitrary: fc.constant("admin") },
);

describe("Ticket 2.2 — WebSocket Message Router PBT", () => {
	// ─── P1: Valid message routing ──────────────────────────────────────────

	describe("P1: routeMessage dispatches known types to correct handler (AC3)", () => {
		it("property: valid type → handler matches type", () => {
			fc.assert(
				fc.property(arbValidIncomingMessage, (msg) => {
					const result = routeMessage(msg);
					expect(isRouteError(result)).toBe(false);
					if (!isRouteError(result)) {
						expect(result.handler).toBe(msg.type);
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: payload excludes the 'type' field", () => {
			fc.assert(
				fc.property(arbValidIncomingMessage, (msg) => {
					const result = routeMessage(msg);
					if (!isRouteError(result)) {
						expect("type" in result.payload).toBe(false);
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P2: Unknown type → error ──────────────────────────────────────────

	describe("P2: routeMessage returns error for unknown types (AC7)", () => {
		it("property: invalid type → error result with UNKNOWN_MESSAGE_TYPE", () => {
			fc.assert(
				fc.property(arbInvalidMessageType, (type) => {
					const msg: IncomingMessage = { type };
					const result = routeMessage(msg);
					expect(isRouteError(result)).toBe(true);
					if (isRouteError(result)) {
						expect(result.code).toBe("UNKNOWN_MESSAGE_TYPE");
						expect(result.message).toContain(type);
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P3: parseIncomingMessage robustness ────────────────────────────────

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

	// ─── P4: Client count tracking ──────────────────────────────────────────

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
						// biome-ignore lint/style/noNonNullAssertion: safe — index is bounded by modulo
						tracker.removeClient(unique[idxToRemove]!);
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

	// ─── P5: Broadcast target exclusion ─────────────────────────────────────

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

	// ─── P6: Idempotent adds ────────────────────────────────────────────────

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

	// ─── P9: parse + route roundtrip ────────────────────────────────────────

	describe("P9: parseIncomingMessage + routeMessage roundtrip (AC3)", () => {
		it("property: serialize→parse→route works for valid messages", () => {
			fc.assert(
				fc.property(arbValidMessageType, (type) => {
					const msg = { type, someField: "value" };
					const raw = JSON.stringify(msg);
					const parsed = parseIncomingMessage(raw);
					expect(parsed).not.toBeNull();
					if (parsed === null) throw new Error("unreachable");
					const result = routeMessage(parsed);
					expect(isRouteError(result)).toBe(false);
					if (!isRouteError(result)) {
						expect(result.handler).toBe(type);
						expect(result.payload["someField"]).toBe("value");
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P10: createClientCountMessage shape ────────────────────────────────

	describe("P10: createClientCountMessage always returns valid shape", () => {
		it("property: count is preserved exactly", () => {
			fc.assert(
				fc.property(fc.nat({ max: 10000 }), (count) => {
					const msg = createClientCountMessage(count);
					expect(msg.type).toBe("client_count");
					expect((msg as { count: number }).count).toBe(count);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P11: Test generator drift guard ────────────────────────────────────

	describe("P11: Test validMessageTypes matches production VALID_MESSAGE_TYPES exactly", () => {
		it("test generator covers all production message types (no drift)", () => {
			// Route every type in our test list — they should all succeed
			for (const type of validMessageTypes) {
				const result = routeMessage({ type });
				expect(isRouteError(result)).toBe(false);
			}

			// Route a known-invalid type — it should fail
			const invalidResult = routeMessage({ type: "__definitely_not_valid__" });
			expect(isRouteError(invalidResult)).toBe(true);

			// Verify our test list has exactly the right number (40 types in production)
			expect(validMessageTypes).toHaveLength(48);

			// Verify no duplicates
			const uniqueTypes = new Set(validMessageTypes);
			expect(uniqueTypes.size).toBe(validMessageTypes.length);
		});

		it("every handler in MESSAGE_HANDLERS is in our test list", () => {
			// This catches the case where a new handler is added to production
			// but the test list is not updated — the actual drift we want to detect.
			const handlerKeys = Object.keys(MESSAGE_HANDLERS).sort();
			const testKeys = [...validMessageTypes].sort();
			expect(testKeys).toEqual(handlerKeys);
		});

		it("every type that routes successfully is in our test list", () => {
			// Exhaustively test that our list and production are aligned.
			// We do this by checking that each of our known types routes,
			// and that any string NOT in our list does NOT route.
			const candidateTypes = [
				...validMessageTypes,
				"unknown",
				"INVALID",
				"connect",
				"disconnect",
				"ping",
				"subscribe",
				"unsubscribe",
				"heartbeat",
				"refresh",
			];

			for (const candidate of candidateTypes) {
				const result = routeMessage({ type: candidate });
				const isValid = !isRouteError(result);
				const inTestList = validMessageTypes.includes(
					candidate as IncomingMessageType,
				);
				expect(isValid).toBe(inTestList);
			}
		});
	});

	// ─── P12: parseIncomingMessage with no type field ───────────────────────

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
