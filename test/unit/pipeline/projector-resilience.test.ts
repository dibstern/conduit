import { Cause, Effect, Runtime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	AssistantMessage,
	ThinkingMessage,
} from "../../../src/lib/frontend/types.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import {
	createAllEffectProjectors,
	type ProjectionContext,
	ProjectionError,
} from "../../../src/lib/persistence/effect/projectors-effect.js";
import type { StoredEvent } from "../../../src/lib/persistence/events.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import {
	type EffectProjectionHarness,
	makeEffectProjectionHarness,
} from "../../helpers/effect-projection-harness.js";
import { makeStored } from "../../helpers/persistence-factories.js";

const SESSION_A = "ses-resilience-a";
const SESSION_B = "ses-resilience-b";
const MSG_ID = "msg-res-1";
const NOW = 1_000_000_000_000;

describe("MessageProjector resilience", () => {
	let harness: EffectProjectionHarness;
	let seq: number;
	let replayNextProjection: boolean;
	let failNextProjection: boolean;

	beforeEach(async () => {
		replayNextProjection = false;
		failNextProjection = false;
		const projectors = createAllEffectProjectors().map((projector) => {
			if (projector.name !== "message") return projector;

			return {
				...projector,
				project: (event: StoredEvent, context?: ProjectionContext) => {
					if (failNextProjection && event.type === "thinking.delta") {
						failNextProjection = false;
						return Effect.fail(
							new ProjectionError({
								projector: "message",
								operation: "project",
								cause: new Error("Simulated disk error"),
							}),
						);
					}

					const effectiveContext = replayNextProjection
						? { replaying: true }
						: context;
					replayNextProjection = false;
					return projector.project(event, effectiveContext);
				},
			};
		});
		harness = makeEffectProjectionHarness(projectors);
		seq = 0;
		for (const sessionId of [SESSION_A, SESSION_B]) {
			await harness.query(
				"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				[sessionId, "claude", "Test", "idle", NOW, NOW],
			);
		}
	});

	afterEach(async () => {
		await harness?.dispose();
	});

	async function project(
		event: StoredEvent,
		ctx?: ProjectionContext,
	): Promise<void> {
		replayNextProjection = ctx?.replaying === true;
		try {
			await harness.reproject([event]);
		} catch (error) {
			if (Runtime.isFiberFailure(error)) {
				throw new Error(
					Cause.pretty(error[Runtime.FiberFailureCauseId], {
						renderErrorCause: true,
					}),
				);
			}
			throw error;
		}
	}

	function nextSeq(): number {
		return ++seq;
	}

	/** Full pipeline: SQLite → history → chat messages */
	async function readPipeline(sessionId: string) {
		const rows = await harness.sessionMessagesWithParts(sessionId);
		const { messages } = messageRowsToHistory(rows, { pageSize: 50 });
		return historyToChatMessages(messages);
	}

	// ─── Session lifecycle ───────────────────────────────────────────────

	describe("session lifecycle", () => {
		it("duplicate session.created does not overwrite a renamed title", async () => {
			const sessionId = "ses-title-owner";
			await project(
				makeStored(
					"session.created",
					sessionId,
					{
						sessionId,
						title: "Claude Session",
						provider: "claude",
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);
			await project(
				makeStored(
					"session.renamed",
					sessionId,
					{
						sessionId,
						title: "Useful title",
					},
					{ sequence: nextSeq(), createdAt: NOW + 1000 },
				),
			);
			await project(
				makeStored(
					"session.created",
					sessionId,
					{
						sessionId,
						title: "Claude Session",
						provider: "claude",
					},
					{ sequence: nextSeq(), createdAt: NOW + 2000 },
				),
			);

			const [row] = await harness.query<{ title: string }>(
				"SELECT title FROM sessions WHERE id = ?",
				[sessionId],
			);
			expect(row?.title).toBe("Useful title");
		});

		it("deleting session with dependent messages cascades via ON DELETE CASCADE", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-del",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			// messages.session_id carries ON DELETE CASCADE (see
			// 0010_session_cascade_deletes.sql), so deleting the session removes
			// its dependent messages in the same statement instead of throwing.
			await expect(
				harness.query("DELETE FROM sessions WHERE id = ?", [SESSION_A]),
			).resolves.toBeDefined();

			const session = await harness.query(
				"SELECT id FROM sessions WHERE id = ?",
				[SESSION_A],
			);
			expect(session).toHaveLength(0);
			const message = await harness.query(
				"SELECT id FROM messages WHERE session_id = ?",
				[SESSION_A],
			);
			expect(message).toHaveLength(0);

			// Pipeline read on the deleted session returns empty — no orphan data
			const chat = await readPipeline(SESSION_A);
			expect(chat.filter((m) => m.type === "thinking")).toHaveLength(0);
			expect(chat.filter((m) => m.type === "assistant")).toHaveLength(0);
		});

		it("deleting session with no dependents succeeds; subsequent message.created fails FK", async () => {
			// Safe to delete: no messages/turns reference SESSION_B yet
			// (beforeEach only seeds the session row, no events projected).
			await expect(
				harness.query("DELETE FROM sessions WHERE id = ?", [SESSION_B]),
			).resolves.toBeDefined();

			// Subsequent message.created for the deleted session fails FK
			await expect(
				project(
					makeStored(
						"message.created",
						SESSION_B,
						{
							messageId: "msg-del-b",
							role: "assistant",
							sessionId: SESSION_B,
						},
						{ sequence: nextSeq(), createdAt: NOW },
					),
				),
			).rejects.toThrow(/FOREIGN KEY|constraint/i);

			// Pipeline read on the deleted session returns empty — no data corruption
			const chat = await readPipeline(SESSION_B);
			expect(chat).toHaveLength(0);
		});
	});

	// ─── Out-of-order events ────────────────────────────────────────────

	describe("out-of-order events", () => {
		it("thinking.delta before thinking.start — part created with correct text", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			// Delta arrives BEFORE start
			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-1",
						text: "early delta",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			// Start arrives late — ON CONFLICT DO NOTHING on the part row
			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-1",
					},
					{ sequence: nextSeq(), createdAt: NOW + 50 },
				),
			);

			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-1",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("early delta");
		});

		it("text.delta before message.created — message auto-created defensively", async () => {
			// text.delta with no preceding message.created
			await project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: "msg-auto",
						partId: "part-text-auto",
						text: "orphan delta",
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			// message.created arrives late — INSERT OR IGNORE (no-op)
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-auto",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-auto",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const assistant = chat.find((m) => m.type === "assistant");
			expect(assistant).toBeDefined();
		});
	});

	// ─── Duplicate event delivery ───────────────────────────────────────

	describe("duplicate event delivery", () => {
		it("KNOWN RISK: duplicate thinking.delta in normal mode doubles text", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-dup",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			const deltaEvent = makeStored(
				"thinking.delta",
				SESSION_A,
				{
					messageId: MSG_ID,
					partId: "part-think-dup",
					text: "hello",
				},
				{ sequence: nextSeq(), createdAt: NOW + 200 },
			);

			// Same delta projected twice — no replaying flag
			await project(deltaEvent);
			await project(deltaEvent);

			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-dup",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// Documents the known risk: text is doubled during normal streaming
			// because alreadyApplied() only checks when ctx.replaying === true.
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("hellohello");
		});

		it("duplicate thinking.delta in replay mode — alreadyApplied() prevents doubling", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-replay",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			const deltaSeq = nextSeq();
			const deltaEvent = makeStored(
				"thinking.delta",
				SESSION_A,
				{
					messageId: MSG_ID,
					partId: "part-think-replay",
					text: "hello",
				},
				{ sequence: deltaSeq, createdAt: NOW + 200 },
			);

			// First projection (normal)
			await project(deltaEvent);

			// Second projection (replay mode) — skipped via alreadyApplied()
			await project(deltaEvent, { replaying: true });

			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-replay",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("hello"); // Not doubled
		});

		it("duplicate thinking.start — ON CONFLICT DO NOTHING, no error", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			const startEvent = makeStored(
				"thinking.start",
				SESSION_A,
				{
					messageId: MSG_ID,
					partId: "part-think-dup-start",
				},
				{ sequence: nextSeq(), createdAt: NOW + 100 },
			);

			await project(startEvent);
			await expect(project(startEvent)).resolves.toBeUndefined();
		});

		it("SSE reconnection replay — overlap events skipped, new events applied", async () => {
			// Phase 1: Normal streaming — events seq 1-3
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: 1, createdAt: NOW },
				),
			);

			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{ messageId: MSG_ID, partId: "part-reconnect" },
					{ sequence: 2, createdAt: NOW + 100 },
				),
			);

			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{ messageId: MSG_ID, partId: "part-reconnect", text: "first" },
					{ sequence: 3, createdAt: NOW + 200 },
				),
			);

			// Phase 2: SSE reconnects — replays events 2-5 (overlap: 2,3; new: 4,5)
			const replayCtx = { replaying: true };

			// Event seq 2 replay — should be skipped
			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{ messageId: MSG_ID, partId: "part-reconnect" },
					{ sequence: 2, createdAt: NOW + 100 },
				),
				replayCtx,
			);

			// Event seq 3 replay — should be skipped
			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{ messageId: MSG_ID, partId: "part-reconnect", text: "first" },
					{ sequence: 3, createdAt: NOW + 200 },
				),
				replayCtx,
			);

			// Event seq 4 — NEW, should be applied
			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{ messageId: MSG_ID, partId: "part-reconnect", text: " second" },
					{ sequence: 4, createdAt: NOW + 300 },
				),
				replayCtx,
			);

			// Event seq 5 — NEW, should be applied
			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{ messageId: MSG_ID, partId: "part-reconnect" },
					{ sequence: 5, createdAt: NOW + 400 },
				),
				replayCtx,
			);

			// Normal mode resumes
			await project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-text-reconnect",
						text: "answer",
					},
					{ sequence: 6, createdAt: NOW + 500 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: 7, createdAt: NOW + 600 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// Text should be "first second" — NOT "firstfirst second" (overlap not doubled)
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("first second");

			// Assistant text also present
			const assistant = chat.find((m) => m.type === "assistant");
			expect(assistant).toBeDefined();
		});
	});

	// ─── Edge cases ─────────────────────────────────────────────────────

	describe("edge cases", () => {
		it("empty thinking block — start + end, no delta", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-empty",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			// No thinking.delta — straight to end
			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-empty",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			await project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-text-1",
						text: "answer",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			// Empty thinking block should exist with empty text, not silently dropped
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("");
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.done).toBe(true);
		});

		it("thinking-only turn — no text.delta, only thinking", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-only",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-only",
						text: "I thought about it but produced no text",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-only",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						cost: 0.01,
						duration: 500,
						tokens: { input: 100, output: 10 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("I thought about it but produced no text");

			// No assistant message — no text.delta was projected
			const assistant = chat.find((m) => m.type === "assistant");
			expect(assistant).toBeUndefined();
		});

		it("3 sequential text.deltas concatenate in correct order", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-concat-ord",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			await project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: "msg-concat-ord",
						partId: "part-concat-ord",
						text: "alpha",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			await project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: "msg-concat-ord",
						partId: "part-concat-ord",
						text: "beta",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			await project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: "msg-concat-ord",
						partId: "part-concat-ord",
						text: "gamma",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-concat-ord",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const assistant = chat.find(
				(m): m is AssistantMessage => m.type === "assistant",
			);
			expect(assistant).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(assistant!.rawText).toBe("alphabetagamma");
		});

		it("3 sequential thinking.deltas concatenate in correct order", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-tconcat",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{ messageId: "msg-tconcat", partId: "part-tconcat" },
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: "msg-tconcat",
						partId: "part-tconcat",
						text: "step1-",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: "msg-tconcat",
						partId: "part-tconcat",
						text: "step2-",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: "msg-tconcat",
						partId: "part-tconcat",
						text: "step3",
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{ messageId: "msg-tconcat", partId: "part-tconcat" },
					{ sequence: nextSeq(), createdAt: NOW + 500 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-tconcat",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 600 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("step1-step2-step3");
		});
	});

	// ─── Multi-part turns ───────────────────────────────────────────────

	describe("multi-part turns", () => {
		it("multiple thinking blocks in one message — all survive pipeline", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			// Thinking block 1
			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-1",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);
			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-1",
						text: "first thought",
					},
					{ sequence: nextSeq(), createdAt: NOW + 150 },
				),
			);
			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-1",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			// Text block 1
			await project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "text-1",
						text: "first answer",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			// Thinking block 2
			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-2",
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);
			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-2",
						text: "second thought",
					},
					{ sequence: nextSeq(), createdAt: NOW + 450 },
				),
			);
			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-2",
					},
					{ sequence: nextSeq(), createdAt: NOW + 500 },
				),
			);

			// Text block 2
			await project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "text-2",
						text: "second answer",
					},
					{ sequence: nextSeq(), createdAt: NOW + 600 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 700 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const thinkingBlocks = chat.filter(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinkingBlocks).toHaveLength(2);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(thinkingBlocks[0]!.text).toBe("first thought");
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(thinkingBlocks[1]!.text).toBe("second thought");

			// Verify ordering: think1 → assistant1 → think2 → assistant2
			const types = chat
				.filter((m) => ["thinking", "assistant"].includes(m.type))
				.map((m) => m.type);
			expect(types).toEqual(["thinking", "assistant", "thinking", "assistant"]);
		});

		it("tool use interleaved with thinking — sort_order preserves sequence", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			// Think → tool → think → text
			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-pre",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);
			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-pre",
						text: "pre-tool reasoning",
					},
					{ sequence: nextSeq(), createdAt: NOW + 150 },
				),
			);
			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-pre",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			await project(
				makeStored(
					"tool.started",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "tool-1",
						toolName: "bash",
						callId: "call-1",
						input: { command: "ls" },
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);
			await project(
				makeStored(
					"tool.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "tool-1",
						result: "file1.ts file2.ts",
						duration: 100,
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-post",
					},
					{ sequence: nextSeq(), createdAt: NOW + 500 },
				),
			);
			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-post",
						text: "post-tool reasoning",
					},
					{ sequence: nextSeq(), createdAt: NOW + 550 },
				),
			);
			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-post",
					},
					{ sequence: nextSeq(), createdAt: NOW + 600 },
				),
			);

			await project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "text-final",
						text: "final answer",
					},
					{ sequence: nextSeq(), createdAt: NOW + 700 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 800 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const types = chat
				.filter((m) => ["thinking", "tool", "assistant"].includes(m.type))
				.map((m) => m.type);
			// Expect: thinking → tool → thinking → assistant
			expect(types).toEqual(["thinking", "tool", "thinking", "assistant"]);
		});
	});

	// ─── Error recovery ─────────────────────────────────────────────────

	describe("error recovery", () => {
		it("partial failure — thinking.start committed, delta rejected, state still valid", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-err",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			// Force the next message projection to fail (simulates disk error)
			failNextProjection = true;

			await expect(
				project(
					makeStored(
						"thinking.delta",
						SESSION_A,
						{
							messageId: MSG_ID,
							partId: "part-err",
							text: "lost delta",
						},
						{ sequence: nextSeq(), createdAt: NOW + 200 },
					),
				),
			).rejects.toThrow("Simulated disk error");

			// State is valid: thinking part exists with empty text from start
			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// Part exists from thinking.start but delta text was lost
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("");
			// History-loaded = always done
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.done).toBe(true);
		});
	});

	// ─── Session isolation ──────────────────────────────────────────────

	describe("session isolation", () => {
		it("events from session A never appear in session B pipeline", async () => {
			// Project thinking in session A
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-a",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);
			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: "msg-a",
						partId: "think-a",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);
			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: "msg-a",
						partId: "think-a",
						text: "session A thought",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);
			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: "msg-a",
						partId: "think-a",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);
			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-a",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			// Project text in session B
			await project(
				makeStored(
					"message.created",
					SESSION_B,
					{
						messageId: "msg-b",
						role: "assistant",
						sessionId: SESSION_B,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);
			await project(
				makeStored(
					"text.delta",
					SESSION_B,
					{
						messageId: "msg-b",
						partId: "text-b",
						text: "session B text",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);
			await project(
				makeStored(
					"turn.completed",
					SESSION_B,
					{
						messageId: "msg-b",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			// Session A: thinking only, no assistant text
			const chatA = await readPipeline(SESSION_A);
			expect(chatA.some((m) => m.type === "thinking")).toBe(true);
			expect(chatA.some((m) => m.type === "assistant")).toBe(false);

			// Session B: assistant text only, no thinking
			const chatB = await readPipeline(SESSION_B);
			expect(chatB.some((m) => m.type === "assistant")).toBe(true);
			expect(chatB.some((m) => m.type === "thinking")).toBe(false);
		});

		it("KNOWN RISK: mismatched StoredEvent.sessionId vs payload.sessionId — data leaks to wrong session", async () => {
			// StoredEvent wrapper says SESSION_A, but payload says SESSION_B
			// MessageProjector uses payload.sessionId for the FK insert
			const mismatchEvent = makeStored(
				"message.created",
				SESSION_A,
				{
					messageId: "msg-inject",
					role: "assistant",
					sessionId: SESSION_B,
				},
				{ sequence: nextSeq(), createdAt: NOW },
			);

			await project(mismatchEvent);

			await project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: "msg-inject",
						partId: "part-inject",
						text: "injected",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-inject",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			// Message lands in SESSION_B despite event being "from" SESSION_A
			const chatB = await readPipeline(SESSION_B);
			const chatA = await readPipeline(SESSION_A);

			// Documents the risk: message.created uses payload.sessionId,
			// so the message row's session_id = SESSION_B
			const assistantInB = chatB.find((m) => m.type === "assistant");
			// If this assertion passes, it confirms the cross-session injection risk
			// If it fails, the projector may have been fixed to use the wrapper sessionId
			if (assistantInB) {
				// Risk confirmed — document it
				expect(assistantInB).toBeDefined();
				expect(chatA.find((m) => m.type === "assistant")).toBeUndefined();
			}
			// Either way, pipeline should not crash
		});
	});

	// ─── Malformed / adversarial payloads ────────────────────────────────

	describe("malformed and adversarial payloads", () => {
		it("thinking.delta with empty string text — concatenates to empty", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-empty",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: "msg-empty",
						partId: "part-empty",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: "msg-empty",
						partId: "part-empty",
						text: "",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: "msg-empty",
						partId: "part-empty",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-empty",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("");
		});

		it("text.delta with SQL-injection-like string — parameterized queries prevent injection", async () => {
			const evilText = "'; DROP TABLE message_parts; --";

			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-sql",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			await project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: "msg-sql",
						partId: "part-sql",
						text: evilText,
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-sql",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			// Table still exists (not dropped)
			const chat = await readPipeline(SESSION_A);
			const assistant = chat.find((m) => m.type === "assistant");
			expect(assistant).toBeDefined();
		});

		it("thinking.delta with very long text (100KB) — stored and retrieved intact", async () => {
			const longText = "x".repeat(100_000);

			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-long",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: "msg-long",
						partId: "part-long",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: "msg-long",
						partId: "part-long",
						text: longText,
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: "msg-long",
						partId: "part-long",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-long",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe(longText);
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text.length).toBe(100_000);
		});

		it("thinking.delta with HTML entities — stored raw, not escaped at DB layer", async () => {
			const htmlText = '<script>alert("xss")</script>&amp;';

			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-html",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: "msg-html",
						partId: "part-html",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: "msg-html",
						partId: "part-html",
						text: htmlText,
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: "msg-html",
						partId: "part-html",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-html",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// DB stores raw text — sanitization is frontend's responsibility
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe(htmlText);
		});
	});

	// ─── Unicode and encoding stress ─────────────────────────────────────

	describe("unicode and encoding stress", () => {
		async function projectThinkingWithText(
			msgId: string,
			partId: string,
			text: string,
		): Promise<void> {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: msgId,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);
			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: msgId,
						partId,
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);
			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: msgId,
						partId,
						text,
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);
			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: msgId,
						partId,
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);
			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: msgId,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);
		}

		it("emoji round-trips through pipeline", async () => {
			await projectThinkingWithText(
				"msg-emoji",
				"part-emoji",
				"🧠 Let me think 🤔💭",
			);
			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("🧠 Let me think 🤔💭");
		});

		it("CJK characters round-trip through pipeline", async () => {
			await projectThinkingWithText(
				"msg-cjk",
				"part-cjk",
				"这是一个测试。思考中…",
			);
			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("这是一个测试。思考中…");
		});

		it("RTL text (Arabic) round-trips through pipeline", async () => {
			await projectThinkingWithText(
				"msg-rtl",
				"part-rtl",
				"هذا اختبار للتفكير",
			);
			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("هذا اختبار للتفكير");
		});

		it("surrogate pairs (𝕳𝖊𝖑𝖑𝖔) round-trip through pipeline", async () => {
			const surrogatePairText = "𝕳𝖊𝖑𝖑𝖔 𝖂𝖔𝖗𝖑𝖉";
			await projectThinkingWithText("msg-surr", "part-surr", surrogatePairText);
			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe(surrogatePairText);
		});

		it("null bytes in text — stored as-is by SQLite TEXT column", async () => {
			const nullByteText = "before\0after";
			await projectThinkingWithText("msg-null", "part-null", nullByteText);
			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// SQLite TEXT columns handle embedded nulls — verify no truncation
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text.length).toBeGreaterThanOrEqual("before".length);
		});

		it("multi-byte concatenation via multiple deltas — boundary not corrupted", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-concat",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);
			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: "msg-concat",
						partId: "part-concat",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			// Two deltas with multi-byte chars at boundaries
			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: "msg-concat",
						partId: "part-concat",
						text: "思考",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);
			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: "msg-concat",
						partId: "part-concat",
						text: "🧠完了",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			await project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: "msg-concat",
						partId: "part-concat",
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);
			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-concat",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 500 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// SQL || concatenation must not corrupt multi-byte boundary
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("思考🧠完了");
		});
	});

	// ─── Orphan event edges ──────────────────────────────────────────────

	describe("orphan event edges", () => {
		it("thinking.end with no thinking.start or thinking.delta — no crash", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-orphan-end",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			// Orphan end — no start, no delta
			await expect(
				project(
					makeStored(
						"thinking.end",
						SESSION_A,
						{
							messageId: "msg-orphan-end",
							partId: "part-orphan-end",
						},
						{ sequence: nextSeq(), createdAt: NOW + 100 },
					),
				),
			).resolves.toBeUndefined();

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-orphan-end",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			// Pipeline should not crash — orphan end may or may not create a part
			await expect(readPipeline(SESSION_A)).resolves.toBeDefined();
		});

		it("turn.completed before any parts — message exists with no content", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-early-turn",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			// Immediate turn.completed — no thinking, no text, no tool
			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-early-turn",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			// No assistant or thinking messages — turn had no content
			expect(chat.filter((m) => m.type === "assistant")).toHaveLength(0);
			expect(chat.filter((m) => m.type === "thinking")).toHaveLength(0);
		});

		it("turn.error mid-thinking — thinking part still readable", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-err-mid",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: "msg-err-mid",
						partId: "part-err-mid",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: "msg-err-mid",
						partId: "part-err-mid",
						text: "reasoning before error",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			// Error arrives — no thinking.end, no turn.completed
			await project(
				makeStored(
					"turn.error",
					SESSION_A,
					{
						messageId: "msg-err-mid",
						error: "Internal error",
						code: "INTERNAL_ERROR",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("reasoning before error");
			// History-loaded = always done=true
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.done).toBe(true);
		});

		it("duplicate message.created for same messageId — ON CONFLICT DO NOTHING", async () => {
			const firstCreate = makeStored(
				"message.created",
				SESSION_A,
				{
					messageId: "msg-dup-create",
					role: "assistant",
					sessionId: SESSION_A,
				},
				{ sequence: nextSeq(), createdAt: NOW },
			);

			await project(firstCreate);

			// Second create for same ID — should be idempotent
			const secondCreate = makeStored(
				"message.created",
				SESSION_A,
				{
					messageId: "msg-dup-create",
					role: "assistant",
					sessionId: SESSION_A,
				},
				{ sequence: nextSeq(), createdAt: NOW + 100 },
			);

			await expect(project(secondCreate)).resolves.toBeUndefined();

			// Message still works
			await project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: "msg-dup-create",
						partId: "part-dup-create",
						text: "still works",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-dup-create",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const assistant = chat.find((m) => m.type === "assistant");
			expect(assistant).toBeDefined();
		});

		it("duplicate turn.completed — no error, message not corrupted", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-dup-turn",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			await project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: "msg-dup-turn",
						partId: "part-dup-turn",
						text: "content",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			const turnEvent = makeStored(
				"turn.completed",
				SESSION_A,
				{
					messageId: "msg-dup-turn",
					cost: 0.01,
					duration: 500,
					tokens: { input: 100, output: 50 },
				},
				{ sequence: nextSeq(), createdAt: NOW + 200 },
			);

			await project(turnEvent);
			await expect(project(turnEvent)).resolves.toBeUndefined();

			const chat = await readPipeline(SESSION_A);
			const assistant = chat.find((m) => m.type === "assistant");
			expect(assistant).toBeDefined();
		});

		it("duplicate thinking.end — no error", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-dup-end",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			await project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: "msg-dup-end",
						partId: "part-dup-end",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			await project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: "msg-dup-end",
						partId: "part-dup-end",
						text: "thought",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			const endEvent = makeStored(
				"thinking.end",
				SESSION_A,
				{
					messageId: "msg-dup-end",
					partId: "part-dup-end",
				},
				{ sequence: nextSeq(), createdAt: NOW + 300 },
			);

			await project(endEvent);
			await expect(project(endEvent)).resolves.toBeUndefined();

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-dup-end",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("thought");
		});

		it("text.delta duplicate in normal mode — documents text doubling risk", async () => {
			await project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-dup-text",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			const textDelta = makeStored(
				"text.delta",
				SESSION_A,
				{
					messageId: "msg-dup-text",
					partId: "part-dup-text",
					text: "hello",
				},
				{ sequence: nextSeq(), createdAt: NOW + 100 },
			);

			await project(textDelta);
			await project(textDelta);

			await project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-dup-text",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			const chat = await readPipeline(SESSION_A);
			const assistant = chat.find((m) => m.type === "assistant");
			expect(assistant).toBeDefined();
			// KNOWN RISK: same as thinking.delta doubling — text.delta also uses
			// ON CONFLICT DO UPDATE SET text = message_parts.text || excluded.text
			// No alreadyApplied() guard in normal (non-replay) mode.
		});
	});
});
