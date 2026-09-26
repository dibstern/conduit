// ─── Effect Projectors + Event Store Tests ──────────────────────────────────
// Tests the @effect/sql migration of projectors, event-store, cursor repo,
// and projection runner using file-backed SQLite via @effect/sql-sqlite-node.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	EventStoreEffectTag,
	EventStoreError,
	makeEventStoreEffect,
} from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import {
	makeProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
	ProjectionRunnerError,
} from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	makeProjectorCursorEffect,
	ProjectorCursorEffectTag,
} from "../../../src/lib/persistence/effect/projector-cursor-effect.js";
import {
	createAllEffectProjectors,
	type EffectProjector,
	type ProjectionContext,
	ProjectionError,
} from "../../../src/lib/persistence/effect/projectors-effect.js";
import { SessionStateProjectionNotifierTag } from "../../../src/lib/persistence/effect/session-state-projection-notifier.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	createEventId,
	type EventId,
	type EventMetadata,
	type StoredEvent,
} from "../../../src/lib/persistence/events.js";
import resumedTurnEvents from "../../fixtures/claude-resumed-turn.json" with {
	type: "json",
};

// ─── Test helpers ───────────────────────────────────────────────────────────

const FIXED_TS = 1_000_000_000_000;

function makeSessionCreated(
	sessionId: string,
	opts?: {
		eventId?: EventId;
		metadata?: EventMetadata;
		createdAt?: number;
		parentId?: string;
		providerSessionId?: string;
		title?: string;
		provider?: string;
	},
): CanonicalEvent {
	return canonicalEvent(
		"session.created",
		sessionId,
		{
			sessionId,
			title: opts?.title ?? "Test Session",
			provider: opts?.provider ?? "opencode",
			...(opts?.parentId !== undefined ? { parentId: opts.parentId } : {}),
			...(opts?.providerSessionId !== undefined
				? { providerSessionId: opts.providerSessionId }
				: {}),
		},
		{
			eventId: opts?.eventId ?? createEventId(),
			metadata: opts?.metadata ?? {},
			createdAt: opts?.createdAt ?? FIXED_TS,
		},
	);
}

function makeMessageCreated(
	sessionId: string,
	messageId: string,
	opts?: { role?: "user" | "assistant"; createdAt?: number },
): CanonicalEvent {
	return canonicalEvent(
		"message.created",
		sessionId,
		{
			messageId,
			role: opts?.role ?? "assistant",
			sessionId,
		},
		{
			eventId: createEventId(),
			metadata: {},
			createdAt: opts?.createdAt ?? FIXED_TS,
		},
	);
}

function makeTextDelta(
	sessionId: string,
	messageId: string,
	text: string,
	opts?: { partId?: string; createdAt?: number },
): CanonicalEvent {
	return canonicalEvent(
		"text.delta",
		sessionId,
		{
			messageId,
			partId: opts?.partId ?? "p1",
			text,
		},
		{
			eventId: createEventId(),
			metadata: {},
			createdAt: opts?.createdAt ?? FIXED_TS,
		},
	);
}

function makeToolStarted(
	sessionId: string,
	messageId: string,
	partId: string,
): CanonicalEvent {
	return canonicalEvent(
		"tool.started",
		sessionId,
		{
			messageId,
			partId,
			toolName: "Task",
			callId: partId,
			input: { tool: "Task", description: "Audit", prompt: "Go" },
		},
		{
			eventId: createEventId(),
			metadata: {},
			createdAt: FIXED_TS,
		},
	);
}

function makeToolRunning(
	sessionId: string,
	messageId: string,
	partId: string,
	metadata?: Record<string, unknown>,
): CanonicalEvent {
	return canonicalEvent(
		"tool.running",
		sessionId,
		{
			messageId,
			partId,
			...(metadata !== undefined ? { metadata } : {}),
		},
		{
			eventId: createEventId(),
			metadata: {},
			createdAt: FIXED_TS,
		},
	);
}

function makeToolCompleted(
	sessionId: string,
	messageId: string,
	partId: string,
	metadata?: Record<string, unknown>,
): CanonicalEvent {
	return canonicalEvent(
		"tool.completed",
		sessionId,
		{
			messageId,
			partId,
			result: "done",
			duration: 150,
			...(metadata !== undefined ? { metadata } : {}),
		},
		{
			eventId: createEventId(),
			metadata: {},
			createdAt: FIXED_TS,
		},
	);
}

function makeFileAttached(
	sessionId: string,
	messageId: string,
	partId: string,
): CanonicalEvent {
	return canonicalEvent(
		"file.attached",
		sessionId,
		{
			messageId,
			partId,
			mime: "image/png",
			filename: "screenshot.png",
			url: "data:image/png;base64,AAAA",
		},
		{
			eventId: createEventId(),
			metadata: {},
			createdAt: FIXED_TS,
		},
	);
}

function makeSessionStatus(
	sessionId: string,
	status: "idle" | "busy" | "error",
	opts?: { createdAt?: number },
): CanonicalEvent {
	return canonicalEvent(
		"session.status",
		sessionId,
		{
			sessionId,
			status,
		},
		{
			eventId: createEventId(),
			metadata: {},
			createdAt: opts?.createdAt ?? FIXED_TS,
		},
	);
}

function makeTurnModelResolved(
	sessionId: string,
	actualModel: string,
	opts?: {
		requestedModel?: string;
		expectedModel?: string;
		createdAt?: number;
	},
): CanonicalEvent {
	return canonicalEvent(
		"turn.model_resolved",
		sessionId,
		{
			...(opts?.requestedModel !== undefined
				? { requestedModel: opts.requestedModel }
				: {}),
			...(opts?.expectedModel !== undefined
				? { expectedModel: opts.expectedModel }
				: {}),
			actualModel,
		},
		{
			eventId: createEventId(),
			metadata: {},
			createdAt: opts?.createdAt ?? FIXED_TS,
		},
	);
}

function makePermissionAsked(
	sessionId: string,
	id: string,
	toolName: string,
	opts?: { createdAt?: number },
): CanonicalEvent {
	return canonicalEvent(
		"permission.asked",
		sessionId,
		{
			id,
			sessionId,
			toolName,
			input: { test: true },
		},
		{
			eventId: createEventId(),
			metadata: {},
			createdAt: opts?.createdAt ?? FIXED_TS,
		},
	);
}

function makePermissionResolved(
	sessionId: string,
	id: string,
	decision: "once" | "always" | "reject",
	opts?: { createdAt?: number },
): CanonicalEvent {
	return canonicalEvent(
		"permission.resolved",
		sessionId,
		{
			id,
			decision,
		},
		{
			eventId: createEventId(),
			metadata: {},
			createdAt: opts?.createdAt ?? FIXED_TS,
		},
	);
}

// ─── Test layer: SQLite with fresh schema ───────────────────────────────────

