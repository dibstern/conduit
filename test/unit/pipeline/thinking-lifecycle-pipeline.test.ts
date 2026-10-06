import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import type { ThinkingMessage } from "../../../src/lib/frontend/types.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import type { StoredEvent } from "../../../src/lib/persistence/events.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import {
	type EffectProjectionHarness,
	makeEffectProjectionHarness,
} from "../../helpers/effect-projection-harness.js";
import { makeStored } from "../../helpers/persistence-factories.js";

const SESSION_ID = "ses-pipeline-1";
const MSG_ID = "msg-asst-1";
const THINK_PART_ID = "part-think-1";
const TEXT_PART_ID = "part-text-1";
const NOW = 1_000_000_000_000;

describe("Thinking lifecycle — full pipeline", () => {
	let harness: EffectProjectionHarness;
	let seq: number;

	beforeEach(async () => {
		harness = makeEffectProjectionHarness();
		seq = 0;

		// Seed session (FK requirement)
		await harness.query(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			[SESSION_ID, "claude", "Test", "idle", NOW, NOW],
		);
	});

	afterEach(async () => {
		await harness?.dispose();
	});

	async function project(event: StoredEvent): Promise<void> {
		await harness.reproject([event]);
	}

	function nextSeq(): number {
		return ++seq;
	}

	it("thinking block survives full pipeline: project → SQLite → history → chat", async () => {
		// 1. Project events through MessageProjector → SQLite
		await project(
			makeStored(
				"message.created",
				SESSION_ID,
				{
					messageId: MSG_ID,
					role: "assistant",
					sessionId: SESSION_ID,
				},
				{ sequence: nextSeq(), createdAt: NOW },
			),
		);

		await project(
			makeStored(
				"thinking.start",
				SESSION_ID,
				{
					messageId: MSG_ID,
					partId: THINK_PART_ID,
				},
				{ sequence: nextSeq(), createdAt: NOW + 100 },
			),
		);

		await project(
			makeStored(
				"thinking.delta",
				SESSION_ID,
				{
					messageId: MSG_ID,
					partId: THINK_PART_ID,
					text: "Let me reason about this...",
				},
				{ sequence: nextSeq(), createdAt: NOW + 200 },
			),
		);

		await project(
			makeStored(
				"thinking.end",
				SESSION_ID,
				{
					messageId: MSG_ID,
					partId: THINK_PART_ID,
				},
				{ sequence: nextSeq(), createdAt: NOW + 300 },
			),
		);

		await project(
			makeStored(
				"text.delta",
				SESSION_ID,
				{
					messageId: MSG_ID,
					partId: TEXT_PART_ID,
					text: "Here is my answer.",
				},
				{ sequence: nextSeq(), createdAt: NOW + 400 },
			),
		);

		await project(
			makeStored(
				"turn.completed",
				SESSION_ID,
				{
					messageId: MSG_ID,
					cost: 0.01,
					duration: 1000,
					tokens: { input: 100, output: 50 },
				},
				{ sequence: nextSeq(), createdAt: NOW + 500 },
			),
		);

		// 2. Read back from SQLite
		const rows = await harness.sessionMessagesWithParts(SESSION_ID);
		const { messages: historyMessages } = messageRowsToHistory(rows, {
			pageSize: 50,
		});

		// 3. Convert to chat messages
		const chatMessages = historyToChatMessages(historyMessages);

		// 4. Assert thinking block survived full pipeline
		const thinkingMsg = chatMessages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(thinkingMsg).toBeDefined();
		assert.exists(thinkingMsg, "expected thinking message");
		expect(thinkingMsg.done).toBe(true);
		expect(thinkingMsg.text).toBe("Let me reason about this...");

		// Assert assistant message also present and ordered after thinking
		const thinkingIdx = chatMessages.findIndex((m) => m.type === "thinking");
		const assistantIdx = chatMessages.findIndex((m) => m.type === "assistant");
		expect(thinkingIdx).toBeLessThan(assistantIdx);
	});

	it("thinking block round-trips through SQLite — simulated reload", async () => {
		// Project a thinking lifecycle
		await project(
			makeStored(
				"message.created",
				SESSION_ID,
				{
					messageId: "msg-reload",
					role: "assistant",
					sessionId: SESSION_ID,
				},
				{ sequence: nextSeq(), createdAt: NOW },
			),
		);

		await project(
			makeStored(
				"thinking.start",
				SESSION_ID,
				{
					messageId: "msg-reload",
					partId: "part-think-reload",
				},
				{ sequence: nextSeq(), createdAt: NOW + 100 },
			),
		);

		await project(
			makeStored(
				"thinking.delta",
				SESSION_ID,
				{
					messageId: "msg-reload",
					partId: "part-think-reload",
					text: "Deep reasoning about the problem...",
				},
				{ sequence: nextSeq(), createdAt: NOW + 200 },
			),
		);

		await project(
			makeStored(
				"thinking.end",
				SESSION_ID,
				{
					messageId: "msg-reload",
					partId: "part-think-reload",
				},
				{ sequence: nextSeq(), createdAt: NOW + 500 },
			),
		);

		// Simulate reload: read the session back from the store (as if reconnecting)
		const rows = await harness.sessionMessagesWithParts(SESSION_ID);
		const { messages } = messageRowsToHistory(rows, { pageSize: 50 });
		const chatMessages = historyToChatMessages(messages);

		const thinking = chatMessages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(thinking).toBeDefined();
		assert.exists(thinking, "expected thinking message");
		expect(thinking.done).toBe(true);
		expect(thinking.text).toBe("Deep reasoning about the problem...");
		// thinking.end stamps the part, so the span runs from start to end
		// rather than to the last delta.
		expect(thinking.duration).toBe(400);
	});

	it("thinking with no end stays in progress on reload", async () => {
		// Project thinking START + DELTA but NO thinking.end
		await project(
			makeStored(
				"message.created",
				SESSION_ID,
				{
					messageId: "msg-partial",
					role: "assistant",
					sessionId: SESSION_ID,
				},
				{ sequence: nextSeq(), createdAt: NOW },
			),
		);

		await project(
			makeStored(
				"thinking.start",
				SESSION_ID,
				{
					messageId: "msg-partial",
					partId: "part-think-partial",
				},
				{ sequence: nextSeq(), createdAt: NOW + 100 },
			),
		);

		await project(
			makeStored(
				"thinking.delta",
				SESSION_ID,
				{
					messageId: "msg-partial",
					partId: "part-think-partial",
					text: "Partial reasoning that never completed...",
				},
				{ sequence: nextSeq(), createdAt: NOW + 200 },
			),
		);

		// NO thinking.end projected — simulates crash/lost event

		// Read from SQLite — part exists but no end timestamp
		const rows = await harness.sessionMessagesWithParts(SESSION_ID);
		const { messages } = messageRowsToHistory(rows, { pageSize: 50 });
		const chatMessages = historyToChatMessages(messages);

		const thinking = chatMessages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(thinking).toBeDefined();
		assert.exists(thinking, "expected thinking message");
		expect(thinking.text).toBe("Partial reasoning that never completed...");

		// The part is still running: only thinking.end or the turn's end
		// (completed, error, interrupted) settles it.
		expect(thinking.done).toBe(false);
	});
});
