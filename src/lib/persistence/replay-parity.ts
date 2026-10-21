import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Layer } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import { PersistenceProjectTag } from "../domain/persistence/Services/persistence-service.js";
import { makeRunnerReceiptStore } from "../provider/runner/runner-receipts.js";
import { makeEventStoreEffect } from "./effect/event-store-effect.js";
import { makeEffectSqlMigrator } from "./effect/migrations.js";
import { makeProjectionRunnerEffect } from "./effect/projection-runner-effect.js";
import {
	makeProjectorCursorEffect,
	ProjectorCursorEffectTag,
} from "./effect/projector-cursor-effect.js";
import { createAllEffectProjectors } from "./effect/projectors-effect.js";
import { makeReadQueryEffect } from "./effect/read-query-effect.js";
import { messageRowsToHistory } from "./session-history-adapter.js";

export const replayProjectionTables = [
	"sessions",
	"messages",
	"message_parts",
	"turns",
	"session_providers",
	"pending_approvals",
	"pending_inputs",
	"session_goal_checks",
	"message_tombstones",
	"message_part_tombstones",
	"session_sidebar",
] as const;

type Row = Record<string, string | number | null>;

export interface ReplayParityOptions {
	readonly projectId?: string;
	/** Bare column names apply to every table; table.column and JSON paths are supported. */
	readonly ignoredColumns?: readonly string[];
}

export interface ReplayParityDiff {
	readonly table: string;
	readonly key: string | number | null;
	readonly fields: string[];
	readonly expected: Row | null;
	readonly actual: Row | null;
}

export interface ReplayParityReport {
	readonly diffs: ReplayParityDiff[];
	readonly danglingPartPointers: { partId: string; resultEventSeq: number }[];
	readonly counts: {
		sessions: number;
		events: number;
		tables: Record<string, { expected: number; actual: number }>;
	};
}

const sqliteLayer = (filename: string) =>
	SqliteNode.layer({ filename }).pipe(Layer.provide(Reactivity.layer));

/** Shared with the compaction diagnostic, whose inputs are already temporary stores. */
export const initializeReplayStore = (filename: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql.unsafe("PRAGMA foreign_keys = OFF");
		yield* makeEffectSqlMigrator();
		yield* makeRunnerReceiptStore(sql);
	}).pipe(Effect.provide(sqliteLayer(filename)), Effect.scoped);

/** Replay only a disposable store. Source databases are never passed here. */
export const replayProjectionStore = (
	filename: string,
	sessionIds: readonly string[],
	options: {
		readonly projectId?: string;
		readonly guardDisk?: () => void;
	} = {},
) => {
	let projected = 0;
	const projectors = createAllEffectProjectors().map((projector) => ({
		...projector,
		project: (
			event: Parameters<typeof projector.project>[0],
			context: Parameters<typeof projector.project>[1],
		) =>
			Effect.gen(function* () {
				if (projected++ % 500 === 0 && options.guardDisk) {
					// A disk failure must interrupt recovery, which otherwise records
					// failed projections and keeps writing.
					yield* Effect.try(options.guardDisk).pipe(
						Effect.catch((error) =>
							Effect.logError(
								"Projection disk guard stopped replay",
								error,
							).pipe(Effect.andThen(Effect.interrupt)),
						),
					);
				}
				return yield* projector.project(event, context);
			}),
	}));
	return Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const cursor = yield* makeProjectorCursorEffect;
		const runner = yield* makeProjectionRunnerEffect(projectors).pipe(
			Effect.provideService(ProjectorCursorEffectTag, cursor),
		);
		const recovery = yield* runner.recover();
		const failures = yield* runner.getFailures();
		const [persisted] = yield* sql<{ count: number }>`
			SELECT COUNT(*) AS count FROM projection_failures`;
		const restart = yield* runner.recover();
		const query = yield* makeReadQueryEffect;
		const store = yield* makeEventStoreEffect;
		const histories = [];
		const streamVersionDifferences = [];
		for (const sessionId of sessionIds) {
			const messages = yield* query.getSessionMessagesWithParts(sessionId);
			histories.push({
				sessionId,
				history: messageRowsToHistory(messages, { pageSize: messages.length }),
			});
			const [expected] = yield* sql<{ next: number | null }>`
				SELECT MAX(stream_version) + 1 AS next FROM events WHERE session_id = ${sessionId}`;
			const actual = yield* store.getNextStreamVersion(sessionId);
			if (actual !== (expected?.next ?? 1)) {
				streamVersionDifferences.push({
					sessionId,
					expected: expected?.next,
					actual,
				});
			}
		}
		return {
			recovery,
			failures: Math.max(failures.length, persisted?.count ?? 0),
			restartReplayed: restart.totalReplayed,
			histories,
			streamVersionDifferences,
		};
	}).pipe(
		Effect.provideService(PersistenceProjectTag, {
			projectId: options.projectId ?? "replay-parity",
		}),
		Effect.provide(sqliteLayer(filename)),
		Effect.scoped,
	);
};

