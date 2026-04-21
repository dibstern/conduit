import { describe, expect, it } from "vitest";
import type { ThinkingMessage } from "../../../src/lib/frontend/types.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import type {
	HistoryMessage,
	HistoryMessagePart,
} from "../../../src/lib/shared-types.js";
import {
	createTestHarness,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

describe("History conversion regression", () => {
	// ─── Part type regression guard ─────────────────────────────────────

	describe("part type regression guard", () => {
		/**
		 * Constructs a minimal HistoryMessage with the given parts.
		 * Uses `as HistoryMessage` because HistoryMessagePart.type is PartType
		 * which may not include "thinking" — the DB stores it but the type union
		 * reflects the OpenCode SDK types. The cast is intentional.
		 */
		function makeHistoryMessage(
			parts: Array<{ type: string; text?: string; time?: unknown }>,
		): HistoryMessage {
			return {
				id: "msg-1",
				role: "assistant",
				parts: parts.map((p, i) => ({
					id: `part-${i}`,
					...p,
				})) as HistoryMessagePart[],
				time: { created: 1000 },
			} as HistoryMessage;
		}

		it("'reasoning' part type → ThinkingMessage (OpenCode SDK path)", () => {
			const chat = historyToChatMessages([
				makeHistoryMessage([{ type: "reasoning", text: "reasoning text" }]),
			]);

			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("reasoning text");
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.done).toBe(true);
		});

		it("'thinking' part type → ThinkingMessage (Task 0 fix — projected path)", () => {
			const chat = historyToChatMessages([
				makeHistoryMessage([{ type: "thinking", text: "thinking text" }]),
			]);

			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("thinking text");
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.done).toBe(true);
		});

		it("'reasoning' and 'thinking' produce identical output shape", () => {
			const chatR = historyToChatMessages([
				makeHistoryMessage([{ type: "reasoning", text: "same" }]),
			]);
			const chatT = historyToChatMessages([
				makeHistoryMessage([{ type: "thinking", text: "same" }]),
			]);

			const thinkR = chatR.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			const thinkT = chatT.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);

			expect(thinkR).toBeDefined();
			expect(thinkT).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinkR!.text).toBe(thinkT!.text);
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinkR!.done).toBe(thinkT!.done);
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinkR!.type).toBe(thinkT!.type);
		});
	});

	// ─── Duration calculation ───────────────────────────────────────────

	describe("duration calculation", () => {
		function makeThinkingMsg(partTime?: {
			start?: number;
			end?: number;
		}): HistoryMessage {
			return {
				id: "msg-dur",
				role: "assistant",
				parts: [
					{
						id: "part-dur",
						type: "reasoning",
						text: "reasoning",
						...(partTime != null && { time: partTime }),
					},
				],
				time: { created: 1000 },
			} as HistoryMessage;
		}

		it("duration computed correctly when time.start and time.end present", () => {
			const chat = historyToChatMessages([
				makeThinkingMsg({ start: 1000, end: 3500 }),
			]);

			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.duration).toBe(2500);
		});

		it("duration undefined when only time.start present", () => {
			const chat = historyToChatMessages([makeThinkingMsg({ start: 1000 })]);

			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.duration).toBeUndefined();
		});

		it("duration undefined when only time.end present", () => {
			const chat = historyToChatMessages([makeThinkingMsg({ end: 3500 })]);

			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.duration).toBeUndefined();
		});

		it("duration undefined when no time data on part", () => {
			const chat = historyToChatMessages([makeThinkingMsg()]);

			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.duration).toBeUndefined();
		});
	});

	// ─── Pagination guard ───────────────────────────────────────────────

	describe("pagination guard", () => {
		it("message with multiple parts stays intact at pageSize=1", () => {
			// Future-proofing guard: getSessionMessagesWithParts() currently
			// returns ALL messages (no pagination), but messageRowsToHistory
			// accepts pageSize. This verifies a multi-part message isn't split.
			let harness: TestHarness | undefined;
			try {
				harness = createTestHarness();
				harness.seedSession("ses-page");
				harness.seedMessage("msg-page", "ses-page", {
					role: "assistant",
					parts: [
						{ id: "p1", type: "thinking", text: "thought", sortOrder: 0 },
						{ id: "p2", type: "text", text: "answer", sortOrder: 1 },
					],
				});

				const readQuery = new ReadQueryService(harness.db);
				const rows = readQuery.getSessionMessagesWithParts("ses-page");
				const { messages } = messageRowsToHistory(rows, { pageSize: 1 });

				// Message should have both parts intact
				expect(messages).toHaveLength(1);
				expect(messages[0]?.parts?.length).toBeGreaterThanOrEqual(2);
			} finally {
				harness?.close();
			}
		});
	});

	// ─── Pre-existing data round-trip (migration safety) ─────────────────

	describe("pre-existing data round-trip", () => {
		it("pre-existing type='thinking' rows in SQLite round-trip after Task 0 fix", () => {
			let harness: TestHarness | undefined;
			try {
				harness = createTestHarness();
				harness.seedSession("ses-migrate");

				// Seed directly into DB — simulates data created before code fix
				harness.seedMessage("msg-migrate", "ses-migrate", {
					role: "assistant",
					parts: [
						{
							id: "part-think-old",
							type: "thinking",
							text: "pre-existing thought",
							sortOrder: 0,
						},
						{
							id: "part-text-old",
							type: "text",
							text: "pre-existing answer",
							sortOrder: 1,
						},
					],
				});

				const readQuery = new ReadQueryService(harness.db);
				const rows = readQuery.getSessionMessagesWithParts("ses-migrate");
				const { messages } = messageRowsToHistory(rows, { pageSize: 50 });
				const chatMessages = historyToChatMessages(messages);

				// Thinking block from pre-existing data
				const thinking = chatMessages.find(
					(m): m is ThinkingMessage => m.type === "thinking",
				);
				expect(thinking).toBeDefined();
				// biome-ignore lint/style/noNonNullAssertion: asserted above
				expect(thinking!.text).toBe("pre-existing thought");
				// biome-ignore lint/style/noNonNullAssertion: asserted above
				expect(thinking!.done).toBe(true);

				// Assistant text also present
				const assistant = chatMessages.find((m) => m.type === "assistant");
				expect(assistant).toBeDefined();
			} finally {
				harness?.close();
			}
		});

		it("pre-existing type='thinking' row with empty text — does not crash pipeline", () => {
			let harness: TestHarness | undefined;
			try {
				harness = createTestHarness();
				harness.seedSession("ses-migrate-empty");

				harness.seedMessage("msg-migrate-empty", "ses-migrate-empty", {
					role: "assistant",
					parts: [
						{
							id: "part-think-empty",
							type: "thinking",
							text: "",
							sortOrder: 0,
						},
					],
				});

				const readQuery = new ReadQueryService(harness.db);
				const rows = readQuery.getSessionMessagesWithParts("ses-migrate-empty");
				const { messages } = messageRowsToHistory(rows, { pageSize: 50 });
				const chatMessages = historyToChatMessages(messages);

				const thinking = chatMessages.find(
					(m): m is ThinkingMessage => m.type === "thinking",
				);
				expect(thinking).toBeDefined();
				// biome-ignore lint/style/noNonNullAssertion: asserted above
				expect(thinking!.text).toBe("");
				// biome-ignore lint/style/noNonNullAssertion: asserted above
				expect(thinking!.done).toBe(true);
			} finally {
				harness?.close();
			}
		});
	});

	// ─── Unknown part type runtime behavior ──────────────────────────────

	describe("unknown part type — runtime drop behavior", () => {
		function makeHistoryMessage(
			parts: Array<{ type: string; text?: string }>,
		): HistoryMessage {
			return {
				id: "msg-unknown",
				role: "assistant",
				parts: parts.map((p, i) => ({
					id: `part-${i}`,
					...p,
				})),
				time: { created: 1000 },
			} as unknown as HistoryMessage;
		}

		it("unknown part type 'image' — silently dropped, no crash, no phantom message", () => {
			const chat = historyToChatMessages([
				makeHistoryMessage([{ type: "image", text: "base64data" }]),
			]);

			// No messages produced — unknown type dropped by default case
			expect(chat).toHaveLength(0);
		});

		it("unknown part type 'audio' — silently dropped", () => {
			const chat = historyToChatMessages([
				makeHistoryMessage([{ type: "audio" }]),
			]);

			expect(chat).toHaveLength(0);
		});

		it("unknown part type 'future_magic' — silently dropped", () => {
			const chat = historyToChatMessages([
				makeHistoryMessage([{ type: "future_magic", text: "surprise" }]),
			]);

			expect(chat).toHaveLength(0);
		});

		it("mixed known and unknown types — known survive, unknown dropped", () => {
			const chat = historyToChatMessages([
				makeHistoryMessage([
					{ type: "thinking", text: "thought" },
					{ type: "unknown_x" },
					{ type: "text", text: "answer" },
					{ type: "unknown_y", text: "nope" },
				]),
			]);

			// Only thinking + text survive
			expect(chat).toHaveLength(2);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(chat[0]!.type).toBe("thinking");
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(chat[1]!.type).toBe("assistant");
		});

		it.todo(
			"unknown part types should be logged for observability — add logging to default case",
		);
	});
});
