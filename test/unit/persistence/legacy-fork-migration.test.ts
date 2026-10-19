import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	effectMigrationEntries,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { refreshSidebar } from "../../../src/lib/persistence/effect/sidebar-projection.js";
import {
	canonicalEvent,
	type EventPayloadMap,
} from "../../../src/lib/persistence/events.js";
import { SidebarRowSchema } from "../../../src/lib/persistence/sidebar-row.js";

const throughLineage = Object.fromEntries(
	Object.entries(effectMigrationEntries).filter(
		([key]) => key <= "0061_sessions_lineage",
	),
);
const throughForkRepair = Object.fromEntries(
	Object.entries(effectMigrationEntries).filter(
		([key]) => key <= "0062_legacy_forks",
	),
);
const T0 = 1_000;
const created = (
	id: string,
	placement: Partial<EventPayloadMap["session.created"]> = {},
) =>
	canonicalEvent(
		"session.created",
		id,
		{ sessionId: id, title: id, provider: "opencode", ...placement },
		{ createdAt: T0 },
	);
const boundary = {
	forkPointEvent: "boundary",
	forkPointTimestamp: T0,
};
const events = [
	created("source"),
	canonicalEvent(
		"message.created",
		"source",
		{ sessionId: "source", messageId: "boundary", role: "assistant" },
		{ createdAt: T0 },
	),
	canonicalEvent(
		"text.delta",
		"source",
		{ messageId: "boundary", partId: "boundary-text", text: "source history" },
		{ createdAt: T0 },
	),
	created("subagent", { parentId: "source" }),
	created("fork", { parentId: "source" }),
	created("fork", { parentId: "source", ...boundary }),
	created("fork-agent", { parentId: "fork" }),
	created("fork-agent-child", { parentId: "fork-agent" }),
	created("fork-side", { parentId: "fork", ...boundary, sideThread: true }),
	created("fork-of-fork", { parentId: "fork", forkPointTimestamp: T0 }),
	created("event-fork", { parentId: "source" }),
	canonicalEvent(
		"session.forked",
		"event-fork",
		{ sessionId: "event-fork", parentId: "source" },
		{ createdAt: T0 },
	),
	created("point-fork", { parentId: "source", forkPointEvent: "boundary" }),
	created("side", { parentId: "source", ...boundary, sideThread: true }),
	canonicalEvent(
		"session.forked",
		"side",
		{ sessionId: "side", parentId: "source", forkPointEvent: "boundary" },
		{ createdAt: T0 },
	),
	created("modern-fork", { forkedFrom: "source", ...boundary }),
	created("unrelated"),
	canonicalEvent(
		"message.created",
		"fork",
		{ sessionId: "fork", messageId: "reply", role: "assistant" },
		{ createdAt: T0 },
	),
	canonicalEvent(
		"text.delta",
		"fork",
		{ messageId: "reply", partId: "reply-text", text: "fork history" },
		{ createdAt: T0 },
	),
	canonicalEvent(
		"turn.completed",
		"fork",
		{ messageId: "reply" },
		{ createdAt: T0 },
	),
	canonicalEvent(
		"session.status",
		"fork",
		{ sessionId: "fork", status: "busy" },
		{ createdAt: T0 },
	),
];