function makeTestSqliteLayer() {
	const dir = mkdtempSync(join(tmpdir(), "conduit-projectors-effect-"));
	const filename = join(dir, "events.db");
	return SqliteNode.layer({ filename }).pipe(
		Layer.provide(Reactivity.layer),
		Layer.merge(
			Layer.scopedDiscard(
				Effect.addFinalizer(() =>
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			),
		),
	);
}

function makeFileSqliteLayer(filename: string) {
	return SqliteNode.layer({ filename }).pipe(Layer.provide(Reactivity.layer));
}

function makeEventStoreLayerForFile(filename: string) {
	const sqliteLayer = makeFileSqliteLayer(filename);
	const eventStoreLayer = Layer.effect(
		EventStoreEffectTag,
		makeEventStoreEffect,
	).pipe(Layer.provide(sqliteLayer));
	return Layer.merge(sqliteLayer, eventStoreLayer);
}

// Combine: SQLite client + schema + service layers
const makeTestLayer = (
	projectors: readonly EffectProjector[] = createAllEffectProjectors(),
) => {
	const testSqliteLayer = makeTestSqliteLayer();
	const schemaLayer = Layer.effectDiscard(makeEffectSqlMigrator()).pipe(
		Layer.provide(testSqliteLayer),
	);
	const baseLayer = Layer.merge(testSqliteLayer, schemaLayer);

	const eventStoreLayer = Layer.effect(
		EventStoreEffectTag,
		makeEventStoreEffect,
	).pipe(Layer.provide(baseLayer));

	const cursorLayer = Layer.effect(
		ProjectorCursorEffectTag,
		makeProjectorCursorEffect,
	).pipe(Layer.provide(baseLayer));

	const projectionRunnerLayer = Layer.effect(
		ProjectionRunnerEffectTag,
		makeProjectionRunnerEffect(projectors),
	).pipe(Layer.provide(Layer.merge(cursorLayer, baseLayer)));

	return Layer.mergeAll(
		baseLayer,
		eventStoreLayer,
		cursorLayer,
		projectionRunnerLayer,
	);
};

// Helper to run an Effect in the test context
function runTest<A, E>(
	effect: Effect.Effect<
		A,
		E,
		| SqlClient.SqlClient
		| EventStoreEffectTag
		| ProjectorCursorEffectTag
		| ProjectionRunnerEffectTag
	>,
): Promise<A> {
	const layer = makeTestLayer();
	return Effect.runPromise(Effect.provide(effect, layer));
}

function runTestWithProjectors<A, E>(
	projectors: readonly EffectProjector[],
	effect: Effect.Effect<
		A,
		E,
		| SqlClient.SqlClient
		| EventStoreEffectTag
		| ProjectorCursorEffectTag
		| ProjectionRunnerEffectTag
	>,
): Promise<A> {
	const layer = makeTestLayer(projectors);
	return Effect.runPromise(Effect.provide(effect, layer));
}

function runWithSqliteFile<A, E>(
	filename: string,
	effect: Effect.Effect<A, E, SqlClient.SqlClient>,
): Promise<A> {
	return Effect.runPromise(
		Effect.provide(effect, makeFileSqliteLayer(filename)),
	);
}

function appendWithIndependentStore(filename: string, event: CanonicalEvent) {
	return Effect.provide(
		Effect.gen(function* () {
			const store = yield* EventStoreEffectTag;
			return yield* store.append(event);
		}),
		makeEventStoreLayerForFile(filename),
	);
}

// Helper to seed a session row directly
function seedSession(sessionId: string, createdAt: number = FIXED_TS) {
	return Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
			VALUES (${sessionId}, 'opencode', 'Test Session', 'idle', ${createdAt}, ${createdAt})`;
	});
}

function insertRawEventRow(opts: {
	sessionId: string;
	type?: string;
	data: string;
	metadata?: string;
	eventId?: EventId;
	streamVersion?: number;
	provider?: string;
	createdAt?: number;
}) {
	return Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			INSERT INTO events (
				event_id, session_id, stream_version, type, data, metadata, provider, created_at
			) VALUES (
				${opts.eventId ?? createEventId()},
				${opts.sessionId},
				${opts.streamVersion ?? 0},
				${opts.type ?? "session.created"},
				${opts.data},
				${opts.metadata ?? "{}"},
				${opts.provider ?? "opencode"},
				${opts.createdAt ?? FIXED_TS}
			)`;
	});
}

// ─── Event Store Tests ──────────────────────────────────────────────────────

