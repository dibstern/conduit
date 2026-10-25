import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, expect, it } from "vitest";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { requeueFailedSteers } from "../../../src/lib/persistence/effect/input-requeue-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { ProviderSideEffectReactor } from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { settleUnclaimedRunnerCommands } from "../../../src/lib/provider/runner/runner-recovery.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

const scenarios: Record<string, unknown>[] = [];
afterAll(() => {
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/82tn10-4-fix10-steers.json",
		JSON.stringify(scenarios, null, 2),
	);
	writeFileSync(
		"test-results/82tn10-4-fix12-steer-order.json",
		JSON.stringify(
			scenarios.filter((scenario) => scenario["steerCount"]),
			null,
			2,
		),
	);
});

it.each([
	2, 3,
])("keeps %i recovered steers in admission order across orphan settlements", async (steerCount) => {
	const root = mkdtempSync(join(tmpdir(), "steer-order-"));
	const persistence = makePersistenceEffectLayer(
		join(root, "events.db"),
		"project",
	);
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			persistence,
			ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
		),
	);
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* commit([
					canonicalEvent("session.created", "session", {
						sessionId: "session",
						provider: "claude",
						title: "Ordered recovery",
					}),
				]);
				// A steer must still go ahead of an older input left in the inbox.
				yield* commit([
					canonicalEvent(
						"input.admitted",
						"session",
						{
							sessionId: "session",
							inputId: "queued",
							delivery: "queue",
							request: { text: "Queued" },
						},
						{ createdAt: 10 },
					),
				]);
				const ids = Array.from(
					{ length: steerCount },
					(_, index) => `steer-${index}`,
				);
				for (const [index, inputId] of ids.entries()) {
					const runId = `run:${inputId}`;
					yield* commit([
						canonicalEvent(
							"input.admitted",
							"session",
							{
								sessionId: "session",
								inputId,
								delivery: "steer",
								request: { text: inputId },
							},
							{ createdAt: 20 + index },
						),
						canonicalEvent("input.sent", "session", {
							sessionId: "session",
							inputId,
							steer: true,
						}),
						canonicalEvent(
							"run.requested",
							"session",
							{ runId, inputId },
							{ provider: "claude", metadata: { runId } },
						),
					]);
					yield* sql`INSERT INTO command_receipts(command_id,project_key,session_id,status,created_at) VALUES(${inputId},'project','session','side_effect_failed',1)`;
					yield* sql`INSERT INTO provider_command_outbox(request_sequence,command_id,project_key,session_id,provider_id,effect_type,payload_json,run_id,status,error_code,attempt_count,requested_at,updated_at)
					VALUES(${index + 1},${inputId},'project','session','claude','send_turn',${JSON.stringify({ sessionId: "session", inputId, prompt: inputId })},${runId},'cancelled','project_inactive',1,1,1)`;
				}
				const recover = () =>
					settleUnclaimedRunnerCommands(
						sql,
						new Set(),
						"claude",
						() => "claude",
						(_sink, turn, failure, beforeProject) =>
							ingestion
								.ingestBatch(
									[
										providerRuntimeEvent(
											"turn.error",
											"session",
											{
												messageId: "",
												error: failure.message,
												code: "runner_stopped",
												retryable: false,
											},
											{
												eventId: `orphan:${turn.runId}`,
												...(turn.runId ? { runId: turn.runId } : {}),
												providerId: "claude",
											},
										),
									],
									{ beforeProject },
								)
								.pipe(Effect.asVoid),
					);
				const passes: string[][] = [];
				for (let pass = 0; pass < 2; pass++) {
					yield* recover();
					yield* requeueFailedSteers(sql, persist);
					const queued = yield* sql<{
						input_id: string;
					}>`SELECT input_id FROM pending_inputs WHERE state = 'queued' ORDER BY admitted_at, rowid`;
					passes.push(queued.map(({ input_id }) => input_id));
				}
				scenarios.push({ steerCount, passes });
				expect(passes).toEqual([
					[...ids, "queued"],
					[...ids, "queued"],
				]);
				for (const row of yield* sql<{
					admitted_at: number;
				}>`SELECT admitted_at FROM pending_inputs`)
					expect(() => new Date(row.admitted_at).toISOString()).not.toThrow();
				expect(
					yield* sql`SELECT type FROM events WHERE type = 'input.requeued'`,
				).toHaveLength(steerCount);
			}),
		);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

