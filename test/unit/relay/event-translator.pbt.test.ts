// ─── Property-Based Tests: Event Translator (Ticket 1.3) ────────────────────
//
// Properties tested:
// P1: mapToolName is idempotent for known tools and identity for unknown
//     → Source: AC3 (tool name mapping)
// P2: All known tools map to PascalCase (first letter uppercase)
//     → Source: AC3
// P3: translatePartDelta never throws, returns delta or thinking_delta or null
//     → Source: AC1, AC6
// P4: Tool lifecycle: pending→tool_start, running→tool_executing, completed→tool_result(ok), error→tool_result(err)
//     → Source: AC2 (tool call lifecycle)
// P5: Reasoning lifecycle: new→thinking_start, delta→thinking_delta, end→thinking_stop
//     → Source: AC6 (reasoning/thinking blocks)
// P6: Unknown event types produce null (never throw)
//     → Source: AC13
// P7: Session status mapping: busy/retry→processing, idle→done
//     → Source: AC8
// P8: Permission event translation preserves all field mappings
//     → Source: AC4
// P9: Question event translation maps 'multiple'→'multiSelect'
//     → Source: AC5
// P10: Stateful translator tracks part IDs — no duplicate starts after rebuild
//      → Source: AC14, AC15
// P11: message.updated only emits result for assistant messages
//      → Source: AC7
// P12: Part removal clears tracking state
//      → Source: AC10
// P13: translatePtyEvent handles pty.created, pty.exited, pty.deleted, unknown
// P14: translateFileEvent handles file.edited, file.watcher.updated, unknown, missing path
// P15: translateMessageRemoved handles valid messageID and missing messageID

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	createTranslator,
	mapToolName,
	translateFileEvent,
	translateMessageRemoved,
	translateMessageUpdated,
	translatePartDelta,
	translatePermission,
	translatePtyEvent,
	translateQuestion,
	translateReasoningPartUpdated,
	translateSessionStatus,
	translateToolPartUpdated,
} from "../../../src/lib/relay/event-translator.js";
import type {
	OpenCodeEvent,
	PartType,
	RelayMessage,
	ToolStatus,
} from "../../../src/lib/types.js";
import {
	anyToolName,
	edgeCaseString,
	idString,
	knownToolName,
	messageUpdatedEvent,
	partDeltaEvent,
	permissionAskedEvent,
	questionAskedEvent,
	sessionStatusEvent,
	timestamp,
	unknownEvent,
	unknownToolName,
} from "../../helpers/arbitraries.js";

const SEED = 42;
const NUM_RUNS = 300;

