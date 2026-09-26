import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer, ManagedRuntime } from "effect";
import { makePersistenceServiceLive } from "../../src/lib/domain/persistence/Services/persistence-service.js";
import { makePersistenceEffectLayer } from "../../src/lib/persistence/effect/live.js";
import { makeEffectSqlMigrator } from "../../src/lib/persistence/effect/migrations.js";
import { ReadQueryEffectTag } from "../../src/lib/persistence/effect/read-query-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	createEventId,
	type EventId,
	type EventMetadata,
	type EventPayloadMap,
	type StoredEvent,
	validateEventPayload,
} from "../../src/lib/persistence/events.js";
import type { MessageWithParts } from "../../src/lib/persistence/read-model-types.js";

export const FIXED_TEST_TIMESTAMP = 1_000_000_000_000;
export const FIXED_TEST_TIMESTAMP_2 = 1_000_000_060_000;

export function makeSessionCreatedEvent(
	sessionId: string,
	opts?: {
		eventId?: EventId;
		metadata?: EventMetadata;
		createdAt?: number;
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
		},
		{
			eventId: opts?.eventId ?? createEventId(),
			metadata: opts?.metadata ?? {},
			createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
		},
	);
}

export function makeTextDelta(
	sessionId: string,
	messageId: string,
	text: string,
	opts?: {
		eventId?: EventId;
		partId?: string;
		metadata?: EventMetadata;
		createdAt?: number;
	},
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
			eventId: opts?.eventId ?? createEventId(),
			metadata: opts?.metadata ?? {},
			createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
		},
	);
}

export function makeMessageCreatedEvent(
	sessionId: string,
	messageId: string,
	opts?: {
		eventId?: EventId;
		role?: "user" | "assistant";
		metadata?: EventMetadata;
		createdAt?: number;
	},
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
			eventId: opts?.eventId ?? createEventId(),
			metadata: opts?.metadata ?? {},
			createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
		},
	);
}

export function makeSessionStatusEvent(
	sessionId: string,
	status: "idle" | "busy" | "error",
	opts?: {
		eventId?: EventId;
		metadata?: EventMetadata;
		createdAt?: number;
	},
): CanonicalEvent {
	return canonicalEvent(
		"session.status",
		sessionId,
		{
			sessionId,
			status,
		},
		{
			eventId: opts?.eventId ?? createEventId(),
			metadata: opts?.metadata ?? {},
			createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
		},
	);
}

export function makeStored<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: EventPayloadMap[T],
	opts?: {
		sequence?: number;
		createdAt?: number;
		streamVersion?: number;
		eventId?: EventId;
		metadata?: EventMetadata;
	},
): StoredEvent {
	const sequence = opts?.sequence ?? 1;
	if (sequence < 1) {
		throw new Error(`makeStored: sequence must be >= 1, got ${sequence}`);
	}

	const streamVersion = opts?.streamVersion ?? 0;
	if (streamVersion < 0) {
		throw new Error(
			`makeStored: streamVersion must be >= 0, got ${streamVersion}`,
		);
	}

	const event = canonicalEvent(type, sessionId, data, {
		eventId: opts?.eventId ?? createEventId(),
		metadata: opts?.metadata ?? {},
		createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
	});

	validateEventPayload(event);

	return { ...event, sequence, streamVersion } as StoredEvent;
}

export interface SessionSeedOpts {
	provider?: string;
	title?: string;
	status?: string;
	parentId?: string;
	forkPointEvent?: string;
	createdAt?: number;
	updatedAt?: number;
}

export interface MessageSeedOpts {
	role?: "user" | "assistant";
	createdAt?: number;
	updatedAt?: number;
	lastAppliedSeq?: number;
	parts?: Array<{
		id: string;
		type: "text" | "thinking" | "tool";
		text?: string;
		sortOrder?: number;
	}>;
}

export interface TestHarness {
	/** A raw statement that bypasses the projectors, e.g. to probe a constraint. */
	readonly execute: (
		statement: string,
		params?: readonly (string | number | null)[],
	) => Promise<void>;
	readonly seedSession: (id: string, opts?: SessionSeedOpts) => Promise<void>;
	readonly seedMessage: (
		id: string,
		sessionId: string,
		opts?: MessageSeedOpts,
	) => Promise<void>;
	/** The read model as session history loads it. */
	readonly sessionMessagesWithParts: (
		sessionId: string,
	) => Promise<MessageWithParts[]>;
	readonly close: () => Promise<void>;
}

