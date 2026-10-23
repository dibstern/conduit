import { ok } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, expect, it } from "vitest";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { CommandReadModelRepository } from "../../../src/lib/provider/orchestration-read-model.js";
import { ProviderSideEffectReactor } from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { settleUnclaimedRunnerCommands } from "../../../src/lib/provider/runner/runner-recovery.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

const evidence: unknown[] = [];
const detachedEvidence: unknown[] = [];
afterAll(() => {
	mkdirSync("test-results/82tn10-4-round7", { recursive: true });
	writeFileSync(
		"test-results/82tn10-4-round7/send-attempts.json",
		JSON.stringify(evidence, null, 2),
	);
	writeFileSync(
		"test-results/82tn10-4-round13-detached-send.json",
		JSON.stringify(detachedEvidence, null, 2),
	);
});

it.each([
	"removed",
	"recovered intake",
	"runner lost",
] as const)("releases a detached background send for %s", async (settlement) => {
	const persistence = makePersistenceEffectLayer(":memory:", "project");
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "session", {
						sessionId: "session",
						provider: "claude",
						title: "Detached background send",
					}),
					canonicalEvent("run.requested", "session", {
						runId: "run",
						inputId: "input",
					}),
				]);
				const payload = JSON.stringify({
					sessionId: "session",
					inputId: "input",
					prompt: "Send once",
					workspaceRoot: "/repo",
					extraFolders: [],
					history: [],
					providerState: {},
					configDir: configuredClaudeConfigDir("/tmp/82tn10-4-round13/claude"),
					folderSource: "account",
				});
				yield* sql`INSERT INTO command_receipts(command_id,project_key,session_id,status,created_at) VALUES('command','project','session','side_effect_requested',1)`;
				yield* sql`INSERT INTO provider_command_outbox(request_sequence,command_id,project_key,session_id,provider_id,effect_type,payload_json,run_id,status,attempt_count,requested_at,updated_at) VALUES(1,'command','project','session','claude','send_turn',${payload},'run','pending',0,1,1)`;
				const entered = yield* Deferred.make<void>();
				const detach = yield* Deferred.make<void>();
				let removed = false;
				let sends = 0;
				const registry = new ProviderRegistry([
					{
						providerId: "claude",
						generateTextEffect: () => Effect.die("unused"),
						discoverEffect: () => Effect.die("unused"),
						sendTurnEffect: () =>
							Effect.gen(function* () {
								sends++;
								yield* Deferred.succeed(entered, undefined);
								yield* Deferred.await(detach);
								return yield* new ProviderInstanceFailure({
									providerId: "claude",
									operation: "detach runner",
									code: "runner_detached",
									cause: "Project released its runner attachment",
								});
							}),
						hasLiveProcessEffect: () => Effect.succeed(true),
						getControlProcessIdEffect: () => Effect.succeed("runner"),
						interruptTurnEffect: () => Effect.void,
						resolvePermissionEffect: () => Effect.void,
						resolveQuestionEffect: () => Effect.void,
						endSessionEffect: () => Effect.void,
						shutdownEffect: () => Effect.void,
					},
				]);
				const reactor = new ProviderSideEffectReactor({
					sql,
					registry,
					write: commit.write,
					ingestion,
					isProjectReady: () =>
						removed
							? Effect.fail(
									new ProviderInstanceFailure({
										providerId: "conduit",
										operation: "executeCommand",
										code: "project_inactive",
										cause: "Project removed",
									}),
								)
							: Effect.succeed(true),
				});
				const worker = yield* Effect.forkChild(reactor.drain());
				yield* Deferred.await(entered).pipe(Effect.timeout("3 seconds"));
				expect(reactor.ownsPendingSend("session", "command", 1, 1)).toBe(true);
				const claimed =
					yield* sql`SELECT status, attempt_count, run_id, payload_json FROM provider_command_outbox`;
				removed = settlement === "removed";
				yield* Deferred.succeed(detach, undefined);
				yield* Effect.gen(function* () {
					while (reactor.ownsPendingSend("session", "command", 1, 1))
						yield* Effect.sleep("1 millis");
				}).pipe(Effect.timeout("3 seconds"));
				for (let index = 0; index < 3; index++) yield* reactor.drain();
				const released =
					yield* sql`SELECT status, error_code, attempt_count, run_id, payload_json FROM provider_command_outbox`;
				if (settlement === "removed") {
					expect(released).toEqual([
						{
							...claimed[0],
							status: "cancelled",
							error_code: "project_inactive",
						},
					]);
					expect(
						yield* sql`SELECT status, error_code FROM command_receipts`,
					).toEqual([
						{ status: "side_effect_failed", error_code: "project_inactive" },
					]);
				} else {
					expect(released).toEqual([{ ...claimed[0], error_code: null }]);
					expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
						{ status: "side_effect_requested" },
					]);
				}
				yield* Fiber.join(worker).pipe(Effect.timeout("1 second"));
				expect(
					yield* sql`SELECT type FROM events WHERE type = 'turn.error'`,
				).toEqual([]);
				if (settlement === "recovered intake") {
					yield* ingestion.ingest(
						providerRuntimeEvent(
							"run.started",
							"session",
							{ requestedRunId: "run", inputId: "input" },
							{ runId: "run" },
						),
					);
					yield* ingestion.ingest(
						providerRuntimeEvent(
							"turn.completed",
							"session",
							{ messageId: "", userMessageId: "input" },
							{ runId: "run" },
						),
					);
				} else if (settlement === "runner lost") {
					yield* settleUnclaimedRunnerCommands(
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
												messageId: "input",
												error: failure.message,
												code: "runner_stopped",
												retryable: false,
											},
											turn.runId ? { runId: turn.runId } : {},
										),
									],
									{ beforeProject },
								)
								.pipe(Effect.asVoid),
						undefined,
						undefined,
						(...args) => reactor.ownsPendingSend(...args),
					);
				}
				for (let index = 0; index < 3; index++) yield* reactor.drain();
				expect(sends).toBe(1);
				const final =
					yield* sql`SELECT status, error_code, attempt_count FROM provider_command_outbox`;
				expect(final).toEqual([
					{
						status:
							settlement === "removed"
								? "cancelled"
								: settlement === "runner lost"
									? "failed"
									: "completed",
						error_code:
							settlement === "removed"
								? "project_inactive"
								: settlement === "runner lost"
									? "runner_stopped"
									: null,
						attempt_count: 1,
					},
				]);
				const receipts =
					yield* sql`SELECT status, error_code FROM command_receipts`;
				expect(receipts).toEqual([
					{
						status:
							settlement === "recovered intake"
								? "side_effect_completed"
								: "side_effect_failed",
						error_code: final[0]?.["error_code"],
					},
				]);
				detachedEvidence.push({
					settlement,
					claimed,
					released,
					final,
					receipts,
					sends,
				});
			}),
		).pipe(
			Effect.provide(
				Layer.provideMerge(ProviderRuntimeIngestionLive, persistence),
			),
		),
	);
});

