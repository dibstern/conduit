import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { literal } from "effect/sql/Statement";
import { describe, expect, it, vi } from "vitest";
import {
	decodeProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	makeProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/project-services/Services/provider-runtime-ingestion-service.js";
import {
	type SessionEventBus,
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/project-services/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	type EventStoreEffect,
	EventStoreEffectTag,
	type EventStoreError,
} from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	type ProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
	ProjectionRunnerError,
} from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { runTerminalStatus } from "../../../src/lib/persistence/effect/projectors-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	type StoredEvent,
} from "../../../src/lib/persistence/events.js";
import { makeRunnerReceiptStore } from "../../../src/lib/provider/runner/runner-receipts.js";
import { makeRunnerRunLifecycle } from "../../../src/lib/provider/runner/runner-retirement.js";
import { makeEffectProjectionHarness } from "../../helpers/effect-projection-harness.js";

const BASE_EVENT = {
	providerId: "claude",
	sessionId: "session-123",
	createdAt: "2026-05-19T00:00:00.000Z",
	rawSource: {
		kind: "claude.sdk.message",
		providerMessageType: "assistant",
	},
	providerRefs: {
		providerSessionId: "provider-session-123",
		providerMessageId: "provider-message-123",
		providerTurnId: "provider-turn-123",
		providerToolUseId: "provider-tool-123",
		providerRequestId: "provider-request-123",
	},
} as const;

function runtimeEvent(event: Record<string, unknown>): ProviderRuntimeEvent {
	return decodeProviderRuntimeEvent({
		...BASE_EVENT,
		...event,
	});
}

