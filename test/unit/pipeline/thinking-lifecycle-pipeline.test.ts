import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThinkingMessage } from "../../../src/lib/frontend/types.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import type { StoredEvent } from "../../../src/lib/persistence/events.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { MessageProjector } from "../../../src/lib/persistence/projectors/message-projector.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { makeStored } from "../../helpers/persistence-factories.js";

const SESSION_ID = "ses-pipeline-1";
const MSG_ID = "msg-asst-1";
const THINK_PART_ID = "part-think-1";
const TEXT_PART_ID = "part-text-1";
const NOW = 1_000_000_000_000;

describe("Thinking lifecycle — full pipeline", () => {
	let db: SqliteClient;
	let projector: MessageProjector;
	let seq: number;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		projector = new MessageProjector();
		seq = 0;

		// Seed session (FK requirement)
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			[SESSION_ID, "claude", "Test", "idle", NOW, NOW],
		);
	});

	afterEach(() => {
		db?.close();
	});

	function project(event: StoredEvent): void {
		projector.project(event, db);
	}

	function nextSeq(): number {
		return ++seq;
	}

	it("thinking block survives full pipeline: project → SQLite → history → chat", () => {
		// 1. Project events through MessageProjector → SQLite
		project(
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

		project(
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

		project(
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

		project(
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

		project(
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

		project(
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
		const readQuery = new ReadQueryService(db);
		const rows = readQuery.getSessionMessagesWithParts(SESSION_ID);
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
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		expect(thinkingMsg!.done).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		expect(thinkingMsg!.text).toBe("Let me reason about this...");

		// Assert assistant message also present and ordered after thinking
		const thinkingIdx = chatMessages.findIndex((m) => m.type === "thinking");
		const assistantIdx = chatMessages.findIndex((m) => m.type === "assistant");
		expect(thinkingIdx).toBeLessThan(assistantIdx);
	});

	it("thinking block round-trips through SQLite — simulated reload", () => {
		// Project a thinking lifecycle
		project(
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

		project(
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

		project(
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

		project(
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

		// Simulate reload: create a NEW ReadQueryService (as if reconnecting)
		const freshReadQuery = new ReadQueryService(db);
		const rows = freshReadQuery.getSessionMessagesWithParts(SESSION_ID);
		const { messages } = messageRowsToHistory(rows, { pageSize: 50 });
		const chatMessages = historyToChatMessages(messages);

		const thinking = chatMessages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(thinking).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		expect(thinking!.done).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		expect(thinking!.text).toBe("Deep reasoning about the problem...");
		// Duration is undefined — MessageProjector doesn't store timing on parts,
		// and partRowToHistoryPart doesn't produce a time field. Known gap.
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		expect(thinking!.duration).toBeUndefined();
	});

	it("documents divergence: SQLite has partial thinking, frontend marks done via safety net", () => {
		// Project thinking START + DELTA but NO thinking.end
		project(
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

		project(
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

		project(
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
		const readQuery = new ReadQueryService(db);
		const rows = readQuery.getSessionMessagesWithParts(SESSION_ID);
		const { messages } = messageRowsToHistory(rows, { pageSize: 50 });
		const chatMessages = historyToChatMessages(messages);

		const thinking = chatMessages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(thinking).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		expect(thinking!.text).toBe("Partial reasoning that never completed...");

		// historyToChatMessages always marks history thinking blocks as done=true
		// (history is static — if it's persisted, it's "done" by definition)
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		expect(thinking!.done).toBe(true);
	});
});
