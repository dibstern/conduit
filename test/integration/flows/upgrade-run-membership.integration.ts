import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, expect, it } from "vitest";
import { makeEffectOpenCodeRuntimeIngress } from "../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { LoggerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { makeFailTurn } from "../../../src/lib/domain/relay/Services/turn-failure.js";
import type { Message } from "../../../src/lib/instance/sdk-types.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	effectMigrationEntries,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	runnerFailure,
	runnerSinkId,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import {
	recoverRunnerCommands,
	runningRunnerCommands,
	settleUnclaimedRunnerCommands,
} from "../../../src/lib/provider/runner/runner-recovery.js";
import { failRunnerTurn } from "../../../src/lib/provider/runner/runner-turn-failure.js";
import { makeBaseSendTurnInput } from "../../helpers/mock-sdk.js";

const roots: string[] = [];
const cases: Array<{ case: string; outcome: "passed" }> = [];
const runId = "legacy-run:test-project:1";

// Open a real pre-0069 file, then let the ordinary persistence layer upgrade it.
// Failures: upgrade invents an interruption/intake, a dead runner cannot close
// its linked turn, idle without an OpenCode result becomes success, or legacy
// successful replay closes the command while its turn remains interrupted.
async function legacyStore(
	provider: "claude" | "cursor" | "opencode",
	accepted: boolean,
) {
	const root = mkdtempSync(join(tmpdir(), "conduit-upgrade-membership-"));
	roots.push(root);
	const filename = join(root, "events.db");
	const userId = provider === "opencode" ? "native-user" : "input";
	await Effect.runPromise(
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator(
				Object.fromEntries(Object.entries(effectMigrationEntries).slice(0, 68)),
			);
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, provider, project_id, status, created_at, updated_at)
				VALUES ('s', ${provider}, 'test-project', 'busy', 1, 1)`;
			yield* sql`INSERT INTO messages (id, session_id, role, input_id, text, created_at, updated_at)
				VALUES (${userId}, 's', 'user', 'input', 'Original prompt', 1, 1)`;
			yield* sql`INSERT INTO turns (id, session_id, user_message_id, state, requested_at, started_at)
				VALUES (${userId}, 's', ${userId}, ${accepted ? "running" : "pending"}, 1, ${accepted ? 12 : null})`;
			yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id,
				provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at)
				VALUES (1, 'input', 'test-project', 's', ${provider}, 'send_turn',
				'{"inputId":"input"}', 'running', 1, 10, 20)`;
			yield* sql`INSERT INTO command_receipts (command_id, session_id, project_key, status, created_at, updated_at)
				VALUES ('input', 's', 'test-project', 'side_effect_requested', 10, 20)`;
			yield* sql`INSERT INTO pending_inputs (input_id, session_id, text, request, state, admitted_at, version)
				VALUES ('queued', 's', 'Next prompt', '{"text":"Next prompt"}', 'queued', 30, 0)`;
		}).pipe(Effect.provide(SqliteClient.layer({ filename }))),
	);
	const persistence = makePersistenceEffectLayer(filename, "test-project");
	return Layer.merge(
		persistence,
		ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
	);
}

const outcome = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return {
		turns: yield* sql`SELECT state, run_id, started_at FROM turns`,
		runs: yield* sql`SELECT status FROM provider_runs`,
		commands: yield* sql`SELECT status FROM provider_command_outbox`,
		receipts: yield* sql`SELECT status FROM command_receipts`,
		queue: yield* sql`SELECT input_id, state FROM pending_inputs`,
		inbox: yield* (yield* ReadQueryEffectTag).readInboxState("s"),
	};
});

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
	const directory = process.env["CONDUIT_TEST_ARTIFACT_DIR"] ?? "test-results";
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "82tn31-1-migration-flow-cases.json"),
		`${JSON.stringify({ cases }, null, 2)}\n`,
	);
});

