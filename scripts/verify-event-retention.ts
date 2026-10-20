/** Drain and replay disposable copies. The supplied source is never opened by SQLite. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Layer } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import {
	type DrainReport,
	makeEventRetention,
} from "../src/lib/domain/persistence/Services/event-retention.js";
import { PersistenceProjectTag } from "../src/lib/domain/persistence/Services/persistence-service.js";
import { makeEffectSqlMigrator } from "../src/lib/persistence/effect/migrations.js";
import {
	compareProjectionStores,
	initializeReplayStore,
	type ReplayParityDiff,
	type ReplayParityReport,
	replayProjectionStore,
	replayProjectionTables,
} from "../src/lib/persistence/replay-parity.js";

// Keep identical to checkReplayParity() in test/integration/helpers/relay-harness.ts.
const ignoredColumns = [
	"version",
	"session_sidebar.row.version",
	"sessions.history_complete",
];
// Same logical byte definition as DrainReport.bytesFreed; this excludes page reclamation.
const eventBytes = `length(CAST(event_id AS BLOB)) + length(CAST(session_id AS BLOB))
	+ length(CAST(type AS BLOB)) + length(CAST(data AS BLOB))
	+ length(CAST(metadata AS BLOB)) + length(CAST(provider AS BLOB))
	+ COALESCE(length(CAST(project_id AS BLOB)), 0)`;

function eventSet(db: DatabaseSync, filename: string) {
	const groups = new Map<
		string,
		{
			projectId: string;
			sessionId: string;
			events: number;
			logicalBytes: number;
			hash: ReturnType<typeof createHash>;
		}
	>();
	let events = 0;
	let logicalBytes = 0;
	for (const row of db
		.prepare(`SELECT project_id, session_id, sequence, event_id,
			${eventBytes} AS bytes FROM events ORDER BY sequence`)
		.iterate() as Iterable<{
		project_id: string | null;
		session_id: string;
		sequence: number;
		event_id: string;
		bytes: number;
	}>) {
		assert(
			row.project_id !== null,
			"Cannot drain an event without a project_id",
		);
		const key = JSON.stringify([row.project_id, row.session_id]);
		let group = groups.get(key);
		if (!group) {
			group = {
				projectId: row.project_id,
				sessionId: row.session_id,
				events: 0,
				logicalBytes: 0,
				hash: createHash("sha256"),
			};
			groups.set(key, group);
		}
		group.events++;
		group.logicalBytes += row.bytes;
		group.hash.update(`${JSON.stringify([row.sequence, row.event_id])}\n`);
		events++;
		logicalBytes += row.bytes;
	}
	return {
		totals: {
			events,
			logicalBytes,
			databaseBytes: statSync(filename).size,
			walBytes: existsSync(`${filename}-wal`)
				? statSync(`${filename}-wal`).size
				: 0,
		},
		sessions: [...groups.values()]
			.map(({ hash, ...group }) => ({ ...group, sha256: hash.digest("hex") }))
			.sort(
				(a, b) =>
					a.projectId.localeCompare(b.projectId) ||
					a.sessionId.localeCompare(b.sessionId),
			),
	};
}

function verdict(db: DatabaseSync, query: string, args: SQLInputValue[] = []) {
	const violations = Number(
		db.prepare(`SELECT COUNT(*) AS count FROM (${query})`).get(...args)?.[
			"count"
		],
	);
	return {
		passed: violations === 0,
		violations,
		samples: violations ? db.prepare(`${query} LIMIT 20`).all(...args) : [],
	};
}

function deadSessions(db: DatabaseSync) {
	const sessions = db
		.prepare(`SELECT project_id AS projectId, session_id AS sessionId,
		COUNT(*) AS events,
		SUM(CASE WHEN type = 'session.deleted' AND json_valid(data)
			AND json_extract(data, '$.sessionId') = session_id THEN 1 ELSE 0 END) AS ownMarkers
		FROM events e WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id)
		GROUP BY project_id, session_id ORDER BY project_id, session_id`)
		.all() as {
		projectId: string;
		sessionId: string;
		events: number;
		ownMarkers: number;
	}[];
	return {
		totals: {
			sessions: sessions.length,
			events: sessions.reduce((sum, row) => sum + row.events, 0),
			sessionsWithOwnMarker: sessions.filter((row) => row.ownMarkers > 0)
				.length,
			ownMarkers: sessions.reduce((sum, row) => sum + row.ownMarkers, 0),
			nonMarkerEvents: sessions.reduce(
				(sum, row) => sum + row.events - row.ownMarkers,
				0,
			),
		},
		sessions,
	};
}

function paritySummary(parity: ReplayParityReport, sampleLimit: number) {
	const diffsByTable: Record<string, number> = {};
	const diffsByColumn: Record<string, number> = {};
	for (const diff of parity.diffs) {
		diffsByTable[diff.table] = (diffsByTable[diff.table] ?? 0) + 1;
		for (const field of diff.fields) {
			const column = `${diff.table}.${field}`;
			diffsByColumn[column] = (diffsByColumn[column] ?? 0) + 1;
		}
	}
	return {
		counts: parity.counts,
		diffCount: parity.diffs.length,
		diffsByTable,
		diffsByColumn,
		// Identifiers only: committed artifacts must not carry row content.
		diffSamples: parity.diffs
			.slice(0, sampleLimit)
			.map(({ table, key, fields }) => ({ table, key, fields })),
		danglingPartPointers: parity.danglingPartPointers,
	};
}

function diffSessionId(
	diff: ReplayParityDiff,
	before: DatabaseSync,
	after: DatabaseSync,
) {
	for (const row of [diff.expected, diff.actual]) {
		if (!row) continue;
		if (typeof row["session_id"] === "string") return row["session_id"];
		if (diff.table === "sessions" && typeof row["id"] === "string")
			return row["id"];
		if (typeof row["message_id"] === "string") {
			for (const db of [before, after]) {
				const owner = db
					.prepare("SELECT session_id FROM messages WHERE id = ?")
					.get(row["message_id"]);
				if (typeof owner?.["session_id"] === "string")
					return owner["session_id"];
			}
		}
	}
	return null;
}

function reclaimedProjectionRows(db: DatabaseSync, sessionIds: string[]) {
	return Object.fromEntries(
		replayProjectionTables.map((table) => {
			const columns = (
				db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
			).map((column) => column.name);
			const owner = table === "sessions" ? "id" : "session_id";
			const query = columns.includes(owner)
				? `SELECT COUNT(*) AS count FROM ${table} WHERE ${owner} IN (SELECT value FROM json_each(?))
					${table === "session_sidebar" ? "AND row IS NOT NULL" : ""}`
				: `SELECT COUNT(*) AS count FROM ${table} p JOIN messages m ON m.id = p.message_id
				WHERE m.session_id IN (SELECT value FROM json_each(?))`;
			return [
				table,
				Number(db.prepare(query).get(JSON.stringify(sessionIds))?.["count"]),
			];
		}),
	);
}

type DrainRun = {
	durationMs: number;
	projects: (DrainReport & { projectId: string; durationMs: number })[];
};

const { values } = parseArgs({
	options: {
		source: { type: "string" },
		output: { type: "string" },
		help: { type: "boolean", short: "h" },
	},
});

if (values.help) {
	console.log(`Usage: node --import tsx scripts/verify-event-retention.ts --source <store-copy.db> --output <report.json>

Migrate temporary copies, drain each project, and compare rebuilt undrained/drained projections.
Live-versus-replay drift on the undrained copy is informational only.
Record event fingerprints, drain timings and idempotence. Temporary stores are removed.
Sources and outputs under ~/.config/conduit are refused. The source directory is never written.`);
} else {
	assert(values.source && values.output, "--source and --output are required");
	const liveDirectory = join(homedir(), ".config", "conduit");
	function refuseLivePath(filename: string) {
		assert(
			filename !== liveDirectory &&
				!filename.startsWith(`${liveDirectory}${sep}`),
			"Use copies and output paths outside ~/.config/conduit",
		);
	}
	refuseLivePath(resolve(values.source));
	const sourceFilename = realpathSync(values.source);
	refuseLivePath(sourceFilename);
	const outputFilename = resolve(values.output);
	refuseLivePath(outputFilename);
	let ancestor = outputFilename;
	while (!lstatSync(ancestor, { throwIfNoEntry: false }))
		ancestor = dirname(ancestor);
	const canonicalOutput = resolve(
		realpathSync(ancestor),
		relative(ancestor, outputFilename),
	);
	refuseLivePath(canonicalOutput);
	assert(
		canonicalOutput !== sourceFilename &&
			!canonicalOutput.startsWith(`${dirname(sourceFilename)}${sep}`),
		"--output must be outside the source directory",
	);
	const sourceStat = statSync(sourceFilename);
	assert(sourceStat.isFile(), "--source must be a regular file");
	if (existsSync(outputFilename)) {
		const outputStat = statSync(outputFilename);
		assert(
			sourceStat.dev !== outputStat.dev || sourceStat.ino !== outputStat.ino,
			"--output must not overwrite the source store",
		);
	}
	const startedAt = performance.now();
	const report: Record<string, unknown> = {
		passed: false,
		startedAt: new Date().toISOString(),
		runtime: { node: process.version, sqlite: process.versions["sqlite"] },
		source: { filename: sourceFilename, bytes: sourceStat.size },
		fingerprint:
			"SHA-256 of newline-delimited JSON [sequence,event_id], in sequence order per project/session",
		bytes:
			"Logical bytes sum event text columns as DrainReport does; database/WAL bytes are physical and no VACUUM is run.",
		ignoredColumns,
	};
	const directory = mkdtempSync(join(tmpdir(), "conduit-retention-dry-run-"));
	console.error(`Disposable stores: ${directory}`);
	const filename = join(directory, "after.db");
	const baselineFilename = join(directory, "before.db");
	const beforeRebuiltFilename = join(directory, "before-rebuilt.db");
	const afterRebuiltFilename = join(directory, "after-rebuilt.db");
	const rebuilds: Record<string, unknown> = {};
	report["rebuilds"] = rebuilds;
	const storeLayer = SqliteNode.layer({ filename, busyTimeout: 5000 }).pipe(
		Layer.provide(Reactivity.layer),
	);
	async function drain(projectIds: string[]): Promise<DrainRun> {
		const started = performance.now();
		const projects = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`PRAGMA foreign_keys = ON`;
				yield* sql`PRAGMA journal_mode = WAL`;
				yield* sql`PRAGMA synchronous = NORMAL`;
				yield* sql`PRAGMA temp_store = MEMORY`;
				const results: DrainRun["projects"] = [];
				for (const projectId of projectIds) {
					const retention = yield* makeEventRetention.pipe(
						Effect.provideService(PersistenceProjectTag, { projectId }),
					);
					const projectStarted = performance.now();
					const result = yield* retention.drain();
					const durationMs = Math.round(performance.now() - projectStarted);
					results.push({ projectId, durationMs, ...result });
					console.error(
						`${projectId}: ${result.sessionsFreed} sessions, ${result.eventsFreed} events, ${result.bytesFreed} bytes freed in ${durationMs} ms`,
					);
				}
				return results;
			}).pipe(Effect.provide(storeLayer), Effect.scoped),
		);
		return { durationMs: Math.round(performance.now() - started), projects };
	}
	async function rebuild(
		label: string,
		inputFilename: string,
		destinationFilename: string,
		sessionIds: string[],
	) {
		const started = performance.now();
		console.error(
			`${label}: creating a fresh store containing only the event log`,
		);
		await Effect.runPromise(initializeReplayStore(destinationFilename));
		const destination = new DatabaseSync(destinationFilename);
		try {
			destination
				.prepare("ATTACH DATABASE ? AS input")
				.run(`${pathToFileURL(inputFilename).href}?immutable=1`);
			const columns = (
				destination.prepare("PRAGMA table_info(events)").all() as {
					name: string;
				}[]
			)
				.map((column) => column.name)
				.join(",");
			destination.exec(`PRAGMA foreign_keys = OFF;
				INSERT INTO events (${columns}) SELECT ${columns} FROM input.events ORDER BY sequence`);
		} finally {
			destination.close();
		}
		const eventCopyDurationMs = Math.round(performance.now() - started);
		console.error(`${label}: replaying the complete event log`);
		const replayStarted = performance.now();
		const result = await Effect.runPromise(
			replayProjectionStore(destinationFilename, sessionIds),
		);
		const summary = {
			eventCopyDurationMs,
			replayDurationMs: Math.round(performance.now() - replayStarted),
			durationMs: Math.round(performance.now() - started),
			recovery: result.recovery,
			failures: result.failures,
			restartReplayed: result.restartReplayed,
			streamVersionDifferences: result.streamVersionDifferences,
			historySessions: result.histories.length,
		};
		rebuilds[label] = summary;
		assert.equal(result.failures, 0, `${label}: recovery skipped a projection`);
		assert.equal(
			result.restartReplayed,
			0,
			`${label}: persisted projector cursors did not catch up`,
		);
		assert.deepEqual(
			result.streamVersionDifferences,
			[],
			`${label}: stream version mismatch`,
		);
		console.error(
			`${label}: rebuild completed in ${summary.durationMs} ms, no failures, restart replayed nothing`,
		);
		return summary;
	}
	let phase = "copy";
	try {
		copyFileSync(sourceFilename, filename);
		chmodSync(filename, 0o600);
		report["copyDurationMs"] = Math.round(performance.now() - startedAt);
		phase = "migrate";
		const migrationStarted = performance.now();
		const applied = await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`PRAGMA journal_mode = WAL`;
				yield* sql`PRAGMA synchronous = NORMAL`;
				yield* sql`PRAGMA foreign_keys = OFF`;
				return yield* makeEffectSqlMigrator();
			}).pipe(Effect.provide(storeLayer), Effect.scoped),
		);
		report["migrations"] = {
			applied,
			durationMs: Math.round(performance.now() - migrationStarted),
		};
		phase = "before event set";
		const beforeDb = new DatabaseSync(filename, { readOnly: true });
		let before: ReturnType<typeof eventSet>;
		let beforeDead: ReturnType<typeof deadSessions>;
		try {
			before = eventSet(beforeDb, filename);
			beforeDead = deadSessions(beforeDb);
			report["before"] = before;
			await backup(beforeDb, baselineFilename);
		} finally {
			beforeDb.close();
		}
		const projectIds = [
			...new Set(before.sessions.map((row) => row.projectId)),
		];
		phase = "first drain";
		const first = await drain(projectIds);
		report["firstDrain"] = first;
		phase = "event diff";
		const db = new DatabaseSync(filename);
		let after: ReturnType<typeof eventSet>;
		let reclaimedSessionIds: string[];
		try {
			after = eventSet(db, filename);
			report["after"] = after;
			const afterDead = deadSessions(db);
			console.error(
				`Dead-session accounting: ${beforeDead.totals.sessions} sessions, ${beforeDead.totals.events} events, ${beforeDead.totals.sessionsWithOwnMarker} with own markers before; ${afterDead.totals.ownMarkers} markers and ${afterDead.totals.nonMarkerEvents} non-marker events left`,
			);
			const deadAccountingPassed =
				beforeDead.totals.sessions === afterDead.totals.sessions &&
				beforeDead.totals.ownMarkers === afterDead.totals.ownMarkers &&
				beforeDead.totals.events - afterDead.totals.events ===
					before.totals.events - after.totals.events;
			report["deadSessions"] = {
				before: beforeDead,
				after: afterDead,
				reconciliation: {
					passed: deadAccountingPassed,
					eventsFreed: beforeDead.totals.events - afterDead.totals.events,
					markersKept: afterDead.totals.ownMarkers,
					nonMarkerEventsLeft: afterDead.totals.nonMarkerEvents,
				},
			};
			assert(
				deadAccountingPassed,
				"Dead-session event and marker accounting did not reconcile",
			);
			db.prepare("ATTACH DATABASE ? AS baseline").run(
				`${pathToFileURL(baselineFilename).href}?immutable=1`,
			);
			db.exec(`CREATE TEMP TABLE removed_events AS
				SELECT sequence, event_id, project_id, session_id, type, ${eventBytes} AS bytes
				FROM baseline.events b WHERE NOT EXISTS (
					SELECT 1 FROM main.events a WHERE a.sequence = b.sequence AND a.event_id = b.event_id);
				CREATE INDEX temp.idx_removed_sequence ON removed_events(sequence)`);
			const removedSessions = db
				.prepare(`SELECT project_id AS projectId, session_id AS sessionId,
					COUNT(*) AS eventsFreed, SUM(bytes) AS bytesFreed,
					(SELECT COUNT(*) FROM main.events a
						WHERE a.project_id = r.project_id AND a.session_id = r.session_id
						AND (a.type <> 'session.deleted' OR
							json_extract(a.data, '$.sessionId') IS NOT a.session_id)) AS remainingNonMarkerEvents
					FROM removed_events r GROUP BY project_id, session_id ORDER BY project_id, session_id`)
				.all() as {
				projectId: string;
				sessionId: string;
				eventsFreed: number;
				bytesFreed: number;
				remainingNonMarkerEvents: number;
			}[];
			reclaimedSessionIds = removedSessions
				.filter((row) => row.remainingNonMarkerEvents === 0)
				.map((row) => row.sessionId);
			const held = first.projects.flatMap(({ projectId, held }) =>
				held.map((session) => ({ projectId, ...session })),
			);
			const verdicts = {
				removalsHaveOwnMarkerAndNoSessionRow: verdict(
					db,
					`SELECT r.* FROM removed_events r WHERE
						NOT EXISTS (SELECT 1 FROM baseline.events marker
							WHERE marker.project_id = r.project_id AND marker.session_id = r.session_id
							AND marker.type = 'session.deleted'
							AND json_extract(marker.data, '$.sessionId') = marker.session_id)
						OR EXISTS (SELECT 1 FROM baseline.sessions s WHERE s.id = r.session_id)
						OR EXISTS (SELECT 1 FROM main.sessions s WHERE s.id = r.session_id)`,
				),
				deletionMarkersPreserved: verdict(
					db,
					"SELECT * FROM removed_events WHERE type = 'session.deleted'",
				),
				liveSessionEventsPreserved: verdict(
					db,
					`SELECT r.* FROM removed_events r JOIN baseline.sessions s ON s.id = r.session_id`,
				),
				heldPrefixesPreserved: verdict(
					db,
					`SELECT r.* FROM removed_events r JOIN json_each(?) h
						ON r.project_id = json_extract(h.value, '$.projectId')
						AND r.session_id = json_extract(h.value, '$.sessionId')
						WHERE r.sequence <= json_extract(h.value, '$.bound')`,
					[JSON.stringify(held)],
				),
				livePartPointersPreserved: verdict(
					db,
					`SELECT r.*, p.id AS partId, s.id AS liveSessionId
						FROM baseline.message_parts p JOIN baseline.messages m ON m.id = p.message_id
						JOIN baseline.sessions s ON s.id = m.session_id
						JOIN removed_events r ON r.sequence = p.result_event_seq`,
				),
				noEventsAddedOrReplaced: verdict(
					db,
					`SELECT a.sequence, a.event_id, a.project_id, a.session_id FROM main.events a
						WHERE NOT EXISTS (SELECT 1 FROM baseline.events b
							WHERE b.sequence = a.sequence AND b.event_id = a.event_id)`,
				),
			};
			const reportMismatches = first.projects.flatMap((project) => {
				const removed = removedSessions.filter(
					(row) => row.projectId === project.projectId,
				);
				const measured = {
					sessionsFreed: removed.filter(
						(row) => row.remainingNonMarkerEvents === 0,
					).length,
					eventsFreed: removed.reduce((sum, row) => sum + row.eventsFreed, 0),
					bytesFreed: removed.reduce((sum, row) => sum + row.bytesFreed, 0),
				};
				return Object.entries(measured).flatMap(([field, actual]) => {
					const expected = project[field as keyof typeof measured];
					return actual === expected
						? []
						: [{ projectId: project.projectId, field, expected, actual }];
				});
			});
			const passed =
				Object.values(verdicts).every((result) => result.passed) &&
				reportMismatches.length === 0;
			report["diff"] = {
				passed,
				eventsRemoved: before.totals.events - after.totals.events,
				logicalBytesRemoved:
					before.totals.logicalBytes - after.totals.logicalBytes,
				removedSessions,
				verdicts,
				reportMismatches,
			};
			assert(
				passed,
				"Retention event diff failed; see diff evidence in the artifact",
			);
		} finally {
			db.close();
		}
		phase = "second drain";
		const second = await drain(projectIds);
		report["secondDrain"] = second;
		const secondDb = new DatabaseSync(filename, { readOnly: true });
		try {
			const afterSecond = eventSet(secondDb, filename);
			const eventSetUnchanged =
				isDeepStrictEqual(after.sessions, afterSecond.sessions) &&
				after.totals.events === afterSecond.totals.events &&
				after.totals.logicalBytes === afterSecond.totals.logicalBytes;
			const freedNothing = second.projects.every(
				(project) =>
					project.sessionsFreed === 0 &&
					project.eventsFreed === 0 &&
					project.bytesFreed === 0,
			);
			report["idempotence"] = {
				passed: freedNothing && eventSetUnchanged,
				freedNothing,
				eventSetUnchanged,
			};
			assert(
				freedNothing && eventSetUnchanged,
				"Second drain was not idempotent",
			);
		} finally {
			secondDb.close();
		}
		const sessionIds = [
			...new Set(before.sessions.map((row) => row.sessionId)),
		];
		phase = "undrained rebuild";
		const beforeReplay = await rebuild(
			"before",
			baselineFilename,
			beforeRebuiltFilename,
			sessionIds,
		);
		phase = "informational preexisting drift";
		const driftStarted = performance.now();
		let liveBefore: DatabaseSync | undefined;
		let rebuiltBefore: DatabaseSync | undefined;
		try {
			liveBefore = new DatabaseSync(baselineFilename, { readOnly: true });
			rebuiltBefore = new DatabaseSync(beforeRebuiltFilename, {
				readOnly: true,
			});
			const drift = paritySummary(
				compareProjectionStores(liveBefore, rebuiltBefore, { ignoredColumns }),
				5,
			);
			report["preexistingDrift"] = {
				informational: true,
				affectsPass: false,
				reusesUndrainedRebuild: true,
				additionalReplayRuns: 0,
				undrainedRebuildDurationMs: beforeReplay.durationMs,
				comparisonDurationMs: Math.round(performance.now() - driftStarted),
				...drift,
			};
			console.error(
				`Informational undrained live-versus-replay drift: ${drift.diffCount} diffs`,
			);
		} catch (error) {
			report["preexistingDrift"] = {
				informational: true,
				affectsPass: false,
				error: String(error),
				comparisonDurationMs: Math.round(performance.now() - driftStarted),
			};
		} finally {
			rebuiltBefore?.close();
			liveBefore?.close();
		}
		phase = "drained rebuild";
		await rebuild("after", filename, afterRebuiltFilename, sessionIds);
		phase = "rebuilt projection parity";
		const parityStarted = performance.now();
		const beforeRebuilt = new DatabaseSync(beforeRebuiltFilename, {
			readOnly: true,
		});
		const afterRebuilt = new DatabaseSync(afterRebuiltFilename, {
			readOnly: true,
		});
		try {
			const parity = compareProjectionStores(beforeRebuilt, afterRebuilt, {
				ignoredColumns,
			});
			const afterDanglingPartPointers = afterRebuilt
				.prepare(`
				SELECT p.id AS partId, p.result_event_seq AS resultEventSeq
				FROM message_parts p JOIN messages m ON m.id = p.message_id
				JOIN sessions s ON s.id = m.session_id
				WHERE p.result_event_seq IS NOT NULL
				AND NOT EXISTS (SELECT 1 FROM events e WHERE e.sequence = p.result_event_seq)
				ORDER BY p.id`)
				.all();
			const reclaimed = new Set(reclaimedSessionIds);
			const reclaimedDiffs = parity.diffs.filter((diff) => {
				const sessionId = diffSessionId(diff, beforeRebuilt, afterRebuilt);
				return sessionId !== null && reclaimed.has(sessionId);
			});
			const reclaimedRows = {
				before: reclaimedProjectionRows(beforeRebuilt, reclaimedSessionIds),
				after: reclaimedProjectionRows(afterRebuilt, reclaimedSessionIds),
			};
			const sidebarTombstones = Object.fromEntries(
				(
					[
						["before", beforeRebuilt],
						["after", afterRebuilt],
					] as const
				).map(([label, db]) => [
					label,
					Number(
						db
							.prepare(`SELECT COUNT(*) AS count FROM session_sidebar
						WHERE row IS NULL AND session_id IN (SELECT value FROM json_each(?))`)
							.get(JSON.stringify(reclaimedSessionIds))?.["count"],
					),
				]),
			);
			const reclaimedPassed =
				reclaimedDiffs.length === 0 &&
				Object.values(reclaimedRows).every((tables) =>
					Object.values(tables).every((count) => count === 0),
				);
			const passed =
				parity.diffs.length === 0 &&
				afterDanglingPartPointers.length === 0 &&
				reclaimedPassed;
			report["parity"] = {
				passed,
				comparison:
					"rebuilt undrained event log versus rebuilt drained event log",
				durationMs: Math.round(performance.now() - parityStarted),
				...paritySummary(parity, 20),
				danglingPartPointers: afterDanglingPartPointers,
				reclaimedSessions: {
					passed: reclaimedPassed,
					sessionIds: reclaimedSessionIds,
					diffCount: reclaimedDiffs.length,
					diffSamples: reclaimedDiffs
						.slice(0, 5)
						.map(({ table, key, fields }) => ({ table, key, fields })),
					projectionRowCounts: reclaimedRows,
					sidebarTombstones,
					sidebarRowPolicy:
						"Only materialized row IS NOT NULL entries count as session projections; deletion tombstones are recorded separately, matching compareProjectionStores live-session scope.",
				},
			};
			assert(
				passed,
				`Rebuilt projection parity failed: ${parity.diffs.length} diffs, ${afterDanglingPartPointers.length} dangling after pointers; reclaimed rows absent=${reclaimedPassed}`,
			);
		} finally {
			afterRebuilt.close();
			beforeRebuilt.close();
		}
		report["passed"] = true;
	} catch (error) {
		report["error"] = { phase, message: String(error) };
		console.error(`${phase}: ${String(error)}`);
	} finally {
		rmSync(directory, { recursive: true, force: true });
		report["temporaryStoresRemoved"] = !existsSync(directory);
		const afterSourceStat = statSync(sourceFilename);
		report["sourceUnchanged"] = [
			"dev",
			"ino",
			"size",
			"mtimeMs",
			"ctimeMs",
			"mode",
		].every(
			(field) =>
				Reflect.get(sourceStat, field) === Reflect.get(afterSourceStat, field),
		);
		if (!report["sourceUnchanged"]) report["passed"] = false;
		report["totalDurationMs"] = Math.round(performance.now() - startedAt);
		report["finishedAt"] = new Date().toISOString();
	}
	mkdirSync(dirname(outputFilename), { recursive: true });
	writeFileSync(outputFilename, `${JSON.stringify(report, null, "\t")}\n`);
	console.error(`Wrote ${outputFilename}; passed=${report["passed"]}`);
	if (!report["passed"]) process.exitCode = 1;
}
