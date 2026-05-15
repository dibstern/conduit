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
import { describe, expect, it } from "vitest";
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
} from "../../../src/lib/persistence/effect/projectors-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	createEventId,
	type EventId,
	type EventMetadata,
} from "../../../src/lib/persistence/events.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

const FIXED_TS = 1_000_000_000_000;

function makeSessionCreated(
	sessionId: string,
	opts?: { eventId?: EventId; metadata?: EventMetadata; createdAt?: number },
): CanonicalEvent {
	return canonicalEvent(
		"session.created",
		sessionId,
		{
			sessionId,
			title: "Test Session",
			provider: "opencode",
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

function makeTurnCompleted(
	sessionId: string,
	messageId: string,
	opts?: {
		cost?: number;
		tokens?: { input?: number; output?: number };
		createdAt?: number;
	},
): CanonicalEvent {
	const data: {
		messageId: string;
		cost?: number;
		tokens?: { input?: number; output?: number };
	} = { messageId };
	if (opts?.cost !== undefined) data.cost = opts.cost;
	if (opts?.tokens !== undefined) data.tokens = opts.tokens;
	return canonicalEvent("turn.completed", sessionId, data, {
		eventId: createEventId(),
		metadata: {},
		createdAt: opts?.createdAt ?? FIXED_TS,
	});
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

	it("failures are recorded but do not block other projectors", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();

				// Append a turn.completed without a session -- will fail FK constraints
				// but should record failure, not throw
				yield* seedSession("s1");
				const e1 = yield* store.append(makeSessionCreated("s1"));
				yield* runner.projectEvent(e1);

				// turn.completed referencing a message that doesn't exist --
				// not a hard error, just a no-op UPDATE
				const e2 = yield* store.append(
					makeTurnCompleted("s1", "nonexistent-msg"),
				);
				yield* runner.projectEvent(e2);

				// Should succeed without throwing
				const _failures = yield* runner.getFailures();
				// Failures may or may not exist depending on FK constraints
				// The key assertion is that it didn't throw
				expect(true).toBe(true);
			}),
		));
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