const setupRunSettlement = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const commit = yield* makeCommitAndSignal;
	const receipts = yield* makeRunnerReceiptStore(sql);
	yield* commit([
		canonicalEvent("session.created", "settlement-session", {
			sessionId: "settlement-session",
			title: "Settlement",
			provider: "claude",
		}),
		canonicalEvent("run.requested", "settlement-session", {
			runId: "held-run",
			inputId: "input",
		}),
		canonicalEvent(
			"run.started",
			"settlement-session",
			{ requestedRunId: "held-run", inputId: "input" },
			{
				provider: "claude",
				metadata: { runId: "held-run" },
			},
		),
	]);
	yield* receipts.register(
		"old-runner",
		{ sessionId: "settlement-session" },
		"serving",
	);
	yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, requested_at, updated_at) SELECT 1, 'input', project_id, 'settlement-session', 'claude', 'send_turn', '{}', 'held-run', 'running', 1, 1 FROM sessions WHERE id = 'settlement-session'`;
	yield* makeRunnerRunLifecycle({
		sql,
		commit,
		eventStore: yield* EventStoreEffectTag,
	}).holdRun({
		sessionId: "settlement-session",
		runId: "held-run",
		commandId: "input",
	});
	yield* sql`UPDATE claude_runner_cursors SET retired_at = 1 WHERE runner_id = 'old-runner'`;
	const readOwners = vi.fn();
	const owners = Effect.gen(function* () {
		readOwners();
		expect((yield* Effect.serviceOption(sql.transactionService))._tag).toBe(
			"Some",
		);
		return yield* sql<{ runId: string }>`SELECT id AS runId FROM provider_runs
			WHERE session_id = 'settlement-session' AND runner_id = 'old-runner' AND status IN ('pending', 'running')`;
	});
	return { sql, commit, receipts, owners, readOwners };
});

// Failure cases: an eager owner snapshot consumes a handoff, a native terminal
// is replaced by synthetic failure, or settlement/receipt writes partially commit.
describe("transactional runner settlement ingestion", () => {
	it("leaves a run moved to another holder before the settlement transaction running", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const { sql, commit, receipts, owners, readOwners } =
					yield* setupRunSettlement;
				yield* receipts.register(
					"new-runner",
					{ sessionId: "settlement-session" },
					"serving",
				);
				yield* commit([
					canonicalEvent(
						"run.released",
						"settlement-session",
						{
							runId: "held-run",
							runnerId: "old-runner",
							commandId: "input",
							transmission: 1,
							reason: "NotSent",
						},
						{ provider: "claude", metadata: { runId: "held-run" } },
					),
				]);
				yield* makeRunnerRunLifecycle({
					sql,
					commit,
					eventStore: yield* EventStoreEffectTag,
				}).holdRun({
					sessionId: "settlement-session",
					runId: "held-run",
					commandId: "input",
				});
				const ingestion = yield* ProviderRuntimeIngestionTag;
				expect(
					yield* ingestion.ingestBatch([], {
						settleRuns: {
							sessionId: "settlement-session",
							reason: "old runner gone",
							owners,
						},
					}),
				).toBe(0);
				expect(readOwners).toHaveBeenCalledOnce();
				expect(
					yield* sql`SELECT status, runner_id FROM provider_runs WHERE id = 'held-run'`,
				).toEqual([{ status: "running", runner_id: "new-runner" }]);
				expect(
					yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'turn.interrupted'`,
				).toEqual([{ n: 0 }]);
			}).pipe(
				Effect.provide(ProviderRuntimeIngestionLive),
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
		);
	});

	it("preserves a native success committed before settlement reads its owners", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const { sql, owners, readOwners } = yield* setupRunSettlement;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* ingestion.ingest(
					runtimeEvent({
						eventId: "native-success-before-settlement",
						sessionId: "settlement-session",
						type: "turn.completed",
						runId: "held-run",
						data: { messageId: "" },
					}),
				);
				expect(
					yield* ingestion.ingestBatch([], {
						settleRuns: {
							sessionId: "settlement-session",
							reason: "runner gone",
							owners,
							errorCode: "process_lost",
						},
					}),
				).toBe(0);
				expect(readOwners).toHaveBeenCalledOnce();
				expect(
					yield* sql`SELECT status FROM provider_runs WHERE id = 'held-run'`,
				).toEqual([{ status: "completed" }]);
				expect(
					yield* sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([{ type: "turn.completed" }]);
			}).pipe(
				Effect.provide(ProviderRuntimeIngestionLive),
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
		);
	});

	it("rolls owner reads and appended terminals back with a failed commit, then retries", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const { sql, owners } = yield* setupRunSettlement;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* sql`CREATE TABLE settlement_query (run_id TEXT)`;
				const queriedOwners =
					sql`INSERT INTO settlement_query VALUES ('held-run')`.pipe(
						Effect.andThen(owners),
					);
				const settlement = {
					sessionId: "settlement-session",
					reason: "runner gone",
					owners: queriedOwners,
				};
				const failed = yield* Effect.exit(
					ingestion.ingestBatch([], {
						settleRuns: settlement,
						beforeCommit: sql
							.unsafe(
								"SELECT missing_settlement_column FROM claude_runner_cursors",
							)
							.pipe(Effect.asVoid),
					}),
				);
				expect(failed._tag).toBe("Failure");
				expect(
					yield* sql`SELECT status FROM provider_runs WHERE id = 'held-run'`,
				).toEqual([{ status: "running" }]);
				expect(yield* sql`SELECT COUNT(*) AS n FROM settlement_query`).toEqual([
					{ n: 0 },
				]);
				expect(
					yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'turn.interrupted'`,
				).toEqual([{ n: 0 }]);
				expect(
					yield* ingestion.ingestBatch([], { settleRuns: settlement }),
				).toBe(2);
				expect(
					yield* sql`SELECT status FROM provider_runs WHERE id = 'held-run'`,
				).toEqual([{ status: "interrupted" }]);
				expect(yield* sql`SELECT COUNT(*) AS n FROM settlement_query`).toEqual([
					{ n: 1 },
				]);
				expect(
					yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'turn.interrupted'`,
				).toEqual([{ n: 1 }]);
			}).pipe(
				Effect.provide(ProviderRuntimeIngestionLive),
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
		);
	});
});

