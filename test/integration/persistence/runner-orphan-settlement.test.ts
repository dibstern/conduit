import { mkdirSync, writeFileSync } from "node:fs";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { afterAll, expect, it } from "vitest";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { ProviderSideEffectReactor } from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { settleUnclaimedRunnerCommands } from "../../../src/lib/provider/runner/runner-recovery.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

const scenarios: Record<string, unknown>[] = [];
const refusalScenarios: Record<string, unknown>[] = [];
afterAll(() => {
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/82tn10-4-fix6-refusal.json",
		JSON.stringify(refusalScenarios, null, 2),
	);
});

// A refusal lock must not impersonate an executor during attachment recovery.
// Conversely, a real execution before runner intake must survive reattachment.
it.each([
	"restored",
	"removed",
	"executing",
] as const)("settles a send when a refusal sweep overlaps project recovery: %s", async (overlap) => {
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
							title: "Refusal overlap",
						}),
						canonicalEvent("run.requested", "session", {
							runId: "run",
							inputId: "input",
						}),
					]);
					yield* sql`INSERT INTO command_receipts(command_id,project_key,session_id,status,created_at) VALUES('command','project','session','side_effect_requested',1)`;
					const payload = JSON.stringify({
						sessionId: "session",
						inputId: "input",
						runId: "run",
						prompt: "Send once",
						workspaceRoot: "/repo",
						extraFolders: [],
						history: [],
						providerState: {},
						configDir: configuredClaudeConfigDir(
							`${process.env["HOME"]}/claude`,
						),
						folderSource: "account",
					});
					yield* sql`INSERT INTO provider_command_outbox(request_sequence,command_id,project_key,session_id,provider_id,effect_type,payload_json,run_id,status,attempt_count,requested_at,updated_at)
					VALUES(1,'command','project','session','claude','send_turn',${payload},'run',${overlap === "executing" ? "pending" : "running"},${overlap === "executing" ? 0 : 1},1,1)`;
					const entered = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					let phase: "removed" | "attaching" | "ready" =
						overlap === "executing" ? "ready" : "removed";
					let providerCalls = 0;
					const registry = new ProviderRegistry([
						{
							providerId: "claude",
							generateTextEffect: () => Effect.die("unused"),
							discoverEffect: () => Effect.die("unused"),
							sendTurnEffect: (input) =>
								Effect.gen(function* () {
									providerCalls++;
									yield* Deferred.succeed(entered, undefined);
									yield* Deferred.await(release);
									yield* input.eventSink.push(
										providerRuntimeEvent(
											"run.started",
											"session",
											{ requestedRunId: "run", inputId: "input" },
											{ eventId: "started", runId: "run" },
										),
									);
									yield* input.eventSink.push(
										providerRuntimeEvent(
											"turn.completed",
											"session",
											{ messageId: "", userMessageId: "input" },
											{ eventId: "completed", runId: "run" },
										),
									);
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
							hasLiveProcessEffect: () =>
								Deferred.succeed(entered, undefined).pipe(
									Effect.andThen(Deferred.await(release)),
									Effect.as(false),
								),
						},
					]);
					const reactor = new ProviderSideEffectReactor({
						sql,
						registry,
						write: commit.write,
						ingestion,
						isProjectReady: () =>
							phase === "removed"
								? Effect.fail(
										new ProviderInstanceFailure({
											providerId: "conduit",
											operation: "executeCommand",
											code: "project_inactive",
											cause: "removed",
										}),
									)
								: Effect.succeed(phase === "ready"),
					});
					const sweep = yield* Effect.forkChild(reactor.drain());
					yield* Deferred.await(entered);
					if (overlap === "executing") {
						phase = "removed";
						yield* reactor.drain();
					}
					const ownedDuringSweep = reactor.ownsPendingSend(
						"session",
						"command",
						1,
						1,
					);
					if (overlap !== "removed") {
						phase = "attaching";
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
							reactor.ownsPendingSend.bind(reactor),
						);
					}
					phase = overlap === "removed" ? "removed" : "ready";
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.join(sweep);
					for (let index = 0; index < 3; index++) yield* reactor.drain();
					const result = {
						overlap,
						ownedDuringSweep,
						providerCalls,
						ownedAfter: reactor.ownsPendingSend("session", "command", 1, 1),
						commands:
							yield* sql`SELECT status, attempt_count, error_code FROM provider_command_outbox`,
						receipts: yield* sql`SELECT status FROM command_receipts`,
						runs: yield* sql`SELECT status FROM provider_runs`,
						terminals:
							yield* sql`SELECT type FROM events WHERE type IN ('turn.error', 'turn.completed')`,
					};
					refusalScenarios.push(result);
					expect(result.ownedDuringSweep).toBe(overlap === "executing");
					expect(result.ownedAfter).toBe(false);
					expect(result.providerCalls).toBe(overlap === "executing" ? 1 : 0);
					expect(result.commands).toEqual([
						{
							status:
								overlap === "executing"
									? "completed"
									: overlap === "removed"
										? "cancelled"
										: "failed",
							attempt_count: 1,
							error_code:
								overlap === "executing"
									? null
									: overlap === "removed"
										? "project_inactive"
										: "runner_stopped",
						},
					]);
					expect(result.receipts).toEqual([
						{
							status:
								overlap === "executing"
									? "side_effect_completed"
									: "side_effect_failed",
						},
					]);
					expect(result.runs).toEqual([
						{ status: overlap === "executing" ? "completed" : "error" },
					]);
					expect(result.terminals).toEqual([
						{ type: overlap === "executing" ? "turn.completed" : "turn.error" },
					]);
				}),
			),
		);
	} finally {
		await runtime.dispose();
	}
});