// Provider terminals can enable a retry before the preceding send returns.
// Attachment must preserve that retry across any older success/failure cleanup.
it.each([
	{ attempts: 2, oldOutcome: "failure", releaseOrder: [0] },
	{ attempts: 2, oldOutcome: "completed", releaseOrder: [0] },
	{ attempts: 3, oldOutcome: "failure", releaseOrder: [1, 0] },
	{ attempts: 3, oldOutcome: "completed", releaseOrder: [0, 1] },
] as const)("keeps attempt $attempts owned while older sends return $oldOutcome", async ({
	attempts,
	oldOutcome,
	releaseOrder,
}) => {
	const persistence = makePersistenceEffectLayer(":memory:", "project");
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			persistence,
			ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
		),
	);
	try {
		await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const ingestion = yield* ProviderRuntimeIngestionTag;
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("session.created", "session", {
							sessionId: "session",
							provider: "claude",
							title: "Overlapping retries",
						}),
						canonicalEvent("run.requested", "session", {
							runId: "run",
							inputId: "input",
						}),
					]);
					const payload = {
						sessionId: "session",
						inputId: "input",
						prompt: "Send once",
						configDir: configuredClaudeConfigDir("/tmp/82tn10-4-round7/claude"),
						folderSource: "account" as const,
						workspaceRoot: "/repo",
						extraFolders: [],
						history: [],
						providerState: {},
					};
					yield* sql`INSERT INTO command_receipts(command_id,project_key,session_id,status,created_at) VALUES('command','project','session','side_effect_requested',1)`;
					yield* sql`INSERT INTO provider_command_outbox(request_sequence,command_id,project_key,session_id,provider_id,effect_type,payload_json,run_id,status,attempt_count,requested_at,updated_at) VALUES(1,'command','project','session','claude','send_turn',${JSON.stringify(payload)},'run','pending',0,1,1)`;
					const releases = yield* Effect.forEach(
						Array.from({ length: attempts }),
						() => Deferred.make<void>(),
					);
					const returned = yield* Effect.forEach(
						Array.from({ length: attempts }),
						() => Deferred.make<void>(),
					);
					const entered = yield* Deferred.make<void>();
					const active = new Set<number>();
					let concurrent = 0;
					const aborted = new Set<number>();
					let calls = 0;
					const registry = new ProviderRegistry([
						{
							providerId: "claude",
							generateTextEffect: () => Effect.die("unused"),
							discoverEffect: () => Effect.die("unused"),
							sendTurnEffect: (input) =>
								Effect.gen(function* () {
									const runId = input.runId;
									ok(runId);
									const index = calls++;
									active.add(index);
									concurrent = Math.max(concurrent, active.size);
									if (index < attempts - 1) {
										input.abortSignal.addEventListener(
											"abort",
											() => aborted.add(index),
											{ once: true },
										);
										yield* input.eventSink.push(
											providerRuntimeEvent(
												"turn.error",
												"session",
												{
													messageId: input.inputId,
													error: "Retry",
													code: "network_error",
													retryable: true,
													retryAt: Date.now() - 1,
												},
												{ eventId: `retry-${index}`, runId },
											),
										);
									} else yield* Deferred.succeed(entered, undefined);
									const release = releases[index];
									const returnedGate = returned[index];
									ok(release);
									ok(returnedGate);
									yield* Deferred.await(release).pipe(
										Effect.ensuring(
											Effect.sync(() => active.delete(index)).pipe(
												Effect.andThen(
													Deferred.succeed(returnedGate, undefined),
												),
											),
										),
									);
									if (index < attempts - 1 && oldOutcome === "failure")
										return yield* Effect.fail(
											new ProviderInstanceFailure({
												providerId: "claude",
												operation: "sendTurn",
												cause: "Old attempt failed",
											}),
										);
									if (index === attempts - 1) {
										yield* input.eventSink.push(
											providerRuntimeEvent(
												"run.started",
												"session",
												{
													requestedRunId: runId,
													inputId: input.inputId,
												},
												{ eventId: "started", runId },
											),
										);
										yield* input.eventSink.push(
											providerRuntimeEvent(
												"turn.completed",
												"session",
												{
													messageId: "",
													userMessageId: input.inputId,
												},
												{ eventId: "completed", runId },
											),
										);
									}
									return {
										status: "completed" as const,
										cost: 0,
										tokens: { input: 0, output: 0 },
										durationMs: 1,
										providerStateUpdates: [],
									};
								}).pipe(
									Effect.mapError(
										(cause) =>
											new ProviderInstanceFailure({
												providerId: "claude",
												operation: "sendTurn",
												cause,
											}),
									),
								),
							interruptTurnEffect: () => Effect.void,
							resolvePermissionEffect: () => Effect.void,
							resolveQuestionEffect: () => Effect.void,
							endSessionEffect: () => Effect.void,
							shutdownEffect: () => Effect.void,
						},
					]);
					const engine = new OrchestrationEngine({
						registry,
						projectOfSession: () => Effect.succeed("project"),
						durableCommands: {
							sql,
							write: commit.write,
							ingestion,
							snapshot: yield* new CommandReadModelRepository(sql).bootstrap(),
							now: () => Date.now(),
							generateId: () => crypto.randomUUID(),
							isProjectReady: () => Effect.succeed(true),
						},
					});
					yield* Effect.addFinalizer(() => engine.shutdownEffect());
					const reactor = new ProviderSideEffectReactor({
						sql,
						registry,
						write: commit.write,
						ingestion,
						outcomePollInterval: "1 millis",
					});
					const owner = attempts === 3 ? reactor : engine;
					const first: Effect.Effect<void, unknown> =
						attempts === 3
							? reactor.runCommand("command").pipe(Effect.asVoid)
							: engine.drainSideEffects();
					const workers = [yield* Effect.forkChild(first)];
					for (let index = 1; index < attempts; index++) {
						yield* Effect.gen(function* () {
							while (!aborted.has(index - 1)) yield* Effect.sleep("1 millis");
						}).pipe(Effect.timeout("3 seconds"));
						if (attempts === 3) {
							// Exercise a third overlapping delivery directly at the executor seam;
							// the live engine waiter serializes additional foreground retries.
							yield* sql`UPDATE provider_command_outbox SET status = 'pending', error_code = NULL WHERE command_id = 'command'`;
							yield* sql`UPDATE command_receipts SET status = 'side_effect_requested', error_code = NULL WHERE command_id = 'command'`;
						}
						const delivery: Effect.Effect<void, unknown> =
							attempts === 3
								? reactor.runCommand("command").pipe(Effect.asVoid)
								: engine
										.dispatchEffect({
											type: "send_turn",
											commandId: "command",
											providerId: "claude",
											input: {
												...payload,
												abortSignal: new AbortController().signal,
												eventSink: {
													push: () => Effect.void,
													requestPermission: () => Effect.die("unused"),
													requestQuestion: () => Effect.die("unused"),
													resolvePermission: () => Effect.void,
													resolveQuestion: () => Effect.void,
												},
											},
										})
										.pipe(Effect.asVoid);
						workers.push(yield* Effect.forkChild(delivery));
					}
					yield* Deferred.await(entered).pipe(Effect.timeout("3 seconds"));
					expect(
						owner.ownsPendingSend(
							"session",
							"command",
							attempts === 3 ? 1 : attempts,
							attempts,
						),
					).toBe(true);
					expect(
						owner.ownsPendingSend(
							"session",
							"command",
							attempts === 3 ? 1 : attempts,
							attempts + 1,
						),
					).toBe(false);
					for (const index of releaseOrder) {
						const release = releases[index];
						const returnedGate = returned[index];
						const worker = workers[index];
						ok(release);
						ok(returnedGate);
						ok(worker);
						yield* Deferred.succeed(release, undefined);
						yield* Deferred.await(returnedGate).pipe(
							Effect.timeout("3 seconds"),
						);
						if (attempts === 2)
							yield* Fiber.await(worker).pipe(Effect.timeout("3 seconds"));
						else
							yield* Effect.gen(function* () {
								while (
									owner.ownsPendingSend("session", "command", 1, index + 1)
								)
									yield* Effect.sleep("1 millis");
							}).pipe(Effect.timeout("3 seconds"));
					}
					yield* settleUnclaimedRunnerCommands(
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
												messageId: "input",
												error: failure.message,
												code: "runner_stopped",
												retryable: false,
											},
											{
												eventId: "orphan",
												...(turn.runId ? { runId: turn.runId } : {}),
											},
										),
									],
									{ beforeProject },
								)
								.pipe(Effect.asVoid),
						undefined,
						undefined,
						(sessionId, commandId, requestSequence, attemptCount) =>
							owner.ownsPendingSend(
								sessionId,
								commandId,
								requestSequence,
								attemptCount,
							),
					);
					const snapshot =
						yield* sql`SELECT request_sequence, status, attempt_count, error_code FROM provider_command_outbox ORDER BY request_sequence`;
					expect(snapshot.at(-1)).toMatchObject({
						request_sequence: attempts === 3 ? 1 : attempts,
						status: "running",
						attempt_count: attempts,
						error_code: null,
					});
					expect(
						yield* sql`SELECT 1 FROM events WHERE event_id = 'orphan'`,
					).toEqual([]);
					const lastRelease = releases[attempts - 1];
					const lastWorker = workers[attempts - 1];
					ok(lastRelease);
					ok(lastWorker);
					yield* Deferred.succeed(lastRelease, undefined);
					yield* Fiber.join(lastWorker).pipe(Effect.timeout("3 seconds"));
					yield* Effect.forEach(workers, (worker) => Fiber.await(worker));
					expect(
						owner.ownsPendingSend(
							"session",
							"command",
							attempts === 3 ? 1 : attempts,
							attempts,
						),
					).toBe(false);
					expect(calls).toBe(attempts);
					expect(concurrent).toBe(attempts);
					const final =
						yield* sql`SELECT status, error_code FROM provider_command_outbox WHERE request_sequence = ${attempts === 3 ? 1 : attempts}`;
					expect(final).toEqual([{ status: "completed", error_code: null }]);
					evidence.push({
						attempts,
						oldOutcome,
						releaseOrder,
						snapshot,
						final,
						calls,
						concurrent,
					});
				}),
			),
		);
	} finally {
		await runtime.dispose();
	}
});