// SQL rows reproduce the old projector, independently of today's placement rule.
const seedLegacy = Effect.gen(function* () {
	yield* makeEffectSqlMigrator(throughLineage);
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT INTO sessions
		(id, provider, title, parent_id, forked_from, side_thread, root_id,
		fork_point_event, fork_point_timestamp, fork_point_message_id, version, created_at, updated_at)
		VALUES
		('source', 'opencode', 'source', NULL, NULL, 0, 'source', NULL, NULL, NULL, 10, ${T0}, ${T0}),
		('subagent', 'opencode', 'subagent', 'source', NULL, 0, 'source', NULL, NULL, NULL, 11, ${T0}, ${T0}),
		('fork', 'opencode', 'fork', 'source', NULL, 0, 'source', 'boundary', ${T0}, 'boundary', 12, ${T0}, ${T0}),
		('fork-agent', 'opencode', 'fork-agent', 'fork', NULL, 0, 'source', NULL, NULL, NULL, 13, ${T0}, ${T0}),
		('fork-agent-child', 'opencode', 'fork-agent-child', 'fork-agent', NULL, 0, 'source', NULL, NULL, NULL, 14, ${T0}, ${T0}),
		('fork-side', 'opencode', 'fork-side', 'fork', NULL, 1, 'source', 'boundary', ${T0}, 'boundary', 15, ${T0}, ${T0}),
		('fork-of-fork', 'opencode', 'fork-of-fork', 'fork', NULL, 0, 'source', NULL, ${T0}, NULL, 16, ${T0}, ${T0}),
		('event-fork', 'opencode', 'event-fork', 'source', NULL, 0, 'source', NULL, NULL, NULL, 17, ${T0}, ${T0}),
		('point-fork', 'opencode', 'point-fork', 'source', NULL, 0, 'source', 'boundary', ${T0}, 'boundary', 18, ${T0}, ${T0}),
		('side', 'opencode', 'side', 'source', NULL, 1, 'source', 'boundary', ${T0}, 'boundary', 19, ${T0}, ${T0}),
		('modern-fork', 'opencode', 'modern-fork', NULL, 'source', 0, 'modern-fork', 'boundary', ${T0}, 'boundary', 20, ${T0}, ${T0}),
		('unrelated', 'opencode', 'unrelated', NULL, NULL, 0, 'unrelated', NULL, NULL, NULL, 21, ${T0}, ${T0})`;
	const versions = new Map<string, number>();
	for (const event of events) {
		const version = (versions.get(event.sessionId) ?? -1) + 1;
		versions.set(event.sessionId, version);
		yield* sql`INSERT INTO events
			(event_id, session_id, stream_version, type, data, provider, created_at)
			VALUES (${event.eventId}, ${event.sessionId}, ${version}, ${event.type},
			${JSON.stringify(event.data)}, ${event.provider}, ${event.createdAt})`;
	}
	yield* sql`INSERT INTO messages (id, session_id, role, text, created_at, updated_at)
		VALUES ('boundary', 'source', 'assistant', 'source history', ${T0}, ${T0}),
		('reply', 'fork', 'assistant', 'fork history', ${T0}, ${T0})`;
	yield* sql`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
		VALUES ('boundary-text', 'boundary', 'text', 'source history', 0, ${T0}, ${T0}),
		('reply-text', 'reply', 'text', 'fork history', 0, ${T0}, ${T0})`;
	yield* sql`UPDATE sessions SET last_message_at = ${T0} WHERE id IN ('source', 'fork')`;
	yield* sql`UPDATE sessions SET status = 'busy', last_turn_end_version =
		(SELECT stream_version FROM events WHERE session_id = 'fork' AND type = 'turn.completed')
		WHERE id = 'fork'`;
	yield* sql`UPDATE read_model_counter SET value = 100 WHERE id = 1`;
	const ids = yield* sql<{ id: string }>`SELECT id FROM sessions`;
	yield* refreshSidebar(
		ids.map(({ id }) => id),
		100,
	);
});

const placement = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return yield* sql`SELECT id, parent_id, forked_from, side_thread, root_id,
		fork_point_event, fork_point_timestamp, fork_point_message_id
		FROM sessions ORDER BY id`;
});
const sidebar = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const rows = yield* sql<{ session_id: string; row: string | null }>`
		SELECT session_id, row FROM session_sidebar ORDER BY session_id`;
	return rows.map(({ session_id, row }) => {
		if (row === null) return { session_id, session: undefined };
		const {
			version: _version,
			lastActivity: _lastActivity,
			...content
		} = Schema.decodeUnknownSync(Schema.fromJsonString(SidebarRowSchema))(row);
		return { session_id, ...content };
	});
});

describe("legacy Fork migration", () => {
	it("moves Forks, reroots their families, stamps changes, and preserves transcripts", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* seedLegacy;
				const sql = yield* SqlClient.SqlClient;
				const before = yield* sql<{
					id: string;
				}>`SELECT * FROM sessions ORDER BY id`;
				const messages = yield* sql`SELECT * FROM messages ORDER BY id`;
				const parts = yield* sql`SELECT * FROM message_parts ORDER BY id`;
				const history = yield* sql`SELECT * FROM events ORDER BY sequence`;
				expect(
					(yield* sidebar).find(({ session_id }) => session_id === "source")
						?.session,
				).toMatchObject({ processing: true, attention: "working" });
				expect(
					yield* sql`SELECT unread FROM sessions WHERE id = 'fork'`,
				).toEqual([{ unread: 1 }]);

				yield* makeEffectSqlMigrator(throughForkRepair);

				expect((yield* placement).map((row) => Object.values(row))).toEqual([
					["event-fork", null, "source", 0, "event-fork", null, null, null],
					["fork", null, "source", 0, "fork", "boundary", T0, "boundary"],
					["fork-agent", "fork", null, 0, "fork", null, null, null],
					["fork-agent-child", "fork-agent", null, 0, "fork", null, null, null],
					["fork-of-fork", null, "fork", 0, "fork-of-fork", null, T0, null],
					["fork-side", "fork", "fork", 1, "fork", "boundary", T0, "boundary"],
					[
						"modern-fork",
						null,
						"source",
						0,
						"modern-fork",
						"boundary",
						T0,
						"boundary",
					],
					[
						"point-fork",
						null,
						"source",
						0,
						"point-fork",
						"boundary",
						T0,
						"boundary",
					],
					["side", "source", "source", 1, "source", "boundary", T0, "boundary"],
					["source", null, null, 0, "source", null, null, null],
					["subagent", "source", null, 0, "source", null, null, null],
					["unrelated", null, null, 0, "unrelated", null, null, null],
				]);
				expect(yield* sql`SELECT value FROM read_model_counter`).toEqual([
					{ value: 101 },
				]);
				expect(
					yield* sql`SELECT id, version FROM sessions WHERE version = 101 ORDER BY id`,
				).toEqual(
					[
						"event-fork",
						"fork",
						"fork-agent",
						"fork-agent-child",
						"fork-of-fork",
						"fork-side",
						"point-fork",
						"side",
					].map((id) => ({ id, version: 101 })),
				);
				const unchanged = ["source", "subagent", "modern-fork", "unrelated"];
				expect(
					yield* sql`SELECT * FROM sessions WHERE id IN ('source', 'subagent', 'modern-fork', 'unrelated') ORDER BY id`,
				).toEqual(before.filter((row) => unchanged.includes(String(row.id))));
				expect((yield* sidebar).map(({ session_id }) => session_id)).toEqual([
					"event-fork",
					"fork",
					"fork-of-fork",
					"modern-fork",
					"point-fork",
					"source",
					"unrelated",
				]);
				const source = (yield* sidebar).find(
					({ session_id }) => session_id === "source",
				)?.session;
				expect(source).toMatchObject({ status: "idle", attention: "idle" });
				expect(source?.processing ?? false).toBe(false);
				expect(source?.unread ?? false).toBe(false);
				expect(
					(yield* sidebar).find(({ session_id }) => session_id === "fork")
						?.session,
				).toMatchObject({ status: "busy", processing: true, unread: true });
				expect(
					yield* sql`SELECT session_id, version FROM session_sidebar WHERE session_id IN ('fork', 'source') ORDER BY session_id`,
				).toEqual([
					{ session_id: "fork", version: 101 },
					{ session_id: "source", version: 101 },
				]);
				expect(yield* sql`SELECT * FROM messages ORDER BY id`).toEqual(
					messages,
				);
				expect(yield* sql`SELECT * FROM message_parts ORDER BY id`).toEqual(
					parts,
				);
				expect(yield* sql`SELECT * FROM events ORDER BY sequence`).toEqual(
					history,
				);
				expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
				expect(yield* sql`PRAGMA integrity_check`).toEqual([
					{ integrity_check: "ok" },
				]);

				const migrated = yield* sql`SELECT * FROM sessions ORDER BY id`;
				const rows =
					yield* sql`SELECT * FROM session_sidebar ORDER BY session_id`;
				yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 60`;
				yield* makeEffectSqlMigrator(throughForkRepair);
				expect(yield* sql`SELECT * FROM sessions ORDER BY id`).toEqual(
					migrated,
				);
				expect(
					yield* sql`SELECT * FROM session_sidebar ORDER BY session_id`,
				).toEqual(rows);
				expect(yield* sql`SELECT value FROM read_model_counter`).toEqual([
					{ value: 101 },
				]);
			}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
		);
	});

	it("matches replay of the same legacy events at the latest schema", async () => {
		const migrated = await Effect.runPromise(
			Effect.gen(function* () {
				yield* seedLegacy;
				yield* makeEffectSqlMigrator(throughForkRepair);
				return { placement: yield* placement, sidebar: yield* sidebar };
			}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
		);
		const replayed = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.recover();
				for (const event of events) {
					yield* runner.projectEvent(yield* store.append(event));
				}
				return { placement: yield* placement, sidebar: yield* sidebar };
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
		);
		expect(migrated).toEqual(replayed);
	});

	it("backfills Side Thread lineage even when there are no Forks to move", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(throughLineage);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, parent_id, side_thread, root_id, version, created_at, updated_at)
					VALUES ('source', 'opencode', NULL, 0, 'source', 7, 1, 1),
					('side', 'opencode', 'source', 1, 'source', 8, 1, 1)`;
				yield* sql`UPDATE read_model_counter SET value = 42 WHERE id = 1`;
				yield* refreshSidebar(["source"], 42);
				yield* makeEffectSqlMigrator(throughForkRepair);
				expect(
					yield* sql`SELECT id, parent_id, forked_from, side_thread, root_id, version FROM sessions ORDER BY id`,
				).toEqual([
					{
						id: "side",
						parent_id: "source",
						forked_from: "source",
						side_thread: 1,
						root_id: "source",
						version: 43,
					},
					{
						id: "source",
						parent_id: null,
						forked_from: null,
						side_thread: 0,
						root_id: "source",
						version: 7,
					},
				]);
				expect(yield* sql`SELECT value FROM read_model_counter`).toEqual([
					{ value: 43 },
				]);
			}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
		);
	});

	it("leaves the counter and every row unchanged when there is no legacy placement", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(throughLineage);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, parent_id, forked_from, side_thread, root_id, version, created_at, updated_at)
					VALUES ('source', 'opencode', NULL, NULL, 0, 'source', 7, 1, 1),
					('agent', 'opencode', 'source', NULL, 0, 'source', 8, 1, 1),
					('fork', 'opencode', NULL, 'source', 0, 'fork', 9, 1, 1),
					('side', 'opencode', 'source', 'source', 1, 'source', 10, 1, 1)`;
				yield* sql`UPDATE read_model_counter SET value = 42 WHERE id = 1`;
				yield* refreshSidebar(["source", "fork"], 42);
				const before = yield* sql`SELECT * FROM sessions ORDER BY id`;
				const rows =
					yield* sql`SELECT * FROM session_sidebar ORDER BY session_id`;
				for (let run = 0; run < 2; run++) {
					yield* makeEffectSqlMigrator(throughForkRepair);
					expect(yield* sql`SELECT * FROM sessions ORDER BY id`).toEqual(
						before,
					);
					expect(
						yield* sql`SELECT * FROM session_sidebar ORDER BY session_id`,
					).toEqual(rows);
					expect(yield* sql`SELECT value FROM read_model_counter`).toEqual([
						{ value: 42 },
					]);
					yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 60`;
				}
			}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
		);
	});
});