for (const driver of ["claude", "cursor"] as const) {
	it(`a dead pre-upgrade ${driver} runner closes its migrated turn with owned error and pauses the queue`, async () => {
		const accepted = driver === "cursor";
		const dependencies = await legacyStore(driver, accepted);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* settleUnclaimedRunnerCommands(
					sql,
					new Set(),
					driver,
					(id) => id,
					(sinkId, turn, failure) =>
						failRunnerTurn(
							(output) =>
								output.type === "event"
									? ingestion.ingest(output.event).pipe(
											Effect.as({}),
											Effect.mapError((cause) =>
												runnerFailure("test output", cause),
											),
										)
									: Effect.succeed({}),
							sinkId,
							turn,
							failure,
							driver,
						),
				);
				const final = yield* outcome;
				expect(final).toMatchObject({
					turns: [
						{ state: "error", run_id: runId, started_at: accepted ? 12 : null },
					],
					runs: [{ status: "error" }],
					commands: [{ status: "failed" }],
					receipts: [{ status: "side_effect_failed" }],
					queue: [{ input_id: "queued", state: "queued" }],
					inbox: { paused: true },
				});
				expect(
					yield* sql`SELECT json_extract(metadata, '$.runId') AS run_id FROM events WHERE type = 'turn.error'`,
				).toEqual([{ run_id: runId }]);
				cases.push({ case: `dead-${driver}`, outcome: "passed" });
			}).pipe(Effect.provide(dependencies)),
		);
	});
	for (const status of driver === "claude"
		? (["completed", "joined"] as const)
		: (["completed"] as const)) {
		it(`a live pre-upgrade ${driver} ${status} reply completes its migrated turn through unchanged legacy recovery`, async () => {
			const accepted = driver === "cursor";
			const dependencies = await legacyStore(driver, accepted);
			await Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const ingestion = yield* ProviderRuntimeIngestionTag;
					const recoveries = yield* recoverRunnerCommands(sql, "s", driver, {
						driverForAccount: (id) => id,
						decodeInput: () =>
							makeBaseSendTurnInput({ sessionId: "s", inputId: "input" }),
						resolveSinkId: (
							commandId,
							_inputId,
							attempt,
							nativeResumeFallback,
						) => runnerSinkId(commandId, attempt, nativeResumeFallback),
						closing: () => false,
						failTurn: () =>
							Effect.die(new Error("Unexpected legacy runner failure")),
						replay: () =>
							ingestion
								.ingestBatch([
									{
										eventId: "old-reply",
										type: "message.created",
										providerId: driver,
										sessionId: "s",
										providerRefs: {},
										rawSource: { kind: "old-runner" },
										createdAt: 40,
										data: {
											sessionId: "s",
											messageId: "reply",
											role: "assistant",
											parentID: "input",
										},
									},
									{
										eventId: "old-result",
										type: "turn.completed",
										providerId: driver,
										sessionId: "s",
										providerRefs: {},
										rawSource: { kind: "old-runner" },
										createdAt: 50,
										data: { messageId: "reply" },
									},
								])
								.pipe(
									Effect.as({
										status,
										cost: 0,
										tokens: { input: 0, output: 0 },
										durationMs: 10,
										providerStateUpdates: [],
									}),
									Effect.mapError((cause) =>
										runnerFailure("test replay", cause),
									),
								),
					});
					expect(recoveries).toHaveLength(1);
					yield* recoveries[0]?.wait ??
						Effect.die(new Error("Missing recovery"));
					expect(yield* outcome).toMatchObject({
						turns: [
							{
								state: "completed",
								run_id: runId,
								started_at: accepted ? 12 : null,
							},
						],
						runs: [{ status: "completed" }],
						commands: [{ status: "completed" }],
						receipts: [{ status: "side_effect_completed" }],
						inbox: { paused: false },
					});
					expect(
						yield* sql`SELECT type FROM events WHERE type = 'run.started'`,
					).toEqual([]);
					expect(
						yield* sql`SELECT json_extract(metadata, '$.runId') AS run_id FROM events WHERE type = 'turn.completed' ORDER BY sequence`,
					).toEqual([{ run_id: null }, { run_id: runId }]);
					cases.push({ case: `live-${driver}-${status}`, outcome: "passed" });
				}).pipe(Effect.provide(dependencies)),
			);
		});
	}
}

for (const result of ["missing", "error", "success"] as const) {
	it(`an OpenCode turn in flight at upgrade reports ${result === "success" ? "proven success" : "no false success"} after ${result} native outcome`, async () => {
		const dependencies = await legacyStore("opencode", true);
		const history: Message[] =
			result === "missing"
				? []
				: [
						{
							id: "native-user",
							sessionID: "s",
							role: "user",
							time: { created: 1 },
							parts: [],
						},
						{
							id: "reply",
							sessionID: "s",
							role: "assistant",
							parentID: "native-user",
							time: { created: 30, completed: 40 },
							finish: "stop",
							parts: [],
							...(result === "error"
								? {
										error: {
											name: "MessageAbortedError",
											data: { message: "Aborted" },
										},
									}
								: {}),
						},
					];
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const ingress = yield* makeEffectOpenCodeRuntimeIngress(
					createSilentLogger(),
					() => Effect.succeed(history),
				);
				yield* Effect.addFinalizer(() => Effect.sync(() => ingress.shutdown()));
				yield* ingress.recoverCommands(
					yield* runningRunnerCommands(sql, "opencode", (id) => id),
					() => Effect.succeed({ s: { type: "idle" } }),
					yield* makeFailTurn,
				);
				const success = result === "success";
				expect(yield* outcome).toMatchObject({
					turns: [
						{
							state: success ? "completed" : "error",
							run_id: runId,
							started_at: 12,
						},
					],
					runs: [{ status: success ? "completed" : "error" }],
					commands: [{ status: success ? "completed" : "failed" }],
					receipts: [
						{
							status: success ? "side_effect_completed" : "side_effect_failed",
						},
					],
					queue: [{ input_id: "queued", state: "queued" }],
					inbox: { paused: !success },
				});
				if (!success)
					expect(
						yield* sql`SELECT json_extract(metadata, '$.runId') AS run_id FROM events WHERE type = 'turn.error' AND json_extract(metadata, '$.runId') IS NOT NULL`,
					).toEqual([{ run_id: runId }]);
				cases.push({ case: `opencode-${result}`, outcome: "passed" });
			}).pipe(
				Effect.scoped,
				Effect.provideService(LoggerTag, createSilentLogger()),
				Effect.provide(dependencies),
			),
		);
	});
}