describe("EventStoreEffect", () => {
	it("appends an event and returns it with sequence and streamVersion", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s1");
				const event = makeSessionCreated("s1");
				const stored = yield* store.append(event);
				expect(stored.sequence).toBe(1);
				expect(stored.streamVersion).toBe(0);
				expect(stored.eventId).toBe(event.eventId);
				expect(stored.type).toBe("session.created");
				expect(stored.sessionId).toBe("s1");
			}),
		));

	it("append returns typed EventStoreError for schema-invalid payloads", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s-invalid-append");
				const event = {
					...makeSessionCreated("s-invalid-append"),
					data: {
						sessionId: "s-invalid-append",
						provider: "opencode",
					},
				} as unknown as CanonicalEvent;

				const result = yield* Effect.either(store.append(event));

				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					const error = result.left;
					expect(error).toBeInstanceOf(EventStoreError);
					if (error instanceof EventStoreError) {
						expect(error.operation).toBe("validateCanonicalEvent");
					}
				}
			}),
		));

	it("append preserves extra payload and metadata fields while validating required shape", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const sql = yield* SqlClient.SqlClient;
				yield* seedSession("s-preserve-extra");
				const event = {
					...makeSessionCreated("s-preserve-extra", {
						metadata: { source: "test" },
					}),
					data: {
						sessionId: "s-preserve-extra",
						title: "Test Session",
						provider: "opencode",
						extraPayloadField: "kept",
					},
					metadata: {
						source: "test",
						extraMetadataField: "kept",
					},
				} as unknown as CanonicalEvent;

				const stored = yield* store.append(event);
				const rows = yield* sql<{ data: string; metadata: string }>`
					SELECT data, metadata FROM events WHERE session_id = 's-preserve-extra'
				`;

				expect(stored.data).toMatchObject({
					extraPayloadField: "kept",
				});
				expect(stored.metadata).toMatchObject({
					extraMetadataField: "kept",
				});
				expect(JSON.parse(rows[0]?.data ?? "{}")).toMatchObject({
					extraPayloadField: "kept",
				});
				expect(JSON.parse(rows[0]?.metadata ?? "{}")).toMatchObject({
					extraMetadataField: "kept",
				});
			}),
		));

	it("assigns incrementing stream versions per session", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s1");
				const e1 = yield* store.append(makeSessionCreated("s1"));
				const e2 = yield* store.append(makeTextDelta("s1", "m1", "hello"));
				const e3 = yield* store.append(makeTextDelta("s1", "m1", " world"));
				expect(e1.streamVersion).toBe(0);
				expect(e2.streamVersion).toBe(1);
				expect(e3.streamVersion).toBe(2);
			}),
		));

	it("assigns independent stream versions per session", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s1");
				yield* seedSession("s2");
				const e1 = yield* store.append(makeSessionCreated("s1"));
				const e2 = yield* store.append(makeSessionCreated("s2"));
				expect(e1.streamVersion).toBe(0);
				expect(e2.streamVersion).toBe(0);
				expect(e1.sequence).toBe(1);
				expect(e2.sequence).toBe(2);
			}),
		));

	it("readFromSequence returns events after the given sequence", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s1");
				yield* store.append(makeSessionCreated("s1"));
				yield* store.append(makeTextDelta("s1", "m1", "hello"));
				yield* store.append(makeTextDelta("s1", "m1", " world"));

				const results = yield* store.readFromSequence(1);
				expect(results.length).toBe(2);
				expect(results[0]?.sequence).toBe(2);
				expect(results[1]?.sequence).toBe(3);
			}),
		));

	it("decodes a valid row inserted directly into SQLite", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s-raw");
				yield* insertRawEventRow({
					sessionId: "s-raw",
					data: JSON.stringify({
						sessionId: "s-raw",
						title: "Raw Session",
						provider: "opencode",
					}),
				});

				const results = yield* store.readFromSequence(0);

				expect(results).toHaveLength(1);
				expect(results[0]?.type).toBe("session.created");
				expect(results[0]?.sessionId).toBe("s-raw");
				expect(results[0]?.data).toEqual({
					sessionId: "s-raw",
					title: "Raw Session",
					provider: "opencode",
				});
			}),
		));

	it("returns typed EventStoreError for invalid JSON in a stored row", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s-invalid-json");
				yield* insertRawEventRow({
					sessionId: "s-invalid-json",
					data: "{not json",
				});

				const result = yield* Effect.either(store.readFromSequence(0));

				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					const error = result.left;
					expect(error).toBeInstanceOf(EventStoreError);
					if (error instanceof EventStoreError) {
						expect(error.operation).toBe("decodeStoredEventRow");
					}
				}
			}),
		));

	it("returns typed EventStoreError for invalid metadata JSON in a stored row", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s-invalid-metadata-json");
				yield* insertRawEventRow({
					sessionId: "s-invalid-metadata-json",
					data: JSON.stringify({
						sessionId: "s-invalid-metadata-json",
						title: "Raw Session",
						provider: "opencode",
					}),
					metadata: "{not json",
				});

				const result = yield* Effect.either(store.readFromSequence(0));

				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					const error = result.left;
					expect(error).toBeInstanceOf(EventStoreError);
					if (error instanceof EventStoreError) {
						expect(error.operation).toBe("decodeStoredEventRow");
						expect(error.cause).toMatchObject({ field: "metadata" });
					}
				}
			}),
		));

	it("returns typed EventStoreError for schema-invalid stored payload", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s-invalid-shape");
				yield* insertRawEventRow({
					sessionId: "s-invalid-shape",
					data: JSON.stringify({
						sessionId: "s-invalid-shape",
					}),
				});

				const result = yield* Effect.either(store.readFromSequence(0));

				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					const error = result.left;
					expect(error).toBeInstanceOf(EventStoreError);
					if (error instanceof EventStoreError) {
						expect(error.operation).toBe("decodeStoredEventRow");
					}
				}
			}),
		));

	it("readBySession returns events for a specific session", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s1");
				yield* seedSession("s2");
				yield* store.append(makeSessionCreated("s1"));
				yield* store.append(makeSessionCreated("s2"));
				yield* store.append(makeTextDelta("s1", "m1", "hello"));

				const results = yield* store.readBySession("s1");
				expect(results.length).toBe(2);
				expect(results.every((e) => e.sessionId === "s1")).toBe(true);
			}),
		));

	it("appendBatch appends multiple events atomically", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s1");
				const events = [
					makeSessionCreated("s1"),
					makeTextDelta("s1", "m1", "hello"),
				];
				const results = yield* store.appendBatch(events);
				expect(results.length).toBe(2);
				expect(results[0]?.sequence).toBe(1);
				expect(results[1]?.sequence).toBe(2);
			}),
		));

	it("append observes stream versions advanced outside the service instance", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s-external-writer");
				yield* store.append(makeSessionCreated("s-external-writer"));
				yield* insertRawEventRow({
					sessionId: "s-external-writer",
					type: "message.created",
					data: JSON.stringify({
						messageId: "external-message",
						role: "assistant",
						sessionId: "s-external-writer",
					}),
					streamVersion: 1,
				});

				const stored = yield* store.append(
					makeTextDelta("s-external-writer", "external-message", "hello"),
				);

				expect(stored.streamVersion).toBe(2);
			}),
		));

	it("concurrent appends to one session receive unique contiguous stream versions", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s-concurrent-appends");
				const events = Array.from({ length: 10 }, (_, index) =>
					makeTextDelta("s-concurrent-appends", `m${index}`, `text ${index}`),
				);

				const stored = yield* Effect.forEach(
					events,
					(event) => store.append(event),
					{ concurrency: "unbounded" },
				);

				expect(
					stored.map((event) => event.streamVersion).sort((a, b) => a - b),
				).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
			}),
		));

	it("concurrent appends from independent store instances receive unique contiguous stream versions", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-projectors-shared-"));
		try {
			const filename = join(dir, "events.db");
			await runWithSqliteFile(
				filename,
				Effect.gen(function* () {
					yield* makeEffectSqlMigrator();
					yield* seedSession("s-independent-concurrent-appends");
				}),
			);
			const events = Array.from({ length: 10 }, (_, index) =>
				makeTextDelta(
					"s-independent-concurrent-appends",
					`m${index}`,
					`text ${index}`,
				),
			);

			const stored = await Effect.runPromise(
				Effect.forEach(
					events,
					(event) => appendWithIndependentStore(filename, event),
					{ concurrency: "unbounded" },
				),
			);

			expect(
				stored.map((event) => event.streamVersion).sort((a, b) => a - b),
			).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("appendBatch rolls back a schema-invalid batch", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s-batch-validation-rollback");
				const valid = makeSessionCreated("s-batch-validation-rollback");
				const invalid = {
					...makeTextDelta("s-batch-validation-rollback", "m1", "hello"),
					data: {
						messageId: "m1",
						partId: "p1",
					},
				} as unknown as CanonicalEvent;

				const batchResult = yield* Effect.either(
					store.appendBatch([valid, invalid]),
				);
				expect(batchResult._tag).toBe("Left");

				const stored = yield* store.append(
					makeSessionCreated("s-batch-validation-rollback"),
				);
				expect(stored.streamVersion).toBe(0);
			}),
		));

	it("appendBatch rolls back a serialization defect", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s-batch-defect-rollback");
				const valid = makeSessionCreated("s-batch-defect-rollback");
				const defect = {
					...canonicalEvent("tool.completed", "s-batch-defect-rollback", {
						messageId: "m1",
						partId: "p1",
						result: BigInt(1),
						duration: 1,
					}),
				} as unknown as CanonicalEvent;

				const batchExit = yield* Effect.exit(
					store.appendBatch([valid, defect]),
				);
				expect(batchExit._tag).toBe("Failure");

				const stored = yield* store.append(
					makeSessionCreated("s-batch-defect-rollback"),
				);
				expect(stored.streamVersion).toBe(0);
			}),
		));

	it("getNextStreamVersion returns 0 for new sessions", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s1");
				const version = yield* store.getNextStreamVersion("s1");
				expect(version).toBe(0);
			}),
		));

	it("getNextStreamVersion returns the version after existing events", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s1");
				yield* store.append(makeSessionCreated("s1"));
				yield* store.append(makeTextDelta("s1", "m1", "a"));
				expect(yield* store.getNextStreamVersion("s1")).toBe(2);
			}),
		));

	it("appends session.created before the session projection row exists", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const sql = yield* SqlClient.SqlClient;
				const stored = yield* store.append(makeSessionCreated("s1"));
				expect(stored.sequence).toBe(1);
				expect(stored.streamVersion).toBe(0);
				expect(stored.sessionId).toBe("s1");
				expect(yield* sql`SELECT id FROM sessions WHERE id = 's1'`).toEqual([]);
			}),
		));

	it("append rejects duplicate event IDs", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s1");
				const eventId = createEventId();
				yield* store.append(makeSessionCreated("s1", { eventId }));
				const duplicate = yield* Effect.either(
					store.append({ ...makeTextDelta("s1", "m1", "x"), eventId }),
				);
				expect(duplicate._tag).toBe("Left");
			}),
		));

	it("appendBatch assigns contiguous stream versions and rolls back on a duplicate event ID", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const sql = yield* SqlClient.SqlClient;
				yield* seedSession("s1");
				const stored = yield* store.appendBatch([
					makeSessionCreated("s1"),
					makeTextDelta("s1", "m1", "hello"),
					makeTextDelta("s1", "m1", " world"),
				]);
				expect(stored.map((e) => e.streamVersion)).toEqual([0, 1, 2]);

				yield* seedSession("s2");
				const shared = makeTextDelta("s2", "m2", "hello");
				const failed = yield* Effect.either(
					store.appendBatch([
						makeSessionCreated("s2"),
						shared,
						{ ...makeTextDelta("s2", "m2", "world"), eventId: shared.eventId },
					]),
				);
				expect(failed._tag).toBe("Left");
				expect(
					yield* sql`SELECT sequence FROM events WHERE session_id = 's2'`,
				).toEqual([]);
			}),
		));

	it("appendBatch returns nothing for empty input", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				expect(yield* store.appendBatch([])).toEqual([]);
			}),
		));

	it("readFromSequence honours limit, an exhausted cursor, and a negative cursor", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s1");
				for (let i = 0; i < 5; i++) {
					yield* store.append(makeTextDelta("s1", "m1", `chunk-${i}`));
				}
				expect(yield* store.readFromSequence(0, 3)).toHaveLength(3);
				expect(yield* store.readFromSequence(5, 10)).toEqual([]);
				expect(yield* store.readFromSequence(-1)).toHaveLength(5);
			}),
		));

	it("readBySession honours fromSequence and limit, and is empty for an unknown session", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s1");
				const first = yield* store.append(makeSessionCreated("s1"));
				for (let i = 0; i < 4; i++) {
					yield* store.append(makeTextDelta("s1", "m1", `chunk-${i}`));
				}
				expect(yield* store.readBySession("s1", first.sequence)).toHaveLength(
					4,
				);
				expect(yield* store.readBySession("s1", 0, 3)).toHaveLength(3);
				expect(yield* store.readBySession("s1", 0, 0)).toEqual([]);
				expect(yield* store.readBySession("nonexistent")).toEqual([]);
			}),
		));

	it("round-trips nested data, metadata, epoch-zero createdAt, and large payloads", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				yield* seedSession("s1");
				const toolStarted = canonicalEvent(
					"tool.started",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						toolName: "bash",
						callId: "call-1",
						input: {
							tool: "Unknown",
							name: "bash",
							raw: { command: "ls -la", nested: { deep: true } },
						},
					},
					{
						metadata: { commandId: "cmd_abc", adapterKey: "oc-main" },
						createdAt: 0,
					},
				);
				const largeText = "x".repeat(10_000);
				yield* store.append(toolStarted);
				yield* store.append(makeTextDelta("s1", "m1", largeText));

				const [tool, delta] = yield* store.readFromSequence(0);
				expect(tool?.data).toEqual(toolStarted.data);
				expect(tool?.metadata).toEqual(toolStarted.metadata);
				expect(tool?.createdAt).toBe(0);
				expect(delta?.data).toMatchObject({ text: largeText });
			}),
		));
});

// ─── Projector Cursor Tests ─────────────────────────────────────────────────

