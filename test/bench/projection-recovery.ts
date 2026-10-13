import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import Database from "better-sqlite3";
import { Effect, Exit, Schema, Tracer } from "effect";
import { PersistenceProjectTag } from "../../src/lib/domain/persistence/Services/persistence-service.js";
import { makeEffectSqlMigrator } from "../../src/lib/persistence/effect/migrations.js";
import { makeProjectionRunnerEffect } from "../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	makeProjectorCursorEffect,
	ProjectorCursorEffectTag,
} from "../../src/lib/persistence/effect/projector-cursor-effect.js";
import type { EffectProjector } from "../../src/lib/persistence/effect/projectors-effect.js";
import { canonicalEvent, EventId } from "../../src/lib/persistence/events.js";

const PROJECT_ID = "projection-recovery-benchmark";
const SESSION_ID = "recovery-session";
const CREATED_AT = 1_750_000_000_000;
const PROJECTOR_NAME = "benchmark-non-idempotent-counter";

const projector: EffectProjector = {
	name: PROJECTOR_NAME,
	handles: ["session.renamed"],
	project: (event) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`UPDATE benchmark_applications
				SET applied_count = applied_count + 1 WHERE sequence = ${event.sequence}`;
			return { stamped: [], removed: [] };
		}),
};

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			events: { type: "string", default: "200000" },
			output: { type: "string" },
			help: { type: "boolean" },
		},
	});
	if (values.help) {
		console.log(
			"Usage: pnpm exec tsx test/bench/projection-recovery.ts [--events 200000] [--output result.json]\nAlways migrates and seeds its own temporary SQLite store.",
		);
		return;
	}
	const eventCount = Number(values.events);
	assert(
		/^\d+$/.test(values.events) &&
			Number.isSafeInteger(eventCount) &&
			eventCount > 0,
		"--events must be a positive safe integer",
	);

	const dir = mkdtempSync(join(tmpdir(), "conduit-projection-recovery-"));
	const filename = join(dir, "events.db");
	const runnerSourceSha256 = createHash("sha256")
		.update(
			readFileSync(
				new URL(
					"../../src/lib/persistence/effect/projection-runner-effect.ts",
					import.meta.url,
				),
			),
		)
		.digest("hex");
	try {
		const migrationStart = performance.now();
		await Effect.runPromise(
			makeEffectSqlMigrator().pipe(
				Effect.provide(SqliteNode.layer({ filename })),
			),
		);
		const migrationMs = performance.now() - migrationStart;
		const seedStart = performance.now();
		const db = new Database(filename);
		try {
			db.exec(`CREATE TABLE benchmark_applications (
				sequence INTEGER PRIMARY KEY,
				applied_count INTEGER NOT NULL DEFAULT 0
			)`);
			const insertEvent = db.prepare(`INSERT INTO events
				(project_id, event_id, session_id, stream_version, type, data, metadata, provider, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
			const insertCounter = db.prepare(
				"INSERT INTO benchmark_applications (sequence) VALUES (?)",
			);
			const decodeEventId = Schema.decodeSync(EventId);
			db.transaction(() => {
				for (let sequence = 1; sequence <= eventCount; sequence++) {
					const event = canonicalEvent(
						"session.renamed",
						SESSION_ID,
						{ sessionId: SESSION_ID, title: "Recovery benchmark" },
						{
							eventId: decodeEventId(`evt_recovery_${sequence}`),
							provider: "claude",
							createdAt: CREATED_AT,
						},
					);
					insertEvent.run(
						PROJECT_ID,
						event.eventId,
						event.sessionId,
						sequence,
						event.type,
						JSON.stringify(event.data),
						JSON.stringify(event.metadata),
						event.provider,
						event.createdAt,
					);
					insertCounter.run(sequence);
				}
			})();
		} finally {
			db.close();
		}
		const seedMs = performance.now() - seedStart;

		let transactionCommits = 0;
		const tracer = Tracer.make({
			span: (name, parent, context, links, startTime, kind) => {
				let committed = false;
				return {
					_tag: "Span",
					name,
					spanId: "benchmark",
					traceId: "benchmark",
					parent,
					context,
					status: { _tag: "Started", startTime },
					attributes: new Map(),
					links,
					sampled: true,
					kind,
					attribute: () => {},
					addLinks: () => {},
					event: (eventName) => {
						if (
							name === "sql.transaction" &&
							eventName === "db.transaction.commit"
						)
							committed = true;
					},
					end: (_endTime, exit) => {
						if (committed && Exit.isSuccess(exit)) transactionCommits++;
					},
				};
			},
			context: (f) => f(),
		});
		const sqliteLayer = SqliteNode.layer({ filename });
		const recover = Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const cursors = yield* makeProjectorCursorEffect;
			const runner = yield* makeProjectionRunnerEffect([projector]).pipe(
				Effect.provideService(ProjectorCursorEffectTag, cursors),
			);
			const [journal] = yield* sql<{
				journal_mode: string;
			}>`PRAGMA journal_mode`;
			const [sync] = yield* sql<{ synchronous: number }>`PRAGMA synchronous`;
			const [sqlite] = yield* sql<{
				version: string;
			}>`SELECT sqlite_version() AS version`;
			const [seed] = yield* sql<{ events: number; maxSequence: number }>`
				SELECT COUNT(*) AS events, MAX(sequence) AS maxSequence FROM events`;
			assert.equal(seed?.events, eventCount);
			assert.equal(seed?.maxSequence, eventCount);
			transactionCommits = 0;
			const start = performance.now();
			const result = yield* runner.recover();
			const elapsedMs = performance.now() - start;
			const commitCount = transactionCommits;
			const [applications] = yield* sql<{
				rows: number;
				totalApplications: number;
				minApplications: number;
				maxApplications: number;
			}>`SELECT COUNT(*) AS rows, SUM(applied_count) AS totalApplications,
				MIN(applied_count) AS minApplications, MAX(applied_count) AS maxApplications
				FROM benchmark_applications`;
			const cursor = yield* cursors.get(PROJECTOR_NAME);
			const failures = yield* runner.getFailures();
			assert.equal(applications?.rows, eventCount);
			assert.equal(applications?.totalApplications, eventCount);
			assert.equal(applications?.minApplications, 1);
			assert.equal(applications?.maxApplications, 1);
			assert.equal(cursor?.lastAppliedSeq, eventCount);
			assert.equal(failures.length, 0);
			return {
				sqlite: {
					version: sqlite?.version,
					journalMode: journal?.journal_mode,
					synchronous: sync?.synchronous,
				},
				recovery: { elapsedMs, transactionCommits: commitCount, result },
				applications,
				cursor: cursor?.lastAppliedSeq,
			};
		}).pipe(
			Effect.provideService(PersistenceProjectTag, { projectId: PROJECT_ID }),
			Effect.provide(sqliteLayer),
			Effect.withTracer(tracer),
		);

		const measured = await Effect.runPromise(recover);
		assert.equal(measured.recovery.result.startCursor, 0);
		assert.equal(measured.recovery.result.totalReplayed, eventCount);
		assert(
			measured.recovery.transactionCommits > 0,
			"No committed transactions were traced",
		);
		// A new connection and runner must rely on the persisted cursor.
		const repeated = await Effect.runPromise(recover);
		assert.equal(repeated.recovery.result.startCursor, eventCount);
		assert.equal(repeated.recovery.result.totalReplayed, 0);
		assert.equal(repeated.recovery.transactionCommits, 0);
		const report = {
			benchmark: "projection-recovery",
			capturedAt: new Date().toISOString(),
			runnerSourceSha256,
			workload: {
				events: eventCount,
				eventType: "session.renamed",
				projectors: 1,
				projection: "Increment applied_count once per sequence",
			},
			environment: {
				runtime: "Node.js",
				version: process.version,
				platform: platform(),
				arch: arch(),
				release: release(),
				cpu: cpus()[0]?.model,
			},
			sqlite: measured.sqlite,
			setup: { migrationMs, seedMs },
			recovery: {
				...measured.recovery,
				eventsPerSecond: (eventCount * 1000) / measured.recovery.elapsedMs,
			},
			verification: {
				...measured.applications,
				cursor: measured.cursor,
				repeatedRecovery: repeated.recovery,
			},
		};
		const json = `${JSON.stringify(report, null, 2)}\n`;
		if (values.output) {
			const output = resolve(values.output);
			mkdirSync(dirname(output), { recursive: true });
			writeFileSync(output, json);
		}
		console.log(json);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

await main();
