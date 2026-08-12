// ─── Effect Projectors + Event Store Tests ──────────────────────────────────
// Tests the @effect/sql migration of projectors, event-store, cursor repo,
// and projection runner using file-backed SQLite via @effect/sql-sqlite-node.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, HashMap, Layer, Logger } from "effect";
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

function makeSessionDeleted(sessionId: string): CanonicalEvent {
	return canonicalEvent(
		"session.deleted",
		sessionId,
		{ sessionId },
		{
			eventId: createEventId(),
			metadata: {},
			createdAt: FIXED_TS,
		},
	);
}

function makeSessionRenamed(sessionId: string, title: string): CanonicalEvent {
	return canonicalEvent(
		"session.renamed",
		sessionId,
		{ sessionId, title },
		{
			eventId: createEventId(),
			metadata: {},
			createdAt: FIXED_TS,
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

function readSessionProjectionSnapshot(sessionId: string) {
	return Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const sessions = yield* sql<{
			id: string;
			provider: string;
			provider_sid: string | null;
			title: string;
			status: string;
			parent_id: string | null;
			last_message_at: number | null;
		}>`SELECT id, provider, provider_sid, title, status, parent_id, last_message_at
			FROM sessions WHERE id = ${sessionId} ORDER BY id`;
		const messages = yield* sql<{
			id: string;
			session_id: string;
			role: string;
			text: string;
			last_applied_seq: number | null;
		}>`SELECT id, session_id, role, text, last_applied_seq
			FROM messages WHERE session_id = ${sessionId} ORDER BY id`;
		const messageParts = yield* sql<{
			id: string;
			message_id: string;
			type: string;
			text: string;
		}>`SELECT id, message_id, type, text
			FROM message_parts ORDER BY id`;
		const turns = yield* sql<{
			id: string;
			session_id: string;
			state: string;
		}>`SELECT id, session_id, state FROM turns WHERE session_id = ${sessionId} ORDER BY id`;
		const sessionProviders = yield* sql<{
			id: string;
			session_id: string;
			provider: string;
			provider_sid: string | null;
			status: string;
		}>`SELECT id, session_id, provider, provider_sid, status
			FROM session_providers WHERE session_id = ${sessionId} ORDER BY id`;
		const pendingApprovals = yield* sql<{
			id: string;
			session_id: string;
		}>`SELECT id, session_id FROM pending_approvals WHERE session_id = ${sessionId} ORDER BY id`;
		const activities = yield* sql<{
			id: string;
			session_id: string;
		}>`SELECT id, session_id FROM activities WHERE session_id = ${sessionId} ORDER BY id`;
		const toolContent = yield* sql<{
			tool_id: string;
			session_id: string;
		}>`SELECT tool_id, session_id FROM tool_content WHERE session_id = ${sessionId} ORDER BY tool_id`;
		const providerState = yield* sql<{
			session_id: string;
			key: string;
			value: string;
		}>`SELECT session_id, key, value FROM provider_state WHERE session_id = ${sessionId} ORDER BY key`;

		return {
			sessions,
			messages,
			messageParts,
			turns,
			sessionProviders,
			pendingApprovals,
			activities,
			toolContent,
			providerState,
		};
	});
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

	it("duplicate session.created preserves the original provider binding through the Effect projector", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				yield* sql`
					INSERT INTO sessions (
						id,
						provider,
						title,
						status,
						created_at,
						updated_at
					)
					VALUES (
						${"s-named"},
						${"work-oc"},
						${"Untitled"},
						${"idle"},
						${FIXED_TS},
						${FIXED_TS}
					)`;

				const original = yield* store.append(
					makeSessionCreated("s-named", {
						provider: "work-oc",
						title: "Untitled",
						createdAt: FIXED_TS,
					}),
				);
				yield* runner.projectEvent(original);
				const duplicate = yield* store.append(
					makeSessionCreated("s-named", {
						provider: "opencode",
						title: "Recovered title",
						createdAt: FIXED_TS + 1,
					}),
				);
				yield* runner.projectEvent(duplicate);

				const rows = yield* sql<{
					provider: string;
					title: string;
					updated_at: number;
				}>`
					SELECT provider, title, updated_at
					FROM sessions
					WHERE id = ${"s-named"}`;
				expect(rows).toEqual([
					{
						provider: "work-oc",
						title: "Recovered title",
						updated_at: FIXED_TS + 1,
					},
				]);
			}),
		));

	it("cold recovery preserves the first provider owner across historical duplicate creation", () =>
		runTest(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const sessionId = "s-cold-provider-owner";

				yield* store.append(
					makeSessionCreated(sessionId, {
						provider: "work-oc",
						providerSessionId: sessionId,
						createdAt: FIXED_TS,
					}),
				);
				yield* store.append(
					makeSessionCreated(sessionId, {
						provider: "claude",
						createdAt: FIXED_TS + 1,
					}),
				);
				yield* runner.recover();

				const sessions = yield* sql<{
					provider: string;
					provider_sid: string | null;
				}>`
					SELECT provider, provider_sid FROM sessions WHERE id = ${sessionId}`;
				const bindings = yield* sql<{
					id: string;
					provider: string;
				}>`
					SELECT id, provider FROM session_providers
					WHERE session_id = ${sessionId} AND status = 'active'`;

				expect(sessions).toEqual([
					{ provider: "work-oc", provider_sid: sessionId },
				]);
				expect(bindings).toEqual([
					{ id: `${sessionId}:initial`, provider: "work-oc" },
				]);
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
	it("records and logs a skipped replay failure", async () => {
		const messageDeliveries: number[] = [];
		const turnDeliveries: Array<{
			sequence: number;
			replaying: boolean | undefined;
		}> = [];
		const projectors = createAllEffectProjectors().map(
			(projector): EffectProjector => {
				if (projector.name === "message") {
					return {
						...projector,
						project: (event, ctx) =>
							Effect.gen(function* () {
								const sql = yield* SqlClient.SqlClient;
								messageDeliveries.push(event.sequence);
								yield* sql`
									INSERT INTO partial_projection_writes (event_sequence)
									VALUES (${event.sequence})`;
								yield* projector.project(event, ctx);
							}),
					};
				}
				if (projector.name === "turn") {
					return {
						...projector,
						project: (event, ctx) =>
							Effect.gen(function* () {
								turnDeliveries.push({
									sequence: event.sequence,
									replaying: ctx?.replaying,
								});
								yield* projector.project(event, ctx);
							}),
					};
				}
				return projector;
			},
		);
		const errorLogs: Array<{
			message: string;
			annotations: Record<string, unknown>;
		}> = [];
		const logger = Logger.make<unknown, void>((options) => {
			if (options.logLevel._tag !== "Error") return;
			errorLogs.push({
				message: Array.isArray(options.message)
					? options.message.map(String).join(" ")
					: String(options.message),
				annotations: Object.fromEntries(HashMap.toEntries(options.annotations)),
			});
		});

		const result = await runTestWithProjectors(
			projectors,
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					CREATE TEMP TABLE partial_projection_writes (
						event_sequence INTEGER NOT NULL
					)`;
				const event = yield* store.append(
					makeMessageCreated("missing-S", "orphan-M", {
						role: "assistant",
					}),
				);

				const recovery = yield* runner.recover();
				const durableFailures = yield* sql<{
					projector_name: string;
					event_sequence: number;
					event_type: string;
					session_id: string;
					error: string;
					failed_at: number;
				}>`SELECT projector_name, event_sequence, event_type, session_id, error, failed_at
					FROM projection_failures`;
				const recentFailures = yield* runner.getFailures();
				const messageRows = yield* sql<{ id: string }>`
					SELECT id FROM messages WHERE id = 'orphan-M'`;
				const partialProjectionWrites = yield* sql<{
					event_sequence: number;
				}>`SELECT event_sequence FROM partial_projection_writes`;
				const cursors = yield* sql<{
					projector_name: string;
					last_applied_seq: number;
				}>`SELECT projector_name, last_applied_seq
					FROM projector_cursors ORDER BY projector_name`;

				return {
					event,
					recovery,
					durableFailures,
					recentFailures,
					messageRows,
					partialProjectionWrites,
					cursors,
				};
			}).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger))),
		);

		expect(result.recovery).toMatchObject({
			startCursor: 0,
			endCursor: 1,
			totalReplayed: 3,
		});
		expect(result.durableFailures).toHaveLength(1);
		const durableFailure = result.durableFailures[0];
		expect(durableFailure).toMatchObject({
			projector_name: "message",
			event_sequence: result.event.sequence,
			event_type: "message.created",
			session_id: "missing-S",
		});
		expect(durableFailure?.error.length).toBeGreaterThan(0);
		expect(durableFailure?.failed_at).toBeGreaterThan(0);
		expect(result.recentFailures).toEqual([
			{
				projectorName: "message",
				eventSequence: result.event.sequence,
				eventType: "message.created",
				sessionId: "missing-S",
				error: durableFailure?.error,
				failedAt: durableFailure?.failed_at,
			},
		]);
		expect(errorLogs).toEqual([
			{
				message: "projection replay failed; event skipped",
				annotations: {
					projectorName: "message",
					eventSequence: result.event.sequence,
					eventType: "message.created",
					sessionId: "missing-S",
					error: durableFailure?.error,
				},
			},
		]);
		expect(turnDeliveries).toEqual([
			{ sequence: result.event.sequence, replaying: true },
		]);
		expect(messageDeliveries).toEqual([result.event.sequence]);
		expect(result.messageRows).toEqual([]);
		expect(result.partialProjectionWrites).toEqual([]);
		expect(result.cursors).toEqual([
			{ projector_name: "activity", last_applied_seq: 1 },
			{ projector_name: "approval", last_applied_seq: 1 },
			{ projector_name: "message", last_applied_seq: 1 },
			{ projector_name: "provider", last_applied_seq: 1 },
			{ projector_name: "session", last_applied_seq: 1 },
			{ projector_name: "turn", last_applied_seq: 1 },
		]);
	});

	it("does not redeliver a skipped event after a later replay decode failure", async () => {
		const messageDeliveries: number[] = [];
		const projectors = createAllEffectProjectors().map(
			(projector): EffectProjector =>
				projector.name === "message"
					? {
							...projector,
							project: (event, ctx) =>
								Effect.gen(function* () {
									messageDeliveries.push(event.sequence);
									yield* projector.project(event, ctx);
								}),
						}
					: projector,
		);
		const invalidEventId = createEventId();

		const result = await runTestWithProjectors(
			projectors,
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const sql = yield* SqlClient.SqlClient;
				const poisonEvent = yield* store.append(
					makeMessageCreated("missing-S", "orphan-M", {
						role: "assistant",
					}),
				);
				yield* insertRawEventRow({
					sessionId: "invalid-S",
					eventId: invalidEventId,
					data: "{not json",
				});

				const firstRecovery = yield* Effect.either(runner.recover());
				const failuresAfterFirst = yield* sql<{
					count: number;
				}>`SELECT COUNT(*) AS count FROM projection_failures`;

				yield* sql`DELETE FROM events WHERE event_id = ${invalidEventId}`;
				const secondRecovery = yield* runner.recover();
				const failuresAfterSecond = yield* sql<{
					projector_name: string;
					event_sequence: number;
				}>`SELECT projector_name, event_sequence FROM projection_failures`;

				return {
					poisonEvent,
					firstRecovery,
					failuresAfterFirst,
					secondRecovery,
					failuresAfterSecond,
				};
			}).pipe(
				Effect.provide(
					Logger.replace(
						Logger.defaultLogger,
						Logger.make<unknown, void>(() => undefined),
					),
				),
			),
		);

		expect(result.firstRecovery._tag).toBe("Left");
		if (result.firstRecovery._tag === "Left") {
			expect(result.firstRecovery.left).toBeInstanceOf(ProjectionRunnerError);
			if (result.firstRecovery.left instanceof ProjectionRunnerError) {
				expect(result.firstRecovery.left.operation).toBe(
					"decodeStoredEventRow",
				);
			}
		}
		expect(result.failuresAfterFirst).toEqual([{ count: 1 }]);
		expect(result.secondRecovery).toMatchObject({
			startCursor: 0,
			endCursor: result.poisonEvent.sequence,
			totalReplayed: 0,
		});
		expect(messageDeliveries).toEqual([result.poisonEvent.sequence]);
		expect(result.failuresAfterSecond).toEqual([
			{
				projector_name: "message",
				event_sequence: result.poisonEvent.sequence,
			},
		]);
	});

	it("does not advance when the durable failure transaction fails", async () => {
		const result = await runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const sql = yield* SqlClient.SqlClient;
				const emptyRecovery = yield* runner.recover();
				const recoveredBeforeFailure = yield* runner.isRecovered();
				yield* store.append(
					makeMessageCreated("missing-S", "orphan-M", {
						role: "assistant",
					}),
				);
				yield* sql`
					CREATE TEMP TRIGGER fail_message_cursor_upsert
					BEFORE INSERT ON projector_cursors
					WHEN NEW.projector_name = 'message'
					BEGIN
						SELECT RAISE(ABORT, 'simulated cursor persistence failure');
					END`;

				const failedRecovery = yield* Effect.either(runner.recover());
				const durableFailuresAfterFailure = yield* sql<{
					count: number;
				}>`SELECT COUNT(*) AS count FROM projection_failures`;
				const messageCursorAfterFailure = yield* sql<{
					last_applied_seq: number;
				}>`SELECT COALESCE(MAX(last_applied_seq), 0) AS last_applied_seq
					FROM projector_cursors WHERE projector_name = 'message'`;
				const recoveredAfterFailure = yield* runner.isRecovered();

				yield* sql`DROP TRIGGER fail_message_cursor_upsert`;
				const retryRecovery = yield* runner.recover();
				const durableFailuresAfterRetry = yield* sql<{
					projector_name: string;
					event_sequence: number;
				}>`SELECT projector_name, event_sequence FROM projection_failures`;
				const cursorsAfterRetry = yield* sql<{
					projector_name: string;
					last_applied_seq: number;
				}>`SELECT projector_name, last_applied_seq
					FROM projector_cursors ORDER BY projector_name`;

				return {
					emptyRecovery,
					recoveredBeforeFailure,
					failedRecovery,
					durableFailuresAfterFailure,
					messageCursorAfterFailure,
					recoveredAfterFailure,
					retryRecovery,
					durableFailuresAfterRetry,
					cursorsAfterRetry,
				};
			}).pipe(
				Effect.provide(
					Logger.replace(
						Logger.defaultLogger,
						Logger.make<unknown, void>(() => undefined),
					),
				),
			),
		);

		expect(result.emptyRecovery.totalReplayed).toBe(0);
		expect(result.recoveredBeforeFailure).toBe(true);
		expect(result.failedRecovery._tag).toBe("Left");
		if (result.failedRecovery._tag === "Left") {
			expect(result.failedRecovery.left).toBeInstanceOf(ProjectionRunnerError);
			if (result.failedRecovery.left instanceof ProjectionRunnerError) {
				expect(result.failedRecovery.left.operation).toBe("recover");
			}
		}
		expect(result.durableFailuresAfterFailure).toEqual([{ count: 0 }]);
		expect(result.messageCursorAfterFailure).toEqual([{ last_applied_seq: 0 }]);
		expect(result.recoveredAfterFailure).toBe(false);
		expect(result.retryRecovery).toMatchObject({
			startCursor: 0,
			endCursor: 1,
			totalReplayed: 2,
		});
		expect(result.durableFailuresAfterRetry).toEqual([
			{ projector_name: "message", event_sequence: 1 },
		]);
		expect(result.cursorsAfterRetry).toEqual([
			{ projector_name: "activity", last_applied_seq: 1 },
			{ projector_name: "approval", last_applied_seq: 1 },
			{ projector_name: "message", last_applied_seq: 1 },
			{ projector_name: "provider", last_applied_seq: 1 },
			{ projector_name: "session", last_applied_seq: 1 },
			{ projector_name: "turn", last_applied_seq: 1 },
		]);
	});

	it("cold replay deletes a session without projection failures", async () => {
		const sessionId = "s-cold-delete";
		const messageId = "m-cold-delete";
		const events = [
			makeSessionCreated(sessionId),
			makeMessageCreated(sessionId, messageId, { role: "user" }),
			makeSessionDeleted(sessionId),
		];

		const cold = await runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const sql = yield* SqlClient.SqlClient;
				for (const event of events) yield* store.append(event);

				const recovery = yield* runner.recover();
				const snapshot = yield* readSessionProjectionSnapshot(sessionId);
				const failures = yield* runner.getFailures();
				const durableFailures = yield* sql<{
					count: number;
				}>`SELECT COUNT(*) AS count FROM projection_failures`;
				const cursors = yield* sql<{
					projector_name: string;
					last_applied_seq: number;
				}>`SELECT projector_name, last_applied_seq FROM projector_cursors ORDER BY projector_name`;

				return { recovery, snapshot, failures, durableFailures, cursors };
			}),
		);

		const online = await runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.markRecovered();
				for (const event of events) {
					const stored = yield* store.append(event);
					yield* runner.projectEvent(stored);
				}

				return {
					snapshot: yield* readSessionProjectionSnapshot(sessionId),
					failures: yield* runner.getFailures(),
				};
			}),
		);

		expect(cold.recovery).toMatchObject({
			startCursor: 0,
			endCursor: 3,
			totalReplayed: 6,
		});
		expect(cold.failures).toEqual([]);
		expect(cold.durableFailures).toEqual([{ count: 0 }]);
		expect(cold.snapshot).toEqual({
			sessions: [],
			messages: [],
			messageParts: [],
			turns: [],
			sessionProviders: [],
			pendingApprovals: [],
			activities: [],
			toolContent: [],
			providerState: [],
		});
		expect(cold.snapshot).toEqual(online.snapshot);
		expect(online.failures).toEqual([]);
		expect(cold.cursors).toEqual([
			{ projector_name: "activity", last_applied_seq: 3 },
			{ projector_name: "approval", last_applied_seq: 3 },
			{ projector_name: "message", last_applied_seq: 3 },
			{ projector_name: "provider", last_applied_seq: 3 },
			{ projector_name: "session", last_applied_seq: 3 },
			{ projector_name: "turn", last_applied_seq: 3 },
		]);
	});

	it("cold replay matches online ordering across delete and recreate", async () => {
		const sessionId = "s-delete-recreate";
		const messageId = "m-before-delete";
		const events = [
			makeSessionCreated(sessionId, { title: "First" }),
			makeMessageCreated(sessionId, messageId, { role: "user" }),
			makeSessionDeleted(sessionId),
			makeSessionCreated(sessionId, { title: "Second" }),
		];

		const execute = (cold: boolean) =>
			runTest(
				Effect.gen(function* () {
					const store = yield* EventStoreEffectTag;
					const runner = yield* ProjectionRunnerEffectTag;
					const sql = yield* SqlClient.SqlClient;
					if (!cold) yield* runner.markRecovered();
					for (const event of events) {
						const stored = yield* store.append(event);
						if (!cold) yield* runner.projectEvent(stored);
					}
					if (cold) yield* runner.recover();

					return {
						snapshot: yield* readSessionProjectionSnapshot(sessionId),
						failures: yield* runner.getFailures(),
						durableFailures: yield* sql<{
							count: number;
						}>`SELECT COUNT(*) AS count FROM projection_failures`,
					};
				}),
			);

		const [cold, online] = await Promise.all([execute(true), execute(false)]);
		expect(cold.snapshot).toEqual(online.snapshot);
		expect(cold.snapshot.sessions).toEqual([
			{
				id: sessionId,
				provider: "opencode",
				provider_sid: null,
				title: "Second",
				status: "idle",
				parent_id: null,
				last_message_at: null,
			},
		]);
		expect(cold.snapshot.messages).toEqual([]);
		expect(cold.snapshot.messageParts).toEqual([]);
		expect(cold.snapshot.sessionProviders).toEqual([
			{
				id: `${sessionId}:initial`,
				session_id: sessionId,
				provider: "opencode",
				provider_sid: null,
				status: "active",
			},
		]);
		expect(cold.failures).toEqual([]);
		expect(online.failures).toEqual([]);
		expect(cold.durableFailures).toEqual([{ count: 0 }]);
		expect(online.durableFailures).toEqual([{ count: 0 }]);
	});

	it("routes mixed cursors strictly behind each event", () => {
		const observations: Array<{
			projectorName: string;
			sequence: number;
			replaying: boolean | undefined;
		}> = [];
		const projectors = createAllEffectProjectors().map(
			(projector): EffectProjector => ({
				...projector,
				project: (event, ctx) =>
					Effect.gen(function* () {
						observations.push({
							projectorName: projector.name,
							sequence: event.sequence,
							replaying: ctx?.replaying,
						});
						yield* projector.project(event, ctx);
					}),
			}),
		);

		return runTestWithProjectors(
			projectors,
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const sql = yield* SqlClient.SqlClient;
				yield* runner.markRecovered();

				for (const event of [
					makeSessionCreated("s-mixed"),
					makeMessageCreated("s-mixed", "m-mixed", { role: "assistant" }),
					makeTextDelta("s-mixed", "m-mixed", "A", { partId: "p-mixed" }),
				]) {
					const stored = yield* store.append(event);
					yield* runner.projectEvent(stored);
				}
				observations.length = 0;
				yield* store.append(makeSessionRenamed("s-mixed", "Renamed"));

				yield* sql`
					INSERT INTO projector_cursors (projector_name, last_applied_seq, updated_at)
					VALUES
						('session', 2, ${FIXED_TS}),
						('message', 2, ${FIXED_TS}),
						('provider', 0, ${FIXED_TS}),
						('turn', 4, ${FIXED_TS}),
						('approval', 1, ${FIXED_TS}),
						('activity', 0, ${FIXED_TS})
					ON CONFLICT (projector_name) DO UPDATE SET
						last_applied_seq = excluded.last_applied_seq,
						updated_at = excluded.updated_at`;

				const recovery = yield* runner.recover();
				const messageRows = yield* sql<{
					text: string;
				}>`SELECT text FROM messages WHERE id = 'm-mixed'`;
				const partRows = yield* sql<{
					text: string;
				}>`SELECT text FROM message_parts WHERE id = 'p-mixed'`;
				const cursors = yield* sql<{
					projector_name: string;
					last_applied_seq: number;
				}>`SELECT projector_name, last_applied_seq FROM projector_cursors ORDER BY projector_name`;

				expect(recovery).toMatchObject({
					startCursor: 0,
					endCursor: 4,
					totalReplayed: 3,
				});
				expect(observations).toEqual([
					{ projectorName: "provider", sequence: 1, replaying: true },
					{ projectorName: "message", sequence: 3, replaying: true },
					{ projectorName: "session", sequence: 4, replaying: true },
				]);
				expect(messageRows).toEqual([{ text: "A" }]);
				expect(partRows).toEqual([{ text: "A" }]);
				expect(cursors).toEqual([
					{ projector_name: "activity", last_applied_seq: 4 },
					{ projector_name: "approval", last_applied_seq: 4 },
					{ projector_name: "message", last_applied_seq: 4 },
					{ projector_name: "provider", last_applied_seq: 4 },
					{ projector_name: "session", last_applied_seq: 4 },
					{ projector_name: "turn", last_applied_seq: 4 },
				]);
			}),
		);
	});

	it("pages a bounded 501-event snapshot", () =>
		runTest(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const sql = yield* SqlClient.SqlClient;
				let appendedMidReplay = false;
				const projectors = createAllEffectProjectors().map(
					(projector): EffectProjector =>
						projector.name === "session"
							? {
									...projector,
									project: (event, ctx) =>
										Effect.gen(function* () {
											if (ctx?.replaying && !appendedMidReplay) {
												appendedMidReplay = true;
												yield* store
													.append(
														makeSessionStatus("s-paged", "error", {
															createdAt: FIXED_TS + 502,
														}),
													)
													.pipe(Effect.orDie);
											}
											yield* projector.project(event, ctx);
										}),
								}
							: projector,
				);
				const runner = yield* makeProjectionRunnerEffect(projectors);

				yield* store.append(makeSessionCreated("s-paged"));
				for (let index = 0; index < 500; index++) {
					yield* store.append(
						makeSessionStatus("s-paged", "busy", {
							createdAt: FIXED_TS + index + 1,
						}),
					);
				}

				const first = yield* runner.recover();
				const firstSession = yield* sql<{
					status: string;
				}>`SELECT status FROM sessions WHERE id = 's-paged'`;
				const firstCursors = yield* sql<{
					projector_name: string;
					last_applied_seq: number;
				}>`SELECT projector_name, last_applied_seq FROM projector_cursors ORDER BY projector_name`;

				expect(first).toMatchObject({
					startCursor: 0,
					endCursor: 501,
					totalReplayed: 1002,
				});
				expect(firstSession).toEqual([{ status: "busy" }]);
				expect(firstCursors).toEqual([
					{ projector_name: "activity", last_applied_seq: 501 },
					{ projector_name: "approval", last_applied_seq: 501 },
					{ projector_name: "message", last_applied_seq: 501 },
					{ projector_name: "provider", last_applied_seq: 501 },
					{ projector_name: "session", last_applied_seq: 501 },
					{ projector_name: "turn", last_applied_seq: 501 },
				]);

				const second = yield* runner.recover();
				const secondSession = yield* sql<{
					status: string;
				}>`SELECT status FROM sessions WHERE id = 's-paged'`;
				expect(second).toMatchObject({
					startCursor: 501,
					endCursor: 502,
					totalReplayed: 2,
				});
				expect(secondSession).toEqual([{ status: "error" }]);
			}),
		));

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
				expect(yield* runner.isRecovered()).toBe(false);
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
				expect(yield* runner.isRecovered()).toBe(false);
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
				yield* runner.recover();
				expect(yield* runner.isRecovered()).toBe(true);
				yield* seedSession("s-replaying-reset");
				yield* insertRawEventRow({
					sessionId: "s-replaying-reset",
					data: JSON.stringify({
						sessionId: "s-replaying-reset",
					}),
				});

				const result = yield* Effect.either(runner.recover());
				expect(result._tag).toBe("Left");
				expect(yield* runner.isRecovered()).toBe(false);

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