describe("ProjectorCursorEffect", () => {
	it("get returns undefined for unknown projectors", () =>
		runTest(
			Effect.gen(function* () {
				const cursor = yield* ProjectorCursorEffectTag;
				const result = yield* cursor.get("nonexistent");
				expect(result).toBeUndefined();
			}),
		));

	it("upsert + get round-trips correctly", () =>
		runTest(
			Effect.gen(function* () {
				const cursor = yield* ProjectorCursorEffectTag;
				yield* cursor.upsert("session", 42);
				const result = yield* cursor.get("session");
				expect(result).toBeDefined();
				expect(result?.projectorName).toBe("session");
				expect(result?.lastAppliedSeq).toBe(42);
				expect(result?.updatedAt).toBeGreaterThan(0);
			}),
		));

	it("upsert advances an existing cursor to a higher sequence", () =>
		runTest(
			Effect.gen(function* () {
				const cursor = yield* ProjectorCursorEffectTag;
				yield* cursor.upsert("session", 5);
				yield* cursor.upsert("session", 15);
				const result = yield* cursor.get("session");
				expect(result?.lastAppliedSeq).toBe(15);
			}),
		));

	it("upsert uses MAX for monotonic advancement", () =>
		runTest(
			Effect.gen(function* () {
				const cursor = yield* ProjectorCursorEffectTag;
				yield* cursor.upsert("session", 42);
				yield* cursor.upsert("session", 10); // lower — should not regress
				const result = yield* cursor.get("session");
				expect(result?.lastAppliedSeq).toBe(42);
			}),
		));

	it("listAll returns all cursors ordered by name", () =>
		runTest(
			Effect.gen(function* () {
				const cursor = yield* ProjectorCursorEffectTag;
				yield* cursor.upsert("activity", 5);
				yield* cursor.upsert("message", 10);
				yield* cursor.upsert("session", 15);
				const all = yield* cursor.listAll();
				expect(all.length).toBe(3);
				expect(all[0]?.projectorName).toBe("activity");
				expect(all[1]?.projectorName).toBe("message");
				expect(all[2]?.projectorName).toBe("session");
			}),
		));

	it("listAll returns nothing when no cursors exist", () =>
		runTest(
			Effect.gen(function* () {
				const cursor = yield* ProjectorCursorEffectTag;
				expect(yield* cursor.listAll()).toEqual([]);
			}),
		));

	it("minCursor returns the lowest cursor value", () =>
		runTest(
			Effect.gen(function* () {
				const cursor = yield* ProjectorCursorEffectTag;
				yield* cursor.upsert("session", 50);
				yield* cursor.upsert("message", 10);
				yield* cursor.upsert("activity", 30);
				const min = yield* cursor.minCursor();
				expect(min).toBe(10);
			}),
		));

	it("minCursor returns 0 when no cursors exist", () =>
		runTest(
			Effect.gen(function* () {
				const cursor = yield* ProjectorCursorEffectTag;
				const min = yield* cursor.minCursor();
				expect(min).toBe(0);
			}),
		));
});

// ─── Session Projector Tests ────────────────────────────────────────────────

describe("Effect Session Projector (via ProjectionRunner)", () => {
	it("session.created projects into sessions table", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				yield* seedSession("s1");
				const event = yield* store.append(makeSessionCreated("s1"));
				yield* runner.projectEvent(event);

				const rows = yield* sql<{
					id: string;
					title: string;
					status: string;
				}>`SELECT id, title, status FROM sessions WHERE id = 's1'`;
				expect(rows[0]?.title).toBe("Test Session");
				expect(rows[0]?.status).toBe("idle");
			}),
		));

	it("session.created writes parent and provider session ids, then preserves them when omitted", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				yield* seedSession("parent-session");
				yield* seedSession("claude-subagent-abc");
				const parent = yield* store.append(
					makeSessionCreated("parent-session", {
						provider: "claude",
						title: "Parent",
					}),
				);
				yield* runner.projectEvent(parent);
				const child = yield* store.append(
					makeSessionCreated("claude-subagent-abc", {
						provider: "claude",
						title: "Explore Agent",
						parentId: "parent-session",
						providerSessionId: "sdk-subagent-1",
					}),
				);
				yield* runner.projectEvent(child);
				const replayWithoutOptionals = yield* store.append(
					makeSessionCreated("claude-subagent-abc", {
						provider: "claude",
						title: "Explore Agent Updated",
					}),
				);
				yield* runner.projectEvent(replayWithoutOptionals);

				const rows = yield* sql<{
					title: string;
					parent_id: string | null;
					provider_sid: string | null;
				}>`
					SELECT title, parent_id, provider_sid FROM sessions WHERE id = 'claude-subagent-abc'`;
				expect(rows[0]).toEqual({
					title: "Explore Agent Updated",
					parent_id: "parent-session",
					provider_sid: "sdk-subagent-1",
				});
			}),
		));

	it("session.status updates the session status", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				yield* seedSession("s1");
				const e1 = yield* store.append(makeSessionCreated("s1"));
				yield* runner.projectEvent(e1);
				const e2 = yield* store.append(makeSessionStatus("s1", "busy"));
				yield* runner.projectEvent(e2);

				const rows = yield* sql<{
					status: string;
				}>`SELECT status FROM sessions WHERE id = 's1'`;
				expect(rows[0]?.status).toBe("busy");
			}),
		));

	it("session.permission_mode_changed updates only the target session", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				for (const sessionId of ["s1", "s2"]) {
					yield* seedSession(sessionId);
					const created = yield* store.append(
						makeSessionCreated(sessionId, { createdAt: FIXED_TS }),
					);
					yield* runner.projectEvent(created);
				}

				const changed = yield* store.append(
					canonicalEvent(
						"session.permission_mode_changed",
						"s1",
						{ sessionId: "s1", mode: "auto" },
						{ createdAt: FIXED_TS + 2500 },
					),
				);
				yield* runner.projectEvent(changed);

				const rows = yield* sql<{
					id: string;
					permission_mode: string | null;
					updated_at: number;
				}>`
					SELECT id, permission_mode, updated_at
					FROM sessions
					WHERE id IN ('s1', 's2')
					ORDER BY id`;
				expect(rows).toEqual([
					{
						id: "s1",
						permission_mode: "auto",
						updated_at: FIXED_TS + 2500,
					},
					{ id: "s2", permission_mode: null, updated_at: FIXED_TS },
				]);
			}),
		));

	it.each([
		["session.settled", "session.unsettled", "settled_at"],
		["session.pinned", "session.unpinned", "pinned_at"],
	] as const)("%s is deterministic across replay", (setType, clearType, column) =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				yield* seedSession("s1");
				const created = yield* store.append(makeSessionCreated("s1"));
				yield* runner.projectEvent(created);
				const set = yield* store.append(
					canonicalEvent(
						setType,
						"s1",
						{ sessionId: "s1" },
						{ createdAt: FIXED_TS + 100 },
					),
				);
				const clear = yield* store.append(
					canonicalEvent(
						clearType,
						"s1",
						{ sessionId: "s1" },
						{ createdAt: FIXED_TS + 200 },
					),
				);
				for (let replay = 0; replay < 2; replay++) {
					yield* runner.projectEvent(set);
					const afterSet = yield* sql<{
						settled_at: number | null;
						pinned_at: number | null;
						updated_at: number;
					}>`SELECT settled_at, pinned_at, updated_at FROM sessions WHERE id = 's1'`;
					expect(afterSet[0]?.[column]).toBe(FIXED_TS + 100);
					expect(afterSet[0]?.updated_at).toBe(FIXED_TS);
					yield* runner.projectEvent(clear);
					const afterClear = yield* sql<{
						settled_at: number | null;
						pinned_at: number | null;
						updated_at: number;
					}>`SELECT settled_at, pinned_at, updated_at FROM sessions WHERE id = 's1'`;
					expect(afterClear[0]?.[column]).toBeNull();
					expect(afterClear[0]?.updated_at).toBe(FIXED_TS);
				}
			}),
		));

	it("session read state is deterministic across replay", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				yield* seedSession("s1");
				const created = yield* store.append(makeSessionCreated("s1"));
				yield* runner.projectEvent(created);
				const read = yield* store.append(
					canonicalEvent(
						"session.read",
						"s1",
						{ sessionId: "s1" },
						{ createdAt: FIXED_TS + 100 },
					),
				);
				yield* runner.projectEvent(read);
				const unread = yield* store.append(
					canonicalEvent(
						"session.unread",
						"s1",
						{ sessionId: "s1" },
						{ createdAt: FIXED_TS + 200 },
					),
				);
				yield* runner.projectEvent(unread);

				const readAt = () =>
					sql<{ read_at: number | null }>`
						SELECT read_at FROM sessions WHERE id = 's1'`;
				expect((yield* readAt())[0]?.read_at).toBeNull();

				// Replaying the same log in the same order reaches the same state.
				// Order is the only thing these handlers rely on, and every replay
				// path is ORDER BY sequence ASC, so last transition wins.
				yield* runner.projectEvent(read);
				yield* runner.projectEvent(unread);
				expect((yield* readAt())[0]?.read_at).toBeNull();

				// Reading again after an unread is a real transition, not a stale
				// replay, and must take effect.
				yield* runner.projectEvent(read);
				expect((yield* readAt())[0]?.read_at).toBe(FIXED_TS + 100);
			}),
		));
});

// ─── Message Projector Tests ────────────────────────────────────────────────

