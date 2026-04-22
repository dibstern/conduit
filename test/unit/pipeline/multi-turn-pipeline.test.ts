import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	AssistantMessage,
	ThinkingMessage,
} from "../../../src/lib/frontend/types.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import { MessageProjector } from "../../../src/lib/persistence/projectors/message-projector.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import {
	createTestHarness,
	makeStored,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

const SESSION_ID = "ses-multi-turn";
const NOW = 1_000_000_000_000;

describe("Multi-turn conversation pipeline", () => {
	let harness: TestHarness;
	let projector: MessageProjector;
	let seq: number;

	beforeEach(() => {
		harness = createTestHarness();
		projector = new MessageProjector();
		seq = 0;
		harness.seedSession(SESSION_ID);
	});

	afterEach(() => {
		harness?.close();
	});

	function project(event: ReturnType<typeof makeStored>): void {
		projector.project(event, harness.db);
	}

	function nextSeq(): number {
		return ++seq;
	}

	function readPipeline() {
		const readQuery = new ReadQueryService(harness.db);
		const rows = readQuery.getSessionMessagesWithParts(SESSION_ID);
		const { messages } = messageRowsToHistory(rows, { pageSize: 50 });
		return historyToChatMessages(messages);
	}

	it("user→assistant(thinking)→user→assistant(thinking) — full pipeline", () => {
		// ─── Turn 1: User message ─────────────────────────────
		project(
			makeStored(
				"message.created",
				SESSION_ID,
				{ messageId: "msg-user-1", role: "user", sessionId: SESSION_ID },
				{ sequence: nextSeq(), createdAt: NOW },
			),
		);

		// ─── Turn 1: Assistant response with thinking ─────────
		project(
			makeStored(
				"message.created",
				SESSION_ID,
				{
					messageId: "msg-asst-1",
					role: "assistant",
					sessionId: SESSION_ID,
				},
				{ sequence: nextSeq(), createdAt: NOW + 100 },
			),
		);

		project(
			makeStored(
				"thinking.start",
				SESSION_ID,
				{ messageId: "msg-asst-1", partId: "think-1" },
				{ sequence: nextSeq(), createdAt: NOW + 200 },
			),
		);

		project(
			makeStored(
				"thinking.delta",
				SESSION_ID,
				{
					messageId: "msg-asst-1",
					partId: "think-1",
					text: "Turn 1 reasoning",
				},
				{ sequence: nextSeq(), createdAt: NOW + 300 },
			),
		);

		project(
			makeStored(
				"thinking.end",
				SESSION_ID,
				{ messageId: "msg-asst-1", partId: "think-1" },
				{ sequence: nextSeq(), createdAt: NOW + 400 },
			),
		);

		project(
			makeStored(
				"text.delta",
				SESSION_ID,
				{
					messageId: "msg-asst-1",
					partId: "text-1",
					text: "Turn 1 answer",
				},
				{ sequence: nextSeq(), createdAt: NOW + 500 },
			),
		);

		project(
			makeStored(
				"turn.completed",
				SESSION_ID,
				{
					messageId: "msg-asst-1",
					cost: 0.01,
					duration: 500,
					tokens: { input: 100, output: 50 },
				},
				{ sequence: nextSeq(), createdAt: NOW + 600 },
			),
		);

		// ─── Turn 2: User message ─────────────────────────────
		project(
			makeStored(
				"message.created",
				SESSION_ID,
				{ messageId: "msg-user-2", role: "user", sessionId: SESSION_ID },
				{ sequence: nextSeq(), createdAt: NOW + 1000 },
			),
		);

		// ─── Turn 2: Assistant response with thinking ─────────
		project(
			makeStored(
				"message.created",
				SESSION_ID,
				{
					messageId: "msg-asst-2",
					role: "assistant",
					sessionId: SESSION_ID,
				},
				{ sequence: nextSeq(), createdAt: NOW + 1100 },
			),
		);

		project(
			makeStored(
				"thinking.start",
				SESSION_ID,
				{ messageId: "msg-asst-2", partId: "think-2" },
				{ sequence: nextSeq(), createdAt: NOW + 1200 },
			),
		);

		project(
			makeStored(
				"thinking.delta",
				SESSION_ID,
				{
					messageId: "msg-asst-2",
					partId: "think-2",
					text: "Turn 2 reasoning",
				},
				{ sequence: nextSeq(), createdAt: NOW + 1300 },
			),
		);

		project(
			makeStored(
				"thinking.end",
				SESSION_ID,
				{ messageId: "msg-asst-2", partId: "think-2" },
				{ sequence: nextSeq(), createdAt: NOW + 1400 },
			),
		);

		project(
			makeStored(
				"text.delta",
				SESSION_ID,
				{
					messageId: "msg-asst-2",
					partId: "text-2",
					text: "Turn 2 answer",
				},
				{ sequence: nextSeq(), createdAt: NOW + 1500 },
			),
		);

		project(
			makeStored(
				"turn.completed",
				SESSION_ID,
				{
					messageId: "msg-asst-2",
					cost: 0.01,
					duration: 500,
					tokens: { input: 100, output: 50 },
				},
				{ sequence: nextSeq(), createdAt: NOW + 1600 },
			),
		);

		// ─── Verify pipeline output ──────────────────────────
		const chat = readPipeline();

		const userMessages = chat.filter((m) => m.type === "user");
		expect(userMessages).toHaveLength(2);

		// Filter to just the assistant-side pipeline to verify ordering
		const assistantSide = chat.filter((m) =>
			["thinking", "assistant"].includes(m.type),
		);
		const assistantTypes = assistantSide.map((m) => m.type);
		expect(assistantTypes).toEqual([
			"thinking",
			"assistant",
			"thinking",
			"assistant",
		]);

		// Verify thinking text associated with correct turn
		const thinkingBlocks = chat.filter(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(thinkingBlocks).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(thinkingBlocks[0]!.text).toBe("Turn 1 reasoning");
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(thinkingBlocks[1]!.text).toBe("Turn 2 reasoning");

		// Verify all thinking blocks done
		for (const t of thinkingBlocks) {
			expect(t.done).toBe(true);
		}
	});

	it("3-turn conversation — messages stay in projection order", () => {
		for (let turn = 1; turn <= 3; turn++) {
			const base = NOW + turn * 10_000;
			const userMsgId = `msg-u${turn}`;
			const asstMsgId = `msg-a${turn}`;

			project(
				makeStored(
					"message.created",
					SESSION_ID,
					{ messageId: userMsgId, role: "user", sessionId: SESSION_ID },
					{ sequence: nextSeq(), createdAt: base },
				),
			);

			project(
				makeStored(
					"message.created",
					SESSION_ID,
					{
						messageId: asstMsgId,
						role: "assistant",
						sessionId: SESSION_ID,
					},
					{ sequence: nextSeq(), createdAt: base + 100 },
				),
			);

			project(
				makeStored(
					"text.delta",
					SESSION_ID,
					{
						messageId: asstMsgId,
						partId: `text-${turn}`,
						text: `Answer ${turn}`,
					},
					{ sequence: nextSeq(), createdAt: base + 200 },
				),
			);

			project(
				makeStored(
					"turn.completed",
					SESSION_ID,
					{
						messageId: asstMsgId,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: base + 300 },
				),
			);
		}

		const chat = readPipeline();
		const assistants = chat.filter(
			(m): m is AssistantMessage => m.type === "assistant",
		);
		expect(assistants).toHaveLength(3);
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(assistants[0]!.rawText).toBe("Answer 1");
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(assistants[1]!.rawText).toBe("Answer 2");
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(assistants[2]!.rawText).toBe("Answer 3");
	});
});
