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
import { ProviderStateEffectTag } from "../../../src/lib/persistence/effect/provider-state-effect.js";
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
	it.effect("copies Cursor history without inheriting its native agent", () =>
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const state = yield* ProviderStateEffectTag;
			const options = {
				provider: "cursor",
				metadata: {
					runId: "run",
					nativeDirectory: "/parent",
					providerRefs: { providerSessionId: "parent-agent" },
				},
			};
			yield* seed([
				canonicalEvent("session.created", "parent", {
					sessionId: "parent",
					provider: "cursor",
					title: "Parent",
				}),
				canonicalEvent(
					"run.requested",
					"parent",
					{ runId: "run", inputId: "input" },
					options,
				),
				canonicalEvent(
					"message.created",
					"parent",
					{
						sessionId: "parent",
						messageId: "input",
						role: "user",
						inputId: "input",
					},
					options,
				),
				canonicalEvent(
					"run.started",
					"parent",
					{ inputId: "input", requestedRunId: "run" },
					options,
				),
				canonicalEvent(
					"message.created",
					"parent",
					{
						sessionId: "parent",
						messageId: "reply",
						role: "assistant",
						parentID: "input",
					},
					options,
				),
				canonicalEvent(
					"turn.completed",
					"parent",
					{
						messageId: "reply",
						cost: 1.25,
						tokens: { input: 10, output: 20 },
						providerSessionId: "parent-agent",
						providerStateUpdates: [
							{ key: "cursor.agentId", value: "parent-agent" },
							{ key: "cursor.cwd", value: "/parent" },
						],
					},
					options,
				),
			]);
			expect(yield* state.getState("parent")).toMatchObject({
				"cursor.agentId": "parent-agent",
			});
			const source = yield* readForkSource("parent", { sideThread: false });
			yield* commit([
				canonicalEvent("session.created", "fork", {
					sessionId: "fork",
					provider: "cursor",
					title: "Fork",
					forkedFrom: "parent",
					inheritsHistory: true,
					forkPointMessageId: source.boundary.messageId,
					forkPointTimestamp: source.boundary.createdAt,
				}),
			]);
			// This is the state the first Cursor send uses to choose resumeAgent.
			expect(yield* state.getState("fork")).toEqual({});
			const query = yield* ReadQueryEffectTag;
			expect((yield* query.getSessionMessagesWithParts("fork")).length).toBe(2);
			const sql = yield* SqlClient.SqlClient;
			expect(
				yield* sql`SELECT state, cost, tokens_in, tokens_out FROM turns WHERE session_id = 'fork'`,
			).toEqual([
				{ state: "completed", cost: 1.25, tokens_in: 10, tokens_out: 20 },
			]);
			const fresh = { provider: "cursor", metadata: { runId: "fresh" } };
			yield* commit([
				canonicalEvent(
					"run.requested",
					"fork",
					{ runId: "fresh", inputId: "fresh" },
					fresh,
				),
				canonicalEvent(
					"message.created",
					"fork",
					{
						sessionId: "fork",
						messageId: "fresh",
						role: "user",
						inputId: "fresh",
					},
					fresh,
				),
				canonicalEvent(
					"run.started",
					"fork",
					{ inputId: "fresh", requestedRunId: "fresh" },
					fresh,
				),
				canonicalEvent(
					"turn.completed",
					"fork",
					{
						messageId: "fresh",
						providerStateUpdates: [
							{ key: "cursor.agentId", value: "fork-agent" },
						],
					},
					fresh,
				),
			]);
			expect(yield* state.getState("fork")).toEqual({
				"cursor.agentId": "fork-agent",
			});
		}).pipe(Effect.provide(testLayer, { local: true })),
	);

	it.effect(
		"copies an owned pre-intake failure with no assistant message",
		() =>
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				const sql = yield* SqlClient.SqlClient;
				const options = { provider: "claude", metadata: { runId: "run" } };
				yield* seed([
					canonicalEvent(
						"run.requested",
						"parent",
						{ runId: "run", inputId: "input" },
						options,
					),
					canonicalEvent(
						"message.created",
						"parent",
						{
							sessionId: "parent",
							messageId: "input",
							role: "user",
							inputId: "input",
						},
						options,
					),
					canonicalEvent(
						"turn.error",
						"parent",
						{ messageId: "", error: "iterator failed before intake" },
						options,
					),
				]);
				const source = yield* readForkSource("parent", {
					messageId: "input",
					sideThread: false,
				});
				yield* commit([
					canonicalEvent("session.created", "fork", {
						sessionId: "fork",
						provider: "claude",
						title: "Fork",
						forkedFrom: "parent",
						inheritsHistory: true,
						forkPointMessageId: source.boundary.messageId,
						forkPointTimestamp: source.boundary.createdAt,
					}),
				]);
				expect(
					yield* sql`SELECT state, started_at FROM turns WHERE session_id = 'fork'`,
				).toEqual([{ state: "error", started_at: null }]);
				expect(
					yield* sql`SELECT status FROM provider_runs WHERE session_id = 'fork'`,
				).toEqual([]);
			}).pipe(Effect.provide(testLayer, { local: true })),
	);

	it.effect(
		"does not inherit execution when a fork cuts inside an open run",
		() =>
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				const sql = yield* SqlClient.SqlClient;
				const options = {
					provider: "claude",
					metadata: { runId: "open" },
					createdAt: 1,
				};
				yield* seed([
					canonicalEvent(
						"run.requested",
						"parent",
						{ runId: "open", inputId: "input" },
						options,
					),
					canonicalEvent(
						"message.created",
						"parent",
						{ sessionId: "parent", messageId: "input", role: "user" },
						options,
					),
					canonicalEvent(
						"run.started",
						"parent",
						{ requestedRunId: "open", inputId: "input" },
						options,
					),
					canonicalEvent(
						"message.created",
						"parent",
						{ sessionId: "parent", messageId: "answer", role: "assistant" },
						{ ...options, createdAt: 2 },
					),
				]);
				const source = yield* readForkSource("parent", {
					messageId: "answer",
					sideThread: false,
				});
				yield* commit([
					canonicalEvent("session.created", "fork", {
						sessionId: "fork",
						title: "Fork",
						provider: "claude",
						forkedFrom: "parent",
						inheritsHistory: true,
						forkPointMessageId: source.boundary.messageId,
						forkPointTimestamp: source.boundary.createdAt,
					}),
				]);
				expect(
					yield* sql`SELECT id FROM provider_runs WHERE session_id = 'fork'`,
				).toEqual([]);
				expect(
					yield* sql`SELECT run_id FROM turns WHERE session_id = 'fork'`,
				).toEqual([{ run_id: null }]);
			}).pipe(Effect.provide(testLayer, { local: true })),
	);

	// A fork preserves final turn facts and acceptance without copying execution.
	// Joined inputs remain closed history and do not inherit live reservations.
	for (const [provider, terminal, state] of [
		["claude", "turn.completed", "completed"],
		["claude", "turn.error", "error"],
		["claude", "turn.interrupted", "interrupted"],
		["opencode", "session.status", "completed"],
	] as const) {
		it.effect(
			`copies ${provider} ${state} turn states without execution and permits fresh fork work`,
			() =>
				Effect.gen(function* () {
					const commit = yield* makeCommitAndSignal;
					const sql = yield* SqlClient.SqlClient;
					const options = (runId: string, createdAt: number) => ({
						provider,
						metadata: { runId },
						createdAt,
					});
					yield* seed([
						canonicalEvent(
							"run.requested",
							"parent",
							{ runId: "a", inputId: "a" },
							options("a", 1),
						),
						canonicalEvent(
							"message.created",
							"parent",
							{
								sessionId: "parent",
								messageId: "a",
								role: "user",
								inputId: "a",
							},
							options("a", 2),
						),
						canonicalEvent(
							"run.started",
							"parent",
							{ inputId: "a", requestedRunId: "a" },
							options("a", 3),
						),
						canonicalEvent(
							"run.requested",
							"parent",
							{ runId: "b", inputId: "b" },
							options("b", 4),
						),
						canonicalEvent(
							"message.created",
							"parent",
							{
								sessionId: "parent",
								messageId: "b",
								role: "user",
								inputId: "b",
							},
							options("b", 5),
						),
						canonicalEvent(
							"run.started",
							"parent",
							{ inputId: "b", requestedRunId: "b" },
							options("a", 6),
						),
						canonicalEvent(
							"run.requested",
							"parent",
							{ runId: "unplaced", inputId: "unplaced" },
							options("unplaced", 7),
						),
						canonicalEvent(
							"message.created",
							"parent",
							{ sessionId: "parent", messageId: "answer", role: "assistant" },
							options("a", 8),
						),
						...(terminal === "session.status"
							? [
									canonicalEvent(
										terminal,
										"parent",
										{ sessionId: "parent", status: "idle" },
										options("a", 9),
									),
								]
							: terminal === "turn.error"
								? [
										canonicalEvent(
											terminal,
											"parent",
											{ messageId: "answer", error: "failed" },
											options("a", 9),
										),
									]
								: [
										canonicalEvent(
											terminal,
											"parent",
											{ messageId: "answer" },
											options("a", 9),
										),
									]),
					]);
					const source = yield* readForkSource("parent", {
						messageId: "answer",
						sideThread: false,
					});
					yield* commit([
						canonicalEvent("session.created", "fork", {
							sessionId: "fork",
							provider,
							title: "Fork",
							forkedFrom: "parent",
							inheritsHistory: true,
							forkPointMessageId: source.boundary.messageId,
							forkPointTimestamp: source.boundary.createdAt,
						}),
					]);
					expect(
						yield* sql`SELECT id, state, run_id, started_at, completed_at FROM turns WHERE session_id = 'fork' ORDER BY id`,
					).toEqual([
						{
							id: "a_fork",
							state,
							run_id: null,
							started_at: 3,
							completed_at: 9,
						},
						{
							id: "b_fork",
							state,
							run_id: null,
							started_at: 6,
							completed_at: 9,
						},
					]);
					expect(
						yield* sql`SELECT id, status, joined_into FROM provider_runs WHERE session_id = 'fork' ORDER BY id`,
					).toEqual([]);
					yield* commit([
						canonicalEvent(
							"run.requested",
							"fork",
							{ runId: "fresh", inputId: "fresh" },
							options("fresh", 10),
						),
						canonicalEvent(
							"message.created",
							"fork",
							{
								sessionId: "fork",
								messageId: "fresh",
								role: "user",
								inputId: "fresh",
							},
							options("fresh", 11),
						),
						canonicalEvent(
							"run.started",
							"fork",
							{ inputId: "fresh", requestedRunId: "fresh" },
							options("fresh", 12),
						),
						...(provider === "opencode"
							? [
									canonicalEvent(
										"session.status",
										"fork",
										{ sessionId: "fork", status: "idle" },
										options("fresh", 13),
									),
								]
							: [
									canonicalEvent(
										"turn.completed",
										"fork",
										{ messageId: "fresh" },
										options("fresh", 13),
									),
								]),
					]);
					expect(
						yield* sql`SELECT state, run_id, started_at, completed_at FROM turns WHERE id = 'fresh'`,
					).toEqual([
						{
							state: "completed",
							run_id: "fresh",
							started_at: 12,
							completed_at: 13,
						},
					]);
				}).pipe(Effect.provide(testLayer, { local: true })),
		);
	}

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
			const owner = {
				provider: "claude",
				metadata: { runId: "completed-run" },
				createdAt: 100,
			};
			yield* seed([
				history[0],
				canonicalEvent(
					"run.requested",
					"parent",
					{ runId: "completed-run", inputId: "msg_user_1" },
					owner,
				),
				...history.slice(1, 13).map((event) => ({
					...event,
					provider: owner.provider,
					metadata: owner.metadata,
				})),
			]);
			const commit = yield* makeCommitAndSignal;
			yield* commit([
				canonicalEvent(
					"message.created",
					"parent",
					{
						sessionId: "parent",
						messageId: "last-reply",
						role: "assistant",
						parentID: "msg_user_1",
					},
					{ ...owner, createdAt: 113 },
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
