import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Effect } from "effect";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makeEffectSqlMigrator } from "../../../../src/lib/persistence/effect/migrations.js";
import {
	makeProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
} from "../../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	makeProjectorCursorEffect,
	ProjectorCursorEffectTag,
} from "../../../../src/lib/persistence/effect/projector-cursor-effect.js";
import { createAllEffectProjectors } from "../../../../src/lib/persistence/effect/projectors-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";

const filename = process.argv[2];
if (!filename) throw new Error("Missing database filename");

await Effect.runPromise(
	Effect.gen(function* () {
		yield* makeEffectSqlMigrator();
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT INTO sessions (id, provider, title, created_at, updated_at) VALUES ('crash-session', 'opencode', 'Before', 1, 1)`;
		const store = yield* makeEventStoreEffect;
		const cursors = yield* makeProjectorCursorEffect;
		const runner = yield* makeProjectionRunnerEffect([
			{
				name: "kill-before-projection",
				handles: ["session.renamed"],
				project: () =>
					Effect.sync(() => {
						process.kill(process.pid, "SIGKILL");
					}),
			},
			...createAllEffectProjectors(),
		]).pipe(Effect.provideService(ProjectorCursorEffectTag, cursors));
		yield* runner.markRecovered();
		const commit = yield* makeCommitAndSignal.pipe(
			Effect.provideService(EventStoreEffectTag, store),
			Effect.provideService(ProjectionRunnerEffectTag, runner),
		);
		yield* commit([
			canonicalEvent("session.renamed", "crash-session", {
				sessionId: "crash-session",
				title: "After",
			}),
		]);
	}).pipe(Effect.provide(SqliteNode.layer({ filename }))),
);
