import fc from "fast-check";
import { assert, describe, expect, it, vi } from "vitest";
import type { ThinkingMessage } from "../../../src/lib/frontend/types.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import type { StoredEvent } from "../../../src/lib/persistence/events.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import {
	type EffectProjectionHarness,
	makeEffectProjectionHarness,
} from "../../helpers/effect-projection-harness.js";
import { makeStored } from "../../helpers/persistence-factories.js";

const SEED = 42;
const NUM_RUNS = 100;

// Each property builds a fresh SQLite harness per run: seconds alone, but past
// the 10s default when the machine is loaded (full suite, parallel worktrees).
// conduit-test-997y
vi.setConfig({ testTimeout: 30_000 });

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

async function projectBlocks(
	harness: EffectProjectionHarness,
	sessionId: string,
	messageId: string,
	blocks: Block[],
): Promise<void> {
	let seq = 0;
	let ts = 1_000_000_000_000;
	const events: StoredEvent[] = [];

	events.push(
		makeStored(
			"message.created",
			sessionId,
			{ messageId, role: "assistant", sessionId },
			{ sequence: ++seq, createdAt: ts++ },
		),
	);

	for (const block of blocks) {
		if (block.type === "thinking") {
			events.push(
				makeStored(
					"thinking.start",
					sessionId,
					{ messageId, partId: block.partId },
					{ sequence: ++seq, createdAt: ts++ },
				),
			);
			for (const text of block.deltas) {
				events.push(
					makeStored(
						"thinking.delta",
						sessionId,
						{ messageId, partId: block.partId, text },
						{ sequence: ++seq, createdAt: ts++ },
					),
				);
			}
			events.push(
				makeStored(
					"thinking.end",
					sessionId,
					{ messageId, partId: block.partId },
					{ sequence: ++seq, createdAt: ts++ },
				),
			);
		} else {
			for (const text of block.deltas) {
				events.push(
					makeStored(
						"text.delta",
						sessionId,
						{ messageId, partId: block.partId, text },
						{ sequence: ++seq, createdAt: ts++ },
					),
				);
			}
		}
	}

	events.push(
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
	);

	await harness.reproject(events);
}

async function seedSession(
	harness: EffectProjectionHarness,
	sessionId: string,
): Promise<void> {
	await harness.query(
		"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		[sessionId, "claude", "Test", "idle", 1_000_000_000_000, 1_000_000_000_000],
	);
}

async function readPipeline(
	harness: EffectProjectionHarness,
	sessionId: string,
) {
	const rows = await harness.sessionMessagesWithParts(sessionId);
	const { messages } = messageRowsToHistory(rows, { pageSize: 50 });
	return historyToChatMessages(messages);
}

// ─── Property tests ─────────────────────────────────────────────────────────

