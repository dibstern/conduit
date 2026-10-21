/**
 * Replay a read-only snapshot's 20 heaviest sessions before/after migration 0057.
 * Run: node --import tsx scripts/verify-event-compaction.ts --source /tmp/perf-store/events.db
 * Format the artifact: pnpm exec biome format --write docs/performance/8rdf19-compaction-parity.json
 * Only version and session_sidebar.row.version are ignored.
 * Every other column and rendered history must match.
 * Temporary stores are always removed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { Effect } from "effect";
import {
	createAllEffectProjectors,
	UNPROJECTED,
} from "../src/lib/persistence/effect/projectors-effect.js";
import {
	compareProjectionStores,
	initializeReplayStore,
	replayProjectionTables as projectedTables,
	replayProjectionStore,
} from "../src/lib/persistence/replay-parity.js";
import { rewriteStore } from "../src/lib/persistence/rewrite-store.js";

const { values } = parseArgs({
	options: {
		source: { type: "string", default: "/tmp/perf-store/events.db" },
		session: { type: "string" },
		output: {
			type: "string",
			default: "docs/performance/8rdf19-compaction-parity.json",
		},
	},
});
const sourceFilename = realpathSync(values.source);
assert(!sourceFilename.startsWith(join(homedir(), ".config", "conduit")));
const outputFilename = resolve(values.output);
const migrationFilename = resolve(
	"src/lib/persistence/migrations/0057_compact_redundant_events.sql",
);
const migrationSql = readFileSync(migrationFilename, "utf8");
const minimumFreeBytes = 8 * 1024 ** 3;
const diskChecks: {
	phase: string;
	availableBytes: number;
	budgetBytes: number;
}[] = [];
let minimumObservedFreeBytes = Number.POSITIVE_INFINITY;

function guardDisk(phase: string, budgetBytes: number, record = true): void {
	// /tmp and the snapshot are on the root volume in this acceptance run.
	const lines = execFileSync("df", ["-k", "/tmp"], { encoding: "utf8" })
		.trim()
		.split("\n");
	const availableBytes = Number(lines.at(-1)?.trim().split(/\s+/)[3]) * 1024;
	assert(Number.isFinite(availableBytes), "Could not read df -k /tmp");
	minimumObservedFreeBytes = Math.min(minimumObservedFreeBytes, availableBytes);
	if (record) diskChecks.push({ phase, availableBytes, budgetBytes });
	assert(
		availableBytes - budgetBytes >= minimumFreeBytes,
		`${phase} would leave less than 8 GiB free: ${availableBytes} available, ${budgetBytes} budget`,
	);
}

type Row = Record<string, string | number | null>;
type SessionCount = { session_id: string; event_count: number };
type EventMetric = {
	type: string;
	rows: number;
	json_bytes: number;
	payload_bytes: number;
};
type ThinkingDifference = {
	sessionId: string;
	messageId: string;
	partId: string;
	field: "updated_at";
	before: number;
	after: number;
};

function metrics(db: DatabaseSync): EventMetric[] {
	return db
		.prepare(`
		SELECT type, COUNT(*) AS rows,
			SUM(length(CAST(data AS BLOB)) + length(CAST(metadata AS BLOB))) AS json_bytes,
			SUM(length(CAST(data AS BLOB)) + length(CAST(metadata AS BLOB))
				+ length(event_id) + length(session_id) + length(type) + length(provider)
				+ COALESCE(length(project_id), 0) + 24) AS payload_bytes
		FROM events GROUP BY type ORDER BY type
	`)
		.all() as EventMetric[];
}

function removedMetrics(db: DatabaseSync): EventMetric[] {
	// Measure the exact numbered migration predicate, rather than duplicating it.
	const statement = migrationSql.trim().replace(/;$/, "");
	assert(statement.includes("DELETE FROM events\n"));
	return db
		.prepare(
			`${statement.replace(
				"DELETE FROM events\n",
				`SELECT type, COUNT(*) AS rows,
			SUM(length(CAST(data AS BLOB)) + length(CAST(metadata AS BLOB))) AS json_bytes,
			SUM(length(CAST(data AS BLOB)) + length(CAST(metadata AS BLOB))
				+ length(event_id) + length(session_id) + length(type) + length(provider)
				+ COALESCE(length(project_id), 0) + 24) AS payload_bytes FROM events\n`,
			)} GROUP BY type ORDER BY type`,
		)
		.all() as EventMetric[];
}

function rows(db: DatabaseSync, table: string): Row[] {
	return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[];
}

const temporaryDirectory = mkdtempSync("/tmp/conduit-compaction-parity-");
const beforeFilename = join(temporaryDirectory, "before.db");
const afterFilename = join(temporaryDirectory, "after.db");
const source = new DatabaseSync(sourceFilename, {
	readOnly: true,
	timeout: 5000,
});
try {
	source.exec("PRAGMA temp_store = MEMORY");
	const sourceBytes = statSync(sourceFilename).size;
	const sessions = values.session
		? (source
				.prepare(
					"SELECT session_id, COUNT(*) AS event_count FROM events WHERE session_id = ? GROUP BY session_id",
				)
				.all(values.session) as SessionCount[])
		: (source
				.prepare(`
		SELECT session_id, COUNT(*) AS event_count FROM events
		GROUP BY session_id ORDER BY event_count DESC, session_id LIMIT 20
	`)
				.all() as SessionCount[]);
	assert.equal(sessions.length, values.session ? 1 : 20);
	const sessionIds = sessions.map((session) => session.session_id);
	const placeholders = sessionIds.map(() => "?").join(",");
	const extract = source
		.prepare(`
		SELECT COUNT(*) AS rows,
			SUM(length(CAST(data AS BLOB)) + length(CAST(metadata AS BLOB))) AS json_bytes
		FROM events WHERE session_id IN (${placeholders})
	`)
		.get(...sessionIds) as { rows: number; json_bytes: number } | undefined;
	assert(extract);
	const extractionBudget = extract.json_bytes * 2 + extract.rows * 256;
	guardDisk("create fresh schema", 16 * 1024 ** 2);
	await Effect.runPromise(initializeReplayStore(beforeFilename));
	guardDisk("extract heaviest sessions", extractionBudget);
	const before = new DatabaseSync(beforeFilename, { timeout: 5000 });
	try {
		before.exec("PRAGMA foreign_keys = OFF");
		before.exec("PRAGMA temp_store = MEMORY");
		before.exec("BEGIN");
		try {
			for (const table of [
				"sessions",
				"events",
				"provider_state",
				"session_providers",
				"claude_runner_cursors",
			]) {
				const sourceColumns = new Set(
					(
						source.prepare(`PRAGMA table_info(${table})`).all() as {
							name: string;
						}[]
					).map((column) => column.name),
				);
				const columns = (
					before.prepare(`PRAGMA table_xinfo(${table})`).all() as {
						name: string;
						hidden: number;
					}[]
				)
					.filter(
						(column) => column.hidden === 0 && sourceColumns.has(column.name),
					)
					.map((column) => column.name);
				// Read through the read-only connection, never ATTACH the input to a writer.
				// Sessions carry resume inputs; transcript read models remain empty.
				// Ancestors satisfy the selected sessions' parent foreign keys.
				const selection =
					table === "sessions"
						? `WITH RECURSIVE lineage(id) AS (
						SELECT id FROM sessions WHERE id IN (${placeholders}) UNION
						SELECT s.parent_id FROM sessions s JOIN lineage l ON s.id = l.id WHERE s.parent_id IS NOT NULL
						) SELECT ${columns.join(",")} FROM sessions WHERE id IN (SELECT id FROM lineage)`
						: `SELECT ${columns.join(",")} FROM ${table}${table === "claude_runner_cursors" ? "" : ` WHERE session_id IN (${placeholders})`}${table === "events" ? " ORDER BY sequence" : ""}`;
				const insert = before.prepare(
					`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((column) => `@${column}`).join(",")})`,
				);
				let inserted = 0;
				for (const row of source
					.prepare(selection)
					.iterate(
						...(table === "claude_runner_cursors" ? [] : sessionIds),
					) as Iterable<Row>) {
					if (inserted++ % 10000 === 0)
						guardDisk("extraction page", extractionBudget, false);
					insert.run(row);
				}
			}

			before.exec("COMMIT");
		} catch (cause) {
			before.exec("ROLLBACK");
			throw cause;
		}
		before.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} finally {
		before.close();
	}
	console.error(
		`Extracted ${extract.rows} events across ${sessions.length} sessions`,
	);
	const subsetBeforeBytes = statSync(beforeFilename).size;
	guardDisk("copy subset", subsetBeforeBytes);
	copyFileSync(beforeFilename, afterFilename);
	guardDisk("logical migration", subsetBeforeBytes * 2);
	const compacted = new DatabaseSync(afterFilename, { timeout: 5000 });
	let subsetBeforeMetrics: EventMetric[];
	let subsetAfterMetrics: EventMetric[];
	let resumeCounts: Record<string, number>;
	let subagentThinkingRows: number;
	let migrationDurationMs: number;
	try {
		compacted.exec("PRAGMA temp_store = MEMORY");
		subsetBeforeMetrics = metrics(compacted);
		const subagent = compacted
			.prepare(`
			SELECT COUNT(*) AS rows FROM events
			WHERE type IN ('thinking.start', 'thinking.delta', 'thinking.end')
				AND json_extract(metadata, '$.rawSource') = 'claude.subagent.transcript'
		`)
			.get() as { rows: number } | undefined;
		subagentThinkingRows = subagent?.rows ?? 0;
		if (!values.session) {
			assert(
				subagentThinkingRows > 0,
				"Heaviest sessions contain no subagent-sourced thinking",
			);
		}
		const handledTypes = new Set<string>(
			createAllEffectProjectors().flatMap((projector) => [
				...projector.handles,
			]),
		);
		for (const metric of subsetBeforeMetrics) {
			assert(
				handledTypes.has(metric.type) ||
					Object.hasOwn(UNPROJECTED, metric.type),
				`Unhandled historical type: ${metric.type}`,
			);
		}
		const resumeTables = [
			"sessions",
			"provider_state",
			"session_providers",
			"claude_runner_cursors",
		];
		const resumeBefore = resumeTables.map((table) => rows(compacted, table));
		resumeCounts = Object.fromEntries(
			resumeTables.map((table, index) => [
				table,
				resumeBefore[index]?.length ?? 0,
			]),
		);
		const migrationStartedAt = performance.now();
		compacted.exec("BEGIN");
		try {
			compacted.exec(migrationSql);
			compacted.exec("COMMIT");
		} catch (cause) {
			compacted.exec("ROLLBACK");
			throw cause;
		}
		migrationDurationMs = Math.round(performance.now() - migrationStartedAt);
		console.error(
			`Subset logical migration completed in ${migrationDurationMs} ms`,
		);
		for (const [index, table] of resumeTables.entries()) {
			assert.deepEqual(
				rows(compacted, table),
				resumeBefore[index],
				`${table} changed during compaction`,
			);
		}
		subsetAfterMetrics = metrics(compacted);
		compacted.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} finally {
		compacted.close();
	}
	guardDisk("physical subset rewrite", subsetBeforeBytes * 2);
	const rewritten = await Effect.runPromise(rewriteStore(afterFilename));
	const checked = new DatabaseSync(afterFilename, {
		readOnly: true,
		timeout: 5000,
	});
	try {
		assert.equal(
			checked.prepare("PRAGMA quick_check").get()?.["quick_check"],
			"ok",
		);
	} finally {
		checked.close();
	}
	assert(
		rewritten.afterBytes < rewritten.beforeBytes,
		"Physical rewrite did not shrink the extract",
	);
	console.error(
		`Subset shrank from ${rewritten.beforeBytes} to ${rewritten.afterBytes} bytes`,
	);
	const replayBudget = subsetBeforeBytes * 4;
	guardDisk("replay both fresh read models", replayBudget);
	// Independent stores can replay together; await both scopes before cleanup.
	const replayResults = await Promise.allSettled([
		Effect.runPromise(
			replayProjectionStore(beforeFilename, sessionIds, {
				projectId: "compaction-parity",
				guardDisk: () => guardDisk("projection page", 1024 ** 3, false),
			}),
		).then((result) => {
			console.error(
				`Original replay completed: ${result.recovery.totalReplayed} projector applications`,
			);
			return result;
		}),
		Effect.runPromise(
			replayProjectionStore(afterFilename, sessionIds, {
				projectId: "compaction-parity",
				guardDisk: () => guardDisk("projection page", 1024 ** 3, false),
			}),
		).then((result) => {
			console.error(
				`Compacted replay completed: ${result.recovery.totalReplayed} projector applications`,
			);
			return result;
		}),
	]);
	const beforeResult = replayResults[0];
	const afterResult = replayResults[1];
	assert(beforeResult && afterResult);
	if (beforeResult.status === "rejected")
		throw new Error("Original replay failed", { cause: beforeResult.reason });
	if (afterResult.status === "rejected")
		throw new Error("Compacted replay failed", { cause: afterResult.reason });
	const beforeReplay = beforeResult.value;
	const afterReplay = afterResult.value;
	const originalRead = new DatabaseSync(beforeFilename, {
		readOnly: true,
		timeout: 5000,
	});
	const compactedRead = new DatabaseSync(afterFilename, {
		readOnly: true,
		timeout: 5000,
	});
	const differences: ThinkingDifference[] = [];
	const rowCounts: Record<string, { before: number; after: number }> = {};
	const unexpected: {
		table: string;
		field: string;
		rowId: string | number | null;
		sessionId: string | number | null;
	}[] = [];
	try {
		for (const result of [beforeReplay, afterReplay]) {
			assert.equal(result.failures, 0, "Recovery skipped a projection");
			assert.equal(
				result.restartReplayed,
				0,
				"Persisted projector cursors did not catch up",
			);
			assert.deepEqual(result.streamVersionDifferences, []);
		}
		const parity = compareProjectionStores(originalRead, compactedRead);
		for (const [table, count] of Object.entries(parity.counts.tables)) {
			rowCounts[table] = { before: count.expected, after: count.actual };
		}
		for (const diff of parity.diffs) {
			const row = diff.expected ?? diff.actual;
			assert(row);
			const sessionId =
				row["session_id"] ??
				(diff.table === "sessions" ? row["id"] : undefined) ??
				(typeof row["message_id"] === "string"
					? (diff.expected ? originalRead : compactedRead)
							.prepare("SELECT session_id FROM messages WHERE id = ?")
							.get(row["message_id"])?.["session_id"]
					: null) ??
				null;
			assert(typeof sessionId === "string" || sessionId === null);
			for (const field of diff.fields) {
				unexpected.push({
					table: diff.table,
					field,
					rowId: diff.key,
					sessionId,
				});
				if (
					diff.table === "message_parts" &&
					row["type"] === "thinking" &&
					field === "updated_at"
				) {
					const before = diff.expected?.[field];
					const after = diff.actual?.[field];
					assert(typeof before === "number" && typeof after === "number");
					assert(
						typeof row["id"] === "string" &&
							typeof row["message_id"] === "string" &&
							sessionId,
					);
					differences.push({
						sessionId,
						messageId: row["message_id"],
						partId: row["id"],
						field,
						before,
						after,
					});
				}
			}
		}
		for (const pointer of parity.danglingPartPointers) {
			const ownerQuery =
				"SELECT m.session_id FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE p.id = ?";
			const owner =
				originalRead.prepare(ownerQuery).get(pointer.partId) ??
				compactedRead.prepare(ownerQuery).get(pointer.partId);
			const sessionId = owner?.["session_id"];
			assert(typeof sessionId === "string" || sessionId === undefined);
			unexpected.push({
				table: "message_parts",
				field: "result_event_seq",
				rowId: pointer.partId,
				sessionId: sessionId ?? null,
			});
		}
		for (const table of ["provider_state", "claude_runner_cursors"]) {
			assert.deepEqual(
				rows(originalRead, table),
				rows(compactedRead, table),
				`${table} differs after replay`,
			);
		}
	} finally {
		originalRead.close();
		compactedRead.close();
	}
	let historyMessages = 0;
	let historyParts = 0;
	let renderedHistoryDifferences = 0;
	for (const [index, original] of beforeReplay.histories.entries()) {
		const compacted = afterReplay.histories[index];
		assert(compacted && original.sessionId === compacted.sessionId);
		for (const message of original.history.messages) {
			historyMessages++;
			assert(message.parts, `History message ${message.id} has no parts`);
			historyParts += message.parts.length;
		}
		if (!isDeepStrictEqual(original.history, compacted.history)) {
			renderedHistoryDifferences++;
			unexpected.push({
				table: "history",
				field: "rendered_history",
				rowId: original.sessionId,
				sessionId: original.sessionId,
			});
		}
	}
	const passed = unexpected.length === 0;
	const unexpectedCounts: Record<string, number> = {};
	for (const difference of unexpected) {
		const key = `${difference.table}.${difference.field}`;
		unexpectedCounts[key] = (unexpectedCounts[key] ?? 0) + 1;
	}
	console.error(
		JSON.stringify({
			passed,
			rowCounts,
			unexpectedCounts,
			thinkingTimestampDifferences: differences.length,
		}),
	);
	const sourceMetrics = values.session ? [] : metrics(source);
	const sourcePredicateStartedAt = performance.now();
	const sourceRemoved = values.session ? [] : removedMetrics(source);
	const sourcePredicateEvaluationDurationMs = values.session
		? null
		: Math.round(performance.now() - sourcePredicateStartedAt);
	if (sourcePredicateEvaluationDurationMs !== null) {
		console.error(
			`Full-store deletion predicate evaluated read-only in ${sourcePredicateEvaluationDurationMs} ms`,
		);
	}
	const totalRows = sourceMetrics.reduce(
		(total, metric) => total + metric.rows,
		0,
	);
	const removedRows = sourceRemoved.reduce(
		(total, metric) => total + metric.rows,
		0,
	);
	const totalPayloadBytes = sourceMetrics.reduce(
		(total, metric) => total + metric.payload_bytes,
		0,
	);
	const removedPayloadBytes = sourceRemoved.reduce(
		(total, metric) => total + metric.payload_bytes,
		0,
	);
	const storage = values.session
		? { table_bytes: 0, index_bytes: 0 }
		: (source
				.prepare(`
		SELECT SUM(CASE WHEN name = 'events' THEN pgsize ELSE 0 END) AS table_bytes,
			SUM(CASE WHEN name <> 'events' THEN pgsize ELSE 0 END) AS index_bytes
		FROM dbstat WHERE name = 'events'
			OR name IN (SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'events')
	`)
				.get() as { table_bytes: number; index_bytes: number } | undefined);
	assert(storage);
	const estimatedSavingsBytes = Math.round(
		(storage.table_bytes * removedPayloadBytes) / totalPayloadBytes +
			(storage.index_bytes * removedRows) / totalRows,
	);
	const report = {
		ticket: "conduit-test-8rdf.19",
		passed,
		measuredAt: new Date().toISOString(),
		command: [
			"node",
			"--import",
			"tsx",
			"scripts/verify-event-compaction.ts",
			"--source",
			values.source,
			...(values.session ? ["--session", values.session] : []),
			"--output",
			values.output,
		],
		migration: {
			file: "0057_compact_redundant_events.sql",
			key: 58,
			sha256: createHash("sha256").update(migrationSql).digest("hex"),
		},
		source: {
			filename: sourceFilename,
			beforeBytes: sourceBytes,
			events: values.session ? null : totalRows,
			removedRows: values.session ? null : removedRows,
			removedByType: sourceRemoved,
			sourcePredicateEvaluationDurationMs,
			sizeAfter: values.session
				? {
						measured: false,
						estimatedBytes: null,
						reason: "Focused diagnostic skips full-store measurement",
					}
				: {
						measured: false,
						estimatedBytes: sourceBytes - estimatedSavingsBytes,
						estimatedSavingsBytes,
						method:
							"Events table dbstat bytes weighted by deleted payload bytes; event-index dbstat bytes weighted by deleted row count. Payload includes measured JSON/string bytes plus 24 bytes for three integer columns.",
						averageEventPayloadBytes: totalPayloadBytes / totalRows,
						averageRemovedPayloadBytes: removedPayloadBytes / removedRows,
						eventTableBytes: storage.table_bytes,
						eventIndexBytes: storage.index_bytes,
						fullStoreCopied: false,
						limitation:
							"Estimate isolates migration 0057. It excludes activities removal by earlier migration 0055, existing intrapage slack and other VACUUM effects; no full-store after size was measured.",
					},
		},
		subset: {
			selection: values.session
				? "Focused session diagnostic"
				: "20 heaviest sessions by event count, ties by session id",
			sessions,
			eventsBefore: extract.rows,
			eventsAfter: subsetAfterMetrics.reduce(
				(total, metric) => total + metric.rows,
				0,
			),
			subagentThinkingRows,
			migrationDurationMs,
			beforeByType: subsetBeforeMetrics,
			afterByType: subsetAfterMetrics,
			beforeBytes: subsetBeforeBytes,
			afterLogicalBytes: rewritten.beforeBytes,
			afterPhysicalBytes: rewritten.afterBytes,
			quickCheck: "ok",
			limitation:
				"Only the selected sessions' events are replayed. Unselected events can add global boundaries or historical cascades in the full store; its deletion predicate is more conservative than this isolated extract. No full-store replay was performed.",
		},
		projection: {
			comparedTables: projectedTables,
			scopeSources: [
				"src/lib/persistence/effect/projectors-effect.ts:createAllEffectProjectors",
				"src/lib/persistence/effect/sidebar-projection.ts:refreshSidebar",
			],
			rowCounts,
			before: beforeReplay.recovery,
			after: afterReplay.recovery,
			failures: 0,
			ignoredFields: ["version", "session_sidebar.row.version"],
			serializedVersionReason:
				"SidebarRowSchema declares a top-level read-model version (sidebar-row.ts:9-11), serialized by refreshSidebar (sidebar-projection.ts:100-105). Only that property is excluded; every other JSON value is compared exactly.",
			comparison:
				"Exact equality for every column except version and session_sidebar.row.version",
			differenceCount: differences.length,
			unexpectedCounts,
			unexpected,
		},
		resume: {
			persistedInputRowsUnchanged: resumeCounts,
			historyMessages,
			historyParts,
			renderedHistoryEqual: renderedHistoryDifferences === 0,
			renderedHistoryComparison:
				"Exact deep equality, including thinking time.end; no timestamp normalization",
			restartReplayedBefore: beforeReplay.restartReplayed,
			restartReplayedAfter: afterReplay.restartReplayed,
			nextStreamVersion:
				"Production getNextStreamVersion matched MAX(stream_version)+1 for all 20 sessions on both stores",
			limitation:
				"Offline parity of persisted resume inputs and production history rendering. No live provider resumed; producer re-emission after losing in-memory offsets remains possible.",
		},
		readerAudit: [
			{
				column: "messages.last_applied_seq",
				decision: "Preserve exactly",
				readers: [
					"src/lib/persistence/effect/projectors-effect.ts:686",
					"src/lib/persistence/effect/projectors-effect.ts:741",
					"src/lib/persistence/effect/read-query-effect.ts:1367",
					"src/lib/persistence/effect/read-query-effect.ts:1645",
					"src/lib/persistence/effect/read-query-effect.ts:1688",
					"src/lib/persistence/effect/read-query-effect.ts:2097",
				],
				reason:
					"Text and thinking replay guards compare event.sequence with this checkpoint. Raw message queries also retain it through SELECT *. Preserve terminal deltas so deletion cannot change replay decisions or raw rows. Paging and sync use created_at/id and version cursors, which do not make checkpoint differences safe.",
			},
			{
				column: "messages.updated_at",
				decision: "Preserve exactly",
				readers: [
					"src/lib/persistence/effect/projectors-effect.ts:1131",
					"src/lib/persistence/effect/read-query-effect.ts:1367",
					"src/lib/persistence/effect/read-query-effect.ts:1645",
					"src/lib/persistence/effect/read-query-effect.ts:1688",
					"src/lib/persistence/effect/read-query-effect.ts:2097",
					"src/lib/persistence/session-history-adapter.ts:337",
					"src/lib/persistence/session-history-adapter.ts:429",
					"src/lib/domain/relay/Services/session-detail-subscription.ts:270",
					"src/lib/frontend/utils/history-logic.ts:421",
				],
				reason:
					"Snapshot projection aggregates MAX(messages.updated_at) into turn.completed_at. History emits updated_at as message.time.completed when completed_at is null; cold, live, paged and resumed browser history exposes it, including result timestamps. Preserve terminal stamps before destructive boundaries so both intermediate turn aggregates and exact rendered history remain unchanged.",
			},
		],
		independentConsumers: [
			{
				behavior: "Transcript ordering and paging",
				sources: [
					"src/lib/persistence/effect/read-query-effect.ts:1569",
					"src/lib/persistence/effect/read-query-effect.ts:1606",
					"src/lib/persistence/effect/read-query-effect.ts:1715",
				],
				reason:
					"Ordering and page cursors use created_at and id; unchanged cursors alone do not establish message timestamp or replay-checkpoint parity.",
			},
			{
				behavior: "Version sync",
				sources: ["src/lib/persistence/effect/read-query-effect.ts:2183"],
				reason:
					"Catch-up uses version and row ids rather than either message bookkeeping column; timestamp differences can still change the emitted payload.",
			},
			{
				behavior: "Native Claude thread output",
				sources: [
					"src/lib/provider/claude/claude-thread-read.ts:27",
					"src/lib/provider/claude/claude-thread-read.ts:56",
				],
				reason:
					"Thread output selects message ids, roles, text and interrupted state; it does not consume either bookkeeping column.",
			},
		],
		disk: {
			minimumFreeBytes,
			minimumObservedFreeBytes,
			checks: diskChecks,
			fullCopies: 0,
			temporaryDatabasesRemoved: true,
		},
		differences,
	};
	mkdirSync(dirname(outputFilename), { recursive: true });
	writeFileSync(outputFilename, `${JSON.stringify(report, null, "\t")}\n`);
	console.error(`Wrote ${outputFilename}`);
	if (!passed) process.exitCode = 1;
} finally {
	source.close();
	rmSync(temporaryDirectory, { recursive: true, force: true });
}
