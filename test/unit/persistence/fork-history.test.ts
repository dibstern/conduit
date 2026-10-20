// Failure modes: hidden or removed cuts; stale timestamp ordering; an inherited
// message without its own creation event; selecting a first reply instead of the
// last reply of a completed turn; losing native transcript account provenance;
// changing OpenCode's intermediate-completion boundary semantics.
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import {
	readForkSource,
	readSideThreadForkBoundary,
} from "../../../src/lib/persistence/fork-history.js";

const history = [
	canonicalEvent(
		"session.created",
		"parent",
		{ sessionId: "parent", title: "Parent", provider: "claude" },
		{ createdAt: 100 },
	),
	canonicalEvent(
		"permission.asked",
		"parent",
		{ id: "permission", sessionId: "parent", toolName: "Read", input: {} },
		{ createdAt: 101 },
	),
	canonicalEvent(
		"message.created",
		"parent",
		{
			sessionId: "parent",
			messageId: "msg_user_1",
			role: "user",
			turnId: "turn_1",
		},
		{ createdAt: 102 },
	),
	canonicalEvent(
		"text.delta",
		"parent",
		{ messageId: "msg_user_1", partId: "prt_user_1", text: "Question" },
		{ createdAt: 103 },
	),
	canonicalEvent(
		"message.created",
		"parent",
		{ sessionId: "parent", messageId: "msg_assistant_1", role: "assistant" },
		{ createdAt: 104 },
	),
	canonicalEvent(
		"thinking.start",
		"parent",
		{ messageId: "msg_assistant_1", partId: "prt_thinking" },
		{ createdAt: 105 },
	),
	canonicalEvent(
		"thinking.delta",
		"parent",
		{ messageId: "msg_assistant_1", partId: "prt_thinking", text: "Think" },
		{ createdAt: 106 },
	),
	canonicalEvent(
		"thinking.end",
		"parent",
		{ messageId: "msg_assistant_1", partId: "prt_thinking" },
		{ createdAt: 107 },
	),
	canonicalEvent(
		"tool.started",
		"parent",
		{
			messageId: "msg_assistant_1",
			partId: "prt_tool",
			callId: "call_1",
			toolName: "Read",
			input: { tool: "Read", filePath: "/file" },
		},
		{ createdAt: 108 },
	),
	canonicalEvent(
		"tool.running",
		"parent",
		{ messageId: "msg_assistant_1", partId: "prt_tool", callId: "call_1" },
		{ createdAt: 109 },
	),
	canonicalEvent(
		"tool.completed",
		"parent",
		{
			messageId: "msg_assistant_1",
			partId: "prt_tool",
			result: "done",
			duration: 5,
		},
		{ createdAt: 110 },
	),
	canonicalEvent(
		"text.delta",
		"parent",
		{ messageId: "msg_assistant_1", partId: "prt_answer", text: "Answer" },
		{ createdAt: 111 },
	),
	canonicalEvent(
		"turn.completed",
		"parent",
		{ messageId: "msg_assistant_1" },
		{ createdAt: 112 },
	),
	canonicalEvent(
		"turn.model_resolved",
		"parent",
		{ actualModel: "claude-sonnet" },
		{ createdAt: 113 },
	),
	canonicalEvent(
		"message.created",
		"parent",
		{ sessionId: "parent", messageId: "msg_user_2", role: "user" },
		{ createdAt: 114 },
	),
	canonicalEvent(
		"message.created",
		"parent",
		{ sessionId: "parent", messageId: "msg_assistant_2", role: "assistant" },
		{ createdAt: 115 },
	),
	canonicalEvent(
		"text.delta",
		"parent",
		{ messageId: "msg_assistant_2", partId: "prt_answer_2", text: "Later" },
		{ createdAt: 116 },
	),
	canonicalEvent(
		"turn.completed",
		"parent",
		{ messageId: "msg_assistant_2" },
		{ createdAt: 117 },
	),
] as const satisfies readonly CanonicalEvent[];

const testLayer = makePersistenceEffectLayer(":memory:", "test-project");

const seed = (events: readonly CanonicalEvent[] = history) =>
	Effect.gen(function* () {
		const commit = yield* makeCommitAndSignal;
		if (!events.some((event) => event.type === "session.created"))
			yield* commit([
				canonicalEvent("session.created", "parent", {
					sessionId: "parent",
					title: "Parent",
					provider: "claude",
				}),
			]);
		yield* commit(events);
	});