describe("Effect Message Projector (via ProjectionRunner)", () => {
	it("message.created inserts a message row", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				yield* seedSession("s1");
				const e1 = yield* store.append(makeSessionCreated("s1"));
				yield* runner.projectEvent(e1);
				const e2 = yield* store.append(
					makeMessageCreated("s1", "m1", { role: "assistant" }),
				);
				yield* runner.projectEvent(e2);

				const rows = yield* sql<{
					id: string;
					role: string;
					is_streaming: number;
				}>`SELECT id, role, is_streaming FROM messages WHERE id = 'm1'`;
				expect(rows[0]?.role).toBe("assistant");
				expect(rows[0]?.is_streaming).toBe(1);
			}),
		));

	it("text.delta accumulates text on messages", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				yield* seedSession("s1");
				const e1 = yield* store.append(makeSessionCreated("s1"));
				yield* runner.projectEvent(e1);
				const e2 = yield* store.append(makeMessageCreated("s1", "m1"));
				yield* runner.projectEvent(e2);
				const e3 = yield* store.append(makeTextDelta("s1", "m1", "hello"));
				yield* runner.projectEvent(e3);
				const e4 = yield* store.append(makeTextDelta("s1", "m1", " world"));
				yield* runner.projectEvent(e4);

				const rows = yield* sql<{
					text: string;
				}>`SELECT text FROM messages WHERE id = 'm1'`;
				expect(rows[0]?.text).toBe("hello world");
			}),
		));

	it("tool.running merges metadata into message parts", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				yield* seedSession("s1");
				const e1 = yield* store.append(makeSessionCreated("s1"));
				yield* runner.projectEvent(e1);
				const e2 = yield* store.append(makeMessageCreated("s1", "m1"));
				yield* runner.projectEvent(e2);
				const e3 = yield* store.append(makeToolStarted("s1", "m1", "tool1"));
				yield* runner.projectEvent(e3);
				const e4 = yield* store.append(
					makeToolRunning("s1", "m1", "tool1", {
						childSessionId: "claude-subagent-abc",
						providerTaskId: "task-1",
					}),
				);
				yield* runner.projectEvent(e4);
				const e5 = yield* store.append(
					makeToolRunning("s1", "m1", "tool1", {
						sdkSubagentId: "agent-abc",
					}),
				);
				yield* runner.projectEvent(e5);
				const e6 = yield* store.append(makeToolRunning("s1", "m1", "tool1"));
				yield* runner.projectEvent(e6);

				const rows = yield* sql<{ status: string; metadata: string | null }>`
					SELECT status, metadata FROM message_parts WHERE id = 'tool1'`;
				expect(rows[0]?.status).toBe("running");
				expect(JSON.parse(rows[0]?.metadata ?? "{}")).toEqual({
					childSessionId: "claude-subagent-abc",
					providerTaskId: "task-1",
					sdkSubagentId: "agent-abc",
				});
			}),
		));

	it("tool.running does not reopen completed message parts", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				yield* seedSession("s1");
				const e1 = yield* store.append(makeSessionCreated("s1"));
				yield* runner.projectEvent(e1);
				const e2 = yield* store.append(makeMessageCreated("s1", "m1"));
				yield* runner.projectEvent(e2);
				const e3 = yield* store.append(makeToolStarted("s1", "m1", "tool1"));
				yield* runner.projectEvent(e3);
				const e4 = yield* store.append(makeToolCompleted("s1", "m1", "tool1"));
				yield* runner.projectEvent(e4);
				const e5 = yield* store.append(
					makeToolRunning("s1", "m1", "tool1", {
						childSessionId: "claude-subagent-abc",
						providerTaskId: "task-1",
					}),
				);
				yield* runner.projectEvent(e5);

				const rows = yield* sql<{ status: string; metadata: string | null }>`
					SELECT status, metadata FROM message_parts WHERE id = 'tool1'`;
				expect(rows[0]?.status).toBe("completed");
				expect(JSON.parse(rows[0]?.metadata ?? "{}")).toEqual({
					childSessionId: "claude-subagent-abc",
					providerTaskId: "task-1",
				});
			}),
		));

	it("tool.running replaces malformed metadata with the next valid metadata", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				yield* seedSession("s1");
				const e1 = yield* store.append(makeSessionCreated("s1"));
				yield* runner.projectEvent(e1);
				const e2 = yield* store.append(makeMessageCreated("s1", "m1"));
				yield* runner.projectEvent(e2);
				const e3 = yield* store.append(makeToolStarted("s1", "m1", "tool1"));
				yield* runner.projectEvent(e3);
				yield* sql`
					UPDATE message_parts SET metadata = '{not json' WHERE id = 'tool1'`;
				const e4 = yield* store.append(
					makeToolRunning("s1", "m1", "tool1", {
						providerTaskId: "task-1",
					}),
				);
				yield* runner.projectEvent(e4);

				const rows = yield* sql<{ metadata: string | null }>`
					SELECT metadata FROM message_parts WHERE id = 'tool1'`;
				expect(JSON.parse(rows[0]?.metadata ?? "{}")).toEqual({
					providerTaskId: "task-1",
				});
			}),
		));

	it("tool.completed merges metadata into message parts", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				yield* seedSession("s1");
				const e1 = yield* store.append(makeSessionCreated("s1"));
				yield* runner.projectEvent(e1);
				const e2 = yield* store.append(makeMessageCreated("s1", "m1"));
				yield* runner.projectEvent(e2);
				const e3 = yield* store.append(makeToolStarted("s1", "m1", "tool1"));
				yield* runner.projectEvent(e3);
				const e4 = yield* store.append(
					makeToolRunning("s1", "m1", "tool1", { providerTaskId: "task-1" }),
				);
				yield* runner.projectEvent(e4);
				const e5 = yield* store.append(
					makeToolCompleted("s1", "m1", "tool1", {
						sessionId: "ses-child",
					}),
				);
				yield* runner.projectEvent(e5);

				const rows = yield* sql<{ metadata: string | null }>`
					SELECT metadata FROM message_parts WHERE id = 'tool1'`;
				expect(JSON.parse(rows[0]?.metadata ?? "{}")).toEqual({
					providerTaskId: "task-1",
					sessionId: "ses-child",
				});
			}),
		));

	it("file.attached creates a file message part", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				yield* seedSession("s1");
				const e1 = yield* store.append(makeSessionCreated("s1"));
				yield* runner.projectEvent(e1);
				const e2 = yield* store.append(makeFileAttached("s1", "m1", "file1"));
				yield* runner.projectEvent(e2);

				const rows = yield* sql<{
					type: string;
					metadata: string | null;
				}>`SELECT type, metadata FROM message_parts WHERE id = 'file1'`;
				expect(rows[0]?.type).toBe("file");
				expect(JSON.parse(rows[0]?.metadata ?? "{}")).toEqual({
					mime: "image/png",
					filename: "screenshot.png",
					url: "data:image/png;base64,AAAA",
				});
			}),
		));
});

// ─── Turn Projector Tests ───────────────────────────────────────────────────