function normalizedRow(
	table: string,
	row: Row,
	ignored: readonly string[],
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...row };
	for (const field of Object.keys(result)) {
		if (ignored.includes(field) || ignored.includes(`${table}.${field}`)) {
			delete result[field];
			continue;
		}
		const nested = ignored.filter((path) =>
			path.startsWith(`${table}.${field}.`),
		);
		const value = result[field];
		if (nested.length === 0 || typeof value !== "string") continue;
		let json: unknown;
		try {
			json = JSON.parse(value);
		} catch {
			// A corrupt read-model value is a mismatch, not an operational error.
			continue;
		}
		for (const path of nested) {
			const keys = path.slice(`${table}.${field}.`.length).split(".");
			let parent = json;
			for (const key of keys.slice(0, -1)) {
				parent =
					parent && typeof parent === "object"
						? Reflect.get(parent, key)
						: null;
			}
			const key = keys.at(-1);
			if (parent && typeof parent === "object" && key)
				Reflect.deleteProperty(parent, key);
		}
		result[field] = json;
	}
	return result;
}

/** Compare live read models without changing either connection. */
export function compareProjectionStores(
	expected: DatabaseSync,
	actual: DatabaseSync,
	options: ReplayParityOptions = {},
): ReplayParityReport {
	const ignored = options.ignoredColumns ?? [
		"version",
		"session_sidebar.row.version",
		// Wake state is a read annotation: a child's wake event can be drained
		// while its snoozed ancestor survives (ADR-0013, conduit-test-hiuf.15).
		"sessions.woken_at",
		"sessions.woken_reason",
		"session_sidebar.row.snooze.woken_at",
		"session_sidebar.row.snooze.woken_reason",
	];
	const sessionsOf = (db: DatabaseSync) =>
		db
			.prepare(
				`SELECT id FROM sessions${options.projectId ? " WHERE project_id = ?" : ""} ORDER BY id`,
			)
			.all(...(options.projectId ? [options.projectId] : [])) as {
			id: string;
		}[];
	const sessions = sessionsOf(expected);
	// A session only the replay has is resurrected history, so it must diff.
	const live = new Set(
		[...sessions, ...sessionsOf(actual)].map(({ id }) => id),
	);
	const owners = (db: DatabaseSync) =>
		new Map(
			(
				db.prepare("SELECT id, session_id FROM messages").all() as {
					id: string;
					session_id: string;
				}[]
			).map((row) => [row.id, row.session_id]),
		);
	const expectedOwners = owners(expected);
	const actualOwners = owners(actual);
	const readRows = (
		db: DatabaseSync,
		table: string,
		messageOwners: Map<string, string>,
	) =>
		(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[]).filter(
			(row) => {
				const owner =
					table === "sessions"
						? row["id"]
						: (row["session_id"] ??
							(typeof row["message_id"] === "string"
								? messageOwners.get(row["message_id"])
								: null));
				return typeof owner === "string" && live.has(owner);
			},
		);
	const diffs: ReplayParityDiff[] = [];
	const tables: ReplayParityReport["counts"]["tables"] = {};
	for (const table of replayProjectionTables) {
		const keys = (
			expected.prepare(`PRAGMA table_info(${table})`).all() as {
				name: string;
				pk: number;
			}[]
		)
			.filter(({ pk }) => pk > 0)
			.sort((a, b) => a.pk - b.pk);
		const keyOf = (row: Row) =>
			keys.length === 1
				? (row[keys[0]?.name ?? ""] ?? null)
				: JSON.stringify(keys.map(({ name }) => row[name]));
		const before = readRows(expected, table, expectedOwners);
		const after = readRows(actual, table, actualOwners);
		tables[table] = { expected: before.length, actual: after.length };
		const afterByKey = new Map(after.map((row) => [keyOf(row), row]));
		for (const row of before) {
			const key = keyOf(row);
			const other = afterByKey.get(key);
			const normalized = normalizedRow(table, row, ignored);
			const normalizedOther = other
				? normalizedRow(table, other, ignored)
				: null;
			const fields = normalizedOther
				? [
						...new Set([
							...Object.keys(normalized),
							...Object.keys(normalizedOther),
						]),
					].filter(
						(field) =>
							!isDeepStrictEqual(normalized[field], normalizedOther[field]),
					)
				: ["row_removed"];
			if (fields.length) {
				diffs.push({
					table,
					key,
					fields,
					expected: row,
					actual: other ?? null,
				});
			}
			afterByKey.delete(key);
		}
		for (const [key, row] of afterByKey)
			diffs.push({
				table,
				key,
				fields: ["row_added"],
				expected: null,
				actual: row,
			});
	}
	const dangling = (db: DatabaseSync) =>
		db
			.prepare(`
		SELECT p.id AS partId, p.result_event_seq AS resultEventSeq
		FROM message_parts p JOIN messages m ON m.id = p.message_id
		JOIN sessions s ON s.id = m.session_id
		WHERE p.result_event_seq IS NOT NULL
		AND NOT EXISTS (SELECT 1 FROM events e WHERE e.sequence = p.result_event_seq)
		${options.projectId ? "AND s.project_id = ?" : ""} ORDER BY p.id`)
			.all(
				...(options.projectId ? [options.projectId] : []),
			) as ReplayParityReport["danglingPartPointers"];
	const danglingPartPointers = [
		...new Map(
			[...dangling(expected), ...dangling(actual)].map((pointer) => [
				JSON.stringify([pointer.partId, pointer.resultEventSeq]),
				pointer,
			]),
		).values(),
	];
	return {
		diffs,
		danglingPartPointers,
		counts: {
			sessions: sessions.length,
			events: Number(
				expected.prepare("SELECT COUNT(*) AS count FROM events").get()?.[
					"count"
				],
			),
			tables,
		},
	};
}

