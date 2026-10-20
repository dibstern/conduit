import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it } from "vitest";
import { Usage } from "../../../src/lib/domain/daemon/Services/usage.js";
import { ContinuationTag } from "../../../src/lib/domain/relay/Services/continuation.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ProviderTurnServiceTag } from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import { SessionEventBusTag } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	SessionInboxLive,
	SessionInboxTag,
} from "../../../src/lib/domain/relay/Services/session-inbox.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	effectMigrationEntries,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import { createEventId } from "../../../src/lib/persistence/events.js";
import { runnerSinkId } from "../../../src/lib/provider/runner/runner-protocol.js";
import {
	recoverRunnerCommands,
	settleUnclaimedRunnerCommands,
} from "../../../src/lib/provider/runner/runner-recovery.js";
import { failRunnerTurn } from "../../../src/lib/provider/runner/runner-turn-failure.js";
import type {
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionTurn,
} from "../../../src/lib/provider/runner/session-runner.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

// Failure modes: upgrade declares an executing runner idle, guessing a legacy
// turn owner places old events, recovery loses the reserved run id, or a
// migrated turn ignores its own recovery terminal;
// a successful joined replay leaves its migrated reservation running forever.
it.each([
	"stopped",
	"completed",
	"joined",
	"superseded",
] as const)("keeps a migrated executing run busy until its exact %s runner recovery terminal", async (result) => {
	const succeeded = result === "completed" || result === "joined";
	const root = mkdtempSync(join(tmpdir(), "legacy-run-upgrade-"));
	const database = join(root, "events.db");
	const proof = {
		case: `legacy-running-upgrade-${result}`,
		outcome: "failed",
		queuedWhileRunning: false,
		recoveredTerminalLegacyTurn: false,
		ownedRecoveryTerminal: false,
		handoffsAfterRecovery: 0,
	};
	let dispose: (() => Promise<void>) | undefined;
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				yield* makeEffectSqlMigrator(
					Object.fromEntries(
						Object.entries(effectMigrationEntries).slice(0, 74),
					),
				);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at)
					VALUES ('legacy', 'test-project', 'claude', 1, 1)`;
				yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at, project_id)
					VALUES ('legacy-created', 'legacy', 1, 'session.created',
					'{"sessionId":"legacy","title":"Legacy","provider":"claude"}', 'claude', 1, 'test-project')`;
				yield* sql`INSERT INTO messages (id, session_id, role, text, input_id, created_at, updated_at)
					VALUES ('legacy-input', 'legacy', 'user', 'old request', 'legacy-input', 1, 1)`;
				yield* sql`INSERT INTO turns (id, session_id, user_message_id, state, requested_at)
					VALUES ('legacy-input', 'legacy', 'legacy-input', 'running', 1)`;
				yield* sql`INSERT INTO command_receipts
					(command_id, session_id, status, command_type, project_key, created_at, updated_at)
					VALUES ('legacy-input', 'legacy', 'side_effect_requested', 'send_turn', 'test-project', 10, 10)`;
				yield* sql`INSERT INTO provider_command_outbox
					(request_sequence, command_id, project_key, session_id, provider_id, effect_type,
					payload_json, status, attempt_count, requested_at, updated_at)
					VALUES (1, 'legacy-input', 'test-project', 'legacy', 'claude', 'send_turn',
					'{"inputId":"legacy-input"}', 'running', 1, 10, 10)`;
			}).pipe(Effect.provide(SqliteClient.layer({ filename: database }))),
		);
		const handoffs: string[] = [];
		const persistence = makePersistenceEffectLayer(database, "test-project");
		const dependencies = Layer.mergeAll(
			persistence,
			makeTestHandlerLayer({ persistenceLayer: persistence }),
			Layer.succeed(SessionEventBusTag)({
				publish: () => Effect.void,
				publishAdvance: () => Effect.void,
				subscribe: () => Effect.succeed(Stream.empty),
				subscribeAdvances: () => Effect.succeed(Stream.empty),
			}),
			Layer.succeed(Usage)({
				readings: Stream.empty,
				latest: () => Effect.succeed(undefined),
				refresh: () => Effect.succeed([]),
				turnEnded: () => Effect.void,
				pickFailover: () => Effect.succeed(undefined),
			}),
			Layer.succeed(ContinuationTag)({
				requestContinuation: () => Effect.void,
				intakeLimit: () => Effect.succeed(false),
				dismissCutOff: () => Effect.void,
				cancelContinuation: () => Effect.void,
				sweepDueContinuations: () => Effect.void,
				queueLimitPolicy: () => Effect.void,
				runLimitPolicies: Effect.never,
			}),
			Layer.succeed(ProviderTurnServiceTag)({
				holdUserTurnsForAccountSwitch: () => Effect.void,
				prepareTurnSession: () => Effect.succeed("claude"),
				beginStop: () => Effect.succeed(Effect.void),
				turnFences: () => ({ stopping: false, switching: false }),
				fenceLifts: Effect.succeed(Stream.empty),
				sendTurn: (input) =>
					Effect.sync(() => {
						handoffs.push(input.commandId);
					}),
			}),
			ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
		);
		const runtime = ManagedRuntime.make(
			SessionInboxLive.pipe(Layer.provideMerge(dependencies)),
		);
		dispose = () => runtime.dispose();
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const inbox = yield* SessionInboxTag;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const [reservation] = yield* sql<{
					id: string;
					status: string;
				}>`SELECT id, status FROM provider_runs`;
				expect(reservation?.status).toBe("running");
				expect(
					yield* sql`SELECT type FROM events WHERE type = 'run.started'`,
				).toEqual([]);
				expect(yield* sql`SELECT state, run_id FROM turns`).toEqual([
					{ state: "running", run_id: reservation?.id },
				]);
				expect(
					yield* inbox.submit({
						clientId: "browser",
						sessionId: "legacy",
						inputId: "next-input",
						delivery: "queue",
						request: { text: "next request" },
					}),
				).toEqual({ handedOff: false });
				expect(handoffs).toEqual([]);
				proof.queuedWhileRunning = true;
				const emit = (
					output: SessionOutput,
				): Effect.Effect<SessionOutputReply, SessionFailure> =>
					output.type === "event"
						? ingestion.ingest(output.event).pipe(
								Effect.as({}),
								Effect.mapError(() => ({
									operation: "persist recovery",
									message: "Recovery ingestion failed",
								})),
							)
						: Effect.succeed({});
				if (result !== "stopped") {
					const recovered = yield* recoverRunnerCommands(
						sql,
						"legacy",
						"claude",
						{
							driverForAccount: (account) =>
								account === "claude" ? "claude" : undefined,
							decodeInput: (row) => JSON.parse(row.payload_json) as SessionTurn,
							resolveSinkId: (commandId, _inputId, attempt) =>
								runnerSinkId(commandId, attempt),
							closing: () => false,
							failTurn: () =>
								Effect.die("Successful legacy replay must not fail"),
							replay: (_row, input) =>
								Effect.gen(function* () {
									expect(input.runId).toBe(reservation?.id);
									// The surviving old runner cannot stamp the newly minted reservation.
									yield* emit({
										type: "event",
										sinkId: "legacy-input:1",
										event: {
											eventId: createEventId(),
											type: "turn.completed",
											providerId: "claude",
											sessionId: "legacy",
											providerRefs: {},
											rawSource: { kind: "claude.sdk.translator" },
											createdAt: 20,
											data: { messageId: "", duration: 10 },
										},
									});
									return {
										status: result === "joined" ? "joined" : "completed",
										cost: 0,
										tokens: { input: 0, output: 0 },
										durationMs: 10,
										providerStateUpdates: [],
									};
								}),
						},
					);
					expect(recovered).toHaveLength(1);
					const [command] = recovered;
					if (!command)
						return yield* Effect.die("Missing recovered legacy command");
					if (result === "superseded") {
						yield* Effect.exit(
							command.wait.pipe(
								Effect.provideService(ProviderRuntimeIngestionTag, {
									...ingestion,
									ingestBatch: (events, options) =>
										sql`UPDATE provider_command_outbox SET attempt_count = 2 WHERE command_id = 'legacy-input'`.pipe(
											Effect.andThen(ingestion.ingestBatch(events, options)),
										),
								}),
							),
						);
						expect(
							yield* sql`SELECT status FROM provider_runs WHERE id = ${reservation?.id}`,
						).toEqual([{ status: "running" }]);
						expect(
							yield* sql`SELECT status, attempt_count FROM provider_command_outbox`,
						).toEqual([{ status: "running", attempt_count: 2 }]);
						expect(
							yield* sql`SELECT type FROM events WHERE type = 'turn.completed' AND json_extract(metadata, '$.runId') IS NOT NULL`,
						).toEqual([]);
						proof.outcome = "passed";
						return;
					}
					yield* command.wait;
					proof.recoveredTerminalLegacyTurn = true;
				} else
					yield* settleUnclaimedRunnerCommands(
						sql,
						new Set(),
						"claude",
						(account) => (account === "claude" ? "claude" : undefined),
						(sinkId, turn, failure) => {
							expect(turn).toMatchObject({
								runId: reservation?.id,
								userMessageId: "legacy-input",
							});
							proof.recoveredTerminalLegacyTurn = true;
							return failRunnerTurn(emit, sinkId, turn, failure);
						},
					);
				expect(
					yield* sql`SELECT status FROM provider_runs WHERE id = ${reservation?.id}`,
				).toEqual([{ status: succeeded ? "completed" : "error" }]);
				expect(
					yield* sql`SELECT type, json_extract(metadata, '$.runId') AS run_id FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted') AND json_extract(metadata, '$.runId') IS NOT NULL`,
				).toEqual([
					{
						type: succeeded ? "turn.completed" : "turn.error",
						run_id: reservation?.id,
					},
				]);
				expect(
					yield* sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([
					{
						status: succeeded ? "completed" : "failed",
						attempt_count: 1,
					},
				]);
				expect(
					yield* sql`SELECT status, error_code FROM command_receipts`,
				).toEqual([
					{
						status: succeeded ? "side_effect_completed" : "side_effect_failed",
						error_code: succeeded ? null : "runner_stopped",
					},
				]);
				expect(yield* sql`SELECT state, run_id FROM turns`).toEqual([
					{ state: succeeded ? "completed" : "error", run_id: reservation?.id },
				]);
				proof.ownedRecoveryTerminal = true;
				expect(
					yield* sql`SELECT type FROM events WHERE type = 'run.started'`,
				).toEqual([]);
				expect(
					yield* inbox.sendNow({
						clientId: "browser",
						sessionId: "legacy",
						inputId: "next-input",
					}),
				).toBe("accepted");
				expect(
					yield* inbox.sendNow({
						clientId: "browser",
						sessionId: "legacy",
						inputId: "next-input",
					}),
				).toBe("already_started");
				expect(handoffs).toEqual(["next-input"]);
				proof.handoffsAfterRecovery = handoffs.length;
				proof.outcome = "passed";
			}),
		);
	} finally {
		await dispose?.();
		rmSync(root, { recursive: true, force: true });
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			`test-results/82tn24-legacy-upgrade${result === "stopped" ? "" : `-${result}`}.json`,
			`${JSON.stringify(proof, null, 2)}\n`,
		);
	}
}, 30_000);
