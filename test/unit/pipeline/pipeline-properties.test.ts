import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ThinkingMessage } from "../../../src/lib/frontend/types.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import type { StoredEvent } from "../../../src/lib/persistence/events.js";
import { MessageProjector } from "../../../src/lib/persistence/projectors/message-projector.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import {
	createTestHarness,
	makeStored,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

const SEED = 42;
const NUM_RUNS = 100;

// ─── Arbitraries ────────────────────────────────────────────────────────────

type Block =
	| { type: "thinking"; partId: string; deltas: string[] }
	| { type: "text"; partId: string; deltas: string[] };

/** A valid thinking block: start → N deltas → end */
const thinkingBlockArb: fc.Arbitrary<Block> = fc
	.record({
		partId: fc.uuid(),
		deltaCount: fc.integer({ min: 0, max: 5 }),
		deltaText: fc.string({ minLength: 0, maxLength: 50 }),
	})
	.map(({ partId, deltaCount, deltaText }) => ({
		type: "thinking" as const,
		partId,
		deltas: Array.from({ length: deltaCount }, () => deltaText),
	}));

/** A valid text block: 1+ deltas */
const textBlockArb: fc.Arbitrary<Block> = fc
	.record({
		partId: fc.uuid(),
		deltaCount: fc.integer({ min: 1, max: 5 }),
		deltaText: fc.string({ minLength: 1, maxLength: 50 }),
	})
	.map(({ partId, deltaCount, deltaText }) => ({
		type: "text" as const,
		partId,
		deltas: Array.from({ length: deltaCount }, () => deltaText),
	}));

/** A valid event sequence: 1–8 interleaved thinking/text blocks */
const eventSequenceArb = fc.array(fc.oneof(thinkingBlockArb, textBlockArb), {
	minLength: 1,
	maxLength: 8,
});

// ─── Shared helpers ─────────────────────────────────────────────────────────

function projectBlocks(
	harness: TestHarness,
	projector: MessageProjector,
	sessionId: string,
	messageId: string,
	blocks: Block[],
): void {
	let seq = 0;
	let ts = 1_000_000_000_000;

	projector.project(
		makeStored(
			"message.created",
			sessionId,
			{ messageId, role: "assistant", sessionId },
			{ sequence: ++seq, createdAt: ts++ },
		),
		harness.db,
	);

	for (const block of blocks) {
		if (block.type === "thinking") {
			projector.project(
				makeStored(
					"thinking.start",
					sessionId,
					{ messageId, partId: block.partId },
					{ sequence: ++seq, createdAt: ts++ },
				),
				harness.db,
			);
			for (const text of block.deltas) {
				projector.project(
					makeStored(
						"thinking.delta",
						sessionId,
						{ messageId, partId: block.partId, text },
						{ sequence: ++seq, createdAt: ts++ },
					),
					harness.db,
				);
			}
			projector.project(
				makeStored(
					"thinking.end",
					sessionId,
					{ messageId, partId: block.partId },
					{ sequence: ++seq, createdAt: ts++ },
				),
				harness.db,
			);
		} else {
			for (const text of block.deltas) {
				projector.project(
					makeStored(
						"text.delta",
						sessionId,
						{ messageId, partId: block.partId, text },
						{ sequence: ++seq, createdAt: ts++ },
					),
					harness.db,
				);
			}
		}
	}

	projector.project(
		makeStored(
			"turn.completed",
			sessionId,
			{
				messageId,
				cost: 0,
				duration: 0,
				tokens: { input: 0, output: 0 },
			},
			{ sequence: ++seq, createdAt: ts++ },
		),
		harness.db,
	);
}

function readPipeline(harness: TestHarness, sessionId: string) {
	const readQuery = new ReadQueryService(harness.db);
	const rows = readQuery.getSessionMessagesWithParts(sessionId);
	const { messages } = messageRowsToHistory(rows, { pageSize: 50 });
	return historyToChatMessages(messages);
}

// ─── Property tests ─────────────────────────────────────────────────────────