/**
 * Snapshot a kept event log and its current read model, then replay into a fresh
 * migrated store. Only operational failures fail the Effect; mismatches are data.
 * The caller retains ownership of an open input handle. All temporary stores
 * and owned connections are released on success, failure, or interruption.
 */
export const verifyReplayParity = (
	source: string | DatabaseSync,
	options: ReplayParityOptions = {},
) =>
	Effect.gen(function* () {
		const directory = yield* Effect.acquireRelease(
			Effect.try(() => mkdtempSync(join(tmpdir(), "conduit-replay-parity-"))),
			(path) =>
				Effect.sync(() => rmSync(path, { recursive: true, force: true })),
		);
		const input =
			typeof source === "string"
				? yield* Effect.acquireRelease(
						Effect.try(
							() => new DatabaseSync(source, { readOnly: true, timeout: 5000 }),
						),
						(db) => Effect.sync(() => db.close()),
					)
				: source;
		const snapshotFilename = join(directory, "snapshot.db");
		yield* Effect.tryPromise(() => backup(input, snapshotFilename)).pipe(
			Effect.uninterruptible,
		);
		const snapshot = yield* Effect.acquireRelease(
			Effect.try(() => new DatabaseSync(snapshotFilename, { readOnly: true })),
			(db) => Effect.sync(() => db.close()),
		);
		const filename = join(directory, "replay.db");
		yield* initializeReplayStore(filename);
		yield* Effect.try(() => {
			const destination = new DatabaseSync(filename);
			try {
				destination.exec("PRAGMA foreign_keys = OFF; BEGIN");
				const columns = (
					snapshot.prepare("PRAGMA table_info(events)").all() as {
						name: string;
					}[]
				).map(({ name }) => name);
				const insert = destination.prepare(
					`INSERT INTO events (${columns.join(",")}) VALUES (${columns.map((name) => `@${name}`).join(",")})`,
				);
				for (const row of snapshot
					.prepare("SELECT * FROM events ORDER BY sequence")
					.iterate())
					insert.run(row);
				destination.exec("COMMIT");
			} finally {
				destination.close();
			}
		});
		const sessionIds = (yield* Effect.try(() =>
			snapshot.prepare("SELECT id FROM sessions ORDER BY id").all(),
		)) as { id: string }[];
		const replay = yield* replayProjectionStore(
			filename,
			sessionIds.map(({ id }) => id),
			options,
		);
		return yield* Effect.try(() => {
			const actual = new DatabaseSync(filename, { readOnly: true });
			try {
				const report = compareProjectionStores(snapshot, actual, options);
				if (
					replay.failures ||
					replay.restartReplayed ||
					replay.streamVersionDifferences.length
				) {
					report.diffs.push({
						table: "replay",
						key: null,
						fields: ["recovery"],
						expected: {
							failures: 0,
							restartReplayed: 0,
							streamVersionDifferences: 0,
						},
						actual: {
							failures: replay.failures,
							restartReplayed: replay.restartReplayed,
							streamVersionDifferences: replay.streamVersionDifferences.length,
						},
					});
				}
				return report;
			} finally {
				actual.close();
			}
		});
	}).pipe(Effect.scoped);
