import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Logger, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HistoryMessageSchema } from "../../../src/lib/contracts/ws-rpc.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { sessionPickEvents } from "../../../src/lib/domain/relay/Services/session-pick.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import {
	economics,
	segmentTurns,
} from "../../../src/lib/frontend/utils/turns.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

function makeCostRuntime(filename: string) {
	const persistence = makePersistenceEffectLayer(filename, "test-project");
	return ManagedRuntime.make(
		Layer.mergeAll(
			persistence,
			ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
		),
	);
}

describe("Claude turn economics through SQLite persistence", () => {
	let dir: string;
	let filename: string;
	let runtime: ReturnType<typeof makeCostRuntime>;
	let stamp: number;
	let messageRuns: Map<string, string>;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "conduit-claude-turn-cost-"));
		filename = join(dir, "events.db");
		stamp = Date.now();
		messageRuns = new Map();
		runtime = makeCostRuntime(filename);
		await runtime.runPromise(
			Effect.flatMap(ProjectionRunnerEffectTag, (runner) => runner.recover()),
		);
	});

	afterEach(async () => {
		await runtime.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	const seedSession = (sessionId: string, provider = "claude") =>
		Effect.gen(function* () {
			const store = yield* EventStoreEffectTag;
			const runner = yield* ProjectionRunnerEffectTag;
			yield* runner.projectEvent(
				yield* store.append(
					canonicalEvent(
						"session.created",
						sessionId,
						{ sessionId, provider, title: sessionId },
						{ provider, createdAt: stamp++ },
					),
				),
			);
		});

	const seedTurn = (sessionId: string, userId: string, assistantId: string) =>
		Effect.gen(function* () {
			const persist = yield* ClaudeEventPersistEffectTag;
			const runId = `run-${sessionId}-${userId}`;
			messageRuns.set(assistantId, runId);
			yield* persist.persistEvents([
				canonicalEvent(
					"message.created",
					sessionId,
					{ messageId: userId, role: "user", sessionId },
					{ provider: "claude", createdAt: stamp++, metadata: { runId } },
				),
				canonicalEvent(
					"run.requested",
					sessionId,
					{ inputId: userId, runId },
					{ provider: "claude", createdAt: stamp++ },
				),
				canonicalEvent(
					"run.started",
					sessionId,
					{ inputId: userId, requestedRunId: runId },
					{ provider: "claude", createdAt: stamp++, metadata: { runId } },
				),
				canonicalEvent(
					"message.created",
					sessionId,
					{
						messageId: assistantId,
						role: "assistant",
						sessionId,
						parentID: userId,
					},
					{ provider: "claude", createdAt: stamp++, metadata: { runId } },
				),
			]);
		});

	const completion = (
		sessionId: string,
		messageId: string,
		total: number,
		providerSessionId = "sdk-session",
		createdAt = stamp++,
		runId = messageRuns.get(messageId),
	) => {
		const data = { messageId, providerCostTotalUsd: total, providerSessionId };
		return canonicalEvent("turn.completed", sessionId, data, {
			provider: "claude",
			createdAt,
			...(runId ? { metadata: { runId } } : {}),
		});
	};

	const costs = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return {
			messages: yield* sql<{ id: string; cost: number | null }>`
				SELECT id, cost FROM messages WHERE role = 'assistant' ORDER BY id`,
			turns: yield* sql<{ id: string; cost: number | null }>`
				SELECT id, cost FROM turns ORDER BY id`,
		};
	});

	const rebuildCosts = Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const runner = yield* ProjectionRunnerEffectTag;
		yield* sql`DELETE FROM turns`;
		yield* sql`DELETE FROM provider_runs`;
		yield* sql`DELETE FROM messages`;
		yield* sql`DELETE FROM projector_cursors WHERE projector_name IN ('message', 'turn')`;
		yield* runner.recover();
		expect(yield* runner.getFailures()).toEqual([]);
		return yield* costs;
	});

	it("bills the explicit reply owner once while closing every input accepted by its run", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				const sql = yield* SqlClient.SqlClient;
				yield* seedSession("folded");
				yield* seedTurn("folded", "u1", "a1");
				const runId = "run-folded-u1";
				messageRuns.set("a2", runId);
				yield* persist.persistEvents([
					canonicalEvent(
						"message.created",
						"folded",
						{ sessionId: "folded", messageId: "u2", role: "user" },
						{
							provider: "claude",
							createdAt: stamp++,
							metadata: { runId: "unused-run" },
						},
					),
					canonicalEvent(
						"run.requested",
						"folded",
						{ inputId: "u2", runId: "unused-run" },
						{ provider: "claude", createdAt: stamp++ },
					),
					canonicalEvent(
						"run.started",
						"folded",
						{ inputId: "u2", requestedRunId: "unused-run" },
						{ provider: "claude", createdAt: stamp++, metadata: { runId } },
					),
					canonicalEvent(
						"message.created",
						"folded",
						{
							sessionId: "folded",
							messageId: "a2",
							parentID: "u2",
							role: "assistant",
						},
						{ provider: "claude", createdAt: stamp++, metadata: { runId } },
					),
					completion("folded", "a2", 0.5),
				]);
				expect((yield* costs).turns).toEqual([
					{ id: "u1", cost: null },
					{ id: "u2", cost: 0.5 },
				]);
				expect(yield* sql`SELECT id, state FROM turns ORDER BY id`).toEqual([
					{ id: "u1", state: "completed" },
					{ id: "u2", state: "completed" },
				]);
			}),
		);
	});

	it("keeps the latest completion event as the result boundary after late task updates and reopening", async () => {
		stamp = 1000;
		let beforeUpdate = 0;
		await runtime.runPromise(
			Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				const read = yield* ReadQueryEffectTag;
				yield* seedSession("s1");
				yield* seedTurn("s1", "u1", "a1");
				yield* persist.persistEvents([
					canonicalEvent(
						"tool.started",
						"s1",
						{
							messageId: "a1",
							partId: "task1",
							toolName: "Task",
							callId: "task1",
							input: { tool: "Task", description: "Audit", prompt: "Go" },
						},
						{ provider: "claude", createdAt: 1100 },
					),
					completion("s1", "a1", 0.1, "sdk-session", 3000),
					completion("s1", "a1", 0.2, "sdk-session", 2000),
				]);
				beforeUpdate = (yield* read.readSessionTranscript("s1")).version;
				yield* persist.persistEvent(
					canonicalEvent(
						"tool.running",
						"s1",
						{
							messageId: "a1",
							partId: "task1",
							metadata: { backgrounded: true, providerTaskId: "task1" },
						},
						{ provider: "claude", createdAt: 9000 },
					),
				);
			}),
		);
		const assertBoundary = Effect.gen(function* () {
			const read = yield* ReadQueryEffectTag;
			const histories = [
				yield* read.getSessionMessagesWithParts("s1"),
				(yield* read.readSessionTranscriptPage("s1", { limit: 50 })).messages,
				(yield* read.readSessionTranscript("s1")).messages,
				(yield* read.readSessionTranscript("s1", { after: beforeUpdate }))
					.messages,
			];
			for (const rows of histories) {
				const assistant = rows.find((row) => row.id === "a1");
				expect(assistant?.updated_at).toBe(9000);
				expect(assistant?.completed_at).toBe(2000);
				expect(assistant?.parts[0]?.updated_at).toBe(9000);
				const history = messageRowsToHistory(rows, { pageSize: 50 });
				expect(
					history.messages.find((message) => message.id === "a1")?.time
						?.completed,
				).toBe(2000);
			}
		});
		await runtime.runPromise(assertBoundary);
		await runtime.dispose();
		runtime = makeCostRuntime(filename);
		await runtime.runPromise(assertBoundary);
		await runtime.runPromise(rebuildCosts);
		await runtime.runPromise(assertBoundary);
	});

	// Migration leaves existing rows null. Rebuilding follows ledger order,
	// answerless results, message lifecycles and REST snapshot protection.
	it("leaves existing completion boundaries null until new events or a projection rebuild", async () => {
		stamp = 1000;
		await runtime.runPromise(
			Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* seedSession("s1");
				yield* seedTurn("s1", "u1", "a1");
				yield* persist.persistEvents([
					completion("s1", "a1", 0.1, "sdk-session", 3000),
					completion("s1", "a1", 0.2, "sdk-session", 2000),
					canonicalEvent(
						"message.created",
						"s1",
						{
							messageId: "u2",
							role: "user",
							sessionId: "s1",
						},
						{ provider: "claude", createdAt: 4000 },
					),
					canonicalEvent(
						"turn.completed",
						"s1",
						{
							messageId: "a1",
							userMessageId: "u2",
						},
						{ provider: "claude", createdAt: 5000 },
					),
					canonicalEvent(
						"message.snapshot",
						"s1",
						{
							messageId: "rest-only",
							message: {
								id: "rest-only",
								sessionID: "s1",
								role: "assistant",
								parentID: "u1",
								time: { created: 5000, completed: 6000 },
								parts: [],
							},
							digest: "rest-only",
						},
						{
							provider: "opencode",
							createdAt: 6000,
							metadata: { rawSource: "opencode.rest" },
						},
					),
					completion("s1", "rest-only", 0.3, "sdk-session", 7000),
					canonicalEvent(
						"tool.started",
						"s1",
						{
							messageId: "a1",
							partId: "late",
							toolName: "Bash",
							callId: "late",
							input: { tool: "Bash", command: "echo done" },
						},
						{ provider: "claude", createdAt: 8000 },
					),
					canonicalEvent(
						"tool.running",
						"s1",
						{
							messageId: "a1",
							partId: "late",
							metadata: { backgrounded: true },
						},
						{ provider: "claude", createdAt: 9000 },
					),
					canonicalEvent(
						"message.snapshot",
						"s1",
						{
							messageId: "a1",
							message: {
								id: "a1",
								sessionID: "s1",
								role: "assistant",
								parentID: "u1",
								time: { created: 1002, completed: 9000 },
								parts: [],
							},
							digest: "a1",
						},
						{
							provider: "opencode",
							createdAt: 10000,
							metadata: { rawSource: "opencode.rest" },
						},
					),
					completion("s1", "a1", 0.4, "sdk-session", 12000),
					canonicalEvent(
						"message.snapshot",
						"s1",
						{
							messageId: "reused",
							message: {
								id: "reused",
								sessionID: "s1",
								role: "assistant",
								parentID: "u2",
								parts: [],
							},
							digest: "reused",
						},
						{
							provider: "opencode",
							createdAt: 13000,
							metadata: { rawSource: "opencode.rest" },
						},
					),
					completion("s1", "reused", 0.5, "sdk-session", 14000),
					canonicalEvent(
						"message.removed",
						"s1",
						{ messageId: "reused" },
						{
							provider: "claude",
							createdAt: 15000,
						},
					),
					canonicalEvent(
						"message.created",
						"s1",
						{
							messageId: "reused",
							role: "assistant",
							sessionId: "s1",
							parentID: "u2",
						},
						{ provider: "claude", createdAt: 16000 },
					),
					completion("s1", "reused", 0.6, "sdk-session", 17000),
					completion("s1", "not-yet-created", 0.7, "sdk-session", 18000),
					canonicalEvent(
						"message.created",
						"s1",
						{
							messageId: "not-yet-created",
							role: "assistant",
							sessionId: "s1",
							parentID: "u2",
						},
						{ provider: "claude", createdAt: 19000 },
					),
				]);
				yield* seedSession("s2", "opencode");
				yield* persist.persistEvents([
					canonicalEvent(
						"message.created",
						"s2",
						{
							messageId: "opencode-answer",
							role: "assistant",
							sessionId: "s2",
						},
						{ provider: "opencode", createdAt: 20000 },
					),
					canonicalEvent(
						"turn.completed",
						"s2",
						{ messageId: "opencode-answer" },
						{
							provider: "opencode",
							createdAt: 21000,
						},
					),
				]);
				yield* persist.persistEvents([
					canonicalEvent(
						"text.delta",
						"s1",
						{
							messageId: "implicit",
							partId: "implicit-text",
							text: "Created from a delta",
						},
						{ provider: "claude", createdAt: 22000 },
					),
					canonicalEvent(
						"turn.completed",
						"s1",
						{ messageId: "implicit" },
						{
							provider: "claude",
							createdAt: 23000,
						},
					),
					canonicalEvent(
						"message.snapshot",
						"s1",
						{
							messageId: "unshielded",
							digest: "unshielded",
							message: {
								id: "unshielded",
								sessionID: "s1",
								role: "assistant",
								parts: [
									{ id: "snapshot-text", type: "text", text: "Original" },
								],
							},
						},
						{
							provider: "opencode",
							createdAt: 24000,
							metadata: { rawSource: "opencode.rest" },
						},
					),
					canonicalEvent(
						"message.part.removed",
						"s1",
						{
							messageId: "unshielded",
							partId: "absent",
						},
						{ provider: "opencode", createdAt: 25000 },
					),
					canonicalEvent(
						"turn.completed",
						"s1",
						{ messageId: "unshielded" },
						{
							provider: "claude",
							createdAt: 26000,
						},
					),
					canonicalEvent(
						"message.part.removed",
						"s1",
						{
							messageId: "unshielded",
							partId: "snapshot-text",
						},
						{ provider: "opencode", createdAt: 27000 },
					),
					canonicalEvent(
						"turn.completed",
						"s1",
						{ messageId: "unshielded" },
						{
							provider: "claude",
							createdAt: 28000,
						},
					),
					canonicalEvent(
						"message.part.removed",
						"s1",
						{
							messageId: "unshielded",
							partId: "snapshot-text",
						},
						{ provider: "opencode", createdAt: 29000 },
					),
				]);
			}),
		);
		const boundaries = Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return yield* sql<{
				id: string;
				completed_at: number | null;
				updated_at: number;
			}>`
				SELECT id, completed_at, updated_at FROM messages ORDER BY id`;
		});
		const projected = await runtime.runPromise(boundaries);
		expect(
			projected.map(({ id, completed_at }) => ({ id, completed_at })),
		).toEqual([
			{ id: "a1", completed_at: null },
			{ id: "implicit", completed_at: 23000 },
			{ id: "not-yet-created", completed_at: null },
			{ id: "opencode-answer", completed_at: 21000 },
			{ id: "rest-only", completed_at: null },
			{ id: "reused", completed_at: 17000 },
			{ id: "u1", completed_at: null },
			{ id: "u2", completed_at: null },
			{ id: "unshielded", completed_at: 28000 },
		]);
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				// Recreate the ledger prefix before completion boundaries were added.
				yield* sql`ALTER TABLE messages DROP COLUMN completed_at`;
				yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 47`;
				expect(yield* makeEffectSqlMigrator()).toEqual([
					[47, "messages_completed_at"],
					[48, "sessions_claude_worktree_state"],
					[49, "sessions_workspace_hint"],
					[50, "sessions_pending_rewind"],
					[51, "message_part_versions"],
					[52, "session_git_published"],
					[53, "store_identity"],
					[54, "events_unstamped_index"],
					[55, "events_session_type_index"],
					[56, "drop_activities"],
					[57, "session_pick_backfill"],
					[58, "compact_redundant_events"],
					[59, "session_project_scope"],
					[60, "daemon_store_imports"],
					[61, "sessions_lineage"],
					[62, "legacy_forks"],
					[63, "sessions_archived"],
					[64, "prompt_provider_reference"],
					[65, "tool_result_event_refs"],
					[66, "project_tree_data"],
					[67, "purge_background_shell_sessions"],
					[68, "input_drafts"],
					[69, "goal_check_metadata"],
					[70, "message_part_surfacing"],
					[71, "sessions_settled_shelf_index"],
					[72, "surfacing_marks"],
					[73, "message_part_read"],
					[74, "turn_recaps"],
					[75, "events_parent_id_index"],
					[76, "events_forked_from_index"],
					[77, "message_parts_result_event_seq_index"],
					[78, "provider_run_ownership"],
					[79, "provider_control_process"],
				]);
				expect(yield* makeEffectSqlMigrator()).toEqual([]);
			}),
		);
		expect(await runtime.runPromise(boundaries)).toEqual(
			projected.map((row) => ({ ...row, completed_at: null })),
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const read = yield* ReadQueryEffectTag;
				for (const sessionId of ["s1", "s2"]) {
					const rows = yield* read.getSessionMessagesWithParts(sessionId);
					const history = messageRowsToHistory(rows, { pageSize: 50 });
					for (const row of rows.filter(
						(row) => row.role === "assistant" && !row.rest_payload,
					)) {
						expect(row.completed_at).toBeNull();
						expect(
							history.messages.find((message) => message.id === row.id)?.time
								?.completed,
						).toBe(row.updated_at);
					}
				}
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* seedTurn("s1", "u3", "a3");
				yield* persist.persistEvents([
					completion("s1", "a3", 0.8, "sdk-session", 30000),
					canonicalEvent(
						"tool.started",
						"s1",
						{
							messageId: "a3",
							partId: "new-late",
							toolName: "Task",
							callId: "new-late",
							input: { tool: "Task", description: "Audit", prompt: "Go" },
						},
						{ provider: "claude", createdAt: 31000 },
					),
					canonicalEvent(
						"tool.running",
						"s1",
						{
							messageId: "a3",
							partId: "new-late",
							metadata: { backgrounded: true },
						},
						{ provider: "claude", createdAt: 32000 },
					),
				]);
			}),
		);
		const assertNewBoundary = Effect.gen(function* () {
			const read = yield* ReadQueryEffectTag;
			const rows = yield* read.getSessionMessagesWithParts("s1");
			expect(rows.find((row) => row.id === "a3")).toMatchObject({
				completed_at: 30000,
				updated_at: 32000,
			});
			expect(
				messageRowsToHistory(rows, { pageSize: 50 }).messages.find(
					(message) => message.id === "a3",
				)?.time?.completed,
			).toBe(30000);
		});
		await runtime.runPromise(assertNewBoundary);
		const newRows = (await runtime.runPromise(boundaries)).filter(
			(row) => row.id === "u3" || row.id === "a3",
		);
		await runtime.runPromise(rebuildCosts);
		expect(await runtime.runPromise(boundaries)).toEqual(
			[...projected, ...newRows].sort((left, right) =>
				left.id.localeCompare(right.id),
			),
		);
		await runtime.runPromise(assertNewBoundary);
	});

	it("keeps usage and context independent through history, reopening and rebuilding, including legacy rows", async () => {
		const snapshot = Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return {
				messages:
					yield* sql`SELECT id, cost, tokens_in, tokens_out, tokens_cache_read,
					tokens_cache_write, context_tokens, context_window, created_at, updated_at
					FROM messages ORDER BY id`,
				turns:
					yield* sql`SELECT id, cost, tokens_in, tokens_out, requested_at, started_at,
					completed_at FROM turns ORDER BY id`,
			};
		});
		await runtime.runPromise(
			Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				const read = yield* ReadQueryEffectTag;
				for (const session of ["new", "old", "opencode", "context-only"]) {
					const provider = session === "opencode" ? "opencode" : "claude";
					yield* seedSession(session, provider);
					yield* seedTurn(session, `${session}-u`, `${session}-a`);
					yield* persist.persistEvent(
						canonicalEvent(
							"turn.completed",
							session,
							{
								messageId: `${session}-a`,
								cost: 0.1,
								...(session === "new" || session === "context-only"
									? { contextTokens: 40_000 }
									: {}),
								tokens:
									session === "context-only"
										? { contextWindow: 200_000 }
										: {
												input: 500,
												output: 20_000,
												cacheRead: 3_300_000,
												cacheWrite: 80_000,
												contextWindow: 200_000,
											},
							},
							{
								provider,
								createdAt: stamp++,
								metadata: { runId: `run-${session}-${session}-u` },
							},
						),
					);
					const history = messageRowsToHistory(
						yield* read.getSessionMessagesWithParts(session),
						{ pageSize: 50 },
					);
					const assistant = history.messages.find(
						(message) => message.role === "assistant",
					);
					expect(assistant).toBeDefined();
					const wire =
						Schema.decodeUnknownSync(HistoryMessageSchema)(assistant);
					expect(wire).toEqual(assistant);
					const [turn] = segmentTurns(
						historyToChatMessages(history.messages),
						false,
					);
					if (!turn) throw new Error("expected hydrated turn");
					const bill = economics(turn, 0);
					expect(bill.tokensIn).toBe(
						session === "context-only" ? undefined : 500,
					);
					expect(bill.tokensOut).toBe(
						session === "context-only" ? undefined : 20_000,
					);
					if (session === "new" || session === "context-only") {
						expect(wire["contextTokens"]).toBe(40_000);
						expect(bill.context).toEqual({
							used: 40_000,
							window: 200_000,
							pct: 20,
						});
					} else {
						expect(wire).not.toHaveProperty("contextTokens");
						expect(bill.context).toEqual({
							used: 3_380_500,
							window: 200_000,
							pct: 100,
						});
					}
					expect(
						(yield* read.getSessionHistoryMetadata(session)).cumulativeTokens,
					).toBe(session === "context-only" ? 0 : 3_400_500);
				}
			}),
		);
		const before = await runtime.runPromise(snapshot);
		await runtime.dispose();
		runtime = makeCostRuntime(filename);
		await runtime.runPromise(
			Effect.flatMap(ProjectionRunnerEffectTag, (runner) => runner.recover()),
		);
		expect(await runtime.runPromise(snapshot)).toEqual(before);
		await runtime.runPromise(rebuildCosts);
		expect(await runtime.runPromise(snapshot)).toEqual(before);
	});

	it("continues the durable baseline after closing and reopening SQLite, then rebuilds", async () => {
		const totals = [0.2982432, 0.37888, 0.402294, 0.4127606];
		await runtime.runPromise(
			Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* seedSession("parent");
				yield* seedTurn("parent", "u1", "a1");
				for (const total of totals)
					yield* persist.persistEvent(completion("parent", "a1", total));
			}),
		);
		await runtime.dispose();
		runtime = makeCostRuntime(filename);
		await runtime.runPromise(
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				const store = yield* EventStoreEffectTag;
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* runner.recover();
				yield* seedTurn("parent", "u2", "a2");
				yield* persist.persistEvent(completion("parent", "a2", 0.4197188));
				const rows = yield* costs;
				expect(rows.turns[0]?.cost).toBeCloseTo(0.4127606, 12);
				expect(rows.turns[1]?.cost).toBeCloseTo(0.0069582, 12);
				expect(
					rows.turns.reduce((sum, row) => sum + (row.cost ?? 0), 0),
				).toBeCloseTo(0.4197188, 12);
				expect(rows.messages.map((row) => row.cost)).toEqual(
					rows.turns.map((row) => row.cost),
				);
				const completed = (yield* store.readBySession("parent")).filter(
					(event) =>
						event.type === "turn.completed" ||
						event.type === "message.completed",
				);
				expect(
					completed.map((event) => event.data.providerCostTotalUsd),
				).toEqual([...totals, 0.4197188]);
				expect(completed.map((event) => event.data.providerSessionId)).toEqual(
					Array(5).fill("sdk-session"),
				);
				expect(yield* rebuildCosts).toEqual(rows);
			}),
		);
	});

	it("adds every completion in a batch and across assistant messages in one turn", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* seedSession("s1");
				yield* seedTurn("s1", "u1", "a1");
				yield* persist.persistEvents([
					completion("s1", "a1", 0.1),
					completion("s1", "a1", 0.3),
					canonicalEvent(
						"message.created",
						"s1",
						{
							messageId: "a2",
							role: "assistant",
							sessionId: "s1",
							parentID: "u1",
						},
						{ provider: "claude", createdAt: stamp++ },
					),
					completion("s1", "a2", 0.7, "sdk-session", stamp++, "run-s1-u1"),
				]);
				const rows = yield* costs;
				expect(rows.messages[0]?.cost).toBeCloseTo(0.3, 12);
				expect(rows.messages[1]?.cost).toBeCloseTo(0.4, 12);
				expect(rows.turns).toEqual([{ id: "u1", cost: 0.7 }]);
				expect(yield* rebuildCosts).toEqual(rows);
			}),
		);
	});

	it("isolates conduit sessions, child sessions and provider session ids by event order", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				const sql = yield* SqlClient.SqlClient;
				yield* seedSession("s1");
				yield* seedSession("s2");
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.projectBatch(
					yield* store.appendBatch(
						sessionPickEvents("s1", {
							harness: "claude",
							model: { providerId: "claude", modelId: "sonnet" },
							effort: "high",
							contextWindow: "1m",
						}),
					),
				);
				yield* seedTurn("s1", "u1", "a1");
				yield* seedTurn("s2", "u2", "a2");
				yield* persist.ensureClaudeSubagentSession({
					childSessionId: "child",
					parentSessionId: "s1",
					providerSessionId: "child-sdk",
					title: "Child",
				});
				expect(
					yield* (yield* ReadQueryEffectTag).getSession("child"),
				).toMatchObject({
					model_provider: "claude",
					model_id: "sonnet",
					variant: "high",
					context_window: "1m",
				});
				expect(
					(yield* store.readAllBySession("child")).map((event) => event.type),
				).toEqual([
					"session.created",
					"session.model_changed",
					"session.variant_changed",
					"session.context_window_changed",
				]);
				yield* seedTurn("child", "uc", "ac");
				yield* persist.persistEvent(
					completion("s1", "a1", 1, "sdk-session", 500),
				);
				yield* persist.persistEvent(completion("s2", "a2", 8));
				yield* persist.persistEvent(
					completion("child", "ac", 0.2, "child-sdk"),
				);
				yield* persist.persistEvent(completion("s1", "a1", 2, "other-sdk"));
				yield* persist.persistEvent(
					completion("s1", "a1", 1.25, "sdk-session", 400),
				);
				yield* persist.persistEvent(
					completion("s1", "a1", 1.5, "sdk-session", 300),
				);
				const deltas = yield* sql<{ total: number; cost: number }>`
					SELECT json_extract(data, '$.providerCostTotalUsd') AS total,
					json_extract(data, '$.cost') AS cost FROM events
					WHERE session_id = 's1' AND type IN ('turn.completed', 'message.completed') ORDER BY sequence`;
				expect(deltas.map((row) => row.cost)).toEqual([1, 2, 0.25, 0.25]);
				expect((yield* costs).turns).toEqual([
					{ id: "u1", cost: 3.5 },
					{ id: "u2", cost: 8 },
					{ id: "uc", cost: 0.2 },
				]);
			}),
		);
	});

	it("keeps OpenCode and old Claude latest-wins costs unchanged on rebuild", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				for (const provider of ["claude", "opencode"]) {
					yield* seedSession(provider, provider);
					yield* seedTurn(provider, `${provider}-u`, `${provider}-a`);
					yield* persist.persistEvents(
						[38.53, 39.84].map((cost) =>
							canonicalEvent(
								"turn.completed",
								provider,
								{ messageId: `${provider}-a`, cost },
								{
									provider,
									createdAt: stamp++,
									metadata: { runId: `run-${provider}-${provider}-u` },
								},
							),
						),
					);
				}
				const before = yield* costs;
				expect(before.messages.map((row) => row.cost)).toEqual([39.84, 39.84]);
				expect(before.turns.map((row) => row.cost)).toEqual([39.84, 39.84]);
				expect(yield* rebuildCosts).toEqual(before);
				// History is deliberately not backfilled or used as a raw-total baseline.
				yield* persist.persistEvent(completion("claude", "claude-a", 40));
				expect((yield* costs).turns[0]?.cost).toBe(79.84);
			}),
		);
	});

	it("handles missing, zero, equal and backwards totals without losing the durable baseline", async () => {
		const warnings: unknown[] = [];
		const logger = Logger.make<unknown, void>((options) => {
			if (options.logLevel === "Warn") warnings.push(options.message);
		});
		await runtime.runPromise(
			Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				const sql = yield* SqlClient.SqlClient;
				yield* seedSession("s1");
				yield* seedTurn("s1", "u1", "a1");
				for (const total of [0, 1, 1])
					yield* persist.persistEvent(completion("s1", "a1", total));
				yield* persist.persistEvent(
					canonicalEvent(
						"turn.completed",
						"s1",
						{ messageId: "a1" },
						{ provider: "claude", createdAt: stamp++ },
					),
				);
				for (const total of [0.5, 0.75])
					yield* persist.persistEvent(completion("s1", "a1", total));
				const rows = yield* sql<{ total: number | null; cost: number | null }>`
					SELECT json_extract(data, '$.providerCostTotalUsd') AS total,
					json_extract(data, '$.cost') AS cost FROM events
					WHERE type IN ('turn.completed', 'message.completed') ORDER BY sequence`;
				expect(rows.map((row) => row.cost)).toEqual([0, 1, 0, null, 0, 0.25]);
				expect((yield* costs).turns).toEqual([{ id: "u1", cost: 1.25 }]);
				expect(warnings).toHaveLength(1);
				expect(String(warnings[0])).toMatch(/s1.*sdk-session|sdk-session.*s1/);
			}).pipe(Effect.provide(Logger.layer([Logger.tracerLogger, logger]))),
		);
	});

	it("rolls the baseline back with a rejected batch and serializes concurrent equal totals", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				const sql = yield* SqlClient.SqlClient;
				yield* seedSession("s1");
				yield* seedTurn("s1", "u1", "a1");
				yield* Effect.all(
					[
						persist.persistEvent(completion("s1", "a1", 1)),
						persist.persistEvent(completion("s1", "a1", 1)),
					],
					{ concurrency: 2 },
				);
				expect((yield* costs).turns).toEqual([{ id: "u1", cost: 1 }]);
				yield* sql`CREATE TEMP TRIGGER reject_cost BEFORE INSERT ON events
					WHEN NEW.type IN ('turn.completed', 'message.completed') AND json_extract(NEW.data, '$.providerCostTotalUsd') = 2
					BEGIN SELECT RAISE(ABORT, 'reject test completion'); END`;
				const rejected = yield* Effect.result(
					persist.persistEvents([
						completion("s1", "a1", 1.5),
						completion("s1", "a1", 2),
					]),
				);
				expect(rejected._tag).toBe("Failure");
				yield* persist.persistEvent(completion("s1", "a1", 1.6));
				const rows = yield* sql<{ cost: number }>`
					SELECT json_extract(data, '$.cost') AS cost FROM events WHERE type IN ('turn.completed', 'message.completed') ORDER BY sequence`;
				expect(rows.map((row) => row.cost)).toEqual([1, 0, 0.6000000000000001]);
				expect((yield* costs).turns[0]?.cost).toBeCloseTo(1.6, 12);
			}),
		);
	});

	it.each([
		{ nextStarted: false, missingOwner: false },
		{ nextStarted: true, missingOwner: false },
		{ nextStarted: false, missingOwner: true },
		{ nextStarted: true, missingOwner: true },
	])("preserves late interrupted-run accounting through runtime ingestion ($nextStarted next started, $missingOwner missing owner)", async ({
		nextStarted,
		missingOwner,
	}) => {
		const evidence = await runtime.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const store = yield* EventStoreEffectTag;
				const sql = yield* SqlClient.SqlClient;
				yield* seedSession("s1");
				yield* seedTurn("s1", "u1", "a1");
				yield* ingestion.ingest(
					providerRuntimeEvent(
						"turn.interrupted",
						"s1",
						{
							messageId: "a1",
						},
						{ runId: "run-s1-u1", createdAt: stamp++ },
					),
				);
				const interrupted =
					yield* sql`SELECT state, completed_at FROM turns WHERE id = 'u1'`;
				const boundary =
					yield* sql`SELECT last_turn_end_version FROM sessions WHERE id = 's1'`;
				if (nextStarted) yield* seedTurn("s1", "u2", "a2");
				if (missingOwner)
					yield* sql`DELETE FROM provider_runs WHERE id = 'run-s1-u1'`;
				const late = providerRuntimeEvent(
					"turn.completed",
					"s1",
					{
						messageId: "a1",
						providerCostTotalUsd: 1,
						providerSessionId: "sdk-session",
						tokens: {
							input: 100,
							output: 20,
							cacheRead: 30,
							cacheWrite: 40,
							contextWindow: 200_000,
						},
						contextTokens: 170,
					},
					{
						eventId: "late-result",
						runId: "run-s1-u1",
						createdAt: stamp++,
						rawSourceKind: "claude.sdk.message",
					},
				);
				yield* ingestion.ingest(late);
				// Re-ingestion and reconstruction of the same result must not add usage twice.
				yield* ingestion.ingest(late);
				yield* ingestion.ingest({ ...late, eventId: "late-result-replayed" });
				const stored = (yield* store.readBySession("s1")).filter(
					(event) => event.type === "message.completed",
				);
				expect(
					yield* sql`SELECT state, completed_at FROM turns WHERE id = 'u1'`,
				).toEqual(interrupted);
				expect(
					yield* sql`SELECT last_turn_end_version FROM sessions WHERE id = 's1'`,
				).toEqual(boundary);
				const message =
					yield* sql`SELECT cost, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, context_tokens, context_window FROM messages WHERE id = 'a1'`;
				if (nextStarted) {
					expect(
						yield* sql`SELECT state, cost, tokens_in FROM turns WHERE id = 'u2'`,
					).toEqual([{ state: "running", cost: null, tokens_in: null }]);
				} else yield* seedTurn("s1", "u2", "a2");
				yield* ingestion.ingest(
					providerRuntimeEvent(
						"turn.completed",
						"s1",
						{
							messageId: "a2",
							providerCostTotalUsd: 2,
							providerSessionId: "sdk-session",
							tokens: { input: 200, output: 40 },
						},
						{ eventId: "next-result", runId: "run-s1-u2", createdAt: stamp++ },
					),
				);
				const live = yield* costs;
				expect(live.turns).toEqual([
					{ id: "u1", cost: missingOwner ? null : 1 },
					{ id: "u2", cost: 1 },
				]);
				expect(stored).toHaveLength(1);
				expect(stored[0]).toMatchObject({
					metadata: { runId: "run-s1-u1" },
					data: { ...late.data, cost: 1 },
				});
				expect(message).toEqual([
					{
						cost: 1,
						tokens_in: 100,
						tokens_out: 20,
						tokens_cache_read: 30,
						tokens_cache_write: 40,
						context_tokens: 170,
						context_window: 200_000,
					},
				]);
				const terminals = (yield* store.readBySession("s1")).filter(
					(event) =>
						event.type === "turn.interrupted" ||
						event.type === "turn.completed" ||
						event.type === "turn.error",
				);
				expect(
					terminals.map((event) => [event.type, event.metadata.runId]),
				).toEqual([
					["turn.interrupted", "run-s1-u1"],
					["turn.completed", "run-s1-u2"],
				]);
				const rebuilt = yield* rebuildCosts;
				expect(rebuilt.turns).toEqual([
					{ id: "u1", cost: 1 },
					{ id: "u2", cost: 1 },
				]);
				const turns =
					yield* sql`SELECT id, state, cost, tokens_in, tokens_out FROM turns ORDER BY id`;
				expect(turns).toEqual([
					{
						id: "u1",
						state: "interrupted",
						cost: 1,
						tokens_in: 100,
						tokens_out: 20,
					},
					{
						id: "u2",
						state: "completed",
						cost: 1,
						tokens_in: 200,
						tokens_out: 40,
					},
				]);
				return {
					nextStarted,
					missingOwner,
					stored,
					terminals,
					message,
					live,
					rebuilt,
					turns,
				};
			}),
		);
		const artifactDir = "test-results/82tn10-4-round4";
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(
			join(artifactDir, `late-success-${nextStarted}-${missingOwner}.json`),
			JSON.stringify(evidence, null, 2),
		);
	});

	it("keeps a late error from replacing an interrupted run through runtime ingestion", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s1");
				yield* seedTurn("s1", "u1", "a1");
				yield* ingestion.ingest(
					providerRuntimeEvent(
						"turn.interrupted",
						"s1",
						{ messageId: "a1" },
						{ runId: "run-s1-u1", createdAt: stamp++ },
					),
				);
				yield* seedTurn("s1", "u2", "a2");
				const before =
					yield* sql`SELECT id, state, completed_at, cost, tokens_in FROM turns ORDER BY id`;
				const late = providerRuntimeEvent(
					"turn.error",
					"s1",
					{ messageId: "a1", error: "late provider error" },
					{ runId: "run-s1-u1", createdAt: stamp++ },
				);
				yield* ingestion.ingest(late);
				yield* ingestion.ingest(late);
				expect(
					yield* sql`SELECT id, state, completed_at, cost, tokens_in FROM turns ORDER BY id`,
				).toEqual(before);
				expect(
					(yield* store.readBySession("s1")).filter(
						(event) => event.type === "turn.error",
					),
				).toEqual([]);
			}),
		);
	});

	it("derives deltas on the production runtime-ingestion path in the same batch", async () => {
		await runtime.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s1");
				yield* seedTurn("s1", "u1", "a1");
				yield* ingestion.ingestBatch(
					[1, 1.5].map((total) => ({
						eventId: crypto.randomUUID(),
						type: "turn.completed" as const,
						providerId: "claude",
						sessionId: "s1",
						runId: "run-s1-u1",
						providerRefs: { providerSessionId: "sdk-session" },
						rawSource: {
							kind: "claude.sdk.message",
							providerMessageType: "result",
						},
						createdAt: stamp++,
						data: {
							messageId: "a1",
							providerCostTotalUsd: total,
							providerSessionId: "sdk-session",
						},
					})),
				);
				const rows = (yield* store.readBySession("s1")).filter(
					(event) =>
						event.type === "turn.completed" ||
						event.type === "message.completed",
				);
				expect(rows.map((event) => event.data.cost)).toEqual([1, 0.5]);
				expect((yield* costs).turns).toEqual([{ id: "u1", cost: 1.5 }]);
			}),
		);
	});
});
