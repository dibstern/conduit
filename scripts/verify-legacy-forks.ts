/**
 * Compare migration 0060 with event replay, using disposable copies only.
 * Run: node --import tsx scripts/verify-legacy-forks.ts --source /tmp/extp/live-clone.db --output docs/performance/extp4-legacy-fork-migration.json
 * Reports contain identifiers, counts, hashes and booleans, never store content.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import Database from "better-sqlite3";
import { Effect, Layer } from "effect";
import { PersistenceProjectTag } from "../src/lib/domain/persistence/Services/persistence-service.js";
import { makeEffectSqlMigrator } from "../src/lib/persistence/effect/migrations.js";
import { makeProjectionRunnerEffect } from "../src/lib/persistence/effect/projection-runner-effect.js";
import {
	makeProjectorCursorEffect,
	ProjectorCursorEffectTag,
} from "../src/lib/persistence/effect/projector-cursor-effect.js";
import { createAllEffectProjectors } from "../src/lib/persistence/effect/projectors-effect.js";
import { refreshSidebar } from "../src/lib/persistence/effect/sidebar-projection.js";
import { SidebarRowSchema } from "../src/lib/persistence/sidebar-row.js";

const { values } = parseArgs({
	options: {
		source: { type: "string", default: "/tmp/extp/live-clone.db" },
		output: {
			type: "string",
			default: "docs/performance/extp4-legacy-fork-migration.json",
		},
	},
});

function safePath(filename: string): string {
	const absolute = resolve(filename);
	const liveDirectory = join(homedir(), ".config", "conduit");
	assert(
		!absolute.startsWith(liveDirectory),
		"Live conduit paths are forbidden",
	);
	let ancestor = absolute;
	while (!existsSync(ancestor)) ancestor = dirname(ancestor);
	const canonical = resolve(
		realpathSync(ancestor),
		relative(ancestor, absolute),
	);
	assert(
		!canonical.startsWith(liveDirectory),
		"Live conduit paths are forbidden",
	);
	return canonical;
}

const sourceFilename = safePath(values.source);
assert.equal(realpathSync(sourceFilename), sourceFilename);
const outputFilename = safePath(values.output);
const sourceFiles = ["", "-wal", "-shm"]
	.map((suffix) => safePath(`${sourceFilename}${suffix}`))
	.filter((filename) => existsSync(filename));
for (const filename of sourceFiles) {
	assert.notEqual(
		outputFilename,
		filename,
		"Output must not overwrite the source",
	);
	if (existsSync(outputFilename)) {
		const input = statSync(filename);
		const output = statSync(outputFilename);
		assert(
			input.dev !== output.dev || input.ino !== output.ino,
			"Output must not be a hard link to the source",
		);
	}
}

const placementColumns = [
	"parent_id",
	"forked_from",
	"side_thread",
	"root_id",
	"fork_point_event",
	"fork_point_timestamp",
	"fork_point_message_id",
] as const;
type Placement = {
	id: string;
	parent_id: string | null;
	forked_from: string | null;
	side_thread: number;
	root_id: string | null;
	fork_point_event: string | null;
	fork_point_timestamp: number | null;
	fork_point_message_id: string | null;
};
type Sidebar = {
	session_id: string;
	version: number;
	last_activity: number;
	row: string | null;
};
type Difference = { id: string; columns: string[] };
type EventRow = Record<string, string | number | null>;

const minimumFreeBytes = 8 * 1024 ** 3;
let minimumObservedFreeBytes = Number.POSITIVE_INFINITY;
let diskChecks = 0;
function guardDisk(budgetBytes: number): void {
	const lines = execFileSync("df", ["-k", "/tmp"], { encoding: "utf8" })
		.trim()
		.split("\n");
	const availableBytes = Number(lines.at(-1)?.trim().split(/\s+/)[3]) * 1024;
	assert(Number.isFinite(availableBytes), "Could not read df -k /tmp");
	minimumObservedFreeBytes = Math.min(minimumObservedFreeBytes, availableBytes);
	diskChecks++;
	assert(
		availableBytes - budgetBytes >= minimumFreeBytes,
		"Insufficient free disk space",
	);
}

function copyStore(source: string, target: string): void {
	const files = ["", "-wal", "-shm"].filter((suffix) =>
		existsSync(safePath(`${source}${suffix}`)),
	);
	guardDisk(
		files.reduce(
			(bytes, suffix) => bytes + statSync(`${source}${suffix}`).size,
			0,
		),
	);
	for (const suffix of files) {
		copyFileSync(
			safePath(`${source}${suffix}`),
			`${target}${suffix}`,
			constants.COPYFILE_EXCL,
		);
	}
}

function placements(db: Database.Database): Placement[] {
	const columns = new Set(
		db
			.prepare<[], { name: string }>("PRAGMA table_info(sessions)")
			.all()
			.map(({ name }) => name),
	);
	// Older snapshots can precede migration 0059, which adds forked_from.
	const selection = placementColumns.map((column) => {
		if (column === "forked_from" && !columns.has(column))
			return "NULL AS forked_from";
		assert(columns.has(column), `Missing placement column: ${column}`);
		return column;
	});
	return db
		.prepare<[], Placement>(
			`SELECT id, ${selection.join(",")} FROM sessions ORDER BY id`,
		)
		.all();
}

function sidebarRows(db: Database.Database): Sidebar[] {
	return db
		.prepare<[], Sidebar>(
			"SELECT session_id, version, last_activity, row FROM session_sidebar ORDER BY session_id",
		)
		.all();
}

function fingerprint(
	db: Database.Database,
	table: "messages" | "message_parts",
) {
	const owner = table === "messages" ? "session_id" : "message_id";
	const hash = createHash("sha256");
	let count = 0;
	for (const row of db
		.prepare<[], { id: string; owner_id: string; version: number }>(
			`SELECT id, ${owner} AS owner_id, version FROM ${table} ORDER BY id`,
		)
		.iterate()) {
		hash.update(`${JSON.stringify([row.id, row.owner_id, row.version])}\n`);
		count++;
	}
	return { count, sha256: hash.digest("hex") };
}

function eventCounts(db: Database.Database) {
	const row = db
		.prepare<[], { count: number; maxSequence: number }>(
			"SELECT COUNT(*) AS count, COALESCE(MAX(sequence), 0) AS maxSequence FROM events",
		)
		.get();
	assert(row);
	return row;
}

function counter(db: Database.Database): number {
	const row = db
		.prepare<[], { value: number }>(
			"SELECT value FROM read_model_counter WHERE id = 1",
		)
		.get();
	assert(row);
	return row.value;
}

function sqliteLayer(filename: string) {
	return SqliteNode.layer({ filename }).pipe(Layer.provide(Reactivity.layer));
}

async function migrate(filename: string, repairLedger = false) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql.unsafe("PRAGMA foreign_keys = OFF");
			if (repairLedger) {
				yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 60`;
			}
			return yield* makeEffectSqlMigrator();
		}).pipe(Effect.provide(sqliteLayer(filename)), Effect.scoped),
	);
}

async function replay(
	filename: string,
	selectedIds: string[],
	readSessionIds: string[],
	selectedRoots: string[],
) {
	let projected = 0;
	const projectors = createAllEffectProjectors().map((projector) => ({
		...projector,
		project: (
			event: Parameters<typeof projector.project>[0],
			context: Parameters<typeof projector.project>[1],
		) => {
			// recover records ordinary failures and continues. Interrupt on low disk.
			const diskGuard =
				projected++ % 500 === 0
					? Effect.try(() => guardDisk(1024 ** 3)).pipe(
							Effect.catchAll(() => Effect.interrupt),
						)
					: Effect.void;
			return diskGuard.pipe(Effect.zipRight(projector.project(event, context)));
		},
	}));
	return Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const cursor = yield* makeProjectorCursorEffect.pipe(
				Effect.provideService(PersistenceProjectTag, {
					projectId: "legacy-fork-parity",
				}),
			);
			const runner = yield* makeProjectionRunnerEffect(projectors).pipe(
				Effect.provideService(ProjectorCursorEffectTag, cursor),
			);
			const recovery = yield* runner.recover();
			const failures = yield* runner.getFailures();
			const [persisted] = yield* sql<{
				count: number;
			}>`SELECT COUNT(*) AS count FROM projection_failures`;
			const restart = yield* runner.recover();
			const carriedOver = yield* sql.withTransaction(
				Effect.gen(function* () {
					// Preserve read meaning using B's versions, never A's raw counter.
					const marked = yield* sql<{ seen_version: number | null }>`
						UPDATE sessions SET seen_version = CASE
							WHEN id IN (SELECT value FROM json_each(${JSON.stringify(readSessionIds)}))
							THEN COALESCE(last_turn_end_version, -1) ELSE NULL END
						WHERE id IN (SELECT value FROM json_each(${JSON.stringify(selectedIds)}))
						RETURNING seen_version`;
					const [readModelCounter] = yield* sql<{ value: number }>`
						SELECT value FROM read_model_counter WHERE id = 1`;
					assert(readModelCounter);
					yield* refreshSidebar(selectedRoots, readModelCounter.value);
					return marked.filter(({ seen_version }) => seen_version !== null)
						.length;
				}),
			);
			return {
				readState: {
					carriedOver,
					reason: "seen_version is not event-sourced (ADR-0004)",
				},
				startCursor: recovery.startCursor,
				endCursor: recovery.endCursor,
				totalReplayed: recovery.totalReplayed,
				failures: failures.length,
				persistedFailures: persisted?.count ?? 0,
				restartReplayed: restart.totalReplayed,
			};
		}).pipe(Effect.provide(sqliteLayer(filename)), Effect.scoped),
	);
}

function comparePlacements(
	before: Placement[],
	after: Placement[],
	ids: string[],
): Difference[] {
	const left = new Map(before.map((row) => [row.id, row]));
	const right = new Map(after.map((row) => [row.id, row]));
	return ids.flatMap((id) => {
		const a = left.get(id);
		const b = right.get(id);
		const columns =
			a && b
				? placementColumns.filter((column) => a[column] !== b[column])
				: ["id"];
		return columns.length === 0 ? [] : [{ id, columns }];
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function visibleSidebar(row: string | null): Record<string, unknown> | null {
	if (row === null) return null;
	const value: unknown = JSON.parse(row);
	assert(isRecord(value));
	assert("version" in value && "lastActivity" in value);
	const { version: _version, lastActivity: _lastActivity, ...visible } = value;
	return visible;
}

function sidebarColumns(before: string | null, after: string | null): string[] {
	const left = visibleSidebar(before);
	const right = visibleSidebar(after);
	if (isDeepStrictEqual(left, right)) return [];
	if (left === null || right === null) return ["row"];
	const columns: string[] = [];
	// Only schema field names enter the artifact, never arbitrary JSON keys.
	for (const field of Object.keys(SidebarRowSchema.fields)) {
		if (field === "version" || field === "lastActivity") continue;
		if (isDeepStrictEqual(left[field], right[field])) continue;
		const a = left[field];
		const b = right[field];
		if (field === "session" && isRecord(a) && isRecord(b)) {
			for (const key of Object.keys(SidebarRowSchema.fields.session.fields)) {
				if (!isDeepStrictEqual(a[key], b[key]))
					columns.push(`row.session.${key}`);
			}
		} else {
			columns.push(`row.${field}`);
		}
	}
	return columns.length > 0 ? columns : ["row"];
}

function compareSidebars(
	before: Sidebar[],
	after: Sidebar[],
	ids: string[],
	exact = false,
): Difference[] {
	const left = new Map(before.map((row) => [row.session_id, row]));
	const right = new Map(after.map((row) => [row.session_id, row]));
	return ids.flatMap((id) => {
		const a = left.get(id);
		const b = right.get(id);
		if (a === undefined && b === undefined) return [];
		if (a === undefined || b === undefined)
			return [{ id, columns: ["session_id"] }];
		const columns: string[] = [];
		if (exact && a.version !== b.version) columns.push("version");
		if (a.last_activity !== b.last_activity) columns.push("last_activity");
		if (exact) {
			if (a.row !== b.row) columns.push("row");
		} else {
			columns.push(...sidebarColumns(a.row, b.row));
		}
		return columns.length === 0 ? [] : [{ id, columns }];
	});
}

async function verify() {
	const temporaryDirectory = mkdtempSync("/tmp/conduit-legacy-fork-parity-");
	const migratedFilename = join(temporaryDirectory, "migrated.db");
	const snapshotFilename = join(temporaryDirectory, "source.db");
	const replayFilename = join(temporaryDirectory, "replay.db");
	const rerunFilename = join(temporaryDirectory, "rerun.db");
	const connections: Database.Database[] = [];
	function open(filename: string, readonly = true): Database.Database {
		const db = new Database(filename, { readonly, fileMustExist: true });
		connections.push(db);
		db.pragma("temp_store = MEMORY");
		return db;
	}
	try {
		// Never open --source with SQLite, even for schema inspection.
		copyStore(sourceFilename, migratedFilename);
		copyStore(migratedFilename, snapshotFilename);
		const source = open(snapshotFilename);
		const sourcePlacements = placements(source);
		const legacyForks = source
			.prepare<[], { id: string }>(`
			SELECT id FROM sessions WHERE parent_id IS NOT NULL AND side_thread = 0
			AND (fork_point_event IS NOT NULL OR fork_point_timestamp IS NOT NULL
				OR EXISTS (SELECT 1 FROM events WHERE session_id = sessions.id AND type = 'session.forked'))
			ORDER BY id
		`)
			.all()
			.map(({ id }) => id);
		const sideThreads = sourcePlacements
			.filter((row) => row.side_thread === 1)
			.map(({ id }) => id);
		const sourceMessages = fingerprint(source, "messages");
		const sourceParts = fingerprint(source, "message_parts");
		const sourceEvents = eventCounts(source);
		const counterBefore = counter(source);
		guardDisk(statSync(migratedFilename).size * 2);
		const applied = await migrate(migratedFilename);
		const migrated = open(migratedFilename);
		const migratedPlacements = placements(migrated);
		const migratedSidebar = sidebarRows(migrated);
		const candidates = new Set([...legacyForks, ...sideThreads]);
		const oldRoots = new Set(
			sourcePlacements
				.filter(({ id }) => candidates.has(id))
				.map(({ root_id }) => root_id),
		);
		const newRoots = new Set(
			migratedPlacements
				.filter(({ id }) => candidates.has(id))
				.map(({ root_id }) => root_id),
		);
		const selectedIds = [
			...new Set([
				...candidates,
				...sourcePlacements
					.filter(({ root_id }) => oldRoots.has(root_id))
					.map(({ id }) => id),
				...migratedPlacements
					.filter(({ root_id }) => newRoots.has(root_id))
					.map(({ id }) => id),
			]),
		].sort();
		const selected = new Set(selectedIds);
		const selectedRoots = [
			...new Set(
				[...sourcePlacements, ...migratedPlacements]
					.filter(({ id }) => selected.has(id))
					.map(({ root_id }) => root_id)
					.filter((id): id is string => id !== null),
			),
		].sort();

		guardDisk(16 * 1024 ** 2);
		await migrate(replayFilename);
		const replayStore = open(replayFilename, false);
		replayStore.pragma("foreign_keys = OFF");
		const columns = source
			.prepare<[], { name: string }>("PRAGMA table_info(events)")
			.all()
			.map(({ name }) => name);
		const insert = replayStore.prepare<EventRow>(
			`INSERT INTO events (${columns.join(",")}) VALUES (${columns.map((column) => `@${column}`).join(",")})`,
		);
		const extraction = source.prepare<[string], EventRow>(`
			SELECT ${columns.join(",")} FROM events
			WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY sequence
		`);
		let copiedEvents = 0;
		replayStore.transaction(() => {
			for (const row of extraction.iterate(JSON.stringify(selectedIds))) {
				if (copiedEvents++ % 10000 === 0) guardDisk(1024 ** 3);
				insert.run(row);
			}
		})();
		const extractedCounts = eventCounts(replayStore);
		replayStore.pragma("wal_checkpoint(TRUNCATE)");
		replayStore.close();
		console.error(
			`Replaying ${copiedEvents} events for ${selectedIds.length} sessions`,
		);
		const readSessionIds = migrated
			.prepare<[string], { id: string }>(`
				SELECT id FROM sessions
				WHERE id IN (SELECT value FROM json_each(?))
				AND seen_version IS NOT NULL
				AND seen_version >= COALESCE(last_turn_end_version, -1)
				ORDER BY id
			`)
			.all(JSON.stringify(selectedIds))
			.map(({ id }) => id);
		const { readState, ...recovery } = await replay(
			replayFilename,
			selectedIds,
			readSessionIds,
			selectedRoots,
		);
		const replayed = open(replayFilename);
		const replayedPlacements = placements(replayed);
		const replayedIds = new Set(replayedPlacements.map(({ id }) => id));
		const notReplayable = migratedPlacements
			.filter(({ id }) => selected.has(id) && !replayedIds.has(id))
			.map(({ id }) => id);
		const excluded = new Set(notReplayable);
		const replayable = selectedIds.filter((id) => !excluded.has(id));
		const placementDifferences = comparePlacements(
			migratedPlacements,
			replayedPlacements,
			replayable,
		);
		const sidebarDifferences = compareSidebars(
			migratedSidebar,
			sidebarRows(replayed),
			selectedRoots.filter((id) => !excluded.has(id)),
		);
		const afterMessages = fingerprint(migrated, "messages");
		const afterParts = fingerprint(migrated, "message_parts");
		const afterEvents = eventCounts(migrated);
		const counterAfter = counter(migrated);
		const integrity = migrated
			.prepare<[], { integrity_check: string }>("PRAGMA integrity_check")
			.all();
		const integrityOk =
			integrity.length === 1 && integrity[0]?.integrity_check === "ok";
		const foreignKeys = migrated
			.prepare<
				[],
				{ table: string; rowid: number | null; parent: string; fkid: number }
			>("PRAGMA foreign_key_check")
			.all();
		const legacyForksMoved = migratedPlacements
			.filter(
				(row) =>
					legacyForks.includes(row.id) &&
					row.parent_id === null &&
					row.forked_from !== null,
			)
			.map(({ id }) => id);
		const sideThreadsWithLineage = migratedPlacements
			.filter(
				(row) =>
					row.side_thread === 1 &&
					row.parent_id !== null &&
					row.forked_from === row.parent_id,
			)
			.map(({ id }) => id);

		copyStore(migratedFilename, rerunFilename);
		guardDisk(statSync(rerunFilename).size * 2);
		const reapplied = await migrate(rerunFilename, true);
		const rerun = open(rerunFilename);
		const rerunPlacements = placements(rerun);
		const rerunIds = [
			...new Set(
				[...migratedPlacements, ...rerunPlacements].map(({ id }) => id),
			),
		].sort();
		const rerunSidebar = sidebarRows(rerun);
		const rerunRoots = [
			...new Set(
				[...migratedSidebar, ...rerunSidebar].map(
					({ session_id }) => session_id,
				),
			),
		].sort();
		const rerunPlacementDifferences = comparePlacements(
			migratedPlacements,
			rerunPlacements,
			rerunIds,
		);
		const rerunSidebarDifferences = compareSidebars(
			migratedSidebar,
			rerunSidebar,
			rerunRoots,
			true,
		);
		const counterRerun = counter(rerun);
		const messagesUnchanged = isDeepStrictEqual(sourceMessages, afterMessages);
		const partsUnchanged = isDeepStrictEqual(sourceParts, afterParts);
		const eventsUnchanged = isDeepStrictEqual(sourceEvents, afterEvents);
		const rerunApplied = reapplied.length === 1 && reapplied[0]?.[0] === 60;
		const passed =
			placementDifferences.length === 0 &&
			sidebarDifferences.length === 0 &&
			messagesUnchanged &&
			partsUnchanged &&
			eventsUnchanged &&
			integrityOk &&
			foreignKeys.length === 0 &&
			recovery.failures === 0 &&
			recovery.persistedFailures === 0 &&
			recovery.restartReplayed === 0 &&
			recovery.endCursor === extractedCounts.maxSequence &&
			copiedEvents === extractedCounts.count &&
			legacyForksMoved.length === legacyForks.length &&
			rerunApplied &&
			rerunPlacementDifferences.length === 0 &&
			rerunSidebarDifferences.length === 0 &&
			counterRerun === counterAfter;
		return {
			ticket: "conduit-test-extp.4",
			passed,
			migration: {
				id: "0060_legacy_forks",
				applied: applied.map(([id]) => id),
			},
			selection: {
				legacyForks,
				sideThreads,
				sessionIds: selectedIds,
				rootIds: selectedRoots,
			},
			legacyForksMoved,
			sideThreadsWithLineage,
			notReplayable,
			readState,
			placement: {
				compared: replayable.length,
				differences: placementDifferences,
			},
			sidebar: {
				compared: selectedRoots.filter((id) => !excluded.has(id)).length,
				differences: sidebarDifferences,
			},
			replay: { events: extractedCounts, ...recovery },
			unchanged: {
				messages: {
					before: sourceMessages,
					after: afterMessages,
					equal: messagesUnchanged,
				},
				messageParts: {
					before: sourceParts,
					after: afterParts,
					equal: partsUnchanged,
				},
				events: {
					before: sourceEvents,
					after: afterEvents,
					equal: eventsUnchanged,
				},
			},
			integrityCheck: {
				ok: integrityOk,
				results: integrity.length,
				problems: integrity.filter(
					({ integrity_check }) => integrity_check !== "ok",
				).length,
			},
			foreignKeyCheck: {
				ok: foreignKeys.length === 0,
				count: foreignKeys.length,
				rows: foreignKeys,
			},
			readModelCounter: {
				before: counterBefore,
				after: counterAfter,
				rerun: counterRerun,
			},
			idempotence: {
				applied: reapplied.map(([id]) => id),
				placementCompared: rerunIds.length,
				sidebarCompared: rerunRoots.length,
				placementDifferences: rerunPlacementDifferences,
				sidebarDifferences: rerunSidebarDifferences,
				counterUnchanged: counterRerun === counterAfter,
			},
			disk: {
				minimumFreeBytes,
				minimumObservedFreeBytes,
				checks: diskChecks,
				fullCopies: 3,
			},
		};
	} finally {
		for (const db of connections) if (db.open) db.close();
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

const report = await verify();
mkdirSync(dirname(outputFilename), { recursive: true });
writeFileSync(
	outputFilename,
	`${JSON.stringify({ ...report, temporaryDatabasesRemoved: true }, null, "\t")}\n`,
);
execFileSync("pnpm", ["exec", "biome", "format", "--write", outputFilename], {
	stdio: "inherit",
});
console.error(`Wrote ${outputFilename}; passed=${report.passed}`);
if (!report.passed) process.exitCode = 1;