describe("Pipeline property-based tests", () => {
	it("PBT: all thinking blocks have done=true after full pipeline", () => {
		fc.assert(
			fc.property(eventSequenceArb, (blocks) => {
				const harness = createTestHarness();
				try {
					harness.seedSession("ses-pbt");
					projectBlocks(
						harness,
						new MessageProjector(),
						"ses-pbt",
						"msg-pbt",
						blocks,
					);

					const chat = readPipeline(harness, "ses-pbt");
					const thinkingBlocks = chat.filter(
						(m): m is ThinkingMessage => m.type === "thinking",
					);
					for (const t of thinkingBlocks) {
						expect(t.done).toBe(true);
					}
				} finally {
					harness.close();
				}
			}),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});

	it("PBT: thinking blocks appear before their paired text in output", () => {
		// Adaptation: the plan's original assertion (firstThinking < firstAssistant
		// whenever both exist) is fundamentally wrong for interleaved block arrays
		// like [text, thinking, ...] — the first text can legitimately appear before
		// any thinking. Restrict the invariant to sequences where the first block
		// with content is a thinking block; in that case the pipeline must preserve
		// that ordering end-to-end.
		fc.assert(
			fc.property(eventSequenceArb, (blocks) => {
				const harness = createTestHarness();
				try {
					harness.seedSession("ses-pbt-ord");
					projectBlocks(
						harness,
						new MessageProjector(),
						"ses-pbt-ord",
						"msg-pbt-ord",
						blocks,
					);

					const chat = readPipeline(harness, "ses-pbt-ord");
					const types = chat.map((m) => m.type);
					const firstThinking = types.indexOf("thinking");
					const firstAssistant = types.indexOf("assistant");

					// Determine which block type yields content first in the input.
					const firstContentBlock = blocks.find(
						(b) =>
							b.type === "thinking" ||
							(b.type === "text" && b.deltas.some((d) => d.length > 0)),
					);

					if (
						firstContentBlock?.type === "thinking" &&
						firstThinking !== -1 &&
						firstAssistant !== -1
					) {
						expect(firstThinking).toBeLessThan(firstAssistant);
					}
				} finally {
					harness.close();
				}
			}),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});

	it("PBT: round-trip fidelity — text blocks with content produce assistant messages", () => {
		fc.assert(
			fc.property(eventSequenceArb, (blocks) => {
				const harness = createTestHarness();
				try {
					harness.seedSession("ses-pbt-rt");
					projectBlocks(
						harness,
						new MessageProjector(),
						"ses-pbt-rt",
						"msg-pbt-rt",
						blocks,
					);

					const chat = readPipeline(harness, "ses-pbt-rt");
					const hasTextContent = blocks.some(
						(b) => b.type === "text" && b.deltas.some((d) => d.length > 0),
					);
					if (hasTextContent) {
						expect(chat.some((m) => m.type === "assistant")).toBe(true);
					}
				} finally {
					harness.close();
				}
			}),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});

	it("PBT: session isolation — events for session A absent from session B", () => {
		fc.assert(
			fc.property(eventSequenceArb, eventSequenceArb, (blocksA, blocksB) => {
				const harness = createTestHarness();
				try {
					harness.seedSession("ses-iso-a");
					harness.seedSession("ses-iso-b");

					const projector = new MessageProjector();
					projectBlocks(harness, projector, "ses-iso-a", "msg-a", blocksA);
					projectBlocks(harness, projector, "ses-iso-b", "msg-b", blocksB);

					const chatA = readPipeline(harness, "ses-iso-a");
					const chatB = readPipeline(harness, "ses-iso-b");

					// Count expected thinking blocks per session
					const expectedThinkingA = blocksA.filter(
						(b) => b.type === "thinking",
					).length;
					const expectedThinkingB = blocksB.filter(
						(b) => b.type === "thinking",
					).length;
					const expectedTextA = blocksA.filter(
						(b) => b.type === "text" && b.deltas.some((d) => d.length > 0),
					).length;
					const expectedTextB = blocksB.filter(
						(b) => b.type === "text" && b.deltas.some((d) => d.length > 0),
					).length;

					// Session A has correct counts
					const thinkingA = chatA.filter((m) => m.type === "thinking");
					const assistantA = chatA.filter((m) => m.type === "assistant");
					expect(thinkingA).toHaveLength(expectedThinkingA);
					// Text blocks with content = assistant messages (may merge if same partId)
					if (expectedTextA > 0) {
						expect(assistantA.length).toBeGreaterThanOrEqual(1);
					}

					// Session B has correct counts
					const thinkingB = chatB.filter((m) => m.type === "thinking");
					const assistantB = chatB.filter((m) => m.type === "assistant");
					expect(thinkingB).toHaveLength(expectedThinkingB);
					if (expectedTextB > 0) {
						expect(assistantB.length).toBeGreaterThanOrEqual(1);
					}
				} finally {
					harness.close();
				}
			}),
			{ seed: SEED, numRuns: 50, endOnFailure: true },
		);
	});

	it("PBT: pipeline never crashes on valid event sequences", () => {
		fc.assert(
			fc.property(eventSequenceArb, (blocks) => {
				const harness = createTestHarness();
				try {
					harness.seedSession("ses-pbt-nocrash");
					// Should not throw for any valid sequence
					expect(() => {
						projectBlocks(
							harness,
							new MessageProjector(),
							"ses-pbt-nocrash",
							"msg-pbt-nocrash",
							blocks,
						);
						readPipeline(harness, "ses-pbt-nocrash");
					}).not.toThrow();
				} finally {
					harness.close();
				}
			}),
			{ seed: SEED, numRuns: 200, endOnFailure: true },
		);
	});
});

// ─── Invalid sequence arbitraries ────────────────────────────────────

/** Shuffle an array randomly */
function shuffle<T>(arr: T[], rng: () => number): T[] {
	const result = [...arr];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		// biome-ignore lint/style/noNonNullAssertion: indices are within bounds by construction
		[result[i]!, result[j]!] = [result[j]!, result[i]!];
	}
	return result;
}

/**
 * Generates a valid event sequence then applies a corruption strategy:
 * - "shuffle": random permutation of all events within the turn
 * - "drop": randomly removes 1-3 events (excluding message.created)
 * - "duplicate": randomly duplicates 1-3 events
 */
const corruptedSequenceArb = fc
	.tuple(
		eventSequenceArb,
		fc.oneof(
			fc.constant("shuffle" as const),
			fc.constant("drop" as const),
			fc.constant("duplicate" as const),
		),
		fc.integer({ min: 1, max: 2_000_000_000 }), // RNG seed
	)
	.map(([blocks, strategy, seed]) => ({ blocks, strategy, seed }));

describe("Pipeline PBT — invalid/corrupted event sequences", () => {
	it("PBT: pipeline never crashes on shuffled event order", () => {
		fc.assert(
			fc.property(corruptedSequenceArb, ({ blocks, seed }) => {
				const harness = createTestHarness();
				try {
					harness.seedSession("ses-shuffle");
					const projector = new MessageProjector();
					const events: StoredEvent[] = [];
					let seq = 0;
					let ts = 1_000_000_000_000;

					// Build full event list
					events.push(
						makeStored(
							"message.created",
							"ses-shuffle",
							{
								messageId: "msg-s",
								role: "assistant",
								sessionId: "ses-shuffle",
							},
							{ sequence: ++seq, createdAt: ts++ },
						),
					);
					for (const block of blocks) {
						if (block.type === "thinking") {
							events.push(
								makeStored(
									"thinking.start",
									"ses-shuffle",
									{
										messageId: "msg-s",
										partId: block.partId,
									},
									{ sequence: ++seq, createdAt: ts++ },
								),
							);
							for (const text of block.deltas) {
								events.push(
									makeStored(
										"thinking.delta",
										"ses-shuffle",
										{
											messageId: "msg-s",
											partId: block.partId,
											text,
										},
										{ sequence: ++seq, createdAt: ts++ },
									),
								);
							}
							events.push(
								makeStored(
									"thinking.end",
									"ses-shuffle",
									{
										messageId: "msg-s",
										partId: block.partId,
									},
									{ sequence: ++seq, createdAt: ts++ },
								),
							);
						} else {
							for (const text of block.deltas) {
								events.push(
									makeStored(
										"text.delta",
										"ses-shuffle",
										{
											messageId: "msg-s",
											partId: block.partId,
											text,
										},
										{ sequence: ++seq, createdAt: ts++ },
									),
								);
							}
						}
					}
					events.push(
						makeStored(
							"turn.completed",
							"ses-shuffle",
							{
								messageId: "msg-s",
								cost: 0,
								duration: 0,
								tokens: { input: 0, output: 0 },
							},
							{ sequence: ++seq, createdAt: ts++ },
						),
					);

					// Shuffle using deterministic RNG
					let rngState = seed;
					const rng = () => {
						rngState = (rngState * 1664525 + 1013904223) & 0x7fffffff;
						return rngState / 0x7fffffff;
					};
					const shuffled = shuffle(events, rng);

					// Project all — should never throw
					expect(() => {
						for (const event of shuffled) {
							projector.project(event, harness.db);
						}
						readPipeline(harness, "ses-shuffle");
					}).not.toThrow();
				} finally {
					harness.close();
				}
			}),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});

	it("PBT: pipeline never crashes on sequences with randomly dropped events", () => {
		fc.assert(
			fc.property(
				corruptedSequenceArb,
				fc.integer({ min: 1, max: 3 }),
				({ blocks, seed }, dropCount) => {
					const harness = createTestHarness();
					try {
						harness.seedSession("ses-drop");
						const projector = new MessageProjector();
						const events: StoredEvent[] = [];
						let seq = 0;
						let ts = 1_000_000_000_000;

						events.push(
							makeStored(
								"message.created",
								"ses-drop",
								{
									messageId: "msg-d",
									role: "assistant",
									sessionId: "ses-drop",
								},
								{ sequence: ++seq, createdAt: ts++ },
							),
						);
						for (const block of blocks) {
							if (block.type === "thinking") {
								events.push(
									makeStored(
										"thinking.start",
										"ses-drop",
										{
											messageId: "msg-d",
											partId: block.partId,
										},
										{ sequence: ++seq, createdAt: ts++ },
									),
								);
								for (const text of block.deltas) {
									events.push(
										makeStored(
											"thinking.delta",
											"ses-drop",
											{
												messageId: "msg-d",
												partId: block.partId,
												text,
											},
											{ sequence: ++seq, createdAt: ts++ },
										),
									);
								}
								events.push(
									makeStored(
										"thinking.end",
										"ses-drop",
										{
											messageId: "msg-d",
											partId: block.partId,
										},
										{ sequence: ++seq, createdAt: ts++ },
									),
								);
							} else {
								for (const text of block.deltas) {
									events.push(
										makeStored(
											"text.delta",
											"ses-drop",
											{
												messageId: "msg-d",
												partId: block.partId,
												text,
											},
											{ sequence: ++seq, createdAt: ts++ },
										),
									);
								}
							}
						}
						events.push(
							makeStored(
								"turn.completed",
								"ses-drop",
								{
									messageId: "msg-d",
									cost: 0,
									duration: 0,
									tokens: { input: 0, output: 0 },
								},
								{ sequence: ++seq, createdAt: ts++ },
							),
						);

						// Drop random events (skip first — message.created)
						let rngState = seed;
						const rng = () => {
							rngState = (rngState * 1664525 + 1013904223) & 0x7fffffff;
							return rngState / 0x7fffffff;
						};
						const droppable = events.slice(1); // keep message.created
						const toDrop = new Set<number>();
						for (let i = 0; i < Math.min(dropCount, droppable.length); i++) {
							toDrop.add(Math.floor(rng() * droppable.length));
						}
						const filtered = [
							// biome-ignore lint/style/noNonNullAssertion: events always has at least one element (message.created)
							events[0]!,
							...droppable.filter((_, idx) => !toDrop.has(idx)),
						];

						expect(() => {
							for (const event of filtered) {
								projector.project(event, harness.db);
							}
							readPipeline(harness, "ses-drop");
						}).not.toThrow();
					} finally {
						harness.close();
					}
				},
			),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});

	it("PBT: pipeline never crashes on sequences with duplicate events", () => {
		fc.assert(
			fc.property(
				corruptedSequenceArb,
				fc.integer({ min: 1, max: 3 }),
				({ blocks, seed }, dupCount) => {
					const harness = createTestHarness();
					try {
						harness.seedSession("ses-dup");
						const projector = new MessageProjector();
						const events: StoredEvent[] = [];
						let seq = 0;
						let ts = 1_000_000_000_000;

						events.push(
							makeStored(
								"message.created",
								"ses-dup",
								{
									messageId: "msg-dp",
									role: "assistant",
									sessionId: "ses-dup",
								},
								{ sequence: ++seq, createdAt: ts++ },
							),
						);
						for (const block of blocks) {
							if (block.type === "thinking") {
								events.push(
									makeStored(
										"thinking.start",
										"ses-dup",
										{
											messageId: "msg-dp",
											partId: block.partId,
										},
										{ sequence: ++seq, createdAt: ts++ },
									),
								);
								for (const text of block.deltas) {
									events.push(
										makeStored(
											"thinking.delta",
											"ses-dup",
											{
												messageId: "msg-dp",
												partId: block.partId,
												text,
											},
											{ sequence: ++seq, createdAt: ts++ },
										),
									);
								}
								events.push(
									makeStored(
										"thinking.end",
										"ses-dup",
										{
											messageId: "msg-dp",
											partId: block.partId,
										},
										{ sequence: ++seq, createdAt: ts++ },
									),
								);
							} else {
								for (const text of block.deltas) {
									events.push(
										makeStored(
											"text.delta",
											"ses-dup",
											{
												messageId: "msg-dp",
												partId: block.partId,
												text,
											},
											{ sequence: ++seq, createdAt: ts++ },
										),
									);
								}
							}
						}
						events.push(
							makeStored(
								"turn.completed",
								"ses-dup",
								{
									messageId: "msg-dp",
									cost: 0,
									duration: 0,
									tokens: { input: 0, output: 0 },
								},
								{ sequence: ++seq, createdAt: ts++ },
							),
						);

						// Duplicate random events
						let rngState = seed;
						const rng = () => {
							rngState = (rngState * 1664525 + 1013904223) & 0x7fffffff;
							return rngState / 0x7fffffff;
						};
						const withDups = [...events];
						for (let i = 0; i < dupCount; i++) {
							const idx = Math.floor(rng() * events.length);
							// biome-ignore lint/style/noNonNullAssertion: idx is within bounds by construction
							withDups.splice(idx + 1, 0, events[idx]!);
						}

						expect(() => {
							for (const event of withDups) {
								projector.project(event, harness.db);
							}
							readPipeline(harness, "ses-dup");
						}).not.toThrow();
					} finally {
						harness.close();
					}
				},
			),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});
});

// ─── PBT Regression Cases ───────────────────────────────────────────────────
// When a PBT fails, add the shrunk counterexample here as a deterministic
// regression test. This ensures past failures remain covered even when the
// random seed produces different sequences.
//
// Imports used by regression cases should match those used by the PBTs above
// (createTestHarness, MessageProjector, projectBlocks, readPipeline, Block).
//
// Format:
//   it("REGRESSION <date>: <description>", () => {
//     const blocks: Block[] = [/* shrunk counterexample */];
//     const harness = createTestHarness();
//     try {
//       harness.seedSession("ses-reg");
//       projectBlocks(harness, new MessageProjector(), "ses-reg", "msg-reg", blocks);
//       const chat = readPipeline(harness, "ses-reg");
//       /* assertion that failed */
//     } finally {
//       harness.close();
//     }
//   });

describe("PBT regression cases", () => {
	// When a PBT fails:
	// 1. Note the seed and path from the failure output
	// 2. Run with --verbose to get the shrunk counterexample
	// 3. Replace this todo with a real it(...) test containing the counterexample
	// 4. Fix the bug
	// 5. Verify both the regression test and the PBT pass
	it.todo("add shrunk counterexamples here when PBTs fail");
});
