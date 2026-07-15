import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	CURRENT_EVENT_STORE_MIGRATION,
	readMigrationSql,
} from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

const EXISTING_SESSION_ID = "legacy-session";
const ORPHAN_SESSION_ID = "runtime-only-session";

function legacyBaselineSql(): string {
	const currentBaseline = readMigrationSql(CURRENT_EVENT_STORE_MIGRATION);
	const currentEventsTail = [
		"\tprovider        TEXT    NOT NULL,",
		"\tcreated_at      INTEGER NOT NULL",
		");",
		"",
		"CREATE UNIQUE INDEX idx_events_session_version",
	].join("\n");
	const legacyEventsTail = [
		"\tprovider        TEXT    NOT NULL,",
		"\tcreated_at      INTEGER NOT NULL,",
		"\tFOREIGN KEY (session_id) REFERENCES sessions(id)",
		");",
		"",
		"CREATE UNIQUE INDEX idx_events_session_version",
	].join("\n");
	const legacyBaseline = currentBaseline.replace(
		currentEventsTail,
		legacyEventsTail,
	);
	if (legacyBaseline === currentBaseline) {
		throw new Error("Failed to construct the legacy events schema");
	}
	return legacyBaseline;
}

function seedLegacyDatabase(filename: string): void {
	const db = SqliteClient.open(filename);
	try {
		db.exec(legacyBaselineSql());
		db.exec(`
			CREATE TABLE effect_sql_migrations (
				migration_id INTEGER PRIMARY KEY NOT NULL,
				created_at DATETIME NOT NULL DEFAULT current_timestamp,
				name VARCHAR(255) NOT NULL
			);
			INSERT INTO effect_sql_migrations (migration_id, name)
			VALUES (1, 'create_event_store_tables');
		`);
		db.execute(
			`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
			 VALUES (?, 'opencode', 'Legacy', 'idle', 100, 100)`,
			[EXISTING_SESSION_ID],
		);
		for (const [sequence, eventId, streamVersion] of [
			[4, "legacy-event-4", 0],
			[9, "legacy-event-9", 1],
		] as const) {
			db.execute(
				`INSERT INTO events (
					sequence, event_id, session_id, stream_version, type,
					data, metadata, provider, created_at
				) VALUES (?, ?, ?, ?, 'session.status', ?, '{}', 'opencode', ?)`,
				[
					sequence,
					eventId,
					EXISTING_SESSION_ID,
					streamVersion,
					JSON.stringify({ sessionId: EXISTING_SESSION_ID, status: "idle" }),
					100 + sequence,
				],
			);
		}
	} finally {
		db.close();
	}
}

describe("events session foreign-key migration", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("preserves events and permits runtime ingestion without a sessions row", async () => {
		dir = mkdtempSync(join(tmpdir(), "conduit-events-fk-migration-"));
		const filename = join(dir, "events.db");
		seedLegacyDatabase(filename);

		const persistenceLayer = makePersistenceEffectLayer(filename);
		const appLayer = Layer.mergeAll(
			persistenceLayer,
			ProviderRuntimeIngestionLive.pipe(Layer.provide(persistenceLayer)),
		);
		const runtime = ManagedRuntime.make(appLayer);

		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const ingestion = yield* ProviderRuntimeIngestionTag;
					const projectionRunner = yield* ProjectionRunnerEffectTag;

					const foreignKeys = yield* sql<{ foreign_keys: number }>`
					PRAGMA foreign_keys`;
					expect(foreignKeys).toEqual([{ foreign_keys: 1 }]);

					const rows = yield* sql<{ sequence: number; event_id: string }>`
					SELECT sequence, event_id FROM events ORDER BY sequence`;
					expect(rows).toEqual([
						{ sequence: 4, event_id: "legacy-event-4" },
						{ sequence: 9, event_id: "legacy-event-9" },
					]);

					const eventForeignKeys = yield* sql`PRAGMA foreign_key_list(events)`;
					expect(eventForeignKeys).toEqual([]);

					const missingSession = yield* sql<{ id: string }>`
					SELECT id FROM sessions WHERE id = ${ORPHAN_SESSION_ID}`;
					expect(missingSession).toEqual([]);
					yield* projectionRunner.recover();

					const runtimeEvent: ProviderRuntimeEvent = {
						eventId: "runtime-status-1",
						type: "session.status",
						providerId: "opencode",
						sessionId: ORPHAN_SESSION_ID,
						providerRefs: { providerSessionId: ORPHAN_SESSION_ID },
						rawSource: { kind: "migration-regression-test" },
						createdAt: 200,
						data: { status: "idle" },
					};
					expect(yield* ingestion.ingest(runtimeEvent)).toBe(1);

					const appended = yield* sql<{
						sequence: number;
						session_id: string;
					}>`
					SELECT sequence, session_id FROM events
					WHERE event_id = 'runtime-status-1'`;
					expect(appended).toEqual([
						{ sequence: 10, session_id: ORPHAN_SESSION_ID },
					]);
				}),
			);
		} finally {
			await runtime.dispose();
		}
	});
});
