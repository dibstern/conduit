// Run only against a disposable snapshot: opening the writer analyzes indexes.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient, Statement } from "effect/sql";
import { PersistenceProjectTag } from "../../src/lib/domain/persistence/Services/persistence-service.js";
import { makeEventStoreEffect } from "../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../src/lib/persistence/effect/live.js";
import { makeReadQueryEffect } from "../../src/lib/persistence/effect/read-query-effect.js";

const [
	filenameArg,
	outputArg,
	sessionId = "ses_d87c87bc61474bb080110b076ede65b9",
] = process.argv.slice(2);
if (!filenameArg || !outputArg)
	throw new Error(
		"Usage: tsx test/bench/storage-tuning.ts <snapshot.db> <output.json> [sessionId]",
	);
const filename = resolve(filenameArg);
if (filename.includes("/.config/conduit/"))
	throw new Error("Use a disposable snapshot, never the live store");

const queries: { name: string; sql: string; params: readonly unknown[] }[] = [];
let operation = "";
await Effect.runPromise(
	Effect.gen(function* () {
		const read = yield* makeReadQueryEffect;
		const store = yield* makeEventStoreEffect;
		operation = "heavy-session-scan";
		yield* store.readAllBySession(sessionId);
		operation = "session-page";
		yield* read.readSessionTranscriptPage(sessionId, { limit: 50 });
		operation = "sidebar";
		yield* read.readSessionList({ projectIds: [store.projectId] });
		operation = "stream-version";
		yield* store.getNextStreamVersion(sessionId);
	}).pipe(
		Effect.provideService(Statement.CurrentTransformer, (statement) => {
			const [sql, params] = statement.compile();
			if (/^\s*(SELECT|WITH)\b/i.test(sql)) {
				const name =
					operation === "session-page"
						? /SELECT messages\.\*/.test(sql)
							? "session-page-messages"
							: /FROM message_parts/.test(sql)
								? "parts-for-page"
								: `session-page-${queries.filter((query) => query.name.startsWith("session-page")).length}`
						: operation;
				queries.push({ name, sql, params });
			}
			return Effect.succeed(statement);
		}),
		Effect.provideService(PersistenceProjectTag, { projectId: "benchmark" }),
		Effect.provide(
			SqliteClient.layer({ filename, readonly: true, disableWAL: true }),
		),
	),
);

function measure(db: DatabaseSync) {
	return queries.map((query) => {
		// These captured production read queries bind only SQLite scalar values.
		const params = query.params as readonly SQLInputValue[];
		const plan = (
			db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...params) as {
				detail: string;
			}[]
		).map(({ detail }) => detail);
		const statement = db.prepare(query.sql);
		const warm = statement.all(...params);
		const samples: number[] = [];
		for (let index = 0; index < 7; index++) {
			const start = performance.now();
			statement.all(...params);
			samples.push(performance.now() - start);
		}
		return {
			...query,
			rows: warm.length,
			plan,
			samplesMs: samples,
			medianMs: [...samples].sort((a, b) => a - b)[3],
		};
	});
}

const beforeDb = new DatabaseSync(filename, {
	readOnly: true,
	timeout: 5000,
});
const before = measure(beforeDb);
const sqliteVersion = beforeDb
	.prepare("SELECT sqlite_version() AS version")
	.get();
const beforeStats = beforeDb
	.prepare(
		"SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'sqlite_stat1'",
	)
	.get();
const projectId = (
	beforeDb
		.prepare("SELECT project_id FROM events WHERE session_id = ? LIMIT 1")
		.get(sessionId) as { project_id: string } | undefined
)?.project_id;
beforeDb.close();
if (!projectId) throw new Error("Session has no project identity");

const started = performance.now();
const runtime = ManagedRuntime.make(
	makePersistenceEffectLayer(filename, projectId),
);
const profile = await runtime.runPromise(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		return {
			mmap: yield* sql`PRAGMA mmap_size`,
			analysisLimit: yield* sql`PRAGMA analysis_limit`,
			stats:
				yield* sql`SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx`,
		};
	}),
);
const openMs = performance.now() - started;
const afterDb = new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
afterDb.exec("PRAGMA mmap_size = 1073741824");
const after = measure(afterDb);
afterDb.close();
await runtime.dispose();
const changedPlans = after.flatMap((query, index) =>
	JSON.stringify(query.plan) === JSON.stringify(before[index]?.plan)
		? []
		: [{ name: query.name, before: before[index]?.plan, after: query.plan }],
);
const report = {
	ticket: "conduit-test-8rdf.18",
	filename,
	sessionId,
	sqliteVersion,
	measuredAt: new Date().toISOString(),
	repetitions: 7,
	method:
		"Warm raw execution of SQL captured from the production Effect store/read-query APIs; same snapshot before and after production writer startup",
	beforeStats,
	profile,
	openMs,
	before,
	after,
	changedPlans,
};
writeFileSync(resolve(outputArg), `${JSON.stringify(report, null, 2)}\n`);
console.log(
	JSON.stringify(
		{
			output: resolve(outputArg),
			openMs,
			stats: profile.stats.length,
			changedPlans,
			timings: before.map((query, index) => ({
				name: query.name,
				rows: query.rows,
				beforeMs: query.medianMs,
				afterMs: after[index]?.medianMs,
			})),
		},
		null,
		2,
	),
);