describe("readForkSource", () => {
	// Failure modes: verdicts disappear, retain parent ids, extend an explicit
	// cutoff, attach to an uncopied part, arrive before text, or leak past the
	// source snapshot. Null probabilities and later verdict revisions must survive.
	it.effect(
		"inherits verdicts only for copied text at the source snapshot",
		() =>
			Effect.gen(function* () {
				yield* seed();
				const commit = yield* makeCommitAndSignal;
				const verdict = (messageId: string, partId: string, ordinal: number) =>
					canonicalEvent("text.surfaced", "parent", {
						messageId,
						partId,
						ordinal,
						categorySetVersion: 1,
						model: "jev-test",
						probabilities: { ask: 0.8, routine: 0.2 },
					});
				// Both verdicts land after the second turn. They must not widen a
				// fork at the first assistant message to include that second turn.
				yield* commit([
					verdict("msg_assistant_1", "prt_answer", 1),
					canonicalEvent("text.surfaced", "parent", {
						messageId: "msg_assistant_1",
						partId: "prt_answer",
						ordinal: 1,
						categorySetVersion: 2,
						model: "jev-revised",
						probabilities: null,
					}),
					verdict("msg_assistant_2", "prt_answer_2", 2),
					verdict("msg_assistant_1", "missing-part", 3),
				]);
				const source = yield* readForkSource("parent", {
					messageId: "msg_assistant_1",
					sideThread: false,
				});
				yield* commit([
					canonicalEvent("session.created", "child", {
						sessionId: "child",
						title: "Fork",
						provider: "claude",
						forkedFrom: "parent",
						inheritsHistory: true,
						forkPointMessageId: source.boundary.messageId,
						forkPointTimestamp: source.boundary.createdAt,
					}),
				]);
				// A verdict after the fork is the Source's alone.
				yield* commit([verdict("msg_assistant_1", "prt_answer", 99)]);
				const query = yield* ReadQueryEffectTag;
				const messages = yield* query.getSessionMessagesWithParts("child");
				expect(messages.map(({ id }) => id)).toEqual([
					"msg_user_1_child",
					"msg_assistant_1_child",
				]);
				expect(
					messages
						.flatMap(({ parts }) => parts)
						.find(({ id }) => id === "prt_answer_child"),
				).toMatchObject({
					surfacing_ordinal: 1,
					surfacing_probabilities: null,
					surfacing_set_version: 2,
					surfacing_model: "jev-revised",
				});
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"resolves an explicit cut without copying or decoding history",
		() =>
			Effect.gen(function* () {
				yield* seed();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE events SET data = json_set(data, '$.text', 42)
				WHERE type = 'text.delta'`;
				const source = yield* readForkSource("parent", {
					messageId: "msg_assistant_1",
					sideThread: false,
				});
				expect(source.boundary).toEqual({
					messageId: "msg_assistant_1",
					createdAt: 104,
					sequence: 5,
				});
				expect(source.historyMessageId).toBe("msg_assistant_1");
				expect(source).not.toHaveProperty("copy");
			}).pipe(Effect.provide(testLayer, { local: true })),
	);

	it.effect("uses the latest visible message when no cut is requested", () =>
		Effect.gen(function* () {
			yield* seed();
			const source = yield* readForkSource("parent", { sideThread: false });
			expect(source.boundary.messageId).toBe("msg_assistant_2");
			expect(source.historyMessageId).toBeUndefined();
		}).pipe(Effect.provide(testLayer, { local: true })),
	);

	it.effect(
		"rejects missing and removed points with the existing refusal",
		() =>
			Effect.gen(function* () {
				yield* seed();
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("message.removed", "parent", {
						messageId: "msg_assistant_1",
					}),
				]);
				for (const messageId of ["missing", "msg_assistant_1"]) {
					const result = yield* Effect.result(
						readForkSource("parent", { messageId, sideThread: false }),
					);
					expect(result._tag).toBe("Failure");
					if (result._tag === "Failure")
						expect(result.failure).toMatchObject({
							reason: "message_not_found",
							messageId,
						});
				}
			}).pipe(Effect.provide(testLayer, { local: true })),
	);

	it.effect(
		"rejects an empty transcript and a row without persisted provenance",
		() =>
			Effect.gen(function* () {
				yield* seed([history[0]]);
				const empty = yield* Effect.result(
					readForkSource("parent", { sideThread: false }),
				);
				expect(empty._tag).toBe("Failure");
				if (empty._tag === "Failure")
					expect(empty.failure).toMatchObject({ reason: "no_transcript" });
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO messages (id, session_id, role, created_at, updated_at)
				VALUES ('projected-only', 'parent', 'assistant', 1, 1)`;
				const missing = yield* Effect.result(
					readForkSource("parent", { sideThread: false }),
				);
				expect(missing._tag).toBe("Failure");
				if (missing._tag === "Failure")
					expect(missing.failure).toMatchObject({ reason: "point_not_found" });
			}).pipe(Effect.provide(testLayer, { local: true })),
	);

	it.effect(
		"resolves inherited read-model rows without copied message events",
		() =>
			Effect.gen(function* () {
				yield* seed([history[0]]);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO messages (id, session_id, role, is_inherited, last_applied_seq, created_at, updated_at)
				VALUES ('inherited', 'parent', 'assistant', 1, 1, 2, 2)`;
				const source = yield* readForkSource("parent", { sideThread: false });
				expect(source.boundary).toEqual({
					messageId: "inherited",
					createdAt: 2,
					sequence: 1,
				});
			}).pipe(Effect.provide(testLayer, { local: true })),
	);

	it.effect(
		"uses current timestamp and id ordering for pending rewind visibility",
		() =>
			Effect.gen(function* () {
				yield* seed([
					...["a", "b", "c"].map((messageId) =>
						canonicalEvent(
							"message.created",
							"parent",
							{ sessionId: "parent", messageId, role: "assistant" },
							{ createdAt: 10 },
						),
					),
					canonicalEvent("session.rewound", "parent", { messageId: "b" }),
				]);
				const pending = yield* readForkSource("parent", { sideThread: false });
				expect(pending.retained).toEqual([
					{ id: "a", role: "assistant", created_at: 10 },
				]);
				expect(pending.historyMessageId).toBe("a");
				const hidden = yield* Effect.result(
					readForkSource("parent", { messageId: "b", sideThread: false }),
				);
				expect(hidden._tag).toBe("Failure");
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE messages SET created_at = 20 WHERE id = 'b'`;
				const moved = yield* readForkSource("parent", { sideThread: false });
				expect(moved.retained.map(({ id }) => id)).toEqual(["a", "c"]);
				expect(moved.historyMessageId).toBe("c");
			}).pipe(Effect.provide(testLayer, { local: true })),
	);

	it.effect(
		"preserves committed rewind and native transcript account provenance",
		() =>
			Effect.gen(function* () {
				yield* seed();
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.provider_changed", "parent", {
						sessionId: "parent",
						oldProvider: "claude",
						newProvider: "claude-sdk",
					}),
					canonicalEvent("session.provider_changed", "parent", {
						sessionId: "parent",
						oldProvider: "claude-sdk",
						newProvider: "claude-work",
					}),
					canonicalEvent("message.removed", "parent", {
						messageId: "msg_user_2",
					}),
					canonicalEvent("message.removed", "parent", {
						messageId: "msg_assistant_2",
					}),
					canonicalEvent("session.rewind_committed", "parent", {
						messageId: "msg_user_2",
					}),
				]);
				const source = yield* readForkSource("parent", { sideThread: false });
				const sql = yield* SqlClient.SqlClient;
				const [rewind] = yield* sql<{
					sequence: number;
				}>`SELECT sequence FROM events WHERE type = 'session.rewind_committed'`;
				expect(source.lastRewindCommitSequence).toBe(rewind?.sequence);
				expect(source.historyMessageId).toBe("msg_assistant_1");
				expect([...source.instanceIds]).toEqual([
					"claude-work",
					"claude",
					"claude-sdk",
				]);
			}).pipe(Effect.provide(testLayer, { local: true })),
	);
});