// Recovery can lose its snapshot to a retry or requeue before it writes a
// terminal. Exercise the real SQL ledger and runtime ingestion transaction.
it.each([
	"retry",
	"requeue",
	"replaced-row",
	"claimed-after-snapshot",
	"unchanged",
] as const)("orphan settlement respects a %s after its snapshot", async (change) => {
	const persistence = makePersistenceEffectLayer(":memory:", "project");
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
				const persist = yield* ClaudeEventPersistEffectTag;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "session", {
						sessionId: "session",
						provider: "claude",
						title: "Orphan snapshot",
					}),
					canonicalEvent("run.requested", "session", {
						runId: "run",
						inputId: "input",
					}),
				]);
				yield* persist.persistUserMessage("session", "Accepted prompt", {
					messageId: "input",
					inputId: "input",
					runId: "run",
				});
				yield* persist.persistEvents([
					canonicalEvent(
						"run.started",
						"session",
						{ requestedRunId: "run", inputId: "input" },
						{ provider: "claude", metadata: { runId: "run" } },
					),
					canonicalEvent(
						"message.created",
						"session",
						{
							messageId: "answer",
							sessionId: "session",
							role: "assistant",
							parentID: "input",
						},
						{ provider: "claude", metadata: { runId: "run" } },
					),
				]);
				yield* sql`INSERT INTO command_receipts (command_id, project_key, session_id, status, created_at) VALUES ('command', 'project', 'session', 'side_effect_requested', 1)`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at)
				VALUES (1, 'command', 'project', 'session', 'claude', 'send_turn', '{"inputId":"input"}', 'run', 'running', 1, 1, 1)`;
				let claimedAfterSnapshot = false;
				yield* settleUnclaimedRunnerCommands(
					sql,
					new Set(),
					"claude",
					() => "claude",
					(_sinkId, turn, failure, current?: Effect.Effect<void, SqlError>) =>
						Effect.gen(function* () {
							if (change === "claimed-after-snapshot")
								claimedAfterSnapshot = true;
							if (change === "retry")
								yield* sql`UPDATE provider_command_outbox SET attempt_count = 2 WHERE command_id = 'command'`;
							if (change === "requeue" || change === "replaced-row")
								yield* sql`UPDATE provider_command_outbox SET status = 'pending' WHERE command_id = 'command'`;
							if (change === "replaced-row")
								yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at)
								VALUES (2, 'command', 'project', 'session', 'claude', 'send_turn', '{"inputId":"other-input"}', 'running', 1, 2, 2)`;
							yield* ingestion.ingestBatch(
								[
									providerRuntimeEvent(
										"turn.error",
										turn.sessionId,
										{
											messageId: turn.messageId,
											error: failure.message,
											code: "runner_stopped",
											retryable: false,
										},
										{
											eventId: "orphan-terminal",
											...(turn.runId ? { runId: turn.runId } : {}),
										},
									),
								],
								current ? { beforeProject: current } : {},
							);
						}),
					undefined,
					undefined,
					() => claimedAfterSnapshot,
				);
				const commands =
					yield* sql`SELECT status, attempt_count, error_code FROM provider_command_outbox WHERE request_sequence = 1`;
				const terminals =
					yield* sql`SELECT type FROM events WHERE event_id = 'orphan-terminal'`;
				scenarios.push({ change, commands, terminals });
				expect(commands).toEqual([
					{
						status:
							change === "retry" || change === "claimed-after-snapshot"
								? "running"
								: change === "requeue" || change === "replaced-row"
									? "pending"
									: "failed",
						attempt_count: change === "retry" ? 2 : 1,
						error_code: change === "unchanged" ? "runner_stopped" : null,
					},
				]);
				expect(terminals).toHaveLength(change === "unchanged" ? 1 : 0);
			}),
		);
	} finally {
		await runtime.dispose();
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn10-4-fix5-orphan-settlement.json",
			JSON.stringify({ scenarios }, null, 2),
		);
	}
});
