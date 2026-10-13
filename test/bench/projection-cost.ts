// Failure modes:
// - Query spans omit BEGIN, SAVEPOINT, or COMMIT, understating transaction cost.
// - Initialization or validation queries contaminate the single-delta count.
// - A cheap transaction fails to append the durable event or projected text.
// - A benchmark touches a live store or leaves its temporary database behind.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { PersistenceProjectTag } from "../../src/lib/domain/persistence/Services/persistence-service.js";
import { makeCommitAndSignal } from "../../src/lib/persistence/effect/commit-and-signal.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "../../src/lib/persistence/effect/event-store-effect.js";
import { makeEffectSqlMigrator } from "../../src/lib/persistence/effect/migrations.js";
import {
	makeProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
} from "../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	makeProjectorCursorEffect,
	ProjectorCursorEffectTag,
} from "../../src/lib/persistence/effect/projector-cursor-effect.js";
import { createAllEffectProjectors } from "../../src/lib/persistence/effect/projectors-effect.js";
import { canonicalEvent } from "../../src/lib/persistence/events.js";
import { makeTracedSqlite } from "../helpers/traced-sqlite.js";

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") {
		console.log(
			"Usage: pnpm exec tsx test/bench/projection-cost.ts [--output <results.json>]\nCounts driver SQL for one text.delta through makeCommitAndSignal using a temporary SQLite store.",
		);
		return;
	}
	if (
		args.length !== 0 &&
		(args.length !== 2 || args[0] !== "--output" || !args[1])
	) {
		throw new Error("Expected --output <results.json>; use --help");
	}
	const output = args[1] ? resolve(args[1]) : undefined;
	const directory = mkdtempSync(join(tmpdir(), "conduit-projection-cost-"));
	const statements: string[] = [];
	const projectors = createAllEffectProjectors();
	let recording = false;
	try {
		const measurement = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const sql = yield* makeTracedSqlite(
						join(directory, "events.db"),
						(statement) => {
							if (recording) statements.push(statement);
						},
					);
					return yield* Effect.gen(function* () {
						yield* makeEffectSqlMigrator();
						const store = yield* makeEventStoreEffect;
						const cursor = yield* makeProjectorCursorEffect;
						const runner = yield* makeProjectionRunnerEffect(projectors).pipe(
							Effect.provideService(ProjectorCursorEffectTag, cursor),
						);
						yield* runner.recover();
						const commit = yield* makeCommitAndSignal.pipe(
							Effect.provideService(EventStoreEffectTag, store),
							Effect.provideService(ProjectionRunnerEffectTag, runner),
						);
						const sessionId = "projection-cost-session";
						const messageId = "projection-cost-message";
						const partId = "projection-cost-part";
						const initialText = "Before ";
						const delta = "after";
						yield* commit([
							canonicalEvent(
								"session.created",
								sessionId,
								{ sessionId, title: "Projection cost", provider: "claude" },
								{ provider: "claude" },
							),
							canonicalEvent(
								"message.created",
								sessionId,
								{ sessionId, messageId, role: "assistant" },
								{ provider: "claude" },
							),
							canonicalEvent(
								"text.delta",
								sessionId,
								{ messageId, partId, text: initialText },
								{ provider: "claude" },
							),
						]);
						const event = canonicalEvent(
							"text.delta",
							sessionId,
							{ messageId, partId, text: delta },
							{ provider: "claude" },
						);
						const started = performance.now();
						recording = true;
						yield* commit([event]);
						recording = false;
						const elapsedMs = performance.now() - started;
						const message = yield* sql<{ text: string }>`
							SELECT text FROM messages WHERE id = ${messageId}`;
						const part = yield* sql<{ text: string }>`
							SELECT text FROM message_parts
							WHERE message_id = ${messageId} AND id = ${partId}`;
						const eventRows = yield* sql<{ count: number }>`
							SELECT COUNT(*) AS count FROM events WHERE event_id = ${event.eventId}`;
						const expectedText = initialText + delta;
						assert.deepEqual(message, [{ text: expectedText }]);
						assert.deepEqual(part, [{ text: expectedText }]);
						assert.deepEqual(eventRows, [{ count: 1 }]);
						return { elapsedMs, expectedText };
					}).pipe(
						Effect.provideService(SqlClient.SqlClient, sql),
						Effect.provideService(PersistenceProjectTag, {
							projectId: "projection-cost-project",
						}),
					);
				}).pipe(Effect.provide(Reactivity.layer)),
			),
		);
		const count = (pattern: RegExp) =>
			statements.filter((statement) => pattern.test(statement)).length;
		const transactionStatements = count(
			/^\s*(?:BEGIN|COMMIT|SAVEPOINT|ROLLBACK|RELEASE)\b/i,
		);
		assert.equal(count(/^\s*BEGIN\b/i), 1);
		assert.equal(count(/^\s*COMMIT\b/i), 1);
		assert.equal(count(/^\s*ROLLBACK\b/i), 0);
		const result = {
			benchmark: "single-text-delta-projection",
			ticket: "conduit-test-8rdf.12",
			capturedAt: new Date().toISOString(),
			machine: { platform: platform(), arch: arch(), node: process.version },
			method: {
				path: "makeCommitAndSignal([text.delta])",
				instrumentation: "real SQLite driver Connection execution methods",
				countingScope:
					"One commit including append, projection, transaction control and cursor writes. Excludes migrations, recovery, seed, validation reads, provider ingestion guards and runner receipts.",
				projectors: projectors.map((projector) => projector.name),
				textDeltas: 1,
			},
			statementCount: statements.length,
			queryStatementCount: statements.length - transactionStatements,
			transactionStatementCount: transactionStatements,
			cursorWriteCount: count(/(?:INSERT|UPDATE|DELETE).*projector_cursors/is),
			elapsedMs: measurement.elapsedMs,
			verification: {
				durableEvents: 1,
				messageText: measurement.expectedText,
				partText: measurement.expectedText,
			},
			statements,
		};
		const json = `${JSON.stringify(result, null, 2)}\n`;
		if (output) writeFileSync(output, json);
		console.log(json);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
