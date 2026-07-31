import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Chunk, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	decodeProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	makeProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	type SessionEventBus,
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	type EventStoreEffect,
	EventStoreEffectTag,
	type EventStoreError,
} from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	type ProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
	ProjectionRunnerError,
} from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import type {
	CanonicalEvent,
	StoredEvent,
} from "../../../src/lib/persistence/events.js";

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

function makeHarness(options?: {
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
	const projectEvent = vi.fn((event: StoredEvent) => {
		projected.push(event);
		return options?.projectEffect?.(event, projected.length) ?? Effect.void;
	});
	const projectBatch = vi.fn((events: readonly StoredEvent[]) => {
		projectBatchCallIndex += 1;
		projected.push(...events);
		batchProjected.push(...events);
		return (
			options?.projectBatchEffect?.(events, projectBatchCallIndex) ??
			Effect.void
		);
	});

	const eventStore = {
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
				startCursor: 0,
				endCursor: 0,
				totalReplayed: 0,
				durationMs: 0,
			}),
		),
		getFailures: vi.fn(() => Effect.succeed([])),
		isRecovered: vi.fn(() => Effect.succeed(true)),
		markRecovered: vi.fn(() => Effect.void),
	} satisfies ProjectionRunnerEffect;

	const executeSql = vi.fn(() => Effect.succeed([]));
	const sql = executeSql as unknown as SqlClient.SqlClient & {
		withTransaction: <A, E, R>(
			effect: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E, R>;
	};
	sql.withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect;

	const depsLayer = Layer.mergeAll(
		Layer.succeed(EventStoreEffectTag, eventStore),
		Layer.succeed(ProjectionRunnerEffectTag, projectionRunner),
		Layer.succeed(SqlClient.SqlClient, sql),
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
	it("publishes ingested provider output to relay clients through the ingestion owner", async () => {
		const harness = makeHarness();
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
				yield* ingestion.drain();
			}).pipe(Effect.provide(layer)),
		);

		expect(published).toEqual([
			{
				type: "delta",
				sessionId: "session-123",
				text: "hello",
				messageId: "message-1",
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

		expect(Chunk.toReadonlyArray(received)).toEqual([
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
		const harness = makeHarness();
		const busPublish = vi.fn(() => Effect.void);
		const relayPublish = vi.fn(() => Effect.void);
		const busLayer = Layer.succeed(SessionEventBusTag, {
			publish: busPublish,
			subscribe: () => Effect.succeed(Stream.empty),
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
							eventId: "publication-matrix-delta",
							type: "text.delta",
							turnId: "turn-1",
							data: {
								messageId: "message-1",
								partId: "text-1",
								text: "hello",
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
		const busLayer = Layer.succeed(SessionEventBusTag, {
			publish: busPublish,
			subscribe: () => Effect.succeed(Stream.empty),
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
					.pipe(Effect.either);
			}).pipe(Effect.provide(layer)),
		);

		expect(result._tag).toBe("Left");
		expect(harness.projectBatch).toHaveBeenCalledTimes(1);
		expect(harness.projectBatch).toHaveBeenCalledWith([
			expect.objectContaining({
				eventId: "single-event-projection-failure",
				sequence: 1,
			}),
		]);
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
		const busLayer = Layer.succeed(SessionEventBusTag, {
			publish: (events) =>
				Effect.gen(function* () {
					yield* Deferred.succeed(publishStarted, undefined);
					yield* Deferred.await(publishGate);
					published.push(...events);
				}),
			subscribe: () => Effect.succeed(Stream.empty),
		} satisfies SessionEventBus);
		const layer = ProviderRuntimeIngestionLive.pipe(
			Layer.provide(harness.depsLayer),
			Layer.provideMerge(busLayer),
		);

		await Effect.runPromise(
			Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const fiber = yield* Effect.fork(
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
				yield* Fiber.interruptFork(fiber);
				yield* Effect.yieldNow();
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
		expect(harness.appendBatch).toHaveBeenCalledWith([
			expect.objectContaining({
				eventId: "runtime-session-created",
				type: "session.created",
			}),
			expect.objectContaining({
				eventId: "runtime-message-created",
				type: "message.created",
			}),
		]);
		expect(harness.appended.map((event) => event.type)).toEqual([
			"session.created",
			"message.created",
		]);
	});

	it("does not pre-seed session projection rows for session.created", async () => {
		const harness = makeHarness();

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
			}).pipe(Effect.provide(harness.layer)),
		);

		expect(harness.appendBatch).toHaveBeenCalledTimes(1);
		expect(harness.appended).toEqual([
			expect.objectContaining({ type: "session.created" }),
		]);
		expect(harness.executeSql).not.toHaveBeenCalled();
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
				metadata: {
					providerRuntimeEventId: "runtime-event-1",
					rawSource: "claude.sdk.message",
					providerRefs: BASE_EVENT.providerRefs,
				},
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
		expect(harness.appendBatch).toHaveBeenCalledWith([]);
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
					.pipe(Effect.fork);
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
					.pipe(Effect.fork);

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

	it("advances mapper state after append even when eager projection fails", async () => {
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
					.pipe(Effect.either);
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
					messageId: "message-1",
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
		expect(harness.appendBatch).toHaveBeenCalledWith([
			expect.objectContaining({ type: "tool.started" }),
			expect.objectContaining({ type: "tool.completed" }),
		]);
		expect(harness.appended.map((event) => event.type)).toEqual([
			"tool.started",
			"tool.completed",
		]);
	});
});
