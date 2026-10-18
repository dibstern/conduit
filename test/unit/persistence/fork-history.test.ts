// Failure modes: confusing a message's creation with its last event; inheriting a
// queued prompt; extending a cut across an omitted parent event; treating global
// sequence gaps as parent gaps; copying removed or pending-rewind messages;
// selecting an incomplete OpenCode step; decoding transcript bodies to validate.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import {
	readForkSource,
	readSideThreadForkBoundary,
} from "../../../src/lib/persistence/fork-history.js";
import { seedSessionLoadFixture } from "../../fixtures/session-load.js";

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
	it.effect(
		"copies a whole turn through tool work and trailing turn events",
		() =>
			Effect.gen(function* () {
				yield* seed();
				const source = yield* readForkSource("parent", {
					messageId: "msg_assistant_1",
					sideThread: false,
				});
				const events = yield* source.copy("ses_fork_a");
				expect(source.boundary).toEqual({
					messageId: "msg_assistant_1",
					createdAt: 104,
					sequence: 5,
				});
				expect(events.map((event) => event.type)).toEqual([
					"message.created",
					"text.delta",
					"message.created",
					"thinking.start",
					"thinking.delta",
					"thinking.end",
					"tool.started",
					"tool.running",
					"tool.completed",
					"text.delta",
					"turn.completed",
					"turn.model_resolved",
				]);
				expect(events.every((event) => event.createdAt < 114)).toBe(true);
				expect(events.every((event) => event.sessionId === "ses_fork_a")).toBe(
					true,
				);
				expect(
					events.find((event) => event.type === "tool.started")?.data,
				).toMatchObject({
					messageId: "msg_assistant_1_ses_fork_a",
					partId: "prt_tool_ses_fork_a",
					callId: "call_1_ses_fork_a",
					toolName: "Read",
				});
				expect(
					events.find((event) => event.type === "tool.running")?.data,
				).toMatchObject({
					callId: "call_1_ses_fork_a",
				});
				expect(events[0]?.data).toMatchObject({
					sessionId: "ses_fork_a",
					turnId: "turn_1_ses_fork_a",
				});
				expect(events[0]?.createdAt).toBe(102);
				expect(events[0]?.eventId).toBe(`${history[2].eventId}_ses_fork_a`);
				expect(events[0]).not.toHaveProperty("sequence");
				expect(events[0]).not.toHaveProperty("streamVersion");
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect("refuses an unknown point without copying", () =>
		Effect.gen(function* () {
			yield* seed();
			const result = yield* Effect.result(
				readForkSource("parent", {
					messageId: "missing",
					sideThread: false,
				}),
			);
			expect(result._tag).toBe("Left");
			if (result._tag === "Failure")
				expect(result.failure).toMatchObject({
					_tag: "ForkRefusal",
					reason: "message_not_found",
					messageId: "missing",
				});
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"refuses an empty transcript and a projected point without a creation event",
		() =>
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				yield* commit([history[0]]);
				const empty = yield* Effect.result(
					readForkSource("parent", { sideThread: false }),
				);
				expect(empty._tag).toBe("Left");
				if (empty._tag === "Failure")
					expect(empty.failure).toMatchObject({ reason: "no_transcript" });
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO messages (id, session_id, role, created_at, updated_at)
				VALUES ('projected-only', 'parent', 'assistant', 1, 1)`;
				const missing = yield* Effect.result(
					readForkSource("parent", { sideThread: false }),
				);
				expect(missing._tag).toBe("Left");
				if (missing._tag === "Failure")
					expect(missing.failure).toMatchObject({ reason: "point_not_found" });
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"copies all message history without a cut and keeps fork ids disjoint",
		() =>
			Effect.gen(function* () {
				yield* seed();
				const source = yield* readForkSource("parent", { sideThread: false });
				expect(source.historyMessageId).toBeUndefined();
				expect(source.boundary.messageId).toBe("msg_assistant_2");
				const first = yield* source.copy("ses_fork_a");
				const second = yield* source.copy("ses_fork_b");
				expect(first).toHaveLength(history.length - 2);
				expect(first.map((event) => event.type)).not.toContain(
					"session.created",
				);
				expect(first.map((event) => event.type)).not.toContain(
					"permission.asked",
				);
				expect(new Set(first.map((event) => event.eventId)).size).toBe(
					first.length,
				);
				expect(
					first.some((event) =>
						second.some((other) => event.eventId === other.eventId),
					),
				).toBe(false);
				const copiedIds = (events: readonly CanonicalEvent[]) =>
					events.flatMap((event) => {
						const data = event.data;
						return [
							"messageId" in data ? data.messageId : undefined,
							"partId" in data ? data.partId : undefined,
							"callId" in data ? data.callId : undefined,
						].filter((id): id is string => typeof id === "string");
					});
				const secondIds = new Set(copiedIds(second));
				expect(copiedIds(first).some((id) => secondIds.has(id))).toBe(false);
				expect(first.map((event) => event.createdAt)).toEqual(
					history.slice(2).map((event) => event.createdAt),
				);
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect("excludes a prompt queued before the target's last event", () =>
		Effect.gen(function* () {
			yield* seed([
				canonicalEvent(
					"message.created",
					"parent",
					{ sessionId: "parent", messageId: "msg_a", role: "assistant" },
					{ createdAt: 1 },
				),
				canonicalEvent(
					"message.created",
					"parent",
					{ sessionId: "parent", messageId: "msg_queued", role: "user" },
					{ createdAt: 2 },
				),
				canonicalEvent(
					"text.delta",
					"parent",
					{ messageId: "msg_queued", partId: "prt_q", text: "Next" },
					{ createdAt: 3 },
				),
				canonicalEvent(
					"text.delta",
					"parent",
					{ messageId: "msg_a", partId: "prt_a", text: "Done" },
					{ createdAt: 4 },
				),
				canonicalEvent(
					"turn.completed",
					"parent",
					{ messageId: "msg_a" },
					{ createdAt: 5 },
				),
			]);
			const source = yield* readForkSource("parent", {
				messageId: "msg_a",
				sideThread: false,
			});
			expect(
				(yield* source.copy("ses_fork")).map((event) =>
					"messageId" in event.data ? event.data.messageId : undefined,
				),
			).toEqual(["msg_a_ses_fork", "msg_a_ses_fork", "msg_a_ses_fork"]);
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("keeps completed compactions before the cut", () =>
		Effect.gen(function* () {
			yield* seed([
				canonicalEvent(
					"session.compaction",
					"parent",
					{
						sessionId: "parent",
						state: "completed",
						detail: "auto",
						preTokens: 900,
						postTokens: 100,
					},
					{ createdAt: 1 },
				),
				canonicalEvent(
					"message.created",
					"parent",
					{ sessionId: "parent", messageId: "msg_a", role: "assistant" },
					{ createdAt: 2 },
				),
			]);
			const source = yield* readForkSource("parent", {
				messageId: "msg_a",
				sideThread: false,
			});
			expect((yield* source.copy("ses_fork"))[0]).toMatchObject({
				type: "session.compaction",
				sessionId: "ses_fork",
				data: { sessionId: "ses_fork", preTokens: 900, postTokens: 100 },
			});
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"extends over parent turn events across other sessions but stops at an omitted parent event",
		() =>
			Effect.gen(function* () {
				yield* seed([
					history[0],
					canonicalEvent(
						"message.created",
						"parent",
						{ sessionId: "parent", messageId: "target", role: "assistant" },
						{ createdAt: 1 },
					),
					canonicalEvent(
						"text.delta",
						"parent",
						{ messageId: "target", partId: "part", text: "Done" },
						{ createdAt: 2 },
					),
					canonicalEvent("session.created", "other", {
						sessionId: "other",
						title: "Other",
						provider: "opencode",
					}),
					canonicalEvent("turn.model_resolved", "parent", {
						actualModel: "adjacent",
					}),
					canonicalEvent("permission.asked", "parent", {
						id: "permission",
						sessionId: "parent",
						toolName: "Read",
						input: {},
					}),
					canonicalEvent("turn.model_resolved", "parent", {
						actualModel: "past-break",
					}),
				]);
				const source = yield* readForkSource("parent", {
					messageId: "target",
					sideThread: false,
				});
				expect(
					(yield* source.copy("child")).map((event) => event.type),
				).toEqual(["message.created", "text.delta", "turn.model_resolved"]);
				expect((yield* source.copy("child")).at(-1)?.data).toEqual({
					actualModel: "adjacent",
				});
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"uses the first event with the target id to decide which messages were already present",
		() =>
			Effect.gen(function* () {
				yield* seed([
					canonicalEvent(
						"turn.completed",
						"parent",
						{ messageId: "target" },
						{ createdAt: 1 },
					),
					canonicalEvent(
						"message.created",
						"parent",
						{ sessionId: "parent", messageId: "queued", role: "user" },
						{ createdAt: 2 },
					),
					canonicalEvent(
						"message.created",
						"parent",
						{ sessionId: "parent", messageId: "target", role: "assistant" },
						{ createdAt: 3 },
					),
					canonicalEvent(
						"text.delta",
						"parent",
						{ messageId: "target", partId: "part", text: "Done" },
						{ createdAt: 4 },
					),
				]);
				const source = yield* readForkSource("parent", {
					messageId: "target",
					sideThread: false,
				});
				expect(
					(yield* source.copy("child")).map((event) => event.type),
				).toEqual(["turn.completed", "message.created", "text.delta"]);
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"coalesces streamed fragments while retaining the first envelope",
		() =>
			Effect.gen(function* () {
				yield* seed([
					canonicalEvent("message.created", "parent", {
						sessionId: "parent",
						messageId: "target",
						role: "assistant",
					}),
					canonicalEvent(
						"text.delta",
						"parent",
						{ messageId: "target", partId: "text", text: "A" },
						{ createdAt: 10, metadata: { source: "first" } },
					),
					canonicalEvent(
						"text.delta",
						"parent",
						{ messageId: "target", partId: "text", text: "B" },
						{ createdAt: 20, metadata: { source: "second" } },
					),
					canonicalEvent("thinking.delta", "parent", {
						messageId: "target",
						partId: "thinking",
						text: "C",
					}),
					canonicalEvent("thinking.delta", "parent", {
						messageId: "target",
						partId: "thinking",
						text: "D",
					}),
				]);
				const source = yield* readForkSource("parent", { sideThread: false });
				const events = yield* source.copy("child");
				expect(events.map((event) => event.type)).toEqual([
					"message.created",
					"text.delta",
					"thinking.delta",
				]);
				expect(events[1]).toMatchObject({
					createdAt: 10,
					metadata: { source: "first" },
					data: { text: "AB" },
				});
				expect(events[2]?.data).toMatchObject({ text: "CD" });
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"filters removals even when they occur after the cut and refuses a removed target",
		() =>
			Effect.gen(function* () {
				yield* seed();
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("message.removed", "parent", {
						messageId: "msg_user_1",
					}),
				]);
				const source = yield* readForkSource("parent", {
					messageId: "msg_assistant_1",
					sideThread: false,
				});
				expect(
					(yield* source.copy("child")).some(
						(event) =>
							"messageId" in event.data &&
							event.data.messageId === "msg_user_1_child",
					),
				).toBe(false);
				yield* commit([
					canonicalEvent("message.removed", "parent", {
						messageId: "msg_assistant_1",
					}),
				]);
				const removed = yield* Effect.result(
					readForkSource("parent", {
						messageId: "msg_assistant_1",
						sideThread: false,
					}),
				);
				expect(removed._tag).toBe("Left");
				if (removed._tag === "Failure")
					expect(removed.failure).toMatchObject({ reason: "message_not_found" });
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"retains current timestamp and id ordering during a pending rewind",
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
				expect(hidden._tag).toBe("Left");
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE messages SET created_at = 20 WHERE id = 'b'`;
				const moved = yield* readForkSource("parent", { sideThread: false });
				expect(moved.retained.map((message) => message.id)).toEqual(["a", "c"]);
				expect(moved.historyMessageId).toBe("c");
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"bounds a committed rewind by the last kept message and reports its commit sequence",
		() =>
			Effect.gen(function* () {
				yield* seed();
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.rewound", "parent", {
						messageId: "msg_user_2",
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
				const cut = yield* sql<{ sequence: number }>`SELECT sequence FROM events
				WHERE session_id = 'parent' AND type = 'session.rewind_committed'`;
				expect(source.lastRewindCommitSequence).toBe(cut[0]?.sequence);
				expect(source.historyMessageId).toBe("msg_assistant_1");
				expect(
					(yield* source.copy("child"))
						.filter((event) => event.type === "message.created")
						.map((event) => event.data.messageId),
				).toEqual(["msg_user_1_child", "msg_assistant_1_child"]);
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"keeps every provider instance in current-first event order, including switches after the point",
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
				]);
				const source = yield* readForkSource("parent", {
					messageId: "msg_assistant_1",
					sideThread: false,
				});
				expect([...source.instanceIds]).toEqual([
					"claude-work",
					"claude",
					"claude-sdk",
				]);
				expect(source.boundary.sequence).toBe(5);
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"reads no content during validation and decodes only the bounded copy",
		() =>
			Effect.gen(function* () {
				yield* seed();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE events SET data = json_set(data, '$.text', 42)
				WHERE type = 'text.delta' AND json_extract(data, '$.messageId') = 'msg_assistant_2'`;
				const source = yield* readForkSource("parent", {
					messageId: "msg_assistant_1",
					sideThread: false,
				});
				expect((yield* source.copy("child")).length).toBeGreaterThan(0);
				const later = yield* readForkSource("parent", {
					messageId: "msg_assistant_2",
					sideThread: false,
				});
				const invalid = yield* Effect.result(later.copy("child"));
				expect(invalid._tag).toBe("Left");
			}).pipe(Effect.provide(testLayer)),
	);

	it("copies a bounded prefix of the heavy session-load fixture", async () => {
		const directory = mkdtempSync(join(tmpdir(), "conduit-fork-source-"));
		const filename = join(directory, "events.db");
		try {
			const fixture = await seedSessionLoadFixture(filename, {
				families: 0,
				heavyTurns: 2,
			});
			await Effect.runPromise(
				Effect.gen(function* () {
					const all = yield* readForkSource(fixture.heavySessionId, {
						sideThread: false,
					});
					const first = all.retained.find(
						(message) => message.role === "assistant",
					);
					if (!first)
						return yield* Effect.fail(
							new Error("Heavy fixture has no assistant message"),
						);
					const source = yield* readForkSource(fixture.heavySessionId, {
						messageId: first.id,
						sideThread: false,
					});
					const events = yield* source.copy("heavy-child");
					expect(
						events.filter((event) => event.type === "message.created"),
					).toHaveLength(2);
					const read = events.find(
						(event) =>
							event.type === "tool.completed" &&
							event.data.partId.endsWith("-Read_heavy-child"),
					);
					expect(
						read?.type === "tool.completed" &&
							typeof read.data.result === "string"
							? read.data.result.length
							: 0,
					).toBe(32_000);
				}).pipe(
					Effect.provide(makePersistenceEffectLayer(filename, "test-project")),
				),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("Side Thread boundary reads", () => {
	it.effect(
		"cuts a busy parent at the final message of its last idle turn",
		() =>
			Effect.gen(function* () {
				yield* seed([
					...history.slice(0, 14),
					canonicalEvent("session.status", "parent", {
						sessionId: "parent",
						status: "idle",
					}),
					...history.slice(14),
					canonicalEvent("session.status", "parent", {
						sessionId: "parent",
						status: "busy",
					}),
				]);
				expect(yield* readSideThreadForkBoundary("parent")).toBe(
					"msg_assistant_1",
				);
				const source = yield* readForkSource("parent", { sideThread: true });
				expect(source.historyMessageId).toBe("msg_assistant_1");
				expect(source.boundary.messageId).toBe("msg_assistant_1");
				expect(
					(yield* source.copy("child"))
						.filter((event) => event.type === "message.created")
						.map((event) => event.data.messageId),
				).toEqual(["msg_user_1_child", "msg_assistant_1_child"]);
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.status", "parent", {
						sessionId: "parent",
						status: "idle",
					}),
				]);
				const idle = yield* readForkSource("parent", { sideThread: true });
				expect(idle.historyMessageId).toBeUndefined();
				expect(idle.boundary.messageId).toBe("msg_assistant_2");
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"detects a queued prompt before busy without treating intermediate OpenCode completions as idle",
		() =>
			Effect.gen(function* () {
				yield* seed([
					...history.slice(0, 14),
					canonicalEvent("session.status", "parent", {
						sessionId: "parent",
						status: "idle",
					}),
					history[14],
				]);
				const queued = yield* readForkSource("parent", { sideThread: true });
				expect(queued.historyMessageId).toBe("msg_assistant_1");
				const commit = yield* makeCommitAndSignal;
				yield* commit([
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
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"refuses a first turn in flight and leaves an empty idle OpenCode parent uncut",
		() =>
			Effect.gen(function* () {
				yield* seed([
					history[0],
					history[2],
					history[4],
					history[12],
					canonicalEvent("session.status", "parent", {
						sessionId: "parent",
						status: "busy",
					}),
				]);
				const first = yield* Effect.result(
					readForkSource("parent", { sideThread: true }),
				);
				expect(first._tag).toBe("Left");
				if (first._tag === "Failure")
					expect(first.failure).toMatchObject({ reason: "no_completed_turn" });
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "empty", {
						sessionId: "empty",
						title: "Empty",
						provider: "opencode",
					}),
					canonicalEvent("session.status", "empty", {
						sessionId: "empty",
						status: "idle",
					}),
				]);
				expect(yield* readSideThreadForkBoundary("empty")).toBeUndefined();
			}).pipe(Effect.provide(testLayer)),
	);
});