describe("Effect Turn Projector (via ProjectionRunner)", () => {
	// The persisted state after each recorded event, in fixture order. Only the
	// turn's own results finish it; anything that follows puts it back to work.
	const EXPECTED_STATE = [
		"pending", // 1. the user prompt opens the turn
		"running", // 2. the session goes busy
		"running", // 3. the first assistant message
		"completed", // 4. a result arrives, but Claude is not done
		"completed", // 5. idle
		"running", // 6. busy again, 68ms later
		"running", // 7. a second assistant message, same turn
		"running", // 8. thinking
		"running", // 9. a tool starts
		"running", // 10. the tool finishes
		"completed", // 11. the second execution reports its own result
		"running", // 12. a third assistant message, 15 minutes later
		"running", // 13. still working 45 minutes after the first "completion"
	];

	it("keeps one production turn running when Claude resumes after successive results", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const runner = yield* ProjectionRunnerEffectTag;
				const sessionId = "ses_c2d8cd521bc14f9f8f7700096bbf1d23";
				yield* seedSession(sessionId);
				yield* runner.markRecovered();
				for (const [index, recorded] of resumedTurnEvents.entries()) {
					// The export omits envelope fields unrelated to the regression.
					const event = {
						...recorded,
						eventId: `recorded-${recorded.sequence}`,
						sessionId,
						streamVersion: index,
						metadata: {},
					} as StoredEvent;
					yield* runner.projectEvent(event);
					const turns = yield* sql<{
						id: string;
					}>`SELECT id, state, assistant_message_id, completed_at, cost, tokens_in, tokens_out FROM turns`;
					// No user message follows, so all thirteen events are one turn.
					expect(turns).toHaveLength(1);
					expect(turns[0], `after event ${index + 1}`).toMatchObject({
						id: "52feab57-ed40-4885-b23b-71dcd78209a8",
						state: EXPECTED_STATE[index],
					});
					if (EXPECTED_STATE[index] === "running") {
						// Reopening has to clear the finish too, or every reader that
						// asks "when did this end" still sees a finished turn.
						expect(turns[0], `after event ${index + 1}`).toMatchObject({
							completed_at: null,
						});
					}
					if (event.type === "turn.completed") {
						expect(turns[0]).toMatchObject({
							assistant_message_id: event.data.messageId,
							completed_at: event.createdAt,
							// Cost is cumulative for the whole SDK session, so the latest
							// wins; tokens are per-execution, so the second result adds.
							cost: event.data.cost,
							tokens_in: index === 3 ? 2 : 4,
							tokens_out: index === 3 ? 2 : 3,
						});
					}
				}
				expect(yield* runner.getFailures()).toEqual([]);
			}),
		));

	it("preserves known accounting when a later execution omits usage", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				for (const event of [
					makeSessionCreated("s1"),
					makeMessageCreated("s1", "u1", { role: "user" }),
					makeMessageCreated("s1", "a1"),
					canonicalEvent("turn.completed", "s1", { messageId: "a1" }),
				])
					yield* runner.projectEvent(yield* store.append(event));
				expect(
					yield* sql`SELECT cost, tokens_in, tokens_out FROM turns`,
				).toEqual([{ cost: null, tokens_in: null, tokens_out: null }]);
				for (const event of [
					makeMessageCreated("s1", "a2"),
					canonicalEvent("turn.completed", "s1", {
						messageId: "a2",
						cost: 0.5,
						tokens: { input: 100, output: 20 },
					}),
					makeMessageCreated("s1", "a3"),
					canonicalEvent("turn.completed", "s1", {
						messageId: "a3",
						tokens: { output: 0 },
					}),
				])
					yield* runner.projectEvent(yield* store.append(event));
				expect(
					yield* sql`SELECT cost, tokens_in, tokens_out FROM turns`,
				).toEqual([{ cost: 0.5, tokens_in: 100, tokens_out: 20 }]);
			}),
		));

	it.each([
		"busy",
		"assistant",
		"tool",
	] as const)("reopens on %s, attaches the next execution, and keeps accounting straight through replay", (resume) =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				const events = [
					makeSessionCreated("s1"),
					makeMessageCreated("s1", "u1", { role: "user" }),
					makeMessageCreated("s1", "a1", { createdAt: FIXED_TS + 1 }),
					canonicalEvent(
						"turn.completed",
						"s1",
						{
							messageId: "a1",
							cost: 0.25,
							tokens: { input: 100, output: 20 },
						},
						{ createdAt: FIXED_TS + 2 },
					),
					canonicalEvent("session.status", "s1", {
						sessionId: "s1",
						status: "idle",
					}),
				];
				for (const event of events) {
					yield* runner.projectEvent(yield* store.append(event));
				}
				expect(yield* sql`SELECT state, completed_at FROM turns`).toEqual([
					{ state: "completed", completed_at: FIXED_TS + 2 },
				]);

				const activity =
					resume === "busy"
						? canonicalEvent("session.status", "s1", {
								sessionId: "s1",
								status: "busy",
							})
						: resume === "assistant"
							? makeMessageCreated("s1", "a2")
							: makeToolStarted("s1", "a1", "tool2");
				yield* runner.projectEvent(yield* store.append(activity));
				expect(
					yield* sql`SELECT state, assistant_message_id, started_at, completed_at FROM turns`,
				).toEqual([
					{
						state: "running",
						assistant_message_id: resume === "assistant" ? "a2" : null,
						started_at: FIXED_TS + 1,
						completed_at: null,
					},
				]);
				if (resume !== "assistant") {
					yield* runner.projectEvent(
						yield* store.append(makeMessageCreated("s1", "a2")),
					);
				}
				// Repeated busy signals must preserve the new attachment.
				yield* runner.projectEvent(
					yield* store.append(
						canonicalEvent("session.status", "s1", {
							sessionId: "s1",
							status: "busy",
						}),
					),
				);
				yield* runner.projectEvent(
					yield* store.append(
						canonicalEvent(
							"turn.completed",
							"s1",
							{
								messageId: "a2",
								cost: 0.5,
								tokens: { input: 200, output: 30 },
							},
							{ createdAt: FIXED_TS + 5 },
						),
					),
				);
				const expected = [
					{
						id: "u1",
						state: "completed",
						assistant_message_id: "a2",
						cost: 0.5,
						tokens_in: 300,
						tokens_out: 50,
						completed_at: FIXED_TS + 5,
					},
				];
				expect(
					yield* sql`SELECT id, state, assistant_message_id, cost, tokens_in, tokens_out, completed_at FROM turns`,
				).toEqual(expected);

				// Rebuild the turn projection from its durable events.
				yield* sql`DELETE FROM turns`;
				yield* sql`DELETE FROM projector_cursors WHERE projector_name = 'turn'`;
				yield* runner.recover();
				expect(yield* runner.getFailures()).toEqual([]);
				expect(
					yield* sql`SELECT id, state, assistant_message_id, cost, tokens_in, tokens_out, completed_at FROM turns`,
				).toEqual(expected);
			}),
		));

	it("streamed output and tool progress do not reopen a settled turn", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				for (const event of [
					makeSessionCreated("s1"),
					makeMessageCreated("s1", "u1", { role: "user" }),
					makeMessageCreated("s1", "a1"),
					makeToolStarted("s1", "a1", "tool1"),
					makeToolCompleted("s1", "a1", "tool1"),
					canonicalEvent(
						"turn.completed",
						"s1",
						{ messageId: "a1" },
						{ createdAt: FIXED_TS + 2 },
					),
				]) {
					yield* runner.projectEvent(yield* store.append(event));
				}
				// A late flush of text for work that already finished is not new
				// work. Treating it as new would leave the turn permanently running.
				yield* runner.projectEvent(
					yield* store.append(
						makeToolRunning("s1", "a1", "tool1", { duration: 500 }),
					),
				);
				yield* runner.projectEvent(
					yield* store.append(makeTextDelta("s1", "a1", "trailing")),
				);
				expect(yield* sql`SELECT state, completed_at FROM turns`).toEqual([
					{ state: "completed", completed_at: FIXED_TS + 2 },
				]);
			}),
		));

	it("a new prompt opens a separate turn, including when prompt timestamps tie", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				for (const event of [
					makeSessionCreated("s1"),
					makeMessageCreated("s1", "u1", { role: "user" }),
					makeMessageCreated("s1", "a1"),
					canonicalEvent("turn.completed", "s1", { messageId: "a1", cost: 1 }),
					makeMessageCreated("s1", "u2", { role: "user" }),
				])
					yield* runner.projectEvent(yield* store.append(event));
				expect(yield* sql`SELECT id, state FROM turns ORDER BY rowid`).toEqual([
					{ id: "u1", state: "completed" },
					{ id: "u2", state: "pending" },
				]);
				for (const event of [
					canonicalEvent("session.status", "s1", {
						sessionId: "s1",
						status: "busy",
					}),
					makeMessageCreated("s1", "a2"),
					canonicalEvent("turn.completed", "s1", { messageId: "a2", cost: 2 }),
				])
					yield* runner.projectEvent(yield* store.append(event));
				expect(
					yield* sql`SELECT id, state, assistant_message_id, cost FROM turns ORDER BY rowid`,
				).toEqual([
					{ id: "u1", state: "completed", assistant_message_id: "a1", cost: 1 },
					{ id: "u2", state: "completed", assistant_message_id: "a2", cost: 2 },
				]);
			}),
		));

	it.each([
		"turn.error",
		"turn.interrupted",
	] as const)("preserves the %s settlement reason and permits more work", (type) =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				for (const event of [
					makeSessionCreated("s1"),
					makeMessageCreated("s1", "u1", { role: "user" }),
					makeMessageCreated("s1", "a1"),
					type === "turn.error"
						? canonicalEvent(type, "s1", { messageId: "a1", error: "Failed" })
						: canonicalEvent(type, "s1", { messageId: "a1" }),
				])
					yield* runner.projectEvent(yield* store.append(event));
				expect(yield* sql`SELECT state FROM turns`).toEqual([
					{ state: type === "turn.error" ? "error" : "interrupted" },
				]);
				yield* runner.projectEvent(
					yield* store.append(makeMessageCreated("s1", "a2")),
				);
				expect(
					yield* sql`SELECT state, assistant_message_id, completed_at FROM turns`,
				).toEqual([
					{ state: "running", assistant_message_id: "a2", completed_at: null },
				]);
			}),
		));

	it("updates only the newest open turn and is replay-idempotent", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				yield* seedSession("s1");
				yield* sql`
					INSERT INTO turns
					(id, session_id, state, user_message_id, requested_at)
					VALUES
					('completed', 's1', 'completed', 'completed', ${FIXED_TS}),
					('running', 's1', 'running', 'running', ${FIXED_TS + 1}),
					('pending', 's1', 'pending', 'pending', ${FIXED_TS + 2})`;

				const event = yield* store.append(
					makeTurnModelResolved("s1", "claude-sonnet-5[1m]", {
						requestedModel: "sonnet",
						expectedModel: "claude-sonnet-5[1m]",
					}),
				);
				yield* runner.projectEvent(event);
				yield* runner.projectEvent(event);

				const rows = yield* sql<{
					id: string;
					requested_model: string | null;
					expected_model: string | null;
					actual_model: string | null;
				}>`SELECT id, requested_model, expected_model, actual_model
					FROM turns ORDER BY requested_at`;
				expect(rows).toEqual([
					{
						id: "completed",
						requested_model: null,
						expected_model: null,
						actual_model: null,
					},
					{
						id: "running",
						requested_model: null,
						expected_model: null,
						actual_model: null,
					},
					{
						id: "pending",
						requested_model: "sonnet",
						expected_model: "claude-sonnet-5[1m]",
						actual_model: "claude-sonnet-5[1m]",
					},
				]);
			}),
		));

	it("preserves nullable evidence", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				yield* seedSession("s1");
				yield* sql`
					INSERT INTO turns
					(id, session_id, state, user_message_id, requested_at)
					VALUES ('pending', 's1', 'pending', 'pending', ${FIXED_TS})`;

				const event = yield* store.append(
					makeTurnModelResolved("s1", "claude-opus-4-6"),
				);
				yield* runner.projectEvent(event);

				const rows = yield* sql<{
					requested_model: string | null;
					expected_model: string | null;
					actual_model: string | null;
				}>`SELECT requested_model, expected_model, actual_model
					FROM turns WHERE id = 'pending'`;
				expect(rows[0]).toEqual({
					requested_model: null,
					expected_model: null,
					actual_model: "claude-opus-4-6",
				});
			}),
		));

	it("updates the newest running turn", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				yield* seedSession("s1");
				yield* sql`
					INSERT INTO turns
					(id, session_id, state, user_message_id, requested_at)
					VALUES
					('older-running', 's1', 'running', 'older-running', ${FIXED_TS}),
					('newest-running', 's1', 'running', 'newest-running', ${FIXED_TS + 1})`;

				const event = yield* store.append(
					makeTurnModelResolved("s1", "claude-sonnet-5", {
						requestedModel: "sonnet",
						expectedModel: "claude-sonnet-5",
					}),
				);
				yield* runner.projectEvent(event);

				const rows = yield* sql<{
					id: string;
					requested_model: string | null;
					expected_model: string | null;
					actual_model: string | null;
				}>`SELECT id, requested_model, expected_model, actual_model
					FROM turns ORDER BY requested_at`;
				expect(rows).toEqual([
					{
						id: "older-running",
						requested_model: null,
						expected_model: null,
						actual_model: null,
					},
					{
						id: "newest-running",
						requested_model: "sonnet",
						expected_model: "claude-sonnet-5",
						actual_model: "claude-sonnet-5",
					},
				]);
			}),
		));

	it("does not attach evidence when no open turn exists", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				yield* seedSession("s1");
				yield* sql`
					INSERT INTO turns
					(id, session_id, state, user_message_id, requested_at)
					VALUES ('completed', 's1', 'completed', 'completed', ${FIXED_TS})`;

				const event = yield* store.append(
					makeTurnModelResolved("s1", "claude-sonnet-5", {
						requestedModel: "sonnet",
						expectedModel: "claude-sonnet-5",
					}),
				);
				yield* runner.projectEvent(event);

				const rows = yield* sql<{ actual_model: string | null }>`
					SELECT actual_model FROM turns WHERE id = 'completed'`;
				expect(rows[0]?.actual_model).toBeNull();
			}),
		));
});

