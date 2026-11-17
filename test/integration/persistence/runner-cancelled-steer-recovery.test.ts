import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, expect, it } from "vitest";
import { ProviderRuntimeIngestionTag } from "../../../src/lib/domain/project-services/Services/provider-runtime-ingestion-service.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { requeueFailedSteers } from "../../../src/lib/persistence/effect/input-requeue-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { loadLedgerView } from "../../../src/lib/persistence/effect/run-ledger-arm.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { ProviderSideEffectReactor } from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { makeRunnerReceiptStore } from "../../../src/lib/provider/runner/runner-receipts.js";
import { settleUnclaimedRunnerCommands } from "../../../src/lib/provider/runner/runner-recovery.js";
import { ProviderRuntimeIngestionLive } from "../../helpers/daemon-turns.js";
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
	{ steerCount: 2, released: false },
	{ steerCount: 3, released: false },
	{ steerCount: 2, released: true },
])("keeps $steerCount recovered steers as their undelivered Run's input, sent after its start in admission order: released=$released", async ({
	steerCount,
	released,
}) => {
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
				yield* makeRunnerReceiptStore(sql);
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
				// The ledger reads the first request as the Run and the steers as its inputs. The
				// Run, never held, was not yet delivered: its start and every steer it issued go back
				// to the outbox, the steers staying its input, sent again after its start (CONTRACT
				// 664-690, D50; 3.9; L2 case 2).
				for (const [index, inputId] of ["start", ...ids].entries()) {
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
					VALUES(${index + 1},${inputId},'project','session','claude','send_turn',${JSON.stringify({ sessionId: "session", inputId, prompt: inputId, workspaceRoot: "/tmp/project", extraFolders: [], providerState: {}, history: [], configDir: configuredClaudeConfigDir(join(root, "claude")), folderSource: "account" })},${runId},'running',NULL,1,1,1)`;
				}
				// A release of every held send before any delivery unlaunches the Run back to Queued; its
				// relaunch stays claimed, never held, until the restart (CONTRACT 664-670, 675, 689-691).
				if (released) {
					const holds = ["start", ...ids].map((commandId) => ({
						runId: `run:${commandId}`,
						runnerId: "runner",
						commandId,
						transmission: 1,
					}));
					yield* commit([
						canonicalEvent(
							"evidence.process_started",
							"session",
							{ runnerId: "runner", label: "runner:1", reattached: false },
							{ provider: "claude" },
						),
						...holds.map((hold) =>
							canonicalEvent("run.dispatched", "session", hold, {
								provider: "claude",
								metadata: { runId: hold.runId },
							}),
						),
					]);
					yield* commit(
						holds.map((hold) =>
							canonicalEvent(
								"run.released",
								"session",
								{ ...hold, reason: "NotSent" },
								{ provider: "claude", metadata: { runId: hold.runId } },
							),
						),
					);
				}
				expect(
					(yield* loadLedgerView("session").pipe(
						Effect.provideService(SqlClient.SqlClient, sql),
					))?.active?.tag,
				).toBe(released ? "Queued" : "Starting");
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
				expect(passes).toEqual([["queued"], ["queued"]]);
				for (const row of yield* sql<{
					admitted_at: number;
				}>`SELECT admitted_at FROM pending_inputs`)
					expect(() => new Date(row.admitted_at).toISOString()).not.toThrow();
				const recovered = {
					requeues:
						yield* sql`SELECT type FROM events WHERE type = 'input.requeued'`,
					terminals:
						yield* sql`SELECT type FROM events WHERE type IN ('turn.error', 'turn.interrupted')`,
					commands:
						yield* sql`SELECT command.command_id, command.status, run.status AS run_status, pending.state
						FROM provider_command_outbox command
						JOIN provider_runs run ON run.id = command.run_id
						JOIN pending_inputs pending ON pending.input_id = command.command_id
						ORDER BY command.request_sequence`,
				};
				expect(recovered).toEqual({
					requeues: [],
					terminals: [],
					commands: ["start", ...ids].map((command_id) => ({
						command_id,
						status: "retryable_failed",
						run_status: "pending",
						state: "steering",
					})),
				});
				// The relaunch sends the start first, then each steer in admission order.
				const sent: string[] = [];
				const reactor = new ProviderSideEffectReactor({
					sql,
					registry: new ProviderRegistry([
						{
							providerId: "claude",
							generateTextEffect: () => Effect.die("unused"),
							discoverEffect: () => Effect.die("unused"),
							sendTurnEffect: (input) =>
								Effect.sync(() => {
									sent.push(input.inputId);
									return {
										status: "completed" as const,
										cost: 0,
										tokens: { input: 0, output: 0 },
										durationMs: 0,
										providerStateUpdates: [],
									};
								}),
							interruptTurnEffect: () => Effect.void,
							resolvePermissionEffect: () => Effect.void,
							resolveQuestionEffect: () => Effect.void,
							endSessionEffect: () => Effect.void,
							shutdownEffect: () => Effect.void,
							hasLiveProcessEffect: () => Effect.succeed(true),
							getControlProcessIdEffect: () => Effect.succeed("runner"),
						},
					]),
					ingestion,
					write: commit.write,
					persistUserMessage: persist.persistUserMessage,
					projectGate: () => Effect.succeed("served" as const),
				});
				for (let drain = 0; drain <= steerCount; drain++)
					yield* reactor.drain();
				scenarios.push({ steerCount, released, passes, recovered, sent });
				expect(sent).toEqual(["start", ...ids]);
			}),
		);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

// Real gate, ingestion and recovery transactions: a removed project never refuses
// a claimed steer (CONTRACT 3.11, 1053-1108); a surviving runner keeps intake
// ownership, and confirmed loss returns only an unplaced steer, never held, to the
// outbox to be sent once under its command, with no terminal (CONTRACT 664-681, D50).
// Repeated sweeps, an accepted message and a user cancellation must not resend.
it.each(
	(["claude", "cursor"] as const).flatMap((driver) =>
		(["unplaced", "accepted", "user-cancelled"] as const).flatMap((placement) =>
			// An accepted steer is held, so the stop commit, not this sweep, settles
			// it once its runner is lost; only a dead runner's drain settles it here.
			(placement === "accepted" ? [false] : [true]).map((alive) => ({
				driver,
				placement,
				alive,
			})),
		),
	),
)("recovers a removed project's native steer after runner loss: $driver $placement alive=$alive", async ({
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
				yield* makeRunnerReceiptStore(sql);
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
					// The ledger build holds the send before it transmits.
					const hold = {
						runId: "run",
						runnerId: "runner",
						commandId: "input",
						transmission: 1,
					};
					yield* commit([
						canonicalEvent(
							"evidence.process_started",
							"session",
							{ runnerId: "runner", label: "runner:1", reattached: false },
							{ provider: driver },
						),
						canonicalEvent("run.dispatched", "session", hold, {
							provider: driver,
							metadata: { runId: "run" },
						}),
					]);
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
					projectGate: () => Effect.succeed("removed" as const),
				});
				yield* reactor.drain();
				if (placement === "user-cancelled") {
					// An explicit Stop cancels for interruption, not project refusal.
					yield* sql`UPDATE provider_command_outbox SET status = 'cancelled', error_code = 'interrupted' WHERE command_id = 'input'`;
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
					// The write that returns the send to the outbox must fail recovery, not be swallowed.
					yield* sql.unsafe(`CREATE TRIGGER fail_requeue BEFORE UPDATE ON provider_command_outbox
						WHEN NEW.status = 'retryable_failed'
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
				// A cancelled steer is no runner candidate; only runner loss settles a running one,
				// and an unplaced steer's loss settles nothing: its send goes back to the outbox.
				expect(afterLoss.settlements).toEqual(
					placement === "accepted" ? [{ command_id: "input" }] : [],
				);
				expect(afterLoss.commands).toEqual([
					placement === "unplaced"
						? { status: "retryable_failed", error_code: null }
						: placement === "user-cancelled"
							? { status: "cancelled", error_code: "interrupted" }
							: { status: "failed", error_code: "runner_stopped" },
				]);
				expect(afterLoss.runs).toEqual([
					{ status: placement === "unplaced" ? "pending" : "error" },
				]);
				expect(afterLoss.inputs).toEqual([
					{
						input_id: "input",
						state: placement === "accepted" ? "removed" : "steering",
					},
				]);
				expect(afterLoss.messages).toHaveLength(
					placement === "accepted" ? 1 : 0,
				);
				expect(afterLoss.requeues).toHaveLength(0);
				expect(afterLoss.terminals).toHaveLength(
					placement === "unplaced" ? 0 : 1,
				);
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
						{ state: placement === "accepted" ? "removed" : "steering" },
					]);
					expect(
						yield* sql`SELECT type FROM events WHERE type = 'input.requeued'`,
					).toHaveLength(0);
					expect(
						yield* sql`SELECT type FROM events WHERE type = 'turn.error'`,
					).toHaveLength(placement === "unplaced" ? 0 : 1);
					expect(
						yield* sql`SELECT command_id FROM receipt_settlements`,
					).toEqual(placement === "accepted" ? [{ command_id: "input" }] : []);
				}),
			);
		}
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