describe("Ticket 1.3 — Event Translator PBT", () => {
	// ─── P1: mapToolName idempotence ──────────────────────────────────────

	describe("P1: mapToolName is idempotent for known and identity for unknown (AC3)", () => {
		it("property: known tools always map to their PascalCase equivalent", () => {
			const TOOL_MAP: Record<string, string> = {
				read: "Read",
				edit: "Edit",
				write: "Write",
				bash: "Bash",
				glob: "Glob",
				grep: "Grep",
				webfetch: "WebFetch",
				websearch: "WebSearch",
				todowrite: "TodoWrite",
				todoread: "TodoRead",
				question: "AskUserQuestion",
				task: "Task",
				lsp: "LSP",
				skill: "Skill",
			};

			fc.assert(
				fc.property(knownToolName, (name) => {
					expect(mapToolName(name)).toBe(TOOL_MAP[name]);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: unknown tools pass through unchanged", () => {
			fc.assert(
				fc.property(unknownToolName, (name) => {
					expect(mapToolName(name)).toBe(name);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P2: PascalCase output ────────────────────────────────────────────

	describe("P2: All known tool mappings start with uppercase (AC3)", () => {
		it("property: mapped known tools have uppercase first letter", () => {
			fc.assert(
				fc.property(knownToolName, (name) => {
					const mapped = mapToolName(name);
					// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
					expect(mapped[0]).toBe(mapped[0]!.toUpperCase());
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P3: translatePartDelta safety ────────────────────────────────────

	describe("P3: translatePartDelta never throws (AC1, AC6)", () => {
		it("property: returns delta, thinking_delta, or null", () => {
			fc.assert(
				fc.property(partDeltaEvent, (event) => {
					const seenParts = new Map<
						string,
						{ type: PartType; status?: ToolStatus }
					>();
					// Sometimes pre-populate with reasoning type
					const partID = (event.properties as { partID?: string }).partID;
					if (partID && Math.random() > 0.5) {
						seenParts.set(partID, { type: "reasoning" });
					}

					const result = translatePartDelta(event, seenParts);

					if (result !== null) {
						expect(["delta", "thinking_delta"]).toContain(result.type);
						if (result.type === "delta" || result.type === "thinking_delta") {
							expect(typeof result.text).toBe("string");
						}
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P4: Tool lifecycle ───────────────────────────────────────────────

	describe("P4: Tool lifecycle status → correct message type (AC2)", () => {
		// translateToolPartUpdated may return a single message, an array
		// (e.g. [tool_start, tool_executing] for first-seen running tools),
		// or null. This helper normalises to an array for uniform assertions.
		function asArray(
			result: ReturnType<typeof translateToolPartUpdated>,
		): RelayMessage[] {
			if (result == null) return [];
			return Array.isArray(result) ? result : [result];
		}

		it("property: pending + new → tool_start", () => {
			fc.assert(
				fc.property(idString, anyToolName, idString, (partID, tool, callID) => {
					const msgs = asArray(
						translateToolPartUpdated(
							partID,
							{ type: "tool", callID, tool, state: { status: "pending" } },
							true, // isNew
						),
					);
					if (msgs.length > 0) {
						// biome-ignore lint/style/noNonNullAssertion: length-checked
						const first = msgs[0]!;
						expect(first.type).toBe("tool_start");
						if (first.type === "tool_start") {
							expect(first.name).toBe(mapToolName(tool));
						}
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: running → tool_executing", () => {
			fc.assert(
				fc.property(idString, anyToolName, (partID, tool) => {
					const msgs = asArray(
						translateToolPartUpdated(
							partID,
							{
								type: "tool",
								tool,
								state: { status: "running", input: { cmd: "test" } },
							},
							false,
						),
					);
					if (msgs.length > 0) {
						// Last message should be tool_executing (may be preceded by tool_start)
						// biome-ignore lint/style/noNonNullAssertion: length-checked
						const last = msgs[msgs.length - 1]!;
						expect(last.type).toBe("tool_executing");
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: completed → tool_result with is_error=false", () => {
			fc.assert(
				fc.property(
					idString,
					anyToolName,
					edgeCaseString,
					(partID, tool, output) => {
						const msgs = asArray(
							translateToolPartUpdated(
								partID,
								{ type: "tool", tool, state: { status: "completed", output } },
								false,
							),
						);
						if (msgs.length > 0) {
							// biome-ignore lint/style/noNonNullAssertion: length-checked
							const last = msgs[msgs.length - 1]!;
							expect(last.type).toBe("tool_result");
							if (last.type === "tool_result") {
								expect(last.is_error).toBe(false);
							}
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: error → tool_result with is_error=true", () => {
			fc.assert(
				fc.property(
					idString,
					anyToolName,
					edgeCaseString,
					(partID, tool, error) => {
						const msgs = asArray(
							translateToolPartUpdated(
								partID,
								{ type: "tool", tool, state: { status: "error", error } },
								false,
							),
						);
						if (msgs.length > 0) {
							// biome-ignore lint/style/noNonNullAssertion: length-checked
							const last = msgs[msgs.length - 1]!;
							expect(last.type).toBe("tool_result");
							if (last.type === "tool_result") {
								expect(last.is_error).toBe(true);
							}
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: non-tool parts return null from translateToolPartUpdated", () => {
			const nonToolTypes: PartType[] = [
				"text",
				"reasoning",
				"file",
				"snapshot",
				"patch",
			];
			fc.assert(
				fc.property(
					idString,
					fc.constantFrom(...nonToolTypes),
					(partID, partType) => {
						const result = translateToolPartUpdated(
							partID,
							{ type: partType, tool: "read", state: { status: "completed" } },
							false,
						);
						expect(result).toBeNull();
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── Metadata forwarding in tool_executing ───────────────────────────

	describe("tool_executing forwards metadata from part state", () => {
		function asArray(
			result: ReturnType<typeof translateToolPartUpdated>,
		): RelayMessage[] {
			if (result == null) return [];
			return Array.isArray(result) ? result : [result];
		}

		it("forwards metadata when present on running tool", () => {
			const meta = { sessionId: "ses_abc123" };
			const msgs = asArray(
				translateToolPartUpdated(
					"part-1",
					{
						type: "tool",
						tool: "task",
						state: {
							status: "running",
							input: { prompt: "test" },
							metadata: meta,
						},
					},
					false,
				),
			);
			expect(msgs).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: length-checked
			const msg = msgs[0]!;
			expect(msg.type).toBe("tool_executing");
			if (msg.type === "tool_executing") {
				expect(msg.metadata).toEqual(meta);
			}
		});

		it("forwards metadata when first seen as running (isNew)", () => {
			const meta = { sessionId: "ses_xyz789" };
			const msgs = asArray(
				translateToolPartUpdated(
					"part-2",
					{
						type: "tool",
						tool: "task",
						state: { status: "running", input: {}, metadata: meta },
					},
					true, // isNew — emits [tool_start, tool_executing]
				),
			);
			expect(msgs).toHaveLength(2);
			expect(msgs[0]?.type).toBe("tool_start");
			expect(msgs[1]?.type).toBe("tool_executing");
			if (msgs[1]?.type === "tool_executing") {
				expect(msgs[1]?.metadata).toEqual(meta);
			}
		});

		it("omits metadata field when not present on part state", () => {
			const msgs = asArray(
				translateToolPartUpdated(
					"part-3",
					{
						type: "tool",
						tool: "task",
						state: { status: "running", input: {} },
					},
					false,
				),
			);
			expect(msgs).toHaveLength(1);
			if (msgs[0]?.type === "tool_executing") {
				// biome-ignore lint/style/noNonNullAssertion: guarded by optional chain above
				expect(msgs[0]!).not.toHaveProperty("metadata");
			}
		});
	});

	// ─── P5: Reasoning lifecycle ──────────────────────────────────────────

	describe("P5: Reasoning lifecycle (AC6)", () => {
		it("property: new reasoning part → thinking_start", () => {
			fc.assert(
				fc.property(fc.constant(true), () => {
					const result = translateReasoningPartUpdated(
						{ type: "reasoning" },
						true,
					);
					expect(result).toEqual({ type: "thinking_start" });
				}),
				{ seed: SEED, numRuns: 10, endOnFailure: true },
			);
		});

		it("property: reasoning part with time.end → thinking_stop", () => {
			fc.assert(
				fc.property(timestamp, (endTime) => {
					const result = translateReasoningPartUpdated(
						{ type: "reasoning", time: { end: endTime } },
						false,
					);
					expect(result).toEqual({ type: "thinking_stop" });
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: non-reasoning parts return null", () => {
			const nonReasoningTypes: PartType[] = [
				"text",
				"tool",
				"file",
				"snapshot",
			];
			fc.assert(
				fc.property(
					fc.constantFrom(...nonReasoningTypes),
					fc.boolean(),
					(partType, isNew) => {
						const result = translateReasoningPartUpdated(
							{ type: partType },
							isNew,
						);
						expect(result).toBeNull();
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P6: Unknown events → null ────────────────────────────────────────

	describe("P6: Unknown event types produce ok: false (AC13)", () => {
		it("property: unknown events never throw and return ok: false", () => {
			fc.assert(
				fc.property(unknownEvent, (event) => {
					const translator = createTranslator();
					const result = translator.translate(event);
					expect(result.ok).toBe(false);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P7: Session status mapping ───────────────────────────────────────

	describe("P7: Session status mapping (AC8)", () => {
		it("property: busy → null, retry → error, idle → null (busy/idle handled by status poller)", () => {
			fc.assert(
				fc.property(sessionStatusEvent, (event) => {
					const result = translateSessionStatus(event);
					const statusType = (
						event.properties as { status?: { type?: string } }
					).status?.type;

					if (statusType === "busy") {
						// busy is now handled by the status poller, not the translator
						expect(result).toBeNull();
					} else if (statusType === "retry") {
						// Retry returns only the error message (no processing status)
						expect(result).not.toBeNull();
						expect(Array.isArray(result)).toBe(false);
						expect(result).toMatchObject({
							type: "error",
							code: "RETRY",
						});
					} else if (statusType === "idle") {
						// idle is now handled by the status poller, not the translator
						expect(result).toBeNull();
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P8: Permission event translation ─────────────────────────────────

	describe("P8: Permission event translation preserves fields (AC4)", () => {
		it("property: permission_request has requestId, toolName, toolInput, sessionId", () => {
			fc.assert(
				fc.property(permissionAskedEvent, idString, (event, sessionId) => {
					const result = translatePermission(event, sessionId);
					const props = event.properties as {
						id?: string;
						permission?: string;
					};

					if (props.id && props.permission && sessionId) {
						expect(result).not.toBeNull();
						if (result && result.type === "permission_request") {
							expect(result.requestId).toBe(props.id);
							expect(result.toolName).toBe(props.permission);
							expect(result.toolInput).toHaveProperty("patterns");
							expect(result.toolInput).toHaveProperty("metadata");
							expect(result.sessionId).toBe(sessionId);
							expect(result.always).toEqual(
								(event.properties as Record<string, unknown>)["always"] ?? [],
							);
						}
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: permission.asked without sessionId context returns ok: false", () => {
			fc.assert(
				fc.property(permissionAskedEvent, (event) => {
					const translator = createTranslator();
					const result = translator.translate(event); // no context
					expect(result.ok).toBe(false);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: permission.asked with empty sessionId returns null", () => {
			fc.assert(
				fc.property(permissionAskedEvent, (event) => {
					const result = translatePermission(event, "");
					expect(result).toBeNull();
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P9: Question field mapping ───────────────────────────────────────

	describe("P9: Question event maps 'multiple' → 'multiSelect' (AC5)", () => {
		it("property: question.asked → ask_user with multiSelect field", () => {
			fc.assert(
				fc.property(questionAskedEvent, (event) => {
					const result = translateQuestion(event);
					const props = event.properties as {
						id?: string;
						questions?: Array<{ multiple?: boolean; custom?: boolean }>;
					};

					if (props.id && props.questions) {
						expect(result).not.toBeNull();
						if (result && result.type === "ask_user") {
							expect(result.toolId).toBe(props.id);
							expect(result.questions).toHaveLength(props.questions.length);

							// Verify field mapping: multiple → multiSelect
							for (let i = 0; i < props.questions.length; i++) {
								// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
								expect(result.questions[i]!.multiSelect).toBe(
									// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
									props.questions[i]!.multiple ?? false,
								);
								// custom defaults to true when undefined
								// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
								expect(result.questions[i]!.custom).toBe(
									// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
									props.questions[i]!.custom ?? true,
								);
							}
						}
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P10: Stateful translator — part tracking ─────────────────────────

	describe("P10: Stateful translator tracks parts, no duplicate starts (AC14, AC15)", () => {
		it("property: same part ID seen twice never emits tool_start twice", () => {
			fc.assert(
				fc.property(
					idString.filter((s) => s.length > 0),
					anyToolName,
					(partID, tool) => {
						const translator = createTranslator();

						// First: pending → should emit tool_start
						const firstEvent: OpenCodeEvent = {
							type: "message.part.updated",
							properties: {
								partID,
								part: {
									type: "tool",
									callID: partID,
									tool,
									state: { status: "pending" },
								},
							},
						};
						const first = translator.translate(firstEvent);
						if (first.ok && first.messages.length === 1) {
							expect(first.messages[0]?.type).toBe("tool_start");
						}

						// Second: running → should NOT emit tool_start again
						const secondEvent: OpenCodeEvent = {
							type: "message.part.updated",
							properties: {
								partID,
								part: {
									type: "tool",
									callID: partID,
									tool,
									state: { status: "running", input: {} },
								},
							},
						};
						const second = translator.translate(secondEvent);
						if (second.ok && second.messages.length === 1) {
							expect(second.messages[0]?.type).not.toBe("tool_start");
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: reset + same event → emits start again (reconnection scenario)", () => {
			fc.assert(
				fc.property(
					idString.filter((s) => s.length > 0),
					anyToolName,
					(partID, tool) => {
						const translator = createTranslator();

						const event: OpenCodeEvent = {
							type: "message.part.updated",
							properties: {
								partID,
								part: {
									type: "tool",
									callID: partID,
									tool,
									state: { status: "pending" },
								},
							},
						};

						// First time
						translator.translate(event);
						expect(translator.getSeenParts()?.has(partID)).toBe(true);

						// Reset (simulates reconnection)
						translator.reset();
						expect(translator.getSeenParts()?.size ?? 0).toBe(0);

						// Same event again — should emit tool_start
						const result = translator.translate(event);
						if (result.ok && result.messages.length === 1) {
							expect(result.messages[0]?.type).toBe("tool_start");
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: rebuildStateFromHistory marks all parts as seen", () => {
			fc.assert(
				fc.property(
					fc.array(
						fc.record({
							parts: fc.array(
								fc.record({
									id: idString.filter((s) => s.length > 0),
									type: fc.constantFrom(
										"tool" as PartType,
										"reasoning" as PartType,
										"text" as PartType,
									),
									state: fc.record({
										status: fc.constantFrom(
											"completed" as ToolStatus,
											"running" as ToolStatus,
										),
									}),
								}),
								{ minLength: 0, maxLength: 5 },
							),
						}),
						{ minLength: 0, maxLength: 5 },
					),
					(messages) => {
						const translator = createTranslator();
						translator.rebuildStateFromHistory("test-session", messages);

						const _totalParts = messages.reduce(
							(sum, m) => sum + (m.parts?.length ?? 0),
							0,
						);
						// Each unique part ID should be tracked (may have duplicates in generated data)
						const uniquePartIDs = new Set(
							messages.flatMap((m) => (m.parts ?? []).map((p) => p.id)),
						);
						expect(translator.getSeenParts("test-session")?.size ?? 0).toBe(
							uniquePartIDs.size,
						);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P11: message.updated for assistant only ──────────────────────────

	describe("P11: message.updated only emits result for assistant messages (AC7)", () => {
		it("property: user role messages produce null, assistant produce result", () => {
			fc.assert(
				fc.property(messageUpdatedEvent, (event) => {
					const result = translateMessageUpdated(event);
					const msg = (event.properties as { message?: { role?: string } })
						.message;

					if (msg?.role === "user") {
						expect(result).toBeNull();
					} else if (msg?.role === "assistant") {
						if (result) {
							expect(result.type).toBe("result");
						}
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: result usage values are non-negative", () => {
			fc.assert(
				fc.property(messageUpdatedEvent, (event) => {
					const result = translateMessageUpdated(event);
					if (result && result.type === "result") {
						expect(result.usage.input).toBeGreaterThanOrEqual(0);
						expect(result.usage.output).toBeGreaterThanOrEqual(0);
						expect(result.usage.cache_read).toBeGreaterThanOrEqual(0);
						expect(result.usage.cache_creation).toBeGreaterThanOrEqual(0);
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P12: Part removal clears state ───────────────────────────────────

	describe("P12: Part removal clears tracking state (AC10)", () => {
		it("property: after part.removed, part is no longer tracked", () => {
			fc.assert(
				fc.property(
					idString.filter((s) => s.length > 0),
					idString.filter((s) => s.length > 0),
					anyToolName,
					(partID, messageID, tool) => {
						const translator = createTranslator();

						// Add part via part.updated
						translator.translate({
							type: "message.part.updated",
							properties: {
								partID,
								part: {
									type: "tool",
									callID: partID,
									tool,
									state: { status: "pending" },
								},
							},
						});
						expect(translator.getSeenParts()?.has(partID)).toBe(true);

						// Remove part
						translator.translate({
							type: "message.part.removed",
							properties: { partID, messageID },
						});
						expect(translator.getSeenParts()?.has(partID)).toBe(false);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P13: translatePtyEvent ────────────────────────────────────────────

	describe("P13: translatePtyEvent handles all pty event types", () => {
		it("pty.created returns pty_created message with correct fields (info nested)", () => {
			// OpenCode wraps PTY info under an `info` key in SSE events
			const event: OpenCodeEvent = {
				type: "pty.created",
				properties: {
					info: {
						id: "pty-1",
						title: "bash",
						command: "/bin/bash",
						cwd: "/home/user",
						status: "running",
						pid: 12345,
					},
				},
			};
			const result = translatePtyEvent(event);
			expect(result).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.type).toBe("pty_created");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			if (result!.type === "pty_created") {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.pty.id).toBe("pty-1");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.pty.title).toBe("bash");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.pty.command).toBe("/bin/bash");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.pty.cwd).toBe("/home/user");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.pty.status).toBe("running");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.pty.pid).toBe(12345);
			}
		});

		it("pty.created falls back to top-level properties when info key absent", () => {
			const event: OpenCodeEvent = {
				type: "pty.created",
				properties: {
					id: "pty-1b",
					title: "zsh",
					command: "/bin/zsh",
					cwd: "/tmp",
					status: "running",
					pid: 999,
				},
			};
			const result = translatePtyEvent(event);
			expect(result).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			if (result!.type === "pty_created") {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.pty.id).toBe("pty-1b");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.pty.title).toBe("zsh");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.pty.command).toBe("/bin/zsh");
			}
		});

		it("pty.created defaults missing fields to empty/0", () => {
			const event: OpenCodeEvent = {
				type: "pty.created",
				properties: {},
			};
			const result = translatePtyEvent(event);
			expect(result).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			if (result!.type === "pty_created") {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.pty.id).toBe("");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.pty.title).toBe("");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.pty.command).toBe("");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.pty.cwd).toBe("");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.pty.status).toBe("running");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.pty.pid).toBe(0);
			}
		});

		it("pty.exited returns pty_exited message", () => {
			const event: OpenCodeEvent = {
				type: "pty.exited",
				properties: { id: "pty-2", exitCode: 1 },
			};
			const result = translatePtyEvent(event);
			expect(result).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.type).toBe("pty_exited");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			if (result!.type === "pty_exited") {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.ptyId).toBe("pty-2");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.exitCode).toBe(1);
			}
		});

		it("pty.exited defaults exitCode to 0", () => {
			const event: OpenCodeEvent = {
				type: "pty.exited",
				properties: { id: "pty-3" },
			};
			const result = translatePtyEvent(event);
			expect(result).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			if (result!.type === "pty_exited") {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.exitCode).toBe(0);
			}
		});

		it("pty.deleted returns pty_deleted message", () => {
			const event: OpenCodeEvent = {
				type: "pty.deleted",
				properties: { id: "pty-4" },
			};
			const result = translatePtyEvent(event);
			expect(result).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.type).toBe("pty_deleted");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			if (result!.type === "pty_deleted") {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.ptyId).toBe("pty-4");
			}
		});

		it("unknown pty event returns null", () => {
			const event: OpenCodeEvent = {
				type: "pty.resized",
				properties: { id: "pty-5", cols: 80, rows: 24 },
			};
			const result = translatePtyEvent(event);
			expect(result).toBeNull();
		});

		it("pty.data returns null (not a recognized subtype)", () => {
			const event: OpenCodeEvent = {
				type: "pty.data",
				properties: { id: "pty-6", data: "hello" },
			};
			const result = translatePtyEvent(event);
			expect(result).toBeNull();
		});

		it("property: pty events with arbitrary properties never throw", () => {
			fc.assert(
				fc.property(
					fc.constantFrom(
						"pty.created",
						"pty.exited",
						"pty.deleted",
						"pty.unknown",
						"pty.data",
					),
					fc.dictionary(
						fc.string({ minLength: 1, maxLength: 10 }),
						fc.jsonValue(),
					),
					(eventType, props) => {
						const event: OpenCodeEvent = { type: eventType, properties: props };
						const result = translatePtyEvent(event);
						// Should never throw; result is either a message or null
						if (result !== null) {
							expect(["pty_created", "pty_exited", "pty_deleted"]).toContain(
								result.type,
							);
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P14: translateFileEvent ───────────────────────────────────────────

	describe("P14: translateFileEvent handles file event types", () => {
		it("file.edited returns file_changed with changeType 'edited'", () => {
			const event: OpenCodeEvent = {
				type: "file.edited",
				properties: { file: "/src/main.ts" },
			};
			const result = translateFileEvent(event);
			expect(result).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.type).toBe("file_changed");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			if (result!.type === "file_changed") {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.path).toBe("/src/main.ts");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.changeType).toBe("edited");
			}
		});

		it("file.watcher.updated returns file_changed with changeType 'external'", () => {
			const event: OpenCodeEvent = {
				type: "file.watcher.updated",
				properties: { file: "/src/index.ts" },
			};
			const result = translateFileEvent(event);
			expect(result).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.type).toBe("file_changed");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			if (result!.type === "file_changed") {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.path).toBe("/src/index.ts");
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.changeType).toBe("external");
			}
		});

		it("unknown file event returns null", () => {
			const event: OpenCodeEvent = {
				type: "file.created",
				properties: { file: "/src/new.ts" },
			};
			const result = translateFileEvent(event);
			expect(result).toBeNull();
		});

		it("file.edited with missing path returns null", () => {
			const event: OpenCodeEvent = {
				type: "file.edited",
				properties: {},
			};
			const result = translateFileEvent(event);
			expect(result).toBeNull();
		});

		it("file.watcher.updated with missing path returns null", () => {
			const event: OpenCodeEvent = {
				type: "file.watcher.updated",
				properties: { content: "data but no path" },
			};
			const result = translateFileEvent(event);
			expect(result).toBeNull();
		});

		it("property: file events with arbitrary properties never throw", () => {
			fc.assert(
				fc.property(
					fc.constantFrom(
						"file.edited",
						"file.watcher.updated",
						"file.created",
						"file.deleted",
					),
					fc.dictionary(
						fc.string({ minLength: 1, maxLength: 10 }),
						fc.jsonValue(),
					),
					(eventType, props) => {
						const event: OpenCodeEvent = { type: eventType, properties: props };
						const result = translateFileEvent(event);
						if (result !== null) {
							expect(result.type).toBe("file_changed");
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P15: translateMessageRemoved ──────────────────────────────────────

	describe("P15: translateMessageRemoved handles messageID presence/absence", () => {
		it("returns message_removed with valid messageID", () => {
			const event: OpenCodeEvent = {
				type: "message.removed",
				properties: { messageID: "msg-123" },
			};
			const result = translateMessageRemoved(event);
			expect(result).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.type).toBe("message_removed");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			if (result!.type === "message_removed") {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
				expect(result!.messageId).toBe("msg-123");
			}
		});

		it("returns null when messageID is missing", () => {
			const event: OpenCodeEvent = {
				type: "message.removed",
				properties: {},
			};
			const result = translateMessageRemoved(event);
			expect(result).toBeNull();
		});

		it("returns null when messageID is undefined explicitly", () => {
			const event: OpenCodeEvent = {
				type: "message.removed",
				properties: { messageID: undefined },
			};
			const result = translateMessageRemoved(event);
			expect(result).toBeNull();
		});

		it("property: translateMessageRemoved with arbitrary messageIDs", () => {
			fc.assert(
				fc.property(
					idString.filter((s) => s.length > 0),
					(messageID) => {
						const event: OpenCodeEvent = {
							type: "message.removed",
							properties: { messageID },
						};
						const result = translateMessageRemoved(event);
						expect(result).not.toBeNull();
						if (result && result.type === "message_removed") {
							expect(result.messageId).toBe(messageID);
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("stateful translator translates message.removed correctly", () => {
			const translator = createTranslator();
			const event: OpenCodeEvent = {
				type: "message.removed",
				properties: { messageID: "msg-456" },
			};
			const result = translator.translate(event);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.messages).toHaveLength(1);
				expect(result.messages[0]?.type).toBe("message_removed");
				if (result.messages[0]?.type === "message_removed") {
					expect(result.messages[0]?.messageId).toBe("msg-456");
				}
			}
		});

		it("stateful translator returns ok: false for message.removed without messageID", () => {
			const translator = createTranslator();
			const event: OpenCodeEvent = {
				type: "message.removed",
				properties: {},
			};
			const result = translator.translate(event);
			expect(result.ok).toBe(false);
		});
	});

	// ── P16: FIFO eviction cap on seenParts ─────────────────────────────────

	describe("P16: seenParts FIFO eviction", () => {
		it("evicts oldest entries when exceeding 10,000 cap", () => {
			const translator = createTranslator();
			// Trigger creation of the default session map with a dummy translate
			translator.translate({
				type: "message.part.updated",
				properties: {
					partID: "seed",
					part: { id: "seed", type: "text", text: "" },
				},
			});
			// Cast to mutable Map for test seeding — runtime object is a Map,
			// ReadonlyMap is only the public API type constraint.
			const seenParts = translator.getSeenParts() as Map<
				string,
				{ type: string }
			>;

			// Seed with 10,000 parts (seed part already present)
			seenParts.clear();
			for (let i = 0; i < 10_000; i++) {
				seenParts.set(`part-${i}`, { type: "text" });
			}
			expect(seenParts.size).toBe(10_000);

			// Translate one more event that adds a new part (triggers eviction)
			const event: OpenCodeEvent = {
				type: "message.part.updated",
				properties: {
					messageID: "msg-1",
					partID: "part-10000",
					part: { id: "part-10000", type: "text", text: "hello" },
				},
			};
			translator.translate(event);

			// Should have evicted ~2000 oldest entries
			// New size = 10,001 - 2000 = 8,001
			expect(seenParts.size).toBeLessThanOrEqual(8_001);
			// New part should exist
			expect(seenParts.has("part-10000")).toBe(true);
			// Oldest parts should be gone
			expect(seenParts.has("part-0")).toBe(false);
			expect(seenParts.has("part-1999")).toBe(false);
			// Parts after eviction should still exist
			expect(seenParts.has("part-2000")).toBe(true);
		});

		it("does not evict when under the cap", () => {
			const translator = createTranslator();
			// Trigger creation of the default session map with a dummy translate
			translator.translate({
				type: "message.part.updated",
				properties: {
					partID: "seed",
					part: { id: "seed", type: "text", text: "" },
				},
			});
			const seenParts = translator.getSeenParts() as Map<
				string,
				{ type: string }
			>;

			// Seed with 100 parts
			seenParts.clear();
			for (let i = 0; i < 100; i++) {
				seenParts.set(`part-${i}`, { type: "text" });
			}

			// Translate one more event
			const event: OpenCodeEvent = {
				type: "message.part.updated",
				properties: {
					messageID: "msg-1",
					partID: "part-100",
					part: { id: "part-100", type: "text", text: "hello" },
				},
			};
			translator.translate(event);

			// All 101 parts should still be present
			expect(seenParts.size).toBe(101);
			expect(seenParts.has("part-0")).toBe(true);
			expect(seenParts.has("part-100")).toBe(true);
		});
	});

	// ── Per-session scoping ─────────────────────────────────────────────────

	describe("Per-session scoping", () => {
		it("reset(sessionId) only clears that session's parts", () => {
			const translator = createTranslator();
			// Translate a tool part for session-A
			translator.translate(
				{
					type: "message.part.updated",
					properties: {
						partID: "part-a",
						part: {
							type: "tool" as PartType,
							callID: "part-a",
							tool: "read",
							state: { status: "pending" as ToolStatus },
						},
					},
				},
				{ sessionId: "ses-A" },
			);
			// Translate a tool part for session-B
			translator.translate(
				{
					type: "message.part.updated",
					properties: {
						partID: "part-b",
						part: {
							type: "tool" as PartType,
							callID: "part-b",
							tool: "read",
							state: { status: "pending" as ToolStatus },
						},
					},
				},
				{ sessionId: "ses-B" },
			);
			// Reset only session-A
			translator.reset("ses-A");
			// session-B part should still be tracked
			const seenB = translator.getSeenParts("ses-B");
			expect(seenB?.has("part-b")).toBe(true);
			// session-A should be cleared
			const seenA = translator.getSeenParts("ses-A");
			expect(seenA?.size ?? 0).toBe(0);
		});

		it("reset() with no arg clears all sessions", () => {
			const translator = createTranslator();
			translator.translate(
				{
					type: "message.part.updated",
					properties: {
						partID: "part-a",
						part: {
							type: "tool" as PartType,
							callID: "part-a",
							tool: "read",
							state: { status: "pending" as ToolStatus },
						},
					},
				},
				{ sessionId: "ses-A" },
			);
			translator.translate(
				{
					type: "message.part.updated",
					properties: {
						partID: "part-b",
						part: {
							type: "tool" as PartType,
							callID: "part-b",
							tool: "read",
							state: { status: "pending" as ToolStatus },
						},
					},
				},
				{ sessionId: "ses-B" },
			);
			translator.reset();
			expect(translator.getSeenParts("ses-A")?.size ?? 0).toBe(0);
			expect(translator.getSeenParts("ses-B")?.size ?? 0).toBe(0);
		});

		it("rebuildStateFromHistory(sessionId, messages) only rebuilds that session", () => {
			const translator = createTranslator();
			translator.translate(
				{
					type: "message.part.updated",
					properties: {
						partID: "part-a",
						part: {
							type: "tool" as PartType,
							callID: "part-a",
							tool: "read",
							state: { status: "pending" as ToolStatus },
						},
					},
				},
				{ sessionId: "ses-A" },
			);
			translator.rebuildStateFromHistory("ses-B", [
				{
					parts: [
						{
							id: "part-b",
							type: "tool" as PartType,
						},
					],
				},
			]);
			// session-A untouched
			expect(translator.getSeenParts("ses-A")?.has("part-a")).toBe(true);
			// session-B rebuilt
			expect(translator.getSeenParts("ses-B")?.has("part-b")).toBe(true);
		});

		it("FIFO eviction is per-session", () => {
			const translator = createTranslator();
			// Fill session-A to capacity (10,000+ parts)
			for (let i = 0; i < 10_001; i++) {
				translator.translate(
					{
						type: "message.part.updated",
						properties: {
							partID: `part-a-${i}`,
							part: {
								type: "text" as PartType,
								id: `part-a-${i}`,
							},
						},
					},
					{ sessionId: "ses-A" },
				);
			}
			// session-A should have been evicted down
			const seenA = translator.getSeenParts("ses-A");
			// biome-ignore lint/style/noNonNullAssertion: guarded — 10k parts were added to this session
			expect(seenA!.size).toBeLessThanOrEqual(10_000);
			// session-B should be unaffected
			translator.translate(
				{
					type: "message.part.updated",
					properties: {
						partID: "part-b",
						part: {
							type: "tool" as PartType,
							callID: "part-b",
							tool: "read",
							state: { status: "pending" as ToolStatus },
						},
					},
				},
				{ sessionId: "ses-B" },
			);
			expect(translator.getSeenParts("ses-B")?.has("part-b")).toBe(true);
		});
	});

	// ── Deterministic seenParts-based delta classification ──────────────────

	describe("seenParts-based delta classification", () => {
		it("routes delta to thinking_delta when part is registered as reasoning", () => {
			const t = createTranslator();
			// Register a reasoning part via part.updated
			t.translate({
				type: "message.part.updated",
				properties: {
					sessionID: "ses_1",
					part: {
						id: "part_1",
						type: "reasoning",
						sessionID: "ses_1",
					},
				},
			});
			// Send a delta for the same part
			const result = t.translate({
				type: "message.part.delta",
				properties: {
					sessionID: "ses_1",
					partID: "part_1",
					field: "text",
					delta: "thinking content",
				},
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.messages).toContainEqual(
					expect.objectContaining({
						type: "thinking_delta",
						text: "thinking content",
					}),
				);
			}
		});

		it("routes delta to delta when part is registered as text", () => {
			const t = createTranslator();
			t.translate({
				type: "message.part.updated",
				properties: {
					sessionID: "ses_1",
					part: {
						id: "part_2",
						type: "text",
						sessionID: "ses_1",
					},
				},
			});
			const result = t.translate({
				type: "message.part.delta",
				properties: {
					sessionID: "ses_1",
					partID: "part_2",
					field: "text",
					delta: "regular content",
				},
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.messages).toContainEqual(
					expect.objectContaining({ type: "delta", text: "regular content" }),
				);
			}
		});

		it("routes delta to delta when part is unknown (fallback)", () => {
			const t = createTranslator();
			// No prior part.updated — part is unknown
			const result = t.translate({
				type: "message.part.delta",
				properties: {
					sessionID: "ses_1",
					partID: "part_unknown",
					field: "text",
					delta: "fallback content",
				},
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.messages).toContainEqual(
					expect.objectContaining({ type: "delta", text: "fallback content" }),
				);
			}
		});
	});
});