// Failure modes: the mapper drops the source, the transactional check misses a
// reference, a born-dead creation hits a FK, or later content revives the child.
describe("born-dead provider creation", () => {
	it.each([
		"parentId",
		"forkedFrom",
	] as const)("marks a creation with a deleted %s in the same projected batch", async (reference) => {
		const harness = makeEffectProjectionHarness();
		try {
			await harness.ingest(
				runtimeEvent({
					eventId: "dead-reference",
					sessionId: "dead-reference",
					type: "session.deleted",
					data: {},
				}),
			);
			await harness.ingestBatch([
				runtimeEvent({
					eventId: "born-dead-created",
					sessionId: "born-dead",
					type: "session.created",
					data: { [reference]: "dead-reference" },
				}),
				runtimeEvent({
					eventId: "born-dead-late-message",
					sessionId: "born-dead",
					type: "message.created",
					data: { messageId: "late-message", role: "assistant" },
				}),
			]);
			expect(
				(await harness.storedEvents("born-dead")).map((event) => event.type),
			).toEqual(["session.created", "session.deleted"]);
			expect(await harness.query("SELECT id FROM sessions")).toEqual([]);
			expect(await harness.query("SELECT id FROM session_providers")).toEqual(
				[],
			);
		} finally {
			await harness.dispose();
		}
	});
});

function makeHarness(options?: {
	readonly existingSession?: boolean;
	readonly appendEffect?: (
		event: CanonicalEvent,
		stored: StoredEvent,
		callIndex: number,
	) => Effect.Effect<StoredEvent, EventStoreError | SqlError>;
	readonly projectEffect?: (
		event: StoredEvent,
		callIndex: number,
	) => Effect.Effect<void, ProjectionRunnerError | SqlError>;
	readonly projectBatchEffect?: (
		events: readonly StoredEvent[],
		callIndex: number,
	) => Effect.Effect<void, ProjectionRunnerError | SqlError>;
}) {
	const appended: CanonicalEvent[] = [];
	const projected: StoredEvent[] = [];
	const batchProjected: StoredEvent[] = [];
	let projectBatchCallIndex = 0;
	const append = vi.fn((event: CanonicalEvent) => {
		appended.push(event);
		const stored = {
			...event,
			sequence: appended.length,
			streamVersion: appended.length - 1,
		} as StoredEvent;
		return (
			options?.appendEffect?.(event, stored, appended.length) ??
			Effect.succeed(stored)
		);
	});
	const appendBatch = vi.fn((events: readonly CanonicalEvent[]) =>
		Effect.forEach(events, append),
	);
	const projectEvent = vi.fn((event: StoredEvent) =>
		Effect.suspend(() => {
			projected.push(event);
			return (
				options?.projectEffect?.(event, projected.length) ?? Effect.void
			).pipe(
				Effect.as({
					version: event.sequence,
					projectIds: [event.projectId],
					sessionIds: [event.sessionId],
					removedSessionIds: [],
					collections: ["messages"] as const,
				}),
			);
		}),
	);
	const projectBatch = vi.fn(
		(events: readonly StoredEvent[], endedRunEvents?: Set<string>) => {
			projectBatchCallIndex += 1;
			projected.push(...events);
			batchProjected.push(...events);
			return (
				options?.projectBatchEffect?.(events, projectBatchCallIndex) ??
				Effect.void
			).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						for (const event of events)
							if (
								event.metadata.runId &&
								runTerminalStatus(event, event.provider)
							)
								endedRunEvents?.add(event.eventId);
					}),
				),
				Effect.as({
					version: events[events.length - 1]?.sequence ?? 0,
					projectIds: [...new Set(events.map((event) => event.projectId))],
					sessionIds: [...new Set(events.map((event) => event.sessionId))],
					removedSessionIds: [],
					collections: ["messages"] as const,
				}),
			);
		},
	);

	const eventStore = {
		projectId: "test-project",
		append,
		appendBatch,
		readFromSequence: vi.fn(() => Effect.succeed([])),
		readBySession: vi.fn(() => Effect.succeed([])),
		readAllBySession: vi.fn(() => Effect.succeed([])),
		getNextStreamVersion: vi.fn(() => Effect.succeed(0)),
	} satisfies EventStoreEffect;
	const projectionRunner = {
		projectEvent,
		projectBatch,
		recover: vi.fn(() =>
			Effect.succeed({
				projectId: "test-project",
				startCursor: 0,
				endCursor: 0,
				totalReplayed: 0,
				durationMs: 0,
			}),
		),
		getFailures: vi.fn(() => Effect.succeed([])),
		isRecovered: vi.fn(() => Effect.succeed(true)),
		markRecovered: vi.fn(() => Effect.void),
		nextVersion: Effect.succeed(0),
	} satisfies ProjectionRunnerEffect;

	const executeSql = vi.fn((strings: TemplateStringsArray) =>
		Effect.succeed(
			options?.existingSession &&
				strings.join("").includes("SELECT id FROM sessions")
				? [{ id: "session-123" }]
				: [],
		),
	);
	const sql = Object.assign(executeSql, {
		literal,
		transactionService: SqlClient.TransactionConnection(0),
	}) as unknown as SqlClient.SqlClient & {
		withTransaction: <A, E, R>(
			effect: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E, R>;
	};
	sql.withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect;

	const depsLayer = Layer.mergeAll(
		Layer.succeed(EventStoreEffectTag)(eventStore),
		Layer.succeed(ProjectionRunnerEffectTag)(projectionRunner),
		Layer.succeed(SqlClient.SqlClient)(sql),
	);
	const layer = ProviderRuntimeIngestionLive.pipe(Layer.provide(depsLayer));

	return {
		appended,
		projected,
		batchProjected,
		append,
		appendBatch,
		projectEvent,
		projectBatch,
		executeSql,
		depsLayer,
		layer,
	};
}