describe("Side Thread boundaries", () => {
	it.effect("cuts at the last visible reply in the last completed turn", () =>
		Effect.gen(function* () {
			yield* seed(history.slice(0, 13));
			const commit = yield* makeCommitAndSignal;
			yield* commit([
				canonicalEvent(
					"message.created",
					"parent",
					{ sessionId: "parent", messageId: "last-reply", role: "assistant" },
					{ createdAt: 113 },
				),
				canonicalEvent(
					"turn.completed",
					"parent",
					{ messageId: "last-reply" },
					{ createdAt: 114 },
				),
				canonicalEvent(
					"session.status",
					"parent",
					{ sessionId: "parent", status: "idle" },
					{ createdAt: 115 },
				),
				canonicalEvent(
					"message.created",
					"parent",
					{ sessionId: "parent", messageId: "running-prompt", role: "user" },
					{ createdAt: 116 },
				),
				canonicalEvent(
					"message.created",
					"parent",
					{
						sessionId: "parent",
						messageId: "running-reply",
						role: "assistant",
					},
					{ createdAt: 117 },
				),
				canonicalEvent(
					"session.status",
					"parent",
					{ sessionId: "parent", status: "busy" },
					{ createdAt: 118 },
				),
			]);
			const source = yield* readForkSource("parent", { sideThread: true });
			expect(source.boundary.messageId).toBe("last-reply");
			expect(source.historyMessageId).toBe("last-reply");
		}).pipe(Effect.provide(testLayer, { local: true })),
	);

	it.effect("refuses an idle Source with no completed turn", () =>
		Effect.gen(function* () {
			yield* seed([history[0], history[2], history[4]]);
			const result = yield* Effect.result(
				readForkSource("parent", { sideThread: true }),
			);
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure")
				expect(result.failure).toMatchObject({ reason: "no_completed_turn" });
		}).pipe(Effect.provide(testLayer, { local: true })),
	);

	it.effect("preserves OpenCode intermediate completions and idle cuts", () =>
		Effect.gen(function* () {
			yield* seed([
				...history.slice(0, 14),
				canonicalEvent("session.status", "parent", {
					sessionId: "parent",
					status: "idle",
				}),
				history[14],
				canonicalEvent("session.status", "parent", {
					sessionId: "parent",
					status: "busy",
				}),
				history[15],
				history[17],
			]);
			expect(yield* readSideThreadForkBoundary("parent")).toBe(
				"msg_assistant_1",
			);
			const commit = yield* makeCommitAndSignal;
			yield* commit([
				canonicalEvent("session.status", "parent", {
					sessionId: "parent",
					status: "idle",
				}),
			]);
			expect(yield* readSideThreadForkBoundary("parent")).toBeUndefined();
		}).pipe(Effect.provide(testLayer, { local: true })),
	);
});