// ─── Approval Projector Tests ───────────────────────────────────────────────

describe("Effect Approval Projector (via ProjectionRunner)", () => {
	it("permission.asked inserts a pending approval", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				yield* seedSession("s1");
				const e1 = yield* store.append(makeSessionCreated("s1"));
				yield* runner.projectEvent(e1);
				const e2 = yield* store.append(
					makePermissionAsked("s1", "perm1", "bash"),
				);
				yield* runner.projectEvent(e2);

				const rows = yield* sql<{
					id: string;
					status: string;
					tool_name: string;
				}>`SELECT id, status, tool_name FROM pending_approvals WHERE id = 'perm1'`;
				expect(rows[0]?.status).toBe("pending");
				expect(rows[0]?.tool_name).toBe("bash");
			}),
		));

	it("permission.resolved updates the approval", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				yield* seedSession("s1");
				const e1 = yield* store.append(makeSessionCreated("s1"));
				yield* runner.projectEvent(e1);
				const e2 = yield* store.append(
					makePermissionAsked("s1", "perm1", "bash"),
				);
				yield* runner.projectEvent(e2);
				const e3 = yield* store.append(
					makePermissionResolved("s1", "perm1", "once"),
				);
				yield* runner.projectEvent(e3);

				const rows = yield* sql<{
					status: string;
					decision: string;
				}>`SELECT status, decision FROM pending_approvals WHERE id = 'perm1'`;
				expect(rows[0]?.status).toBe("resolved");
				expect(rows[0]?.decision).toBe("once");
			}),
		));
});

// ──��� ProjectionRunner Tests ─────────────────────────────────────────────────

