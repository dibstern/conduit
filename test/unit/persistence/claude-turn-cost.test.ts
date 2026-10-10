import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, Logger, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HistoryMessageSchema } from "../../../src/lib/contracts/ws-rpc.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import {
	economics,
	segmentTurns,
} from "../../../src/lib/frontend/utils/turns.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";

function makeCostRuntime(filename: string) {
	const persistence = makePersistenceEffectLayer(filename);
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

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "conduit-claude-turn-cost-"));
		filename = join(dir, "events.db");
		stamp = Date.now();
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
			yield* persist.persistEvents([
				canonicalEvent(
					"message.created",
					sessionId,
					{ messageId: userId, role: "user", sessionId },
					{ provider: "claude", createdAt: stamp++ },
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
					{ provider: "claude", createdAt: stamp++ },
				),
			]);
		});

	const completion = (
		sessionId: string,
		messageId: string,
		total: number,
		providerSessionId = "sdk-session",
		createdAt = stamp++,
	) => {
		const data = { messageId, providerCostTotalUsd: total, providerSessionId };
		return canonicalEvent("turn.completed", sessionId, data, {
			provider: "claude",
			createdAt,
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
		yield* sql`DELETE FROM messages`;
		yield* sql`DELETE FROM projector_cursors WHERE projector_name IN ('message', 'turn')`;
		yield* runner.recover();
		expect(yield* runner.getFailures()).toEqual([]);
		return yield* costs;
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
							{ provider, createdAt: stamp++ },
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
					(event) => event.type === "turn.completed",
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
					completion("s1", "a2", 0.7),
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
				yield* seedTurn("s1", "u1", "a1");
				yield* seedTurn("s2", "u2", "a2");
				yield* persist.ensureClaudeSubagentSession({
					childSessionId: "child",
					parentSessionId: "s1",
					providerSessionId: "child-sdk",
					title: "Child",
				});
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
					WHERE session_id = 's1' AND type = 'turn.completed' ORDER BY sequence`;
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
								{ provider, createdAt: stamp++ },
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
			if (options.logLevel._tag === "Warning") warnings.push(options.message);
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
					WHERE type = 'turn.completed' ORDER BY sequence`;
				expect(rows.map((row) => row.cost)).toEqual([0, 1, 0, null, 0, 0.25]);
				expect((yield* costs).turns).toEqual([{ id: "u1", cost: 1.25 }]);
				expect(warnings).toHaveLength(1);
				expect(String(warnings[0])).toMatch(/s1.*sdk-session|sdk-session.*s1/);
			}).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
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
					WHEN NEW.type = 'turn.completed' AND json_extract(NEW.data, '$.providerCostTotalUsd') = 2
					BEGIN SELECT RAISE(ABORT, 'reject test completion'); END`;
				const rejected = yield* Effect.either(
					persist.persistEvents([
						completion("s1", "a1", 1.5),
						completion("s1", "a1", 2),
					]),
				);
				expect(rejected._tag).toBe("Left");
				yield* persist.persistEvent(completion("s1", "a1", 1.6));
				const rows = yield* sql<{ cost: number }>`
					SELECT json_extract(data, '$.cost') AS cost FROM events WHERE type = 'turn.completed' ORDER BY sequence`;
				expect(rows.map((row) => row.cost)).toEqual([1, 0, 0.6000000000000001]);
				expect((yield* costs).turns[0]?.cost).toBeCloseTo(1.6, 12);
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
					(event) => event.type === "turn.completed",
				);
				expect(rows.map((event) => event.data.cost)).toEqual([1, 0.5]);
				expect((yield* costs).turns).toEqual([{ id: "u1", cost: 1.5 }]);
			}),
		);
	});
});