// Real refusal, ingestion and recovery transactions: a surviving runner keeps
// intake ownership; confirmed loss releases only an unplaced inactive steer.
// Repeated sweeps, an accepted message and a user cancellation must not resend.
it.each(
	(["claude", "cursor"] as const).flatMap((driver) =>
		(["unplaced", "accepted", "user-cancelled"] as const).flatMap((placement) =>
			(placement === "accepted" ? [true, false] : [true]).map((alive) => ({
				driver,
				placement,
				alive,
			})),
		),
	),
)("recovers a cancelled native steer after runner loss: $driver $placement alive=$alive", async ({
	driver,
	placement,
	alive,
}) => {
	const root = mkdtempSync(join(tmpdir(), "cancelled-steer-"));
	const persistence = makePersistenceEffectLayer(
		join(root, "events.db"),
		"project",
	);
	let runtime = ManagedRuntime.make(
		Layer.mergeAll(
			persistence,
			ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
		),
	);
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const persist = yield* ClaudeEventPersistEffectTag;
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "session", {
						sessionId: "session",
						provider: driver,
						title: "Cancelled steer",
					}),
					canonicalEvent("input.admitted", "session", {
						sessionId: "session",
						inputId: "input",
						delivery: "steer",
						request: { text: "Native steer" },
					}),
					canonicalEvent("input.sent", "session", {
						sessionId: "session",
						inputId: "input",
						steer: true,
					}),
					canonicalEvent(
						"run.requested",
						"session",
						{ runId: "run", inputId: "input" },
						{ provider: driver, metadata: { runId: "run" } },
					),
				]);
				if (placement === "accepted") {
					yield* persist.persistUserMessage("session", "Native steer", {
						messageId: "input",
						inputId: "input",
						runId: "run",
						provider: driver,
					});
					yield* ingestion.ingest(
						providerRuntimeEvent(
							"run.started",
							"session",
							{ requestedRunId: "run", inputId: "input" },
							{ runId: "run", providerId: driver },
						),
					);
				}
				yield* sql`INSERT INTO command_receipts(command_id,project_key,session_id,status,created_at) VALUES('input','project','session','side_effect_requested',1)`;
				yield* sql`INSERT INTO provider_command_outbox(request_sequence,command_id,project_key,session_id,provider_id,effect_type,payload_json,run_id,status,attempt_count,requested_at,updated_at)
						VALUES(1,'input','project','session',${driver},'send_turn',${JSON.stringify({ sessionId: "session", inputId: "input", prompt: "Native steer", workspaceRoot: "/tmp/project", extraFolders: [], providerState: {} })},'run','running',1,1,1)`;
				yield* sql.unsafe("CREATE TABLE receipt_settlements (command_id TEXT)");
				yield* sql.unsafe(`CREATE TRIGGER count_settlements AFTER UPDATE ON command_receipts
					WHEN NEW.status = 'side_effect_failed'
					BEGIN INSERT INTO receipt_settlements VALUES (NEW.command_id); END`);
				const registry = new ProviderRegistry([
					{
						providerId: driver,
						generateTextEffect: () => Effect.die("unused"),
						discoverEffect: () => Effect.die("unused"),
						sendTurnEffect: () => Effect.die("must not resend"),
						interruptTurnEffect: () => Effect.void,
						resolvePermissionEffect: () => Effect.void,
						resolveQuestionEffect: () => Effect.void,
						endSessionEffect: () => Effect.void,
						shutdownEffect: () => Effect.void,
						hasLiveProcessEffect: () => Effect.succeed(alive),
						getControlProcessIdEffect: () => Effect.succeed("verified-runner"),
					},
				]);
				const reactor = new ProviderSideEffectReactor({
					sql,
					registry,
					ingestion,
					write: commit.write,
					persistUserMessage: persist.persistUserMessage,
					isProjectReady: () =>
						Effect.fail(
							new ProviderInstanceFailure({
								providerId: "conduit",
								operation: "executeCommand",
								code: "project_inactive",
								cause: "removed",
							}),
						),
				});
				yield* reactor.drain();
				if (placement === "user-cancelled") {
					// An explicit Stop cancels for interruption, not project refusal.
					yield* sql`UPDATE provider_command_outbox SET error_code = 'interrupted' WHERE command_id = 'input'`;
				}
				const recover = (claimed: ReadonlySet<string>) =>
					settleUnclaimedRunnerCommands(
						sql,
						claimed,
						driver,
						() => driver,
						(_sink, turn, failure, beforeProject) =>
							ingestion
								.ingestBatch(
									[
										providerRuntimeEvent(
											"turn.error",
											"session",
											{
												messageId: "",
												error: failure.message,
												code: "runner_stopped",
												retryable: false,
											},
											{
												providerId: driver,
												...(turn.runId ? { runId: turn.runId } : {}),
											},
										),
									],
									{ beforeProject },
								)
								.pipe(
									Effect.tap(() =>
										Effect.gen(function* () {
											// A crash here must not leave a terminal run with an
											// undiscoverable steer. No post-terminal repair has run.
											expect(
												yield* sql`SELECT state FROM pending_inputs`,
											).toEqual([
												{
													state:
														placement === "unplaced" ? "queued" : "removed",
												},
											]);
										}),
									),
									// Simulate loss immediately after COMMIT, before
									// settleRunnerCommand's separate cleanup can run.
									Effect.andThen(
										placement === "unplaced" ? Effect.interrupt : Effect.void,
									),
									Effect.asVoid,
								),
					);
				const snapshot = () =>
					Effect.gen(function* () {
						return {
							commands:
								yield* sql`SELECT status,error_code FROM provider_command_outbox`,
							receipts:
								yield* sql`SELECT status,error_code FROM command_receipts`,
							settlements:
								yield* sql`SELECT command_id FROM receipt_settlements`,
							runs: yield* sql`SELECT status FROM provider_runs`,
							inputs: yield* sql`SELECT input_id,state FROM pending_inputs`,
							messages: yield* sql`SELECT id FROM messages WHERE role = 'user'`,
							requeues:
								yield* sql`SELECT data FROM events WHERE type = 'input.requeued'`,
							terminals:
								yield* sql`SELECT type FROM events WHERE type IN ('turn.error', 'turn.interrupted')`,
						};
					});
				for (let pass = 0; pass < 3; pass++) {
					yield* recover(new Set(["session"]));
					yield* requeueFailedSteers(sql, persist);
				}
				const beforeLoss = yield* snapshot();
				expect(beforeLoss.inputs).toEqual([
					{
						input_id: "input",
						state: placement === "accepted" ? "removed" : "steering",
					},
				]);
				expect(beforeLoss.requeues).toHaveLength(0);
				if (placement === "unplaced") {
					yield* sql.unsafe(`CREATE TRIGGER fail_requeue BEFORE INSERT ON events
						WHEN NEW.type = 'input.requeued'
						BEGIN SELECT RAISE(ABORT, 'requeue persistence failed'); END`);
					const failed = yield* Effect.result(recover(new Set()));
					expect(failed._tag).toBe("Failure");
					expect(yield* snapshot()).toEqual(beforeLoss);
					yield* sql.unsafe("DROP TRIGGER fail_requeue");
				}
				if (placement === "user-cancelled")
					// A later provider crash must not undo the user's cancellation.
					yield* ingestion.ingest(
						providerRuntimeEvent(
							"turn.error",
							"session",
							{
								messageId: "",
								error: "Runner stopped",
								code: "runner_stopped",
								retryable: false,
							},
							{ runId: "run", providerId: driver },
						),
					);
				for (let pass = 0; pass < 3; pass++) {
					yield* recover(new Set());
					yield* requeueFailedSteers(sql, persist);
				}
				const afterLoss = yield* snapshot();
				scenarios.push({ driver, placement, alive, beforeLoss, afterLoss });
				expect(afterLoss.settlements).toEqual([{ command_id: "input" }]);
				expect(afterLoss.commands).toEqual([
					{
						status: "cancelled",
						error_code:
							placement === "user-cancelled"
								? "interrupted"
								: "project_inactive",
					},
				]);
				expect(afterLoss.runs).toEqual([{ status: "error" }]);
				expect(afterLoss.inputs).toEqual([
					{
						input_id: "input",
						state:
							placement === "unplaced"
								? "queued"
								: placement === "accepted"
									? "removed"
									: "steering",
					},
				]);
				expect(afterLoss.messages).toHaveLength(
					placement === "accepted" ? 1 : 0,
				);
				expect(afterLoss.requeues).toHaveLength(
					placement === "unplaced" ? 1 : 0,
				);
				expect(afterLoss.terminals).toHaveLength(1);
			}),
		);
		for (let restart = 0; restart < 2; restart++) {
			await runtime.dispose();
			runtime = ManagedRuntime.make(
				Layer.mergeAll(
					persistence,
					ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
				),
			);
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const persist = yield* ClaudeEventPersistEffectTag;
					yield* requeueFailedSteers(sql, persist);
					expect(yield* sql`SELECT state FROM pending_inputs`).toEqual([
						{
							state:
								placement === "unplaced"
									? "queued"
									: placement === "accepted"
										? "removed"
										: "steering",
						},
					]);
					expect(
						yield* sql`SELECT type FROM events WHERE type = 'input.requeued'`,
					).toHaveLength(placement === "unplaced" ? 1 : 0);
					expect(
						yield* sql`SELECT type FROM events WHERE type = 'turn.error'`,
					).toHaveLength(1);
					expect(
						yield* sql`SELECT command_id FROM receipt_settlements`,
					).toEqual([{ command_id: "input" }]);
				}),
			);
		}
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
