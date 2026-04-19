import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ThinkingMessage } from "../../../src/lib/frontend/types.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import { MessageProjector } from "../../../src/lib/persistence/projectors/message-projector.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import {
	createTestHarness,
	makeStored,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

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
const eventSequenceArb = fc.array(
	fc.oneof(thinkingBlockArb, textBlockArb),
	{ minLength: 1, maxLength: 8 },
);

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
			{ numRuns: 100 },
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
			{ numRuns: 100 },
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
			{ numRuns: 100 },
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
					const expectedThinkingA = blocksA.filter((b) => b.type === "thinking").length;
					const expectedThinkingB = blocksB.filter((b) => b.type === "thinking").length;
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
			{ numRuns: 50 },
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
			{ numRuns: 200 },
		);
	});
});