describe("Pipeline property-based tests", () => {
	it("PBT: all thinking blocks have done=true after full pipeline", async () => {
		const harness = makeEffectProjectionHarness();
		let runIndex = 0;
		try {
			await fc.assert(
				fc.asyncProperty(eventSequenceArb, async (blocks) => {
					const runId = ++runIndex;
					const sessionId = `ses-pbt-${runId}`;
					const messageId = `msg-pbt-${runId}`;
					await seedSession(harness, sessionId);
					await projectBlocks(harness, sessionId, messageId, blocks);

					const chat = await readPipeline(harness, sessionId);
					const thinkingBlocks = chat.filter(
						(m): m is ThinkingMessage => m.type === "thinking",
					);
					for (const t of thinkingBlocks) {
						expect(t.done).toBe(true);
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		} finally {
			await harness.dispose();
		}
	});

	it("PBT: thinking blocks appear before their paired text in output", async () => {
		const harness = makeEffectProjectionHarness();
		let runIndex = 0;
		try {
			// Adaptation: the plan's original assertion (firstThinking < firstAssistant
			// whenever both exist) is fundamentally wrong for interleaved block arrays
			// like [text, thinking, ...] — the first text can legitimately appear before
			// any thinking. Restrict the invariant to sequences where the first block
			// with content is a thinking block; in that case the pipeline must preserve
			// that ordering end-to-end.
			await fc.assert(
				fc.asyncProperty(eventSequenceArb, async (blocks) => {
					const runId = ++runIndex;
					const sessionId = `ses-pbt-ord-${runId}`;
					const messageId = `msg-pbt-ord-${runId}`;
					await seedSession(harness, sessionId);
					await projectBlocks(harness, sessionId, messageId, blocks);

					const chat = await readPipeline(harness, sessionId);
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
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		} finally {
			await harness.dispose();
		}
	});

	it("PBT: round-trip fidelity — text blocks with content produce assistant messages", async () => {
		const harness = makeEffectProjectionHarness();
		let runIndex = 0;
		try {
			await fc.assert(
				fc.asyncProperty(eventSequenceArb, async (blocks) => {
					const runId = ++runIndex;
					const sessionId = `ses-pbt-rt-${runId}`;
					const messageId = `msg-pbt-rt-${runId}`;
					await seedSession(harness, sessionId);
					await projectBlocks(harness, sessionId, messageId, blocks);

					const chat = await readPipeline(harness, sessionId);
					const hasTextContent = blocks.some(
						(b) => b.type === "text" && b.deltas.some((d) => d.length > 0),
					);
					if (hasTextContent) {
						expect(chat.some((m) => m.type === "assistant")).toBe(true);
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		} finally {
			await harness.dispose();
		}
	});

	it("PBT: session isolation — events for session A absent from session B", async () => {
		const harness = makeEffectProjectionHarness();
		let runIndex = 0;
		try {
			await fc.assert(
				fc.asyncProperty(
					eventSequenceArb,
					eventSequenceArb,
					async (blocksA, blocksB) => {
						const runId = ++runIndex;
						const sessionA = `ses-iso-a-${runId}`;
						const messageA = `msg-a-${runId}`;
						const sessionB = `ses-iso-b-${runId}`;
						const messageB = `msg-b-${runId}`;
						await seedSession(harness, sessionA);
						await seedSession(harness, sessionB);

						await projectBlocks(harness, sessionA, messageA, blocksA);
						await projectBlocks(harness, sessionB, messageB, blocksB);

						const chatA = await readPipeline(harness, sessionA);
						const chatB = await readPipeline(harness, sessionB);

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
					},
				),
				{ seed: SEED, numRuns: 50, endOnFailure: true },
			);
		} finally {
			await harness.dispose();
		}
	});

	it("PBT: pipeline never crashes on valid event sequences", async () => {
		const harness = makeEffectProjectionHarness();
		let runIndex = 0;
		try {
			await fc.assert(
				fc.asyncProperty(eventSequenceArb, async (blocks) => {
					const runId = ++runIndex;
					const sessionId = `ses-pbt-nocrash-${runId}`;
					const messageId = `msg-pbt-nocrash-${runId}`;
					await seedSession(harness, sessionId);
					// Should not throw for any valid sequence
					await expect(
						(async () => {
							await projectBlocks(harness, sessionId, messageId, blocks);
							await readPipeline(harness, sessionId);
						})(),
					).resolves.toBeUndefined();
				}),
				{ seed: SEED, numRuns: 200, endOnFailure: true },
			);
		} finally {
			await harness.dispose();
		}
	});
});

// ─── Invalid sequence arbitraries ────────────────────────────────────

/** Shuffle an array randomly */
function shuffle<T>(arr: T[], rng: () => number): T[] {
	const result = [...arr];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const current = result[i];
		const swapped = result[j];
		assert.exists(current, "expected current shuffled item");
		assert.exists(swapped, "expected swapped shuffled item");
		[result[i], result[j]] = [swapped, current];
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
	it("PBT: pipeline never crashes on shuffled event order", async () => {
		const harness = makeEffectProjectionHarness();
		let runIndex = 0;
		try {
			await fc.assert(
				fc.asyncProperty(corruptedSequenceArb, async ({ blocks, seed }) => {
					const runId = ++runIndex;
					const sessionId = `ses-shuffle-${runId}`;
					const messageId = `msg-s-${runId}`;
					await seedSession(harness, sessionId);
					const events: StoredEvent[] = [];
					let seq = 0;
					let ts = 1_000_000_000_000;

					// Build full event list
					events.push(
						makeStored(
							"message.created",
							sessionId,
							{
								messageId,
								role: "assistant",
								sessionId,
							},
							{ sequence: ++seq, createdAt: ts++ },
						),
					);
					for (const block of blocks) {
						if (block.type === "thinking") {
							events.push(
								makeStored(
									"thinking.start",
									sessionId,
									{
										messageId,
										partId: block.partId,
									},
									{ sequence: ++seq, createdAt: ts++ },
								),
							);
							for (const text of block.deltas) {
								events.push(
									makeStored(
										"thinking.delta",
										sessionId,
										{
											messageId,
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
									sessionId,
									{
										messageId,
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
										sessionId,
										{
											messageId,
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
							sessionId,
							{
								messageId,
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
					await expect(
						(async () => {
							for (const event of shuffled) {
								await harness.reproject([event]);
							}
							await readPipeline(harness, sessionId);
						})(),
					).resolves.toBeUndefined();
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		} finally {
			await harness.dispose();
		}
	});

	it("PBT: pipeline never crashes on sequences with randomly dropped events", async () => {
		const harness = makeEffectProjectionHarness();
		let runIndex = 0;
		try {
			await fc.assert(
				fc.asyncProperty(
					corruptedSequenceArb,
					fc.integer({ min: 1, max: 3 }),
					async ({ blocks, seed }, dropCount) => {
						const runId = ++runIndex;
						const sessionId = `ses-drop-${runId}`;
						const messageId = `msg-d-${runId}`;
						await seedSession(harness, sessionId);
						const events: StoredEvent[] = [];
						let seq = 0;
						let ts = 1_000_000_000_000;

						events.push(
							makeStored(
								"message.created",
								sessionId,
								{
									messageId,
									role: "assistant",
									sessionId,
								},
								{ sequence: ++seq, createdAt: ts++ },
							),
						);
						for (const block of blocks) {
							if (block.type === "thinking") {
								events.push(
									makeStored(
										"thinking.start",
										sessionId,
										{
											messageId,
											partId: block.partId,
										},
										{ sequence: ++seq, createdAt: ts++ },
									),
								);
								for (const text of block.deltas) {
									events.push(
										makeStored(
											"thinking.delta",
											sessionId,
											{
												messageId,
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
										sessionId,
										{
											messageId,
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
											sessionId,
											{
												messageId,
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
								sessionId,
								{
									messageId,
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
						const firstEvent = events[0];
						assert.exists(firstEvent, "expected message.created event");
						const filtered = [
							firstEvent,
							...droppable.filter((_, idx) => !toDrop.has(idx)),
						];

						await expect(
							(async () => {
								for (const event of filtered) {
									await harness.reproject([event]);
								}
								await readPipeline(harness, sessionId);
							})(),
						).resolves.toBeUndefined();
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		} finally {
			await harness.dispose();
		}
	});

	it("PBT: pipeline never crashes on sequences with duplicate events", async () => {
		const harness = makeEffectProjectionHarness();
		let runIndex = 0;
		try {
			await fc.assert(
				fc.asyncProperty(
					corruptedSequenceArb,
					fc.integer({ min: 1, max: 3 }),
					async ({ blocks, seed }, dupCount) => {
						const runId = ++runIndex;
						const sessionId = `ses-dup-${runId}`;
						const messageId = `msg-dp-${runId}`;
						await seedSession(harness, sessionId);
						const events: StoredEvent[] = [];
						let seq = 0;
						let ts = 1_000_000_000_000;

						events.push(
							makeStored(
								"message.created",
								sessionId,
								{
									messageId,
									role: "assistant",
									sessionId,
								},
								{ sequence: ++seq, createdAt: ts++ },
							),
						);
						for (const block of blocks) {
							if (block.type === "thinking") {
								events.push(
									makeStored(
										"thinking.start",
										sessionId,
										{
											messageId,
											partId: block.partId,
										},
										{ sequence: ++seq, createdAt: ts++ },
									),
								);
								for (const text of block.deltas) {
									events.push(
										makeStored(
											"thinking.delta",
											sessionId,
											{
												messageId,
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
										sessionId,
										{
											messageId,
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
											sessionId,
											{
												messageId,
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
								sessionId,
								{
									messageId,
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
							const duplicate = events[idx];
							assert.exists(duplicate, "expected event to duplicate");
							withDups.splice(idx + 1, 0, duplicate);
						}

						await expect(
							(async () => {
								for (const event of withDups) {
									await harness.reproject([event]);
								}
								await readPipeline(harness, sessionId);
							})(),
						).resolves.toBeUndefined();
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		} finally {
			await harness.dispose();
		}
	});
});

// ─── PBT Regression Cases ───────────────────────────────────────────────────
// When a PBT fails, add the shrunk counterexample here as a deterministic
// regression test. This ensures past failures remain covered even when the
// random seed produces different sequences.
//
// Imports used by regression cases should match those used by the PBTs above
// (makeEffectProjectionHarness, projectBlocks, readPipeline, Block).
//
// Format:
//   it("REGRESSION <date>: <description>", async () => {
//     const blocks: Block[] = [/* shrunk counterexample */];
//     const harness = makeEffectProjectionHarness();
//     try {
//       await seedSession(harness, "ses-reg");
//       await projectBlocks(harness, "ses-reg", "msg-reg", blocks);
//       const chat = await readPipeline(harness, "ses-reg");
//       /* assertion that failed */
//     } finally {
//       await harness.dispose();
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
