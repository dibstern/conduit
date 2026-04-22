import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const NOW = 1_000_000_000_000;

describe("Concurrent projection — interleaved sessions", () => {
	let harness: TestHarness;
	let projector: MessageProjector;

	beforeEach(() => {
		harness = createTestHarness();
		projector = new MessageProjector();
	});

	afterEach(() => {
		harness?.close();
	});

	function readPipeline(sessionId: string) {
		const readQuery = new ReadQueryService(harness.db);
		const rows = readQuery.getSessionMessagesWithParts(sessionId);
		const { messages } = messageRowsToHistory(rows, { pageSize: 50 });
		return historyToChatMessages(messages);
	}

	it("interleaved projections across 3 sessions — no cross-contamination", () => {
		const sessions = ["ses-c1", "ses-c2", "ses-c3"];
		for (const sid of sessions) {
			harness.seedSession(sid);
		}

		let globalSeq = 0;

		// Interleave: session 1 message.created, session 2 message.created,
		// session 1 thinking.start, session 3 message.created, etc.
		projector.project(
			makeStored(
				"message.created",
				"ses-c1",
				{
					messageId: "msg-c1",
					role: "assistant",
					sessionId: "ses-c1",
				},
				{ sequence: ++globalSeq, createdAt: NOW },
			),
			harness.db,
		);

		projector.project(
			makeStored(
				"message.created",
				"ses-c2",
				{
					messageId: "msg-c2",
					role: "assistant",
					sessionId: "ses-c2",
				},
				{ sequence: ++globalSeq, createdAt: NOW + 1 },
			),
			harness.db,
		);

		projector.project(
			makeStored(
				"thinking.start",
				"ses-c1",
				{ messageId: "msg-c1", partId: "think-c1" },
				{ sequence: ++globalSeq, createdAt: NOW + 2 },
			),
			harness.db,
		);

		projector.project(
			makeStored(
				"message.created",
				"ses-c3",
				{
					messageId: "msg-c3",
					role: "assistant",
					sessionId: "ses-c3",
				},
				{ sequence: ++globalSeq, createdAt: NOW + 3 },
			),
			harness.db,
		);

		projector.project(
			makeStored(
				"thinking.delta",
				"ses-c1",
				{
					messageId: "msg-c1",
					partId: "think-c1",
					text: "session 1 thought",
				},
				{ sequence: ++globalSeq, createdAt: NOW + 4 },
			),
			harness.db,
		);

		projector.project(
			makeStored(
				"text.delta",
				"ses-c2",
				{
					messageId: "msg-c2",
					partId: "text-c2",
					text: "session 2 text",
				},
				{ sequence: ++globalSeq, createdAt: NOW + 5 },
			),
			harness.db,
		);

		projector.project(
			makeStored(
				"thinking.start",
				"ses-c3",
				{ messageId: "msg-c3", partId: "think-c3" },
				{ sequence: ++globalSeq, createdAt: NOW + 6 },
			),
			harness.db,
		);

		projector.project(
			makeStored(
				"thinking.end",
				"ses-c1",
				{ messageId: "msg-c1", partId: "think-c1" },
				{ sequence: ++globalSeq, createdAt: NOW + 7 },
			),
			harness.db,
		);

		projector.project(
			makeStored(
				"thinking.delta",
				"ses-c3",
				{
					messageId: "msg-c3",
					partId: "think-c3",
					text: "session 3 thought",
				},
				{ sequence: ++globalSeq, createdAt: NOW + 8 },
			),
			harness.db,
		);

		projector.project(
			makeStored(
				"text.delta",
				"ses-c1",
				{
					messageId: "msg-c1",
					partId: "text-c1",
					text: "session 1 answer",
				},
				{ sequence: ++globalSeq, createdAt: NOW + 9 },
			),
			harness.db,
		);

		projector.project(
			makeStored(
				"thinking.end",
				"ses-c3",
				{ messageId: "msg-c3", partId: "think-c3" },
				{ sequence: ++globalSeq, createdAt: NOW + 10 },
			),
			harness.db,
		);

		// Complete all turns
		for (const [sid, mid] of [
			["ses-c1", "msg-c1"],
			["ses-c2", "msg-c2"],
			["ses-c3", "msg-c3"],
		] as const) {
			projector.project(
				makeStored(
					"turn.completed",
					sid,
					{
						messageId: mid,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: ++globalSeq, createdAt: NOW + 100 },
				),
				harness.db,
			);
		}

		// Verify isolation
		const chat1 = readPipeline("ses-c1");
		const chat2 = readPipeline("ses-c2");
		const chat3 = readPipeline("ses-c3");

		// Session 1: thinking + assistant
		const think1 = chat1.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(think1).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		expect(think1!.text).toBe("session 1 thought");
		expect(chat1.some((m) => m.type === "assistant")).toBe(true);

		// Session 2: assistant only, no thinking
		expect(chat2.some((m) => m.type === "thinking")).toBe(false);
		expect(chat2.some((m) => m.type === "assistant")).toBe(true);

		// Session 3: thinking only, no assistant text
		const think3 = chat3.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(think3).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		expect(think3!.text).toBe("session 3 thought");
		expect(chat3.some((m) => m.type === "assistant")).toBe(false);
	});

	it("shared MessageProjector instance across sessions — no state leaks", () => {
		// MessageProjector is stateless (no instance fields tracking session).
		// Verify that using a single instance for multiple sessions is safe.
		harness.seedSession("ses-shared-1");
		harness.seedSession("ses-shared-2");

		// Project complete thinking lifecycle in session 1
		projector.project(
			makeStored(
				"message.created",
				"ses-shared-1",
				{
					messageId: "msg-s1",
					role: "assistant",
					sessionId: "ses-shared-1",
				},
				{ sequence: 1, createdAt: NOW },
			),
			harness.db,
		);
		projector.project(
			makeStored(
				"thinking.start",
				"ses-shared-1",
				{ messageId: "msg-s1", partId: "think-s1" },
				{ sequence: 2, createdAt: NOW + 1 },
			),
			harness.db,
		);
		projector.project(
			makeStored(
				"thinking.delta",
				"ses-shared-1",
				{
					messageId: "msg-s1",
					partId: "think-s1",
					text: "session 1 only",
				},
				{ sequence: 3, createdAt: NOW + 2 },
			),
			harness.db,
		);
		projector.project(
			makeStored(
				"thinking.end",
				"ses-shared-1",
				{ messageId: "msg-s1", partId: "think-s1" },
				{ sequence: 4, createdAt: NOW + 3 },
			),
			harness.db,
		);
		projector.project(
			makeStored(
				"turn.completed",
				"ses-shared-1",
				{
					messageId: "msg-s1",
					cost: 0,
					duration: 0,
					tokens: { input: 0, output: 0 },
				},
				{ sequence: 5, createdAt: NOW + 4 },
			),
			harness.db,
		);

		// Same projector instance — project in session 2
		projector.project(
			makeStored(
				"message.created",
				"ses-shared-2",
				{
					messageId: "msg-s2",
					role: "assistant",
					sessionId: "ses-shared-2",
				},
				{ sequence: 6, createdAt: NOW + 5 },
			),
			harness.db,
		);
		projector.project(
			makeStored(
				"text.delta",
				"ses-shared-2",
				{
					messageId: "msg-s2",
					partId: "text-s2",
					text: "session 2 only",
				},
				{ sequence: 7, createdAt: NOW + 6 },
			),
			harness.db,
		);
		projector.project(
			makeStored(
				"turn.completed",
				"ses-shared-2",
				{
					messageId: "msg-s2",
					cost: 0,
					duration: 0,
					tokens: { input: 0, output: 0 },
				},
				{ sequence: 8, createdAt: NOW + 7 },
			),
			harness.db,
		);

		// No cross-contamination
		const chat1 = readPipeline("ses-shared-1");
		const chat2 = readPipeline("ses-shared-2");

		expect(chat1.some((m) => m.type === "thinking")).toBe(true);
		expect(chat1.some((m) => m.type === "assistant")).toBe(false);
		expect(chat2.some((m) => m.type === "thinking")).toBe(false);
		expect(chat2.some((m) => m.type === "assistant")).toBe(true);
	});
});