describe("ProjectionRunnerEffect", () => {
	it("notifies after projectEvent succeeds", () => {
		const sessionStateProjected = vi.fn(() => Effect.void);

		return runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				yield* seedSession("s-single-notified");
				const event = yield* store.append(
					makeSessionCreated("s-single-notified"),
				);

				yield* runner.projectEvent(event);

				expect(sessionStateProjected).toHaveBeenCalledOnce();
				expect(sessionStateProjected).toHaveBeenCalledWith(
					"s-single-notified",
					"session.created",
				);
			}).pipe(
				Effect.provideService(SessionStateProjectionNotifierTag, {
					sessionStateProjected,
				}),
			),
		);
	});

	it("notifies once for every successfully projected batch event", () => {
		const sessionStateProjected = vi.fn(() => Effect.void);

		return runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				yield* seedSession("s-notified");
				const events = [
					yield* store.append(makeSessionCreated("s-notified")),
					yield* store.append(makeMessageCreated("s-notified", "m-notified")),
				];

				yield* runner.projectBatch(events);

				expect(sessionStateProjected).toHaveBeenCalledTimes(2);
				expect(sessionStateProjected).toHaveBeenNthCalledWith(
					1,
					"s-notified",
					"session.created",
				);
				expect(sessionStateProjected).toHaveBeenNthCalledWith(
					2,
					"s-notified",
					"message.created",
				);
			}).pipe(
				Effect.provideService(SessionStateProjectionNotifierTag, {
					sessionStateProjected,
				}),
			),
		);
	});

	it("does not notify while recover replays the event log", () => {
		const sessionStateProjected = vi.fn(() => Effect.void);

		return runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* seedSession("s-replay-no-notify");
				yield* store.append(makeSessionCreated("s-replay-no-notify"));

				yield* runner.recover();

				expect(sessionStateProjected).not.toHaveBeenCalled();
			}).pipe(
				Effect.provideService(SessionStateProjectionNotifierTag, {
					sessionStateProjected,
				}),
			),
		);
	});

	it("projects successfully when the notifier service is absent", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				yield* seedSession("s-no-notifier");
				const event = yield* store.append(
					makeSessionCreated("s-no-notifier", { title: "No notifier" }),
				);

				yield* runner.projectEvent(event);

				const rows = yield* sql<{ title: string }>`
					SELECT title FROM sessions WHERE id = 's-no-notifier'`;
				expect(rows[0]?.title).toBe("No notifier");
			}),
		));

	it("projectEvent surfaces a projector failure with its cause intact", () => {
		const rootCause = new Error("projector explosion");
		const projector: EffectProjector = {
			name: "failing-command-projector",
			handles: ["session.created"],
			project: () =>
				Effect.fail(
					new ProjectionError({
						projector: "failing-command-projector",
						operation: "project",
						cause: rootCause,
					}),
				),
		};

		return runTestWithProjectors(
			[projector],
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				yield* seedSession("s-command-failure");
				const event = yield* store.append(
					makeSessionCreated("s-command-failure"),
				);

				const result = yield* Effect.either(runner.projectEvent(event));

				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					expect(result.left).toBeInstanceOf(ProjectionRunnerError);
					if (result.left instanceof ProjectionRunnerError) {
						expect(result.left.cause).toBeInstanceOf(ProjectionError);
						if (result.left.cause instanceof ProjectionError) {
							expect(result.left.cause.cause).toBe(rootCause);
						}
					}
				}
			}),
		);
	});

	it("projectEvent throws before recovery", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;

				yield* seedSession("s1");
				const event = yield* store.append(makeSessionCreated("s1"));

				const result = yield* Effect.either(runner.projectEvent(event));
				expect(result._tag).toBe("Left");
			}),
		));

	it("projectBatch throws before recovery", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;

				yield* seedSession("s-batch-before-recovery");
				const event = yield* store.append(
					makeSessionCreated("s-batch-before-recovery"),
				);

				const result = yield* Effect.either(runner.projectBatch([event]));
				expect(result._tag).toBe("Left");
			}),
		));

	it("projectBatch is a no-op for an empty batch before recovery", () =>
		runTest(
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;

				yield* runner.projectBatch([]);

				expect(yield* runner.isRecovered()).toBe(false);
			}),
		));

	it("recover replays events and sets recovered state", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const sql = yield* SqlClient.SqlClient;

				yield* seedSession("s1");
				yield* store.append(makeSessionCreated("s1"));
				yield* store.append(makeMessageCreated("s1", "m1", { role: "user" }));

				const result = yield* runner.recover();
				expect(result.totalReplayed).toBeGreaterThan(0);

				const isRecovered = yield* runner.isRecovered();
				expect(isRecovered).toBe(true);

				// Verify projections were applied
				const rows = yield* sql<{
					title: string;
				}>`SELECT title FROM sessions WHERE id = 's1'`;
				expect(rows[0]?.title).toBe("Test Session");
			}),
		));

	it("recover returns typed ProjectionRunnerError for invalid replay row", () =>
		runTest(
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				yield* seedSession("s-bad-replay");
				yield* insertRawEventRow({
					sessionId: "s-bad-replay",
					data: "{not json",
				});

				const result = yield* Effect.either(runner.recover());

				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					const error = result.left;
					expect(error).toBeInstanceOf(ProjectionRunnerError);
					if (error instanceof ProjectionRunnerError) {
						expect(error.operation).toBe("decodeStoredEventRow");
					}
				}
			}),
		));

	it("recover returns typed ProjectionRunnerError for schema-invalid replay row", () =>
		runTest(
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				yield* seedSession("s-invalid-shape-replay");
				yield* insertRawEventRow({
					sessionId: "s-invalid-shape-replay",
					data: JSON.stringify({
						sessionId: "s-invalid-shape-replay",
					}),
				});

				const result = yield* Effect.either(runner.recover());

				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					const error = result.left;
					expect(error).toBeInstanceOf(ProjectionRunnerError);
					if (error instanceof ProjectionRunnerError) {
						expect(error.operation).toBe("decodeStoredEventRow");
					}
				}
			}),
		));

	it("resets replaying state after typed replay decode failure", () => {
		let observedContext: ProjectionContext | undefined;
		const projector: EffectProjector = {
			name: "replaying-state-test",
			handles: ["session.created"],
			project: (_event, ctx) =>
				Effect.sync(() => {
					observedContext = ctx;
				}),
		};

		return runTestWithProjectors(
			[projector],
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				yield* seedSession("s-replaying-reset");
				yield* insertRawEventRow({
					sessionId: "s-replaying-reset",
					data: JSON.stringify({
						sessionId: "s-replaying-reset",
					}),
				});

				const result = yield* Effect.either(runner.recover());
				expect(result._tag).toBe("Left");

				yield* runner.markRecovered();
				yield* runner.projectEvent({
					...makeSessionCreated("s-replaying-reset"),
					sequence: 2,
					streamVersion: 1,
				});

				expect(observedContext?.replaying).toBe(false);
			}),
		);
	});

	it("recover is idempotent (no-op when caught up)", () =>
		runTest(
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;

				// First recover with no events
				const r1 = yield* runner.recover();
				expect(r1.totalReplayed).toBe(0);

				// Second recover -- still no-op
				const r2 = yield* runner.recover();
				expect(r2.totalReplayed).toBe(0);
			}),
		));

	it("recover replays only events after the persisted cursor", () => {
		const projectedSequences: number[] = [];
		const projector: EffectProjector = {
			name: "incremental-recovery-projector",
			handles: ["session.created"],
			project: (event) =>
				Effect.sync(() => {
					projectedSequences.push(event.sequence);
				}),
		};

		return runTestWithProjectors(
			[projector],
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* seedSession("s-incremental-recovery");

				const first = yield* store.append(
					makeSessionCreated("s-incremental-recovery"),
				);
				yield* runner.recover();

				const second = yield* store.append(
					makeSessionCreated("s-incremental-recovery", {
						title: "Second event",
					}),
				);
				const result = yield* runner.recover();

				expect(result.totalReplayed).toBe(1);
				expect(projectedSequences).toEqual([first.sequence, second.sequence]);
			}),
		);
	});

	it("projectBatch projects multiple events in one transaction", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const sql = yield* SqlClient.SqlClient;
				yield* runner.markRecovered();

				yield* seedSession("s1");
				const e1 = yield* store.append(makeSessionCreated("s1"));
				const e2 = yield* store.append(
					makeMessageCreated("s1", "m1", { role: "user" }),
				);
				yield* runner.projectBatch([e1, e2]);

				const sessionRows = yield* sql<{
					title: string;
				}>`SELECT title FROM sessions WHERE id = 's1'`;
				expect(sessionRows[0]?.title).toBe("Test Session");

				// Verify cursor was advanced
				const cursorRepo = yield* ProjectorCursorEffectTag;
				const cursor = yield* cursorRepo.get("session");
				expect(cursor).toBeDefined();
				expect(cursor?.lastAppliedSeq).toBe(e2.sequence);
			}),
		));

	it("recover records a bad event and continues replay", () => {
		let successfulProjectorRan = false;
		const failingProjector: EffectProjector = {
			name: "failing-replay-projector",
			handles: ["session.created"],
			project: () =>
				Effect.fail(
					new ProjectionError({
						projector: "failing-replay-projector",
						operation: "project",
						cause: new Error("replay projector explosion"),
					}),
				),
		};
		const successfulProjector: EffectProjector = {
			name: "successful-replay-projector",
			handles: ["session.created"],
			project: () =>
				Effect.sync(() => {
					successfulProjectorRan = true;
				}),
		};

		return runTestWithProjectors(
			[failingProjector, successfulProjector],
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* seedSession("s-resilient-replay");
				yield* store.append(makeSessionCreated("s-resilient-replay"));

				const result = yield* runner.recover();

				expect(result.totalReplayed).toBe(2);
				expect(successfulProjectorRan).toBe(true);
				const failures = yield* runner.getFailures();
				expect(failures).toHaveLength(1);
				expect(failures[0]?.projectorName).toBe("failing-replay-projector");
			}),
		);
	});

	it("projectBatch applies the whole batch or none of it", async () => {
		// The batch is one transaction (S9). A translation that produced several
		// events must not land half-applied, so a failure on any event rolls back
		// the writes the earlier events already made.
		const halfWritingProjector: EffectProjector = {
			name: "half-writing-batch-projector",
			handles: ["session.created"],
			project: (event) =>
				event.sessionId === "s-batch-second"
					? Effect.fail(
							new ProjectionError({
								projector: "half-writing-batch-projector",
								operation: "project",
								cause: new Error("second event of the batch explodes"),
							}),
						)
					: Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							yield* sql`UPDATE sessions SET title = 'batch-applied' WHERE id = ${event.sessionId}`;
						}),
		};

		const outcome = await runTestWithProjectors(
			[halfWritingProjector],
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				yield* seedSession("s-batch-first");
				yield* seedSession("s-batch-second");
				const first = yield* store.append(makeSessionCreated("s-batch-first"));
				const second = yield* store.append(
					makeSessionCreated("s-batch-second"),
				);

				const failure = yield* runner.projectBatch([first, second]).pipe(
					Effect.match({
						onFailure: (error) => error,
						onSuccess: () => undefined,
					}),
				);

				const rows = yield* sql<{
					title: string;
				}>`SELECT title FROM sessions WHERE id = 's-batch-first'`;
				return { failure, title: rows[0]?.title };
			}),
		);

		expect(outcome.failure).toBeInstanceOf(ProjectionRunnerError);
		expect(outcome.title).toBe("Test Session");
	});
});

// ─── Provider Projector Tests ───────────────────────────────────────────────

describe("Effect Provider Projector (via ProjectionRunner)", () => {
	it("session.created inserts initial provider binding", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				yield* seedSession("s1");
				const e1 = yield* store.append(makeSessionCreated("s1"));
				yield* runner.projectEvent(e1);

				const rows = yield* sql<{
					id: string;
					provider: string;
					status: string;
				}>`SELECT id, provider, status FROM session_providers WHERE session_id = 's1'`;
				expect(rows.length).toBe(1);
				expect(rows[0]?.id).toBe("s1:initial");
				expect(rows[0]?.provider).toBe("opencode");
				expect(rows[0]?.status).toBe("active");
			}),
		));
});