describe("ProviderRuntimeIngestion", () => {
	it("publishes only turn-ended alerts through the ingestion owner", async () => {
		const harness = makeHarness({ existingSession: true });
		const published: unknown[] = [];
		const layer = makeProviderRuntimeIngestionLive({
			relayPublisher: {
				publish: (message) =>
					Effect.sync(() => {
						published.push(message);
					}),
			},
		}).pipe(Layer.provide(harness.depsLayer));

		await Effect.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* ingestion.ingest(
					runtimeEvent({
						eventId: "runtime-text-delta",
						type: "text.delta",
						turnId: "turn-1",
						data: {
							messageId: "message-1",
							partId: "text-1",
							text: "hello",
						},
					}),
				);
				yield* ingestion.ingest(
					runtimeEvent({
						eventId: "runtime-turn-completed",
						type: "turn.completed",
						runId: "run-1",
						turnId: "turn-1",
						data: { messageId: "message-1" },
					}),
				);
				yield* ingestion.drain();
			}).pipe(Effect.provide(layer)),
		);

		expect(published).toEqual([
			{
				type: "done",
				sessionId: "session-123",
				code: 0,
				alertId: '["session-123","message-1","done"]',
			},
		]);
	});

	it("publishes committed stored events to the session event bus post-commit", async () => {
		const harness = makeHarness();
		const layer = ProviderRuntimeIngestionLive.pipe(
			Layer.provide(harness.depsLayer),
			Layer.provideMerge(SessionEventBusLive),
		);

		const received = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const bus = yield* SessionEventBusTag;
					// Subscribe before ingesting so the committed event buffers.
					const stream = yield* bus.subscribe({ sessionId: "session-123" });
					const ingestion = yield* ProviderRuntimeIngestionTag;
					yield* ingestion.ingest(
						runtimeEvent({
							eventId: "committed-1",
							type: "message.created",
							turnId: "turn-1",
							data: { messageId: "message-1", role: "assistant" },
						}),
					);
					return yield* stream.pipe(Stream.take(1), Stream.runCollect);
				}).pipe(Effect.provide(layer)),
			),
		);

		expect([...received]).toEqual([
			expect.objectContaining({ eventId: "committed-1", sequence: 1 }),
		]);
	});

	it.each([
		{
			name: "publishes to both sinks by default",
			options: undefined,
			expectedBusCalls: 1,
			expectedRelayCalls: 1,
		},
		{
			name: "publishes only to the bus when relay publishing is disabled",
			options: { publishToRelay: false },
			expectedBusCalls: 1,
			expectedRelayCalls: 0,
		},
		{
			name: "publishes only to the relay when bus publishing is disabled",
			options: { publishToBus: false },
			expectedBusCalls: 0,
			expectedRelayCalls: 1,
		},
	])("$name", async ({ options, expectedBusCalls, expectedRelayCalls }) => {
		const harness = makeHarness({ existingSession: true });
		const busPublish = vi.fn(() => Effect.void);
		const relayPublish = vi.fn(() => Effect.void);
		const busLayer = Layer.succeed(SessionEventBusTag)({
			publish: busPublish,
			publishAdvance: () => Effect.void,
			subscribe: () => Effect.succeed(Stream.empty),
			subscribeAdvances: () => Effect.succeed(Stream.empty),
		} satisfies SessionEventBus);
		const layer = makeProviderRuntimeIngestionLive({
			relayPublisher: { publish: relayPublish },
		}).pipe(Layer.provide(harness.depsLayer), Layer.provideMerge(busLayer));

		await Effect.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* ingestion.ingestBatch(
					[
						runtimeEvent({
							eventId: "publication-matrix-completed",
							type: "turn.completed",
							runId: "run-1",
							turnId: "turn-1",
							data: {
								messageId: "message-1",
							},
						}),
					],
					options,
				);
			}).pipe(Effect.provide(layer)),
		);

		expect(busPublish).toHaveBeenCalledTimes(expectedBusCalls);
		expect(relayPublish).toHaveBeenCalledTimes(expectedRelayCalls);
	});

	it("single stored events fail ingestion and do not publish when projectBatch fails", async () => {
		const harness = makeHarness({
			projectBatchEffect: () =>
				Effect.fail(
					new ProjectionRunnerError({
						operation: "projectBatch",
						cause: new Error("projection failed"),
					}),
				),
		});
		const busPublish = vi.fn(() => Effect.void);
		const relayPublish = vi.fn(() => Effect.void);
		const busLayer = Layer.succeed(SessionEventBusTag)({
			publish: busPublish,
			publishAdvance: () => Effect.void,
			subscribe: () => Effect.succeed(Stream.empty),
			subscribeAdvances: () => Effect.succeed(Stream.empty),
		} satisfies SessionEventBus);
		const layer = makeProviderRuntimeIngestionLive({
			relayPublisher: { publish: relayPublish },
		}).pipe(Layer.provide(harness.depsLayer), Layer.provideMerge(busLayer));

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				return yield* ingestion
					.ingest(
						runtimeEvent({
							eventId: "single-event-projection-failure",
							type: "message.created",
							turnId: "turn-1",
							data: {
								messageId: "message-1",
								role: "assistant",
							},
						}),
					)
					.pipe(Effect.result);
			}).pipe(Effect.provide(layer)),
		);

		expect(result._tag).toBe("Failure");
		expect(harness.projectBatch).toHaveBeenCalledTimes(1);
		expect(harness.projectBatch).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					eventId: "single-event-projection-failure",
					sequence: 1,
				}),
			],
			expect.any(Set),
			expect.any(Function),
		);
		expect(harness.projectEvent).not.toHaveBeenCalled();
		expect(busPublish).not.toHaveBeenCalled();
		expect(relayPublish).not.toHaveBeenCalled();
	});

	it("an interrupt cannot split ingestion projection from its bus signal", async () => {
		const publishStarted = await Effect.runPromise(Deferred.make<void>());
		const publishGate = await Effect.runPromise(Deferred.make<void>());
		const published: StoredEvent[] = [];
		let projectedCountAtPublish = 0;
		const harness = makeHarness();
		const busLayer = Layer.succeed(SessionEventBusTag)({
			publish: (events) =>
				Effect.gen(function* () {
					yield* Deferred.succeed(publishStarted, undefined);
					yield* Deferred.await(publishGate);
					published.push(...events);
				}),
			publishAdvance: () => Effect.void,
			subscribe: () => Effect.succeed(Stream.empty),
			subscribeAdvances: () => Effect.succeed(Stream.empty),
		} satisfies SessionEventBus);
		const layer = ProviderRuntimeIngestionLive.pipe(
			Layer.provide(harness.depsLayer),
			Layer.provideMerge(busLayer),
		);

		await Effect.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const fiber = yield* Effect.forkChild(
					ingestion.ingest(
						runtimeEvent({
							eventId: "interrupt-during-bus-publish",
							type: "message.created",
							turnId: "turn-1",
							data: {
								messageId: "message-1",
								role: "assistant",
							},
						}),
					),
				);

				yield* Deferred.await(publishStarted);
				projectedCountAtPublish = harness.projected.length;
				fiber.interruptUnsafe();
				yield* Effect.yieldNow;
				yield* Deferred.succeed(publishGate, undefined);
				yield* Fiber.await(fiber);
			}).pipe(Effect.provide(layer)),
		);

		expect(projectedCountAtPublish).toBe(1);
		expect(published).toEqual([
			expect.objectContaining({
				eventId: "interrupt-during-bus-publish",
				sequence: 1,
			}),
		]);
	});

	it("ingests related runtime events as one ordered domain-event batch", async () => {
		const harness = makeHarness();

		const written = await Effect.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				return yield* ingestion.ingestBatch([
					runtimeEvent({
						eventId: "runtime-session-created",
						type: "session.created",
						data: {
							sessionId: "session-123",
							title: "Untitled",
							provider: "claude",
						},
					}),
					runtimeEvent({
						eventId: "runtime-message-created",
						type: "message.created",
						turnId: "turn-1",
						data: {
							messageId: "message-1",
							role: "assistant",
						},
					}),
				]);
			}).pipe(Effect.provide(harness.layer)),
		);

		expect(written).toBe(2);
		expect(harness.appendBatch).toHaveBeenCalledTimes(1);
		expect(harness.appendBatch).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					eventId: "runtime-session-created",
					type: "session.created",
				}),
				expect.objectContaining({
					eventId: "runtime-message-created",
					type: "message.created",
				}),
			],
			undefined,
		);
		expect(harness.appended.map((event) => event.type)).toEqual([
			"session.created",
			"message.created",
		]);
	});

	it("persists an explicitly created session with its original timestamp", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* ingestion.ingest(
					runtimeEvent({
						eventId: "runtime-session-created",
						type: "session.created",
						data: {
							sessionId: "session-123",
							title: "Untitled",
							provider: "claude",
						},
					}),
				);
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT id, provider, title, created_at FROM sessions`,
				).toEqual([
					{
						id: "session-123",
						provider: "claude",
						title: "Untitled",
						created_at: Date.parse(BASE_EVENT.createdAt),
					},
				]);
				const store = yield* EventStoreEffectTag;
				expect(yield* store.readAllBySession("session-123")).toEqual([
					expect.objectContaining({ type: "session.created" }),
				]);
			}).pipe(
				Effect.provide(ProviderRuntimeIngestionLive),
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
		);
	});

	it("seeds a session row for a session it never saw created", async () => {
		const harness = makeHarness();

		await Effect.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* ingestion.ingest(
					runtimeEvent({
						eventId: "runtime-subagent-message",
						sessionId: "subagent-session",
						type: "message.created",
						turnId: "turn-1",
						data: {
							messageId: "message-1",
							role: "assistant",
						},
					}),
				);
				yield* ingestion.drain();
			}).pipe(Effect.provide(harness.layer)),
		);

		// Claude subagents stream under an id Conduit never created. Without the
		// row the message projector trips sessions(id) and the message is lost.
		const queries = harness.executeSql.mock.calls as unknown as [
			TemplateStringsArray,
			...unknown[],
		][];
		const seedCalls = queries.filter(([fragment]) =>
			fragment.join("?").includes("INSERT OR IGNORE INTO sessions"),
		);
		expect(seedCalls).toHaveLength(1);
		const seed = seedCalls[0];
		if (!seed) throw new Error("No session seed");
		const [fragment, ...values] = seed;
		expect(fragment.join("?")).toContain("INSERT OR IGNORE INTO sessions");
		expect(values).toEqual(
			expect.arrayContaining(["subagent-session", "claude"]),
		);
		expect(
			harness.executeSql.mock.invocationCallOrder[queries.indexOf(seed)],
		).toBeLessThan(harness.projectBatch.mock.invocationCallOrder[0] as number);
	});

	it("appends mapped domain events and projects the stored events eagerly", async () => {
		const harness = makeHarness();

		await Effect.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* ingestion.ingest(
					runtimeEvent({
						eventId: "runtime-event-1",
						type: "message.created",
						turnId: "turn-1",
						data: {
							messageId: "message-1",
							role: "assistant",
						},
					}),
				);
				yield* ingestion.drain();
			}).pipe(Effect.provide(harness.layer)),
		);

		expect(harness.append).toHaveBeenCalledTimes(1);
		expect(harness.appendBatch).toHaveBeenCalledTimes(1);
		expect(harness.appended).toEqual([
			expect.objectContaining({
				eventId: "runtime-event-1",
				type: "message.created",
				sessionId: "session-123",
				provider: "claude",
				data: expect.objectContaining({
					messageId: "message-1",
					role: "assistant",
				}),
				metadata: {},
			}),
		]);
		expect(harness.projectBatch).toHaveBeenCalledTimes(1);
		expect(harness.projectEvent).not.toHaveBeenCalled();
		expect(harness.batchProjected).toEqual([
			expect.objectContaining({
				eventId: "runtime-event-1",
				sequence: 1,
				streamVersion: 0,
			}),
		]);
	});

	it("keeps mapper state scoped by session and turn across ingest calls", async () => {
		const harness = makeHarness();

		await Effect.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				for (const event of [
					runtimeEvent({
						eventId: "session-a-turn-1-message",
						sessionId: "session-a",
						type: "message.created",
						turnId: "turn-1",
						data: { messageId: "message-a1", role: "assistant" },
					}),
					runtimeEvent({
						eventId: "session-a-turn-2-message",
						sessionId: "session-a",
						type: "message.created",
						turnId: "turn-2",
						data: { messageId: "message-a2", role: "assistant" },
					}),
					runtimeEvent({
						eventId: "session-b-turn-1-message",
						sessionId: "session-b",
						type: "message.created",
						turnId: "turn-1",
						data: { messageId: "message-b1", role: "assistant" },
					}),
					runtimeEvent({
						eventId: "session-a-turn-1-thinking",
						sessionId: "session-a",
						type: "thinking.start",
						turnId: "turn-1",
						data: { partId: "thinking-a1" },
					}),
					runtimeEvent({
						eventId: "session-a-turn-2-tool",
						sessionId: "session-a",
						type: "tool.started",
						turnId: "turn-2",
						data: {
							partId: "tool-a2",
							toolName: "Bash",
							input: { command: "pwd" },
						},
					}),
					runtimeEvent({
						eventId: "session-b-turn-1-thinking",
						sessionId: "session-b",
						type: "thinking.start",
						turnId: "turn-1",
						data: { partId: "thinking-b1" },
					}),
				]) {
					yield* ingestion.ingest(event);
				}
				yield* ingestion.drain();
			}).pipe(Effect.provide(harness.layer)),
		);

		expect(
			harness.appended.map((event) => ({
				eventId: event.eventId,
				type: event.type,
				data: event.data,
			})),
		).toEqual([
			expect.objectContaining({
				eventId: "session-a-turn-1-message",
				type: "message.created",
				data: expect.objectContaining({ messageId: "message-a1" }),
			}),
			expect.objectContaining({
				eventId: "session-a-turn-2-message",
				type: "message.created",
				data: expect.objectContaining({ messageId: "message-a2" }),
			}),
			expect.objectContaining({
				eventId: "session-b-turn-1-message",
				type: "message.created",
				data: expect.objectContaining({ messageId: "message-b1" }),
			}),
			{
				eventId: "session-a-turn-1-thinking",
				type: "thinking.start",
				data: {
					messageId: "message-a1",
					partId: "thinking-a1",
				},
			},
			expect.objectContaining({
				eventId: "session-a-turn-2-tool",
				type: "tool.started",
				data: expect.objectContaining({
					messageId: "message-a2",
					partId: "tool-a2",
				}),
			}),
			{
				eventId: "session-b-turn-1-thinking",
				type: "thinking.start",
				data: {
					messageId: "message-b1",
					partId: "thinking-b1",
				},
			},
		]);
	});

	it("does not append or project events that map to no durable domain event", async () => {
		const harness = makeHarness();

		await Effect.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* ingestion.ingest(
					runtimeEvent({
						eventId: "provider-change-without-payload",
						type: "session.provider_changed",
						data: {},
					}),
				);
				yield* ingestion.drain();
			}).pipe(Effect.provide(harness.layer)),
		);

		expect(harness.append).not.toHaveBeenCalled();
		expect(harness.appendBatch).not.toHaveBeenCalled();
		expect(harness.projectEvent).not.toHaveBeenCalled();
	});

	it("serializes concurrent ingestion so stateful follow-up events see prior accepted output", async () => {
		const firstAppendStarted = await Effect.runPromise(Deferred.make<void>());
		const releaseFirstAppend = await Effect.runPromise(Deferred.make<void>());
		const harness = makeHarness({
			appendEffect: (_event, stored, callIndex) => {
				if (callIndex !== 1) return Effect.succeed(stored);
				return Effect.gen(function* () {
					yield* Deferred.succeed(firstAppendStarted, undefined);
					yield* Deferred.await(releaseFirstAppend);
					return stored;
				});
			},
		});

		await Effect.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const first = yield* ingestion
					.ingest(
						runtimeEvent({
							eventId: "message-start",
							type: "message.created",
							turnId: "turn-1",
							data: {
								messageId: "message-1",
								role: "assistant",
							},
						}),
					)
					.pipe(Effect.forkChild);
				yield* Deferred.await(firstAppendStarted);
				const second = yield* ingestion
					.ingest(
						runtimeEvent({
							eventId: "thinking-start",
							type: "thinking.start",
							turnId: "turn-1",
							data: {
								partId: "thinking-1",
							},
						}),
					)
					.pipe(Effect.forkChild);

				expect(harness.append).toHaveBeenCalledTimes(1);
				yield* Deferred.succeed(releaseFirstAppend, undefined);
				yield* Fiber.join(first);
				yield* Fiber.join(second);
				yield* ingestion.drain();
			}).pipe(Effect.provide(harness.layer)),
		);

		expect(harness.appended).toEqual([
			expect.objectContaining({
				eventId: "message-start",
				type: "message.created",
			}),
			expect.objectContaining({
				eventId: "thinking-start",
				type: "thinking.start",
				data: {
					messageId: "message-1",
					partId: "thinking-1",
				},
			}),
		]);
	});

	it("does not advance mapper state when eager projection fails", async () => {
		const harness = makeHarness({
			projectBatchEffect: (_events, callIndex) =>
				callIndex === 1
					? Effect.fail(
							new ProjectionRunnerError({
								operation: "projectBatch",
								cause: new Error("projection failed"),
							}),
						)
					: Effect.void,
		});

		await Effect.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* ingestion
					.ingest(
						runtimeEvent({
							eventId: "message-start",
							type: "message.created",
							turnId: "turn-1",
							data: {
								messageId: "message-1",
								role: "assistant",
							},
						}),
					)
					.pipe(Effect.result);
				yield* ingestion.ingest(
					runtimeEvent({
						eventId: "thinking-start",
						type: "thinking.start",
						turnId: "turn-1",
						data: {
							partId: "thinking-1",
						},
					}),
				);
				yield* ingestion.drain();
			}).pipe(Effect.provide(harness.layer)),
		);

		expect(harness.appended).toEqual([
			expect.objectContaining({
				eventId: "message-start",
				type: "message.created",
			}),
			expect.objectContaining({
				eventId: "thinking-start",
				type: "thinking.start",
				data: {
					messageId: "provider-message-123",
					partId: "thinking-1",
				},
			}),
		]);
		expect(harness.projectBatch).toHaveBeenCalledTimes(2);
		expect(harness.projectEvent).not.toHaveBeenCalled();
	});

	it("appends all domain events from one runtime event as a single durable batch", async () => {
		const harness = makeHarness();

		await Effect.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* ingestion.ingest(
					runtimeEvent({
						eventId: "tool-completed-without-start",
						type: "tool.completed",
						turnId: "turn-1",
						data: {
							messageId: "message-1",
							partId: "tool-1",
							toolName: "Bash",
							input: { command: "pwd" },
							result: "ok",
						},
					}),
				);
			}).pipe(Effect.provide(harness.layer)),
		);

		expect(harness.appendBatch).toHaveBeenCalledTimes(1);
		expect(harness.appendBatch).toHaveBeenCalledWith(
			[
				expect.objectContaining({ type: "tool.started" }),
				expect.objectContaining({ type: "tool.completed" }),
			],
			undefined,
		);
		expect(harness.appended.map((event) => event.type)).toEqual([
			"tool.started",
			"tool.completed",
		]);
	});
});