/** A migrated in-memory event store for seeding read-model rows directly. */
export function createTestHarness(): TestHarness {
	const runtime = ManagedRuntime.make(makePersistenceEffectLayer(":memory:"));

	const execute: TestHarness["execute"] = (statement, params = []) =>
		runtime.runPromise(
			Effect.flatMap(SqlClient.SqlClient, (sql) =>
				sql.unsafe(statement, [...params]).pipe(Effect.asVoid),
			),
		);

	const seedSession: TestHarness["seedSession"] = (id, opts) => {
		const now = opts?.createdAt ?? FIXED_TEST_TIMESTAMP;
		return execute(
			`INSERT INTO sessions (id, provider, title, status, parent_id, fork_point_event, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				opts?.provider ?? "opencode",
				opts?.title ?? "Test Session",
				opts?.status ?? "idle",
				opts?.parentId ?? null,
				opts?.forkPointEvent ?? null,
				now,
				opts?.updatedAt ?? now,
			],
		);
	};

	const seedMessage: TestHarness["seedMessage"] = async (
		id,
		sessionId,
		opts,
	) => {
		const now = opts?.createdAt ?? FIXED_TEST_TIMESTAMP;
		await execute(
			`INSERT INTO messages (id, session_id, role, created_at, updated_at, last_applied_seq)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				id,
				sessionId,
				opts?.role ?? "assistant",
				now,
				opts?.updatedAt ?? now,
				opts?.lastAppliedSeq ?? 0,
			],
		);
		for (const [i, part] of (opts?.parts ?? []).entries()) {
			await execute(
				`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					part.id,
					id,
					part.type,
					part.text ?? "",
					part.sortOrder ?? i,
					now,
					now,
				],
			);
		}
	};

	return {
		execute,
		seedSession,
		seedMessage,
		sessionMessagesWithParts: (sessionId) =>
			runtime.runPromise(
				Effect.flatMap(ReadQueryEffectTag, (readQuery) =>
					readQuery.getSessionMessagesWithParts(sessionId),
				),
			),
		close: () => runtime.dispose(),
	};
}

/**
 * Writes a migrated event store to `filename` and seeds it, for fixtures that
 * lay down a project's `.conduit/events.db` before the code under test opens it.
 * The SQLite driver is synchronous, so runSync completes; it throws if that ever
 * stops being true.
 */
export function writeEventStore(
	filename: string,
	seed: Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
): void {
	Effect.runSync(
		makeEffectSqlMigrator().pipe(
			Effect.zipRight(seed),
			Effect.provide(EffectSqliteClient.layer({ filename })),
		),
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// Effect Layer Test Helpers
// ═══════════════════════════════════════════════════════════════════════════
//
// Convenience layers for @effect/vitest tests that need persistence services.

/**
 * File-backed SQLite layer for Effect tests.
 * Provides @effect/sql's SqlClient.SqlClient and the sqlite-node client.
 * Use with `Layer.provideMerge(makePersistenceServiceLive, makeTestSqlLayer())`.
 */
export function makeTestSqlLayer() {
	const dir = mkdtempSync(join(tmpdir(), "conduit-effect-persistence-"));
	const filename = join(dir, "events.db");
	return EffectSqliteClient.layer({ filename }).pipe(
		Layer.merge(
			Layer.scopedDiscard(
				Effect.addFinalizer(() =>
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			),
		),
	);
}

/**
 * Composed Layer providing both SqlClient and PersistenceService for Effect tests.
 *
 * Usage:
 *   it.effect("my persistence test", () =>
 *     Effect.gen(function* () {
 *       const persistence = yield* PersistenceServiceTag;
 *       // ... test logic ...
 *     }).pipe(Effect.provide(makeTestPersistenceLayer())),
 *   );
 */
export const makeTestPersistenceLayer = () =>
	Layer.provideMerge(makePersistenceServiceLive, makeTestSqlLayer());
