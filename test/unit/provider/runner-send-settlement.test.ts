import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import {
	Clock,
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Option,
	Random,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import type { InputDraftEnvelope } from "../../../src/lib/contracts/ws-rpc.js";
import {
	InputDraftsTag,
	makeInputDrafts,
} from "../../../src/lib/domain/project-services/Services/input-drafts.js";
import {
	makePendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/project-services/Services/pending-interaction-service.js";
import { ProviderRuntimeIngestionTag } from "../../../src/lib/domain/project-services/Services/provider-runtime-ingestion-service.js";
import { SessionEventBusLive } from "../../../src/lib/domain/project-services/Services/session-event-bus.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { ProviderSideEffectReactor } from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type { ProcessRunnerDriver } from "../../../src/lib/provider/runner/process-runner-types.js";
import { makeProcessSessionRunner } from "../../../src/lib/provider/runner/process-session-runner.js";
import {
	type RunnerHello,
	type RunnerSocket,
	type RunnerWriteGate,
	runnerBuildId,
	runnerFailure,
	sendToken,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import {
	makeRunnerProviderInstance,
	type RunnerRecoveryDependencies,
} from "../../../src/lib/provider/runner/runner-provider-instance.js";
import { makeRunnerReceiptStore } from "../../../src/lib/provider/runner/runner-receipts.js";
import * as runnerRegistry from "../../../src/lib/provider/runner/runner-registry.js";
import { prepareRunnerDirectory } from "../../../src/lib/provider/runner/runner-registry.js";
import { makeRunnerRunLifecycle } from "../../../src/lib/provider/runner/runner-retirement.js";
import { RunnerSendJournal } from "../../../src/lib/provider/runner/runner-send-journal.js";
import * as runnerSends from "../../../src/lib/provider/runner/runner-sends.js";
import type {
	SessionCommand,
	SessionFailure,
} from "../../../src/lib/provider/runner/session-runner.js";
import type { TurnResult } from "../../../src/lib/provider/types.js";
import { ProviderRuntimeIngestionLive } from "../../helpers/daemon-turns.js";
import {
	createMockEventSink,
	makeBaseSendTurnInput,
} from "../../helpers/mock-sdk.js";
import { gatedWrite } from "../../helpers/runner-write-gate.js";

const spawned = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: spawned.spawn,
}));

const runRetirement = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
	const persistence = makePersistenceEffectLayer(
		":memory:",
		"test-project",
	).pipe(Layer.provideMerge(SessionEventBusLive));
	return Effect.scoped(effect).pipe(
		Effect.provide(
			Layer.mergeAll(
				persistence,
				ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
				makePendingInteractionServiceLive(),
			),
		),
	);
};

// Real manager, provider, reactor and SQLite. Only the child process transport and
// process table are fake, so faults cross the same session interface as dispatch.
const s7Fixture = (driverKind: "claude" | "cursor" = "cursor") =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.sync(() => mkdtempSync(join(tmpdir(), "runner-settlement-"))),
			(directory) =>
				Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
		);
		const sql = yield* SqlClient.SqlClient;
		const commit = yield* makeCommitAndSignal;
		yield* commit([
			canonicalEvent("session.created", "s", {
				sessionId: "s",
				title: "Send settlement",
				provider: driverKind,
			}),
		]);
		const runnerId = "131313131313";
		const pid = 100_088;
		const receipts = yield* makeRunnerReceiptStore(sql);
		const socketPath = join(prepareRunnerDirectory(root, root), runnerId);
		writeFileSync(
			`${socketPath}.json`,
			JSON.stringify({
				driverKind,
				runnerId,
				sessionId: "s",
				socketPath,
				buildId: runnerBuildId(),
				pid,
				startTime: "original",
				registeredAt: 1,
			}),
		);
		const processes = new Map<number, { state: "running"; startTime: string }>([
			[pid, { state: "running", startTime: "original" }],
		]);
		let spawnedProcesses = 0;
		spawned.spawn.mockImplementation(() => {
			const child = Object.assign(new EventEmitter(), {
				pid: 100_020 + spawnedProcesses++,
				exitCode: null,
				signalCode: null,
				connected: false,
				unref: () => {},
				disconnect: () => {},
			});
			processes.set(child.pid, { state: "running", startTime: "replacement" });
			queueMicrotask(() =>
				child.emit("message", {
					channel: "conduit-claude-runner",
					type: "listening",
				}),
			);
			return child as unknown as ChildProcess;
		});
		const attachments: Array<Parameters<ProcessRunnerDriver["connect"]>[0]> =
			[];
		const commands: Array<{ runnerId: string; type: string }> = [];
		const connections: RunnerSocket[] = [];
		const hellos: RunnerHello[] = [];
		// The reactor's own call runs this before any feeder step.
		const preparation: {
			gate?: Effect.Effect<void, ProviderInstanceFailure>;
		} = {};
		const replaySend: {
			execute?: (
				token: string,
				command: Extract<SessionCommand, { type: "send-turn" }>,
			) => Effect.Effect<TurnResult | undefined, SessionFailure>;
		} = {};
		const driver: ProcessRunnerDriver = {
			driverKind,
			prepareStoredTurnEffect: (input) =>
				Effect.succeed({
					input: {
						...input,
						prompt: input.text ?? "send",
						history: [],
						facts: { _tag: "Claude" as const },
					},
				}),
			connect: vi.fn<ProcessRunnerDriver["connect"]>((options) =>
				Effect.gen(function* () {
					attachments.push(options);
					const connection = {
						closed: false,
						commandEffect: (
							id: string,
							command: SessionCommand,
							canWrite?: RunnerWriteGate,
						) =>
							gatedWrite(
								canWrite,
								Effect.suspend(() => {
									commands.push({
										runnerId: options.runnerId,
										type: command.type,
									});
									return command.type === "send-turn"
										? (replaySend.execute?.(id, command) ??
												Effect.succeed(terminalResult()))
										: Effect.succeed(undefined);
								}),
							),
						retireEffect: () => Effect.succeed(true),
						commandStatusEffect: () => Effect.succeed("not_received"),
						destroy: () => {},
						write: () => {},
					} as unknown as RunnerSocket;
					const hello: RunnerHello = {
						type: "hello",
						protocolVersion: 1,
						buildId: runnerBuildId(),
						stampsRunIds: true,
						runnerId: options.runnerId,
						sessionId: "s",
						pid: options.pid ?? 0,
						bindings: [],
						sendAnswers: [],
					};
					connections.push(connection);
					hellos.push(hello);
					yield* options.onHello(hello, connection);
					return connection;
				}),
			),
			settingsDeferredCode: "test-deferred",
			warmCommand: (sessionId, _state, snapshot) => ({
				type: "pre-warm",
				sessionId,
				input: { ...snapshot.input, sessionId },
			}),
			snapshotCommandSettings: () => ({}),
			loginChange: () => "None",
		};
		const accounts = accountsStateFromInstances(
			[{ id: "account", driver: driverKind, name: "Account" }],
			configuredClaudeConfigDir(root),
		);
		const processTable: runnerRegistry.RunnerProcessTable = {
			inspect: (processId) => processes.get(processId) ?? { state: "gone" },
			signal: () => {},
		};
		let recovery: RunnerRecoveryDependencies | undefined;
		let emit: Parameters<typeof makeProcessSessionRunner>[1] = () =>
			Effect.succeed({});
		const manager = yield* makeProcessSessionRunner(
			{
				daemonConfigDir: root,
				accounts: Effect.succeed(accounts),
				projectRootForSession: () => Effect.succeed(root),
				processTable,
				recoveryForSession: () => Effect.succeed(recovery),
			},
			(...args) => emit(...args),
			driver,
		);
		const originalRecover = manager.recoverEffect;
		let registered = false;
		Object.defineProperty(manager, "recoverEffect", {
			value: Effect.gen(function* () {
				if (!registered) {
					yield* receipts.register(
						runnerId,
						{ sessionId: "s", pid, startTime: "original", driverKind },
						"serving",
					);
					registered = true;
				}
				yield* originalRecover;
			}),
		});
		const account = accounts.accounts[0];
		if (!account) return yield* Effect.die("missing fixture account");
		const input = makeBaseSendTurnInput({
			sessionId: "s",
			workspaceRoot: root,
			extraFolders: [],
			providerState: {},
			configDir: configuredClaudeConfigDir(root),
			inputId: "input",
			account,
			eventSink: createMockEventSink(),
			abortSignal: new AbortController().signal,
		});
		const instance = yield* makeRunnerProviderInstance(
			{ daemonConfigDir: root, accounts: Effect.succeed(accounts) },
			{
				driverKind,
				discoverEffect: () => Effect.die("unused discovery"),
				generateTextEffect: () => Effect.die("unused generation"),
				prepareTurnEffect: (turn) =>
					(preparation.gate ?? Effect.void).pipe(
						Effect.as({
							input: {
								...turn,
								prompt: turn.text ?? "send",
								history: [],
								facts: { _tag: "Claude" as const },
							},
						}),
					),
			},
			(output) => {
				emit = output;
				return Effect.succeed(manager);
			},
		);
		const discover = runnerRegistry.discoverAllRunners;
		const discovery = vi
			.spyOn(runnerRegistry, "discoverAllRunners")
			.mockImplementation((config) => discover(config, processTable));
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => discovery.mockRestore()),
		);
		const persist = yield* ClaudeEventPersistEffectTag;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const wakes: Array<
			ReadonlyArray<{ readonly command_id: string; readonly status: string }>
		> = [];
		const drafts = yield* makeInputDrafts;
		const recoveryContext: RunnerRecoveryDependencies = {
			projectId: "test-project",
			ingestion,
			inputDrafts: drafts,
			pending: yield* PendingInteractionServiceTag,
			persist,
			timeoutHooks: {},
			resolveCallContext: () =>
				Effect.succeed({
					projectId: "test-project",
					sessionId: "s",
					account,
					workspaceRoot: root,
					extraFolders: [],
					shellEnv: {},
				}),
			retirePrompts: () => Effect.succeed(0),
			wakeReactor: Effect.gen(function* () {
				wakes.push(
					yield* sql<{
						command_id: string;
						status: string;
					}>`SELECT command_id, status FROM provider_command_outbox ORDER BY request_sequence`,
				);
			}).pipe(Effect.orDie),
		};
		recovery = recoveryContext;
		const reactor = new ProviderSideEffectReactor({
			projectId: "test-project",
			sql,
			registry: new ProviderRegistry([instance]),
			ingestion,
			write: commit.write,
			persistUserMessage: (...args) => persist.persistUserMessage(...args),
			// The project relay hands the reactor its draft owner.
			projectContext: () => Option.some(Context.make(InputDraftsTag, drafts)),
		});
		const seed = (
			commandId: string,
			sequence = 1,
			attempt = 1,
			transmission: "held" | "unheld" = "held",
		) =>
			Effect.gen(function* () {
				const turn = {
					...input,
					inputId: commandId,
					commandAttempt: attempt,
					runId: `run:${commandId}`,
					prompt: `text ${commandId}`,
					text: `text ${commandId}`,
					history: [],
				};
				yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES (${turn.runId}, 's', 'pending', 1)`;
				yield* sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, command_type, project_key, fingerprint_hash, fingerprint_version, side_effect_sequence, updated_at) VALUES (${commandId}, 's', 'side_effect_requested', 1, 'send_turn', 'test-project', 'sha256:settlement', 1, ${sequence}, 1)`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at, run_id) VALUES (${sequence}, ${commandId}, 'test-project', 's', 'account', 'send_turn', ${JSON.stringify(turn)}, ${attempt === 0 ? "pending" : "running"}, ${attempt}, 1, 1, ${turn.runId})`;
				if (attempt > 0 && transmission !== "unheld")
					yield* commit([
						canonicalEvent(
							"run.dispatched",
							"s",
							{ runId: turn.runId, runnerId, commandId, transmission: 1 },
							{ provider: driverKind, metadata: { runId: turn.runId } },
						),
					]);
				return turn;
			});
		const hello = (transform: (hello: RunnerHello) => RunnerHello) => {
			const connect = vi.mocked(driver.connect).getMockImplementation();
			if (!connect) return Effect.die("missing fixture connection");
			vi.mocked(driver.connect).mockImplementation((options) =>
				connect({
					...options,
					onHello: (value, connection, replay) => {
						const retained = transform(value);
						Object.defineProperty(connection, "retainedSends", {
							configurable: true,
							get: () => retained.sendTokens,
						});
						return options.onHello(retained, connection, replay);
					},
				}),
			);
			return Effect.void;
		};
		return {
			root,
			sql,
			commit,
			driver,
			processTable,
			processes,
			attachments,
			commands,
			connections,
			hellos,
			manager,
			instance,
			input,
			replaySend,
			preparation,
			persist,
			ingestion,
			reactor,
			recovery: recoveryContext,
			drafts,
			wakes,
			seed,
			hello,
			recover: instance.recoverProjectContextsEffect(() =>
				Effect.succeed(recoveryContext),
			),
		};
	});

const terminalResult = (
	status: TurnResult["status"] = "completed",
	error?: TurnResult["error"],
): TurnResult => ({
	status,
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
	...(error ? { error } : {}),
});

// Every injected fault rolls back the gate's real SQLite transaction. The
// observation time lets the cap test assert pacing without wall-clock sleeps.
const failHoldWrites = (sql: SqlClient.SqlClient, faults = Infinity) =>
	Effect.gen(function* () {
		const connection = yield* Effect.scoped(sql.reserve);
		const execute = connection.execute;
		const entered = yield* Deferred.make<void>();
		const attempts: number[] = [];
		let unavailable = true;
		const injected = vi
			.spyOn(connection, "execute")
			.mockImplementation((query, params, transform) =>
				Effect.gen(function* () {
					if (
						query.includes(
							"SELECT owner.id, session.provider, owner.status, owner.runner_id",
						)
					) {
						attempts.push(yield* Clock.currentTimeMillis);
						if (unavailable && attempts.length <= faults) {
							yield* Deferred.succeed(entered, undefined);
							return yield* Effect.fail(
								new SqlError({
									reason: new ConnectionError({ cause: "gate unavailable" }),
								}),
							);
						}
					}
					return yield* execute(query, params, transform);
				}),
			);
		yield* Effect.addFinalizer(() => Effect.sync(() => injected.mockRestore()));
		return {
			entered,
			attempts,
			recover: () => {
				unavailable = false;
			},
		};
	});

for (const state of [
	"held",
	"terminal",
	"missing owner",
	"wrong command",
] as const)
	it.effect(`F47 F48 total gate returns a value for ${state}`, () =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("gate", 1, 1, state === "held" ? "held" : "unheld");
				if (state === "terminal")
					yield* f.commit([
						canonicalEvent(
							"turn.completed",
							"s",
							{ messageId: "gate" },
							{ provider: "claude", metadata: { runId: "run:gate" } },
						),
					]);
				if (state === "missing owner")
					yield* f.sql`DELETE FROM provider_command_outbox`;
				const result = yield* makeRunnerRunLifecycle({
					sql: f.sql,
					commit: f.commit,
					eventStore: yield* EventStoreEffectTag,
				})
					.holdRun({
						sessionId: "s",
						runId: "run:gate",
						commandId: state === "wrong command" ? "another" : "gate",
					})
					.pipe(Effect.result);
				expect(result._tag).toBe("Success");
				if (result._tag === "Success")
					expect(result.success).toEqual({
						_tag: state === "held" ? "Busy" : "Ended",
					});
				expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
			}),
		),
	);

it.effect(
	"F46 F48 round-3 C1 four store faults then settlement admits the next send",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("head", 1, 0);
				yield* f.seed("next", 2, 0);
				yield* f.recover;
				const fault = yield* failHoldWrites(f.sql, 4);
				const sending = yield* f.reactor.drain().pipe(Effect.forkChild);
				yield* Deferred.await(fault.entered);
				for (
					let elapsed = 0;
					elapsed < 30000 && fault.attempts.length < 4;
					elapsed += 10
				)
					yield* TestClock.adjust(10);
				expect(fault.attempts).toHaveLength(4);
				yield* f.commit([
					canonicalEvent(
						"turn.interrupted",
						"s",
						{ messageId: "head" },
						{ provider: "claude", metadata: { runId: "run:head" } },
					),
				]);
				fault.recover();
				yield* TestClock.adjust("8 seconds");
				expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
				expect(
					yield* f.sql`SELECT command_id, status FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([
					{ command_id: "head", status: "failed" },
					{ command_id: "next", status: "completed" },
				]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.commandId') AS commandId FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ commandId: "next" }]);
				expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
					1,
				);
			}),
		),
);

it.effect(
	"F62 a gate outage uses capped durable re-entry and keeps later sends queued",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("outage", 1, 0);
				yield* f.seed("later", 2, 0);
				yield* f.recover;
				const fault = yield* failHoldWrites(f.sql);
				const sending = yield* f.reactor.drain().pipe(Effect.forkChild);
				yield* Deferred.await(fault.entered);
				for (const delay of [1000, 2000, 4000, 8000, 16000, 30000])
					yield* TestClock.adjust(delay);
				expect(fault.attempts).toEqual([
					0, 1000, 3000, 7000, 15000, 31000, 61000,
				]);
				expect(
					yield* f.sql`SELECT command_id, status FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([
					{ command_id: "outage", status: "running" },
					{ command_id: "later", status: "pending" },
				]);
				expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
				fault.recover();
				yield* TestClock.adjust("30 seconds");
				expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
				expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
					2,
				);
			}),
		),
);

for (const retryable of [false, true])
	it.effect(
		`F49 F68 F71 ${retryable ? "transient" : "permanent"} start refusal retains evidence across rollback without starting again`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.seed("start-refused", 1, 0);
					vi.mocked(f.driver.connect).mockImplementation(() =>
						Effect.fail({
							operation: "start runner",
							code: retryable ? "account_switch_busy" : "configuration_refused",
							message: "start refused",
							...(retryable ? { retryable: true } : {}),
						}),
					);
					const fault = yield* failSettlementWrite(f.sql);
					const sending = yield* f.reactor.runOnce().pipe(Effect.forkChild);
					yield* Deferred.await(fault.entered);
					expect(fault.attemptedTerminals).toHaveLength(1);
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "pending" },
					]);
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox`,
					).toEqual([{ status: "running" }]);
					const starts = spawned.spawn.mock.calls.length;
					expect(starts).toBe(1);
					fault.recover();
					yield* TestClock.adjust("1 second");
					expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
					expect(spawned.spawn).toHaveBeenCalledTimes(starts);
					expect(
						yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
					).toEqual([
						{
							status: retryable ? "retryable_failed" : "failed",
							error_code: retryable
								? "account_switch_busy"
								: "configuration_refused",
						},
					]);
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "error" },
					]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.error', 'turn.completed', 'turn.interrupted')`,
					).toEqual([{ type: "turn.error" }]);
					if (!retryable) {
						expect(
							yield* f.sql`SELECT text FROM input_drafts WHERE draft_key = 's'`,
						).toEqual([{ text: "text start-refused" }]);
						expect(
							yield* f.sql`SELECT input_id FROM messages WHERE role = 'user'`,
						).toEqual([{ input_id: "start-refused" }]);
					}
					expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
				}),
			),
	);

it.effect("F50 a runner gone before its bind fails once as StartLost", () =>
	runRetirement(
		Effect.gen(function* () {
			const f = yield* s7Fixture("claude");
			yield* f.seed("lost", 1, 0);
			// Started has returned once a serving row exists; the runner is lost
			// inside the next gate transaction, before that step can bind it.
			const connection = yield* Effect.scoped(f.sql.reserve);
			const execute = connection.execute;
			const injected = vi
				.spyOn(connection, "execute")
				.mockImplementation((query, params, transform) =>
					query.includes(
						"SELECT owner.id, session.provider, owner.status, owner.runner_id",
					)
						? execute(
								"UPDATE claude_runner_cursors SET retired_at = 0, stop_started_at = 0, stop_state = 'Gone', retirement_state = 'Complete' WHERE role = 'serving' AND retired_at IS NULL",
								[],
								undefined,
							).pipe(Effect.andThen(execute(query, params, transform)))
						: execute(query, params, transform),
				);
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => injected.mockRestore()),
			);
			const sending = yield* f.reactor.runOnce().pipe(Effect.forkChild);
			yield* TestClock.adjust("1 second");
			expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
			expect(
				yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
			).toEqual([{ status: "failed", error_code: "runner_start_lost" }]);
			expect(
				yield* f.sql`SELECT type FROM events WHERE type IN ('turn.error', 'turn.completed', 'turn.interrupted')`,
			).toEqual([{ type: "turn.error" }]);
			expect(spawned.spawn).toHaveBeenCalledTimes(1);
			expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
		}),
	),
);

it.effect(
	"F52 interruption during an unavailable hold writes no send outcome",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("shutdown", 1, 0);
				yield* f.recover;
				const fault = yield* failHoldWrites(f.sql);
				const sending = yield* f.reactor.runOnce().pipe(Effect.forkChild);
				yield* Deferred.await(fault.entered);
				yield* f.manager.executeEffect({ type: "shutdown" });
				yield* Fiber.interrupt(sending);
				fault.recover();
				yield* TestClock.adjust("10 seconds");
				expect(
					yield* f.sql`SELECT status, runner_id FROM provider_runs`,
				).toEqual([{ status: "pending", runner_id: null }]);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "running" }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.error', 'turn.completed', 'turn.interrupted')`,
				).toEqual([]);
				expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
			}),
		),
);

for (const refusalReason of [undefined, "exiting", "retiring"] as const)
	it.effect(
		`F64 the write owner retains a failed ${refusalReason ?? "NotSent"} release and transmits only n plus one`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.seed("release", 1, 0);
					yield* f.recover;
					let sends = 0;
					f.replaySend.execute = () =>
						++sends === 1
							? Effect.fail({
									operation: "send-turn",
									code: "not_sent",
									message: "no bytes",
									delivery: refusalReason
										? { _tag: "Refused", reason: refusalReason }
										: { _tag: "NotSent" },
								})
							: Effect.succeed(terminalResult());
					const connection = yield* Effect.scoped(f.sql.reserve);
					const execute = connection.execute;
					let releaseAttempts = 0;
					let unavailable = true;
					const injected = vi
						.spyOn(connection, "execute")
						.mockImplementation((query, params, transform) => {
							if (
								query.includes("INSERT INTO events") &&
								params.includes("run.released")
							) {
								releaseAttempts++;
								if (unavailable)
									return Effect.fail(
										new SqlError({
											reason: new ConnectionError({
												cause: "release unavailable",
											}),
										}),
									);
							}
							return execute(query, params, transform);
						});
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => injected.mockRestore()),
					);
					const sending = yield* f.reactor.runOnce().pipe(Effect.forkChild);
					yield* TestClock.adjust(0);
					expect(releaseAttempts).toBe(1);
					expect(
						yield* f.sql`SELECT held_transmission FROM provider_runs`,
					).toEqual([{ held_transmission: 1 }]);
					unavailable = false;
					yield* TestClock.adjust("1 second");
					// A refusal's stop commit carries the release (4.5): its retry
					// lands it, and the write fiber's own release then finds it stale.
					expect(releaseAttempts).toBe(refusalReason ? 3 : 2);
					if (refusalReason) yield* TestClock.adjust("4 seconds");
					expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
					expect(sends).toBe(2);
					expect(
						yield* f.sql`SELECT json_extract(data, '$.transmission') AS transmission FROM events WHERE type = 'run.dispatched'`,
					).toEqual([{ transmission: 1 }, { transmission: 2 }]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.error', 'turn.completed', 'turn.interrupted')`,
					).toEqual([{ type: "turn.completed" }]);
				}),
			),
	);

// Design A open item 1: only the reconciler's release returns the run's sends
// to the queue (Sends.released). A lifecycle release that bypasses it, the
// stored owner's unwritten failure or the refusal of a held send, settles the
// send in the same commit and requeues nothing, as on main.
for (const path of ["reconciler", "stored-owner", "refusal"] as const)
	it.effect(`only the reconciler's release requeues sends: ${path}`, () =>
		runRetirement(
			Effect.gen(function* () {
				const requeued: unknown[] = [];
				const make = runnerSends.makeRunnerSends;
				const spy = vi
					.spyOn(runnerSends, "makeRunnerSends")
					.mockImplementation((deps) => {
						const sends = make(deps);
						const released = sends.released;
						return Object.assign(sends, {
							released: (input: Parameters<typeof released>[0]) => {
								requeued.push(input);
								released(input);
							},
						});
					});
				yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
				const f = yield* s7Fixture("claude");
				// A running owner with no caller is fed to the stored owner on restart;
				// its undecodable payload fails before the first byte.
				yield* f.seed("release", 1, path === "stored-owner" ? 1 : 0, "unheld");
				if (path === "stored-owner")
					yield* f.sql`UPDATE provider_command_outbox SET payload_json = json_remove(payload_json, '$.inputId')`;
				yield* f.recover;
				let sends = 0;
				f.replaySend.execute = () =>
					++sends > 1
						? Effect.succeed(terminalResult())
						: Effect.fail(
								path === "refusal"
									? {
											operation: "send-turn",
											code: "send_admission_timeout",
											message: "admission timed out",
											retryable: false,
										}
									: {
											operation: "send-turn",
											code: "not_sent",
											message: "no bytes",
											delivery: { _tag: "NotSent" },
										},
							);
				if (path !== "stored-owner")
					yield* f.reactor.runOnce().pipe(Effect.forkChild);
				yield* TestClock.adjust("5 seconds");
				expect(
					yield* f.sql`SELECT DISTINCT json_extract(data, '$.reason') AS reason FROM events WHERE type = 'run.released'`,
				).toEqual([{ reason: "NotSent" }]);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([
					path === "reconciler"
						? { status: "completed", error_code: null }
						: {
								status: "failed",
								error_code:
									path === "refusal"
										? "send_admission_timeout"
										: "invalid_runner_turn",
							},
				]);
				expect(requeued).toHaveLength(path === "reconciler" ? 1 : 0);
			}),
		),
	);

it.effect(
	"F65 adoption releases a send with no caller and feeds it once as Adopted",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("absent", 1, 1, "held");
				yield* f.hello((hello) => ({
					...hello,
					drainsConnections: true,
					sendTokens: [],
					sendAnswers: [],
				}));
				yield* f.recover;
				yield* TestClock.adjust(0);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.transmission') AS transmission FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ transmission: 1 }, { transmission: 2 }]);
				expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
					1,
				);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "completed" }]);
			}),
		),
);

it.effect(
	"P3-E draft restoration uses the retained settlement observation time",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("draft-time", 1, 1, "held");
				yield* f.hello(
					journalHello(
						"draft-time",
						terminalResult("error", { code: "refused", message: "permanent" }),
					),
				);
				yield* TestClock.adjust(1730);
				const fault = yield* failSettlementWrite(f.sql);
				const recovering = yield* f.recover.pipe(Effect.forkChild);
				yield* Deferred.await(fault.entered);
				fault.recover();
				yield* TestClock.adjust("1 second");
				expect(recovering.pollUnsafe()).toMatchObject({ _tag: "Success" });
				expect(
					yield* f.sql`SELECT text, updated_at FROM input_drafts WHERE draft_key = 's'`,
				).toEqual([{ text: "text draft-time", updated_at: 1730 }]);
			}),
		),
);

it.effect(
	"P3-D Gone with corrupt payload settles terminal without payload duties",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("corrupt-gone", 1, 1, "held");
				yield* f.hello(
					journalHello("corrupt-gone", undefined, undefined, "running"),
				);
				yield* f.recover;
				yield* new RunnerSendJournal(
					runnerRegistry.runnerDirectory(f.root, f.root),
					"s",
					"claude",
				).execute(
					sendToken("hold", "corrupt-gone", 1),
					Effect.succeed(
						terminalResult("error", { code: "refused", message: "permanent" }),
					),
				);
				yield* f.sql`UPDATE provider_command_outbox SET payload_json = '{' WHERE command_id = 'corrupt-gone'`;
				f.processes.clear();
				yield* f.manager
					.executeEffect({ type: "end-session", sessionId: "s" })
					.pipe(Effect.forkChild);
				yield* TestClock.adjust("1 second");
				expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
					{ status: "error" },
				]);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "failed", error_code: "refused" }]);
				expect(
					yield* f.sql`SELECT input_id FROM messages WHERE role = 'user'`,
				).toEqual([]);
				expect(yield* f.sql`SELECT text FROM input_drafts`).toEqual([]);
			}),
		),
);

it.effect(
	"payload resume mode replaces a stale live capability and sends once",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.recover;
				const turn = yield* f.seed("payload-mode", 1, 1, "unheld");
				yield* f.sql`UPDATE provider_command_outbox SET payload_json = json_set(payload_json, '$.nativeResumeFallback', json('true')) WHERE command_id = 'payload-mode'`;
				const modes: boolean[] = [];
				f.replaySend.execute = (_id, command) =>
					Effect.sync(() => {
						modes.push(command.input.nativeResumeFallback === true);
						return terminalResult();
					});
				const sending = yield* f.instance
					.sendTurnEffect({ ...turn, nativeResumeFallback: false })
					.pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
				expect(modes).toEqual([true]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.transmission') AS transmission FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ transmission: 1 }]);
			}),
		),
);

for (const outcome of ["terminal", "covered"] as const)
	it.effect(
		`F72 readiness wait ignores unrelated commits and yields when its head is ${outcome}`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					const head = yield* f.seed("ready-head", 1, 1, "unheld");
					const next = yield* f.seed("ready-next", 2, 1, "unheld");
					const connect = vi.mocked(f.driver.connect).getMockImplementation();
					if (!connect) return yield* Effect.die("missing fixture connection");
					const waiting = yield* Deferred.make<void>();
					const ready = yield* Deferred.make<void>();
					let starts = 0;
					vi.mocked(f.driver.connect).mockImplementation((options) =>
						++starts === 1
							? Deferred.succeed(waiting, undefined).pipe(
									Effect.andThen(Deferred.await(ready)),
									Effect.andThen(connect(options)),
								)
							: connect(options),
					);
					yield* f.instance.sendTurnEffect(head).pipe(Effect.forkChild);
					yield* Deferred.await(waiting);
					yield* f.instance.sendTurnEffect(next).pipe(Effect.forkChild);
					yield* f.commit.write(() => Effect.void);
					yield* TestClock.adjust(0);
					expect(starts).toBe(1);
					expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
					if (outcome === "terminal")
						yield* f.commit([
							canonicalEvent(
								"turn.error",
								"s",
								{
									messageId: "ready-head",
									error: "ended while starting",
									code: "refused",
								},
								{ provider: "claude", metadata: { runId: "run:ready-head" } },
							),
						]);
					else
						yield* f.commit.write(() =>
							f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at) VALUES (3, 'cover-ready', 'test-project', 's', 'account', 'interrupt_turn', ${JSON.stringify({ type: "interrupt_turn", sessionId: "s", stop: { owners: [{ runId: "run:ready-head" }], turnIds: ["ready-head"], deadlineAt: 3000, runnerBacked: true, retainedSteers: false } })}, 'completed', 1, 1)`.pipe(
								Effect.asVoid,
							),
						);
					yield* TestClock.adjust(0);
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run:ready-head'`,
					).toEqual([
						{ status: outcome === "terminal" ? "error" : "interrupted" },
					]);
					expect(
						yield* f.sql`SELECT json_extract(data, '$.commandId') AS commandId FROM events WHERE type = 'run.dispatched'`,
					).toEqual([{ commandId: "ready-next" }]);
					expect(starts).toBe(1);
					expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
					yield* Deferred.succeed(ready, undefined);
					yield* TestClock.adjust(0);
					expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
						1,
					);
				}),
			),
	);

it.effect(
	"F73 release wakes native-resume preparation before run end and fresh sends n plus one once",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.recover;
				const turn = yield* f.seed("resume", 1, 1, "unheld");
				const modes: boolean[] = [];
				f.replaySend.execute = (_id, command) =>
					Effect.sync(() => {
						modes.push(command.input.nativeResumeFallback === true);
						return command.input.nativeResumeFallback === true
							? terminalResult()
							: {
									...terminalResult("error", {
										code: "claude_resume_refused",
										message: "Resume rejected",
									}),
									nativeResumeRejected: true,
								};
					});
				const primary = yield* f.instance
					.sendTurnEffect(turn)
					.pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				expect(primary.pollUnsafe()).toMatchObject({
					_tag: "Success",
					value: { nativeResumeRejected: true },
				});
				expect(
					yield* f.sql`SELECT status, runner_id FROM provider_runs`,
				).toEqual([{ status: "pending", runner_id: null }]);
				expect(modes).toEqual([false]);
				yield* f.sql`UPDATE provider_command_outbox SET payload_json = json_set(payload_json, '$.nativeResumeFallback', json('true')) WHERE command_id = 'resume'`;
				const fresh = yield* f.instance
					.sendTurnEffect({ ...turn, nativeResumeFallback: true })
					.pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				expect(fresh.pollUnsafe()).toMatchObject({
					_tag: "Success",
					value: { status: "completed" },
				});
				expect(modes).toEqual([false, true]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.transmission') AS transmission FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ transmission: 1 }, { transmission: 2 }]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.reason') AS reason FROM events WHERE type = 'run.released'`,
				).toEqual([{ reason: "ResumeRejected" }]);
			}),
		),
);

it.effect(
	"F52 restart scan feeds an unheld running owner without a caller",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("restart-unheld", 1, 1, "unheld");
				f.replaySend.execute = () => Effect.succeed(terminalResult());
				yield* f.recover;
				yield* TestClock.adjust("1 second");
				expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
					1,
				);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "completed" }]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.transmission') AS transmission FROM events WHERE type = 'run.dispatched'`,
				).toEqual([{ transmission: 1 }]);
			}),
		),
);

// From 32.5 restart recovery re-holds a joined steer's unsent transmission through the feeder
// under the steer's own run id, keeping its claim (CONTRACT 1862-1869, 2021-2025).
// How it could fail: recovery reads the steer under its owner's run id, so the hold ends it
// unsent or skips it as held; it is marked for a fresh reactor re-send with a new attempt; its
// held transmission is never released, so it stays stuck; or its owner's Run is ended.
for (const transmission of ["unheld", "held"] as const)
	it.effect(
		`restart re-holds a joined steer's ${transmission} unsent transmission under its own run id`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.seed("head", 1, 1, "held");
					yield* f.seed("steer", 2, 1, transmission);
					yield* f.sql`UPDATE provider_runs SET joined_into = 'run:head', status = 'joined' WHERE id = 'run:steer'`;
					// The runner reports the owner's send running and never received the steer's.
					yield* f.hello((hello) => ({
						...journalHello("head", undefined, undefined, "running")(hello),
						drainsConnections: true,
					}));
					const sent: string[] = [];
					f.replaySend.execute = (_id, command) =>
						Effect.sync(() => {
							sent.push(command.input.inputId);
							return terminalResult("joined");
						});
					yield* f.recover;
					yield* TestClock.adjust("1 second");
					expect(sent).toEqual(["steer"]);
					expect(
						yield* f.sql`SELECT type, json_extract(data, '$.commandId') AS commandId,
							json_extract(data, '$.transmission') AS transmission, json_extract(data, '$.reason') AS reason FROM events
							WHERE type IN ('run.dispatched', 'run.released') AND json_extract(data, '$.runId') = 'run:steer' ORDER BY sequence`,
					).toEqual(
						transmission === "unheld"
							? [
									{
										type: "run.dispatched",
										commandId: "steer",
										transmission: 1,
										reason: null,
									},
								]
							: [
									{
										type: "run.dispatched",
										commandId: "steer",
										transmission: 1,
										reason: null,
									},
									{
										type: "run.released",
										commandId: "steer",
										transmission: 1,
										reason: "NotSent",
									},
									{
										type: "run.dispatched",
										commandId: "steer",
										transmission: 2,
										reason: null,
									},
								],
					);
					expect(
						yield* f.sql`SELECT command_id, status, attempt_count FROM provider_command_outbox ORDER BY request_sequence`,
					).toEqual([
						{ command_id: "head", status: "running", attempt_count: 1 },
						{ command_id: "steer", status: "running", attempt_count: 1 },
					]);
					expect(
						yield* f.sql`SELECT id, status FROM provider_runs WHERE id IN ('run:head', 'run:steer') ORDER BY id`,
					).toEqual([
						{ id: "run:head", status: "pending" },
						{ id: "run:steer", status: "joined" },
					]);
				}),
			),
	);

// A joined steer's own row reads `joined`, but its hold stays while its owner's Run is open,
// so adoption settles its finished journal answer like any held send (CONTRACT 2021-2025, 4.9, 7.2).
// How it could fail: recovery reads only pending or running rows, so the answer is skipped and the
// steer stays held on the adopted runner forever; or the steer's outcome ends its owner's Run.
for (const retryable of [true, false])
	it.effect(
		`adoption settles a joined steer's finished ${retryable ? "retryable" : "permanent"} failure and leaves its owner's Run open`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.seed("head", 1, 1, "held");
					yield* f.seed("steer", 2, 1, "held");
					yield* f.sql`UPDATE provider_runs SET joined_into = 'run:head', status = 'joined' WHERE id = 'run:steer'`;
					yield* f.hello((hello) => ({
						...journalHello("head", undefined, undefined, "running")(hello),
						sendAnswers: [
							{ token: sendToken("hold", "head", 1), status: "running" },
							{
								token: sendToken("hold", "steer", 1),
								status: "finished",
								failure: {
									operation: "send-turn",
									code: "temporary",
									message: "steer failed",
									retryable,
								},
							},
						],
					}));
					const sent: string[] = [];
					f.replaySend.execute = (_id, command) =>
						Effect.sync(() => {
							sent.push(command.input.inputId);
							return terminalResult("joined");
						});
					yield* f.recover;
					yield* TestClock.adjust("2 seconds");
					// The retryable steer is its own Run's next transmission; the permanent one fails.
					expect(
						yield* f.sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'steer'`,
					).toEqual([
						retryable
							? { status: "running", error_code: null }
							: { status: "failed", error_code: "temporary" },
					]);
					expect(sent).toEqual(retryable ? ["steer"] : []);
					expect(
						yield* f.sql`SELECT json_extract(data, '$.transmission') AS n FROM events
							WHERE type = 'run.dispatched' AND json_extract(data, '$.runId') = 'run:steer' ORDER BY sequence`,
					).toEqual(retryable ? [{ n: 1 }, { n: 2 }] : [{ n: 1 }]);
					expect(
						yield* f.sql`SELECT id, status FROM provider_runs WHERE id IN ('run:head', 'run:steer') ORDER BY id`,
					).toEqual([
						{ id: "run:head", status: "pending" },
						{ id: "run:steer", status: "joined" },
					]);
				}),
			),
	);

for (const refusal of [false, true])
	it.effect(
		`F73 restart after release prepares fresh mode once and ${refusal ? "fails a fresh refusal visibly" : "completes"}`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.seed("restart-resume", 1, 1, "held");
					yield* f.commit([
						canonicalEvent("run.released", "s", {
							runId: "run:restart-resume",
							runnerId: "131313131313",
							commandId: "restart-resume",
							transmission: 1,
							reason: "ResumeRejected",
						}),
					]);
					const modes: boolean[] = [];
					f.replaySend.execute = (_id, command) =>
						Effect.sync(() => {
							modes.push(command.input.nativeResumeFallback === true);
							return refusal
								? terminalResult("error", {
										code: "fresh_refused",
										message: "fresh start refused",
									})
								: terminalResult();
						});
					yield* f.recover;
					yield* TestClock.adjust("1 second");
					expect(modes).toEqual([true]);
					expect(
						yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
					).toEqual([
						{
							status: refusal ? "failed" : "completed",
							error_code: refusal ? "fresh_refused" : null,
						},
					]);
					expect(
						yield* f.sql`SELECT json_extract(data, '$.transmission') AS transmission FROM events WHERE type = 'run.dispatched'`,
					).toEqual([{ transmission: 1 }, { transmission: 2 }]);
					if (refusal)
						expect(
							yield* f.sql`SELECT text FROM input_drafts WHERE draft_key = 's'`,
						).toEqual([{ text: "text restart-resume" }]);
				}),
			),
	);

it.effect(
	"F67 a lost serving registration stops its candidate and holds once on the winner",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.recover;
				yield* f.seed("slot-race", 1, 0);
				yield* f.sql`DELETE FROM claude_runner_cursors WHERE runner_id = '131313131313'`;
				const connection = yield* Effect.scoped(f.sql.reserve);
				const execute = connection.execute;
				let raced = false;
				const injected = vi
					.spyOn(connection, "execute")
					.mockImplementation((query, params, transform) =>
						Effect.gen(function* () {
							if (
								!raced &&
								query.includes("SELECT 1 FROM claude_runner_cursors") &&
								query.includes("retired_at IS NULL LIMIT 1")
							) {
								raced = true;
								yield* execute(
									"INSERT INTO claude_runner_cursors (runner_id, sequence, session_id, driver_kind, pid, start_time, role) VALUES (?, 0, 's', 'claude', 100088, 'original', 'serving')",
									["131313131313"],
									undefined,
								);
							}
							return yield* execute(query, params, transform);
						}),
					);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => injected.mockRestore()),
				);
				const sending = yield* f.reactor.runOnce().pipe(Effect.forkChild);
				yield* TestClock.adjust("1 second");
				expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
				expect(
					yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE role = 'serving' AND retired_at IS NULL`,
				).toEqual([{ runner_id: "131313131313" }]);
				expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([
					{ runnerId: "131313131313", type: "send-turn" },
				]);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "completed" }]);
				expect(
					yield* f.sql`SELECT json_extract(stop_reason, '$._tag') AS reason FROM claude_runner_cursors WHERE runner_id != '131313131313'`,
				).toEqual([{ reason: "CandidateAbandoned" }]);
			}),
		),
);

it.effect(
	"F71 a permanent live reply retains its evidence across rollback without another transmission",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("live-refused", 1, 0);
				yield* f.recover;
				f.replaySend.execute = () =>
					Effect.succeed(
						terminalResult("error", {
							code: "live_refused",
							message: "permanent refusal",
						}),
					);
				const fault = yield* failSettlementWrite(f.sql);
				const sending = yield* f.reactor.runOnce().pipe(Effect.forkChild);
				yield* Deferred.await(fault.entered);
				expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
					{ status: "pending" },
				]);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "running" }]);
				fault.recover();
				yield* TestClock.adjust("1 second");
				expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "failed", error_code: "live_refused" }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.error', 'turn.completed', 'turn.interrupted')`,
				).toEqual([{ type: "turn.error" }]);
				expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
					1,
				);
				expect(spawned.spawn).not.toHaveBeenCalled();
			}),
		),
);

for (const outcome of ["terminal", "covered"] as const)
	it.effect(
		`F72 Cleaning wait survives unrelated commits and releases a ${outcome} head`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.recover;
					yield* f.sql`UPDATE claude_runner_cursors SET role = 'candidate' WHERE runner_id = '131313131313'`;
					const head = yield* f.seed("clean-head", 1, 1, "unheld");
					const next = yield* f.seed("clean-next", 2, 1, "unheld");
					const connection = yield* Effect.scoped(f.sql.reserve);
					const execute = connection.execute;
					const gates: string[] = [];
					let stops = 0;
					const injected = vi
						.spyOn(connection, "execute")
						.mockImplementation((query, params, transform) => {
							if (
								query.includes(
									"SELECT owner.id, session.provider, owner.status, owner.runner_id",
								)
							) {
								if (params.includes("run:clean-head")) gates.push("head");
								if (params.includes("run:clean-next")) gates.push("next");
							}
							if (
								query.includes("UPDATE claude_runner_cursors SET") &&
								query.includes("retired_at")
							) {
								stops++;
								return Effect.fail(
									new SqlError({
										reason: new ConnectionError({
											cause: "Cleaning commit unavailable",
										}),
									}),
								);
							}
							return execute(query, params, transform);
						});
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => injected.mockRestore()),
					);
					yield* f.instance.sendTurnEffect(head).pipe(Effect.forkChild);
					yield* f.instance.sendTurnEffect(next).pipe(Effect.forkChild);
					yield* TestClock.adjust(0);
					expect(stops).toBe(1);
					expect(spawned.spawn).not.toHaveBeenCalled();
					expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
					const gateCount = gates.length;
					expect(gates).not.toContain("next");
					yield* f.commit.write(() => Effect.void);
					yield* TestClock.adjust(0);
					expect(gates).toHaveLength(gateCount);
					if (outcome === "terminal")
						yield* f.commit([
							canonicalEvent(
								"turn.interrupted",
								"s",
								{ messageId: "clean-head" },
								{ provider: "claude", metadata: { runId: "run:clean-head" } },
							),
						]);
					else
						yield* f.commit.write(() =>
							f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at) VALUES (3, 'cover-clean', 'test-project', 's', 'account', 'interrupt_turn', ${JSON.stringify({ type: "interrupt_turn", sessionId: "s", stop: { owners: [{ runId: "run:clean-head" }], turnIds: ["clean-head"], deadlineAt: 3000, runnerBacked: true, retainedSteers: false } })}, 'completed', 1, 1)`.pipe(
								Effect.asVoid,
							),
						);
					yield* TestClock.adjust(0);
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run:clean-head'`,
					).toEqual([{ status: "interrupted" }]);
					expect(gates).toContain("next");
					expect(spawned.spawn).not.toHaveBeenCalled();
				}),
			),
	);

for (const pickup of ["live caller", "restart scan"] as const)
	it.effect(
		`F75 an unavailable Cleaning cleanup waits on the reconciler's commit and leaves when the send ends (${pickup})`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					if (pickup === "live caller") {
						yield* f.recover;
						yield* f.sql`UPDATE claude_runner_cursors SET role = 'candidate' WHERE runner_id = '131313131313'`;
					}
					const head = yield* f.seed("clean-fault", 1, 1, "unheld");
					const connection = yield* Effect.scoped(f.sql.reserve);
					const execute = connection.execute;
					let gates = 0;
					let stops = 0;
					const injected = vi
						.spyOn(connection, "execute")
						.mockImplementation((query, params, transform) => {
							// Recovery stops every existing candidate before its scan, so
							// a restart meets Cleaning only from a candidate registered
							// after that (an upgrade); register it as the scan reads the run.
							if (
								query.includes(
									"SELECT run.id FROM provider_command_outbox command",
								) &&
								query.includes("run.runner_id IS NULL")
							)
								return execute(
									"UPDATE claude_runner_cursors SET role = 'candidate' WHERE runner_id = '131313131313'",
									[],
									undefined,
								).pipe(Effect.andThen(execute(query, params, transform)));
							if (
								query.includes(
									"SELECT owner.id, session.provider, owner.status, owner.runner_id",
								) &&
								params.includes("run:clean-fault")
							)
								gates++;
							if (
								query.includes(
									"SELECT retired_at, role, session_id FROM claude_runner_cursors",
								)
							) {
								stops++;
								return Effect.fail(
									new SqlError({
										reason: new ConnectionError({
											cause: "Cleaning commit unavailable",
										}),
									}),
								);
							}
							return execute(query, params, transform);
						});
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => injected.mockRestore()),
					);
					const sending =
						pickup === "live caller"
							? yield* f.instance.sendTurnEffect(head).pipe(Effect.forkChild)
							: undefined;
					if (pickup === "restart scan") yield* f.recover;
					yield* TestClock.adjust(0);
					expect(stops).toBe(1);
					const gateCount = gates;
					expect(sending?.pollUnsafe()).toBeUndefined();
					expect(
						yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
					).toEqual([{ status: "running", error_code: null }]);
					// The reconciler re-runs the commit; the send does not re-gate, and
					// no runner serves the session until the cleanup commits.
					yield* TestClock.adjust("1 second");
					expect(gates).toBe(gateCount);
					expect(stops).toBe(2);
					expect(sending?.pollUnsafe()).toBeUndefined();
					expect(spawned.spawn).not.toHaveBeenCalled();
					yield* f.commit([
						canonicalEvent(
							"turn.interrupted",
							"s",
							{ messageId: "clean-fault" },
							{ provider: "claude", metadata: { runId: "run:clean-fault" } },
						),
					]);
					yield* TestClock.adjust(0);
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run:clean-fault'`,
					).toEqual([{ status: "interrupted" }]);
					if (sending)
						expect((yield* Fiber.join(sending)).status).toBe("cancelled");
					expect(spawned.spawn).not.toHaveBeenCalled();
					expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
				}),
			),
	);

// The predecessor park (S1 step 4). Gate reads are counted at the gate's own
// SQL, so a re-step or a poll shows up as an extra read.
const countGates = (sql: SqlClient.SqlClient, runIds: readonly string[]) =>
	Effect.gen(function* () {
		const connection = yield* Effect.scoped(sql.reserve);
		const execute = connection.execute;
		const gates: string[] = [];
		const injected = vi
			.spyOn(connection, "execute")
			.mockImplementation((query, params, transform) => {
				if (
					query.includes(
						"SELECT owner.id, session.provider, owner.status, owner.runner_id",
					)
				)
					for (const runId of runIds)
						if (params.includes(runId)) gates.push(runId);
				return execute(query, params, transform);
			});
		yield* Effect.addFinalizer(() => Effect.sync(() => injected.mockRestore()));
		return gates;
	});

for (const outcome of ["delivered", "terminal", "covered"] as const)
	it.effect(
		outcome === "delivered"
			? "F60 a send behind a TERM-surviving predecessor parks through TERM, KILL and Escalated, then starts and delivers once"
			: `F60 a ${outcome} head is stepped at once during the predecessor park and starts nothing`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.recover;
					const clock = yield* Clock.Clock;
					const signals: Array<{
						readonly signal: string;
						readonly at: number;
					}> = [];
					// The predecessor ignores TERM; KILL is recorded but the process
					// is reaped only after the Stop window, so Escalated ends the park.
					vi.spyOn(f.processTable, "signal").mockImplementation(
						(_pid, signal) => {
							signals.push({ signal, at: clock.currentTimeMillisUnsafe() });
						},
					);
					const gates = yield* countGates(f.sql, ["run:park-head"]);
					yield* f.manager
						.executeEffect({ type: "end-session", sessionId: "s" })
						.pipe(Effect.forkChild);
					const head = yield* f.seed("park-head", 1, 1, "unheld");
					const sending = yield* f.instance
						.sendTurnEffect(head)
						.pipe(Effect.forkChild);
					yield* TestClock.adjust(0);
					// The park is observable: the reconciler's Stop is in progress.
					expect(
						yield* f.sql`SELECT stop_state, stop_started_at, retired_at FROM claude_runner_cursors WHERE runner_id = '131313131313'`,
					).toEqual([
						{ stop_state: "Escalating", stop_started_at: 0, retired_at: 0 },
					]);
					expect(signals).toEqual([{ signal: "SIGTERM", at: 0 }]);
					expect(gates).toEqual(["run:park-head"]);
					yield* TestClock.adjust("1 second");
					expect(gates).toEqual(["run:park-head"]);
					if (outcome !== "delivered") {
						if (outcome === "terminal")
							yield* f.commit([
								canonicalEvent(
									"turn.interrupted",
									"s",
									{ messageId: "park-head" },
									{
										provider: "claude",
										metadata: { runId: "run:park-head" },
									},
								),
							]);
						else
							yield* f.commit.write(() =>
								f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at) VALUES (3, 'cover-park', 'test-project', 's', 'account', 'interrupt_turn', ${JSON.stringify({ type: "interrupt_turn", sessionId: "s", stop: { owners: [{ runId: "run:park-head" }], turnIds: ["park-head"], deadlineAt: 3000, runnerBacked: true, retainedSteers: false } })}, 'completed', 1, 1)`.pipe(
									Effect.asVoid,
								),
							);
						yield* TestClock.adjust(0);
						// Stepped at once, at 1 s, not when the park would end at 4 s.
						expect(gates).toEqual(["run:park-head", "run:park-head"]);
						expect(
							yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run:park-head'`,
						).toEqual([{ status: "interrupted" }]);
						expect((yield* Fiber.join(sending)).status).toBe("cancelled");
						yield* TestClock.adjust("10 seconds");
						expect(gates).toHaveLength(2);
						expect(spawned.spawn).not.toHaveBeenCalled();
						expect(f.commands.filter((c) => c.type === "send-turn")).toEqual(
							[],
						);
						return;
					}
					yield* TestClock.adjust("2 seconds");
					expect(signals).toEqual([
						{ signal: "SIGTERM", at: 0 },
						{ signal: "SIGKILL", at: 3000 },
					]);
					expect(gates).toEqual(["run:park-head"]);
					yield* TestClock.adjust("999 millis");
					expect(spawned.spawn).not.toHaveBeenCalled();
					expect(gates).toEqual(["run:park-head"]);
					yield* TestClock.adjust("1 milli");
					expect(
						yield* f.sql`SELECT stop_state FROM claude_runner_cursors WHERE runner_id = '131313131313'`,
					).toEqual([{ stop_state: "Escalated" }]);
					expect(spawned.spawn).toHaveBeenCalledTimes(1);
					expect((yield* Fiber.join(sending)).status).toBe("completed");
					const replacement = f.attachments.at(-1)?.runnerId;
					expect(replacement).not.toBe("131313131313");
					expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([
						{ runnerId: replacement, type: "send-turn" },
					]);
					expect(
						yield* f.sql`SELECT json_extract(data, '$.commandId') AS commandId, json_extract(data, '$.runnerId') AS runnerId, json_extract(data, '$.transmission') AS transmission FROM events WHERE type = 'run.dispatched'`,
					).toEqual([
						{ commandId: "park-head", runnerId: replacement, transmission: 1 },
					]);
				}),
			),
	);

it.effect(
	"F61 two sends queued behind one stopping predecessor park once and are delivered in order",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.recover;
				const gates = yield* countGates(f.sql, [
					"run:queued-a",
					"run:queued-b",
				]);
				yield* f.manager
					.executeEffect({ type: "end-session", sessionId: "s" })
					.pipe(Effect.forkChild);
				const first = yield* f.seed("queued-a", 1, 1, "unheld");
				const second = yield* f.seed("queued-b", 2, 1, "unheld");
				const sendingFirst = yield* f.instance
					.sendTurnEffect(first)
					.pipe(Effect.forkChild);
				const sendingSecond = yield* f.instance
					.sendTurnEffect(second)
					.pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				expect(
					yield* f.sql`SELECT stop_state FROM claude_runner_cursors WHERE runner_id = '131313131313'`,
				).toEqual([{ stop_state: "Escalating" }]);
				// One park: only the head reads the gate while the predecessor stops.
				expect(gates).toEqual(["run:queued-a"]);
				yield* TestClock.adjust("3999 millis");
				expect(gates).toEqual(["run:queued-a"]);
				expect(spawned.spawn).not.toHaveBeenCalled();
				yield* TestClock.adjust("1 milli");
				expect((yield* Fiber.join(sendingFirst)).status).toBe("completed");
				expect((yield* Fiber.join(sendingSecond)).status).toBe("completed");
				expect(spawned.spawn).toHaveBeenCalledTimes(1);
				const replacement = f.attachments.at(-1)?.runnerId;
				expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([
					{ runnerId: replacement, type: "send-turn" },
					{ runnerId: replacement, type: "send-turn" },
				]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.commandId') AS commandId, json_extract(data, '$.transmission') AS transmission FROM events WHERE type = 'run.dispatched' ORDER BY sequence`,
				).toEqual([
					{ commandId: "queued-a", transmission: 1 },
					{ commandId: "queued-b", transmission: 1 },
				]);
			}),
		),
);

for (const predecessor of ["unloaded", "legacy"] as const)
	it.effect(
		`F66 ${predecessor === "unloaded" ? "a predecessor recover has not loaded" : "a loaded legacy retirement row"} parks the send only until its window end, with no poll, then starts`,
		() => {
			// A poll is a jittered retry schedule; every jitter draws here.
			let draws = 0;
			return runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					if (predecessor === "unloaded")
						// No recover: the reconciler has no state for this row.
						yield* f.sql`INSERT INTO claude_runner_cursors (runner_id, sequence, session_id, driver_kind, retired_at, pid, start_time, stop_state, stop_reason, stop_started_at) VALUES ('666666666666', 0, 's', 'claude', 0, 100_099, 'unloaded', 'Escalating', 'EndSession', 1000)`;
					else {
						yield* f.recover;
						// A row retired before Stop states existed; recover maps it to
						// Escalated, while the gate still names it until its window ends.
						yield* f.sql`UPDATE claude_runner_cursors SET retired_at = 1000 WHERE runner_id = '131313131313'`;
						yield* f.recover;
					}
					const until = 5000;
					const gates = yield* countGates(f.sql, ["run:window-head"]);
					yield* TestClock.adjust("1 second");
					const head = yield* f.seed("window-head", 1, 1, "unheld");
					const before = draws;
					const sending = yield* f.instance
						.sendTurnEffect(head)
						.pipe(Effect.forkChild);
					yield* TestClock.adjust(0);
					expect(gates).toEqual(["run:window-head"]);
					yield* TestClock.adjust(`${until - 1000 - 1} millis`);
					expect(gates).toEqual(["run:window-head"]);
					expect(draws - before).toBe(0);
					expect(spawned.spawn).not.toHaveBeenCalled();
					yield* TestClock.adjust("1 milli");
					expect(spawned.spawn).toHaveBeenCalledTimes(1);
					expect((yield* Fiber.join(sending)).status).toBe("completed");
					expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([
						{ runnerId: f.attachments.at(-1)?.runnerId, type: "send-turn" },
					]);
				}).pipe(
					Effect.provideService(Random.Random, {
						nextIntUnsafe: () => 0,
						nextDoubleUnsafe: () => {
							draws += 1;
							return 0.5;
						},
					}),
				),
			);
		},
	);

it.effect(
	"F60 a predecessor whose Stop commit is in flight at park start and then rejected parks the send until its window end, then starts",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.recover;
				// The row is retired by a commit this reconciler has not loaded, so
				// the gate names it while the end-session Stop is still Committing.
				yield* f.sql`UPDATE claude_runner_cursors SET retired_at = 0, stop_state = 'Escalating', stop_reason = 'EndSession', stop_started_at = 0 WHERE runner_id = '131313131313'`;
				const connection = yield* Effect.scoped(f.sql.reserve);
				const execute = connection.execute;
				const gates: string[] = [];
				let commits = 0;
				// The first commit hits an unavailable store and stays Committing
				// through its backoff; every later commit is rejected by a defect.
				const injected = vi
					.spyOn(connection, "execute")
					.mockImplementation((query, params, transform) => {
						if (
							query.includes(
								"SELECT owner.id, session.provider, owner.status, owner.runner_id",
							) &&
							params.includes("run:rejected-head")
						)
							gates.push("run:rejected-head");
						if (
							!query.includes(
								"SELECT retired_at, role, session_id FROM claude_runner_cursors",
							) ||
							!params.includes("131313131313")
						)
							return execute(query, params, transform);
						commits++;
						return commits === 1
							? Effect.fail(
									new SqlError({
										reason: new ConnectionError({
											cause: "Stop commit unavailable",
										}),
									}),
								)
							: Effect.die("Stop commit rejected");
					});
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => injected.mockRestore()),
				);
				yield* f.manager
					.executeEffect({ type: "end-session", sessionId: "s" })
					.pipe(Effect.forkChild);
				const head = yield* f.seed("rejected-head", 1, 1, "unheld");
				const sending = yield* f.instance
					.sendTurnEffect(head)
					.pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				expect(commits).toBe(1);
				expect(gates).toEqual(["run:rejected-head"]);
				// The rejection at the 1 s backoff fails only the Stop's waiters.
				yield* TestClock.adjust("1 second");
				expect(commits).toBe(2);
				expect(sending.pollUnsafe()).toBeUndefined();
				expect(gates).toEqual(["run:rejected-head"]);
				yield* TestClock.adjust("2999 millis");
				expect(spawned.spawn).not.toHaveBeenCalled();
				expect(gates).toEqual(["run:rejected-head"]);
				yield* TestClock.adjust("1 milli");
				expect(spawned.spawn).toHaveBeenCalledTimes(1);
				expect((yield* Fiber.join(sending)).status).toBe("completed");
				const replacement = f.attachments.at(-1)?.runnerId;
				expect(replacement).not.toBe("131313131313");
				expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([
					{ runnerId: replacement, type: "send-turn" },
				]);
			}),
		),
);

it.effect(
	"S4 an unavailable Cleaning cleanup after a lost registration starts afresh instead of StartLost",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("lost-clean", 1, 0);
				f.replaySend.execute = () =>
					Effect.succeed(
						terminalResult("error", { code: "final", message: "final reply" }),
					);
				const connection = yield* Effect.scoped(f.sql.reserve);
				const execute = connection.execute;
				let foreignStops = 0;
				const injected = vi
					.spyOn(connection, "execute")
					.mockImplementation((query, params, transform) => {
						// A foreign candidate appears as the start registers, so the S4
						// recheck returns Lost, start returns Started and the next gate
						// reads Cleaning for the foreign runner.
						if (
							query.includes("AND retired_at IS NULL LIMIT 1") &&
							foreignStops === 0
						)
							return execute(
								"INSERT OR IGNORE INTO claude_runner_cursors (runner_id, sequence, session_id, driver_kind, role) VALUES ('f0f0f0f0f0f0', 0, 's', 'claude', 'candidate')",
								[],
								undefined,
							).pipe(Effect.andThen(execute(query, params, transform)));
						// The store is unavailable for the first Cleaning commit only; the
						// reconciler's retry after one backoff reads the fence again.
						if (
							query.includes(
								"SELECT retired_at, role, session_id FROM claude_runner_cursors",
							) &&
							params.includes("f0f0f0f0f0f0") &&
							foreignStops === 0
						) {
							foreignStops++;
							return Effect.fail(
								new SqlError({
									reason: new ConnectionError({
										cause: "Cleaning commit unavailable",
									}),
								}),
							);
						}
						return execute(query, params, transform);
					});
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => injected.mockRestore()),
				);
				const sending = yield* f.reactor.runOnce().pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				expect(foreignStops).toBe(1);
				expect(spawned.spawn).toHaveBeenCalledTimes(1);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "running", error_code: null }]);
				// During the backoff its owner retires the foreign candidate and the
				// lost runner's stop completes, so the next gate reads Unserved{None}.
				yield* f.sql`UPDATE claude_runner_cursors SET retired_at = COALESCE(retired_at, 0), stop_started_at = COALESCE(stop_started_at, 0), stop_state = 'Gone', retirement_state = 'Complete' WHERE session_id = 's'`;
				yield* TestClock.adjust("1 second");
				yield* TestClock.adjust("4 seconds");
				expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "failed", error_code: "final" }]);
				expect(spawned.spawn).toHaveBeenCalledTimes(2);
				expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
					1,
				);
			}),
		),
);

for (const delayed of ["held result", "first write"] as const)
	it.effect(
		`F80 a release during delayed ${delayed} revokes n without closing n plus one`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.recover;
					const turn = yield* f.seed("write-race", 1, 1, "unheld");
					const paused = yield* Deferred.make<void>();
					const proceed = yield* Deferred.make<void>();
					const gate = join(
						f.root,
						"conduit-test-send-continuation-after-hold",
					);
					const proof = join(f.root, "proof.jsonl");
					if (delayed === "held result") {
						let block = true;
						Object.assign(f.recovery, {
							wakeReactor: Effect.gen(function* () {
								const [run] = yield* f.sql<{
									held_transmission: number | null;
								}>`SELECT held_transmission FROM provider_runs WHERE id = 'run:write-race'`;
								if (block && run?.held_transmission === 1) {
									block = false;
									yield* Deferred.succeed(paused, undefined);
									yield* Deferred.await(proceed);
								}
							}).pipe(Effect.orDie),
						});
					} else {
						vi.stubEnv("CONDUIT_TEST_SEND_CONTINUATION_PAUSE", "after-hold");
						vi.stubEnv("CONDUIT_TEST_PROCESS_PROOF", proof);
						writeFileSync(gate, "pause");
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => vi.unstubAllEnvs()),
						);
					}
					const sends: number[] = [];
					f.replaySend.execute = () =>
						Effect.sync(() => {
							sends.push(1);
							return terminalResult();
						});
					const sending = yield* f.instance
						.sendTurnEffect(turn)
						.pipe(Effect.forkChild);
					if (delayed === "held result") yield* Deferred.await(paused);
					else {
						yield* TestClock.adjust(0);
						expect(existsSync(proof)).toBe(true);
						expect(readFileSync(proof, "utf8")).toContain('"transmission":1');
					}
					expect(sends).toEqual([]);
					const attachment = f.attachments[0];
					const connection = f.connections[0];
					const hello = f.hellos[0];
					if (!attachment || !connection || !hello)
						return yield* Effect.die("missing recovered runner");
					yield* attachment.onHello(
						{ ...hello, drainsConnections: true, sendAnswers: [] },
						connection,
					);
					expect(
						yield* f.sql`SELECT json_extract(data, '$.transmission') AS transmission FROM events WHERE type = 'run.released'`,
					).toEqual([{ transmission: 1 }]);
					if (delayed === "held result")
						yield* Deferred.succeed(proceed, undefined);
					else rmSync(gate);
					yield* TestClock.adjust("10 millis");
					expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
					expect(sends).toEqual([1]);
					expect(
						yield* f.sql`SELECT held_transmission FROM provider_runs`,
					).toEqual([{ held_transmission: 2 }]);
					expect(
						yield* f.sql`SELECT json_extract(data, '$.transmission') AS transmission FROM events WHERE type = 'run.dispatched'`,
					).toEqual([{ transmission: 1 }, { transmission: 2 }]);
				}),
			),
	);

const journalHello =
	(
		commandId: string,
		result?: TurnResult,
		failure?: SessionFailure,
		state: "running" | "finished" = "finished",
	) =>
	(hello: RunnerHello): RunnerHello => ({
		...hello,
		bindings: [],
		sendTokens: [],
		sendAnswers: [
			{
				token: sendToken("hold", commandId, 1),
				status: state,
				...(result ? { result } : {}),
				...(failure ? { failure } : {}),
			},
		],
	});

it.effect("F51 an adopted failure with retryable unset is permanent once", () =>
	runRetirement(
		Effect.gen(function* () {
			const f = yield* s7Fixture("claude");
			yield* f.seed("unset", 1, 1, "held");
			yield* f.hello(
				journalHello("unset", undefined, {
					operation: "send-turn",
					code: "permanent_refusal",
					message: "refused",
				}),
			);
			yield* f.recover;
			expect(
				yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
			).toEqual([{ status: "failed", error_code: "permanent_refusal" }]);
			expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
				{ status: "error" },
			]);
			expect(
				yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
			).toEqual([{ type: "turn.error" }]);
			expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
			expect(
				yield* f.sql`SELECT text FROM input_drafts WHERE draft_key = 's'`,
			).toEqual([{ text: "text unset" }]);
		}),
	),
);

it.effect(
	"F53 adoption finishes run and outbox before retained terminal replay",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("finished", 1, 1, "held");
				yield* f.hello(journalHello("finished", terminalResult()));
				yield* f.recover;
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "completed" }]);
				expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
					{ status: "completed" },
				]);
				f.processes.clear();
				yield* TestClock.adjust("5 seconds");
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([{ type: "turn.completed" }]);
			}),
		),
);

it.effect("F54 adoption of running evidence leaves run and outbox held", () =>
	runRetirement(
		Effect.gen(function* () {
			const f = yield* s7Fixture("claude");
			yield* f.seed("pending", 1, 1, "held");
			yield* f.hello(journalHello("pending", undefined, undefined, "running"));
			yield* f.recover;
			expect(yield* f.sql`SELECT status FROM provider_command_outbox`).toEqual([
				{ status: "running" },
			]);
			expect(
				yield* f.sql`SELECT status, runner_id, held_transmission FROM provider_runs`,
			).toEqual([
				{ status: "pending", runner_id: "131313131313", held_transmission: 1 },
			]);
			expect(
				yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
			).toEqual([]);
		}),
	),
);

it.effect(
	"F63 retryable runner replies end each run and exhaust the sixth cross-run transmission",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("cursor");
				yield* f.seed("retry", 1, 0);
				yield* f.recover;
				f.replaySend.execute = () =>
					Effect.succeed(
						terminalResult("error", {
							code: "transient",
							message: "try again",
							retryable: true,
						}),
					);
				for (let attempt = 1; attempt <= 5; attempt++) {
					yield* f.reactor.runOnce();
					expect(
						yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox`,
					).toEqual([{ status: "retryable_failed", attempt_count: attempt }]);
					expect(
						yield* f.sql`SELECT status FROM provider_runs ORDER BY requested_at, id`,
					).toHaveLength(attempt);
					const [row] = yield* f.sql<{
						next_attempt_at: number;
					}>`SELECT next_attempt_at FROM provider_command_outbox`;
					expect(row?.next_attempt_at).toBeTypeOf("number");
					yield* TestClock.adjust(
						(row?.next_attempt_at ?? 0) - (yield* Clock.currentTimeMillis),
					);
				}
				yield* f.reactor.runOnce();
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([
					{ status: "failed", error_code: "provider_send_attempts_exhausted" },
				]);
				expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
					5,
				);
			}),
		),
);

it.effect(
	"a re-queued input gets the full cap again: three tries, a new reservation, then five more before exhaustion",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("cursor");
				yield* f.seed("retry", 1, 0);
				yield* f.recover;
				f.replaySend.execute = () =>
					Effect.succeed(
						terminalResult("error", {
							code: "transient",
							message: "try again",
							retryable: true,
						}),
					);
				const retry = Effect.gen(function* () {
					yield* f.reactor.runOnce();
					const [row] = yield* f.sql<{
						status: string;
						next_attempt_at: number;
					}>`SELECT status, next_attempt_at FROM provider_command_outbox`;
					expect(row?.status).toBe("retryable_failed");
					yield* TestClock.adjust(
						(row?.next_attempt_at ?? 0) - (yield* Clock.currentTimeMillis),
					);
				});
				for (let attempt = 1; attempt <= 3; attempt++) yield* retry;
				// Stop then Resume re-admits the input under its id: its dispatch writes a new reservation.
				yield* f.commit([
					canonicalEvent(
						"input.sent",
						"s",
						{ sessionId: "s", inputId: "retry" },
						{ provider: "cursor" },
					),
				]);
				for (let attempt = 1; attempt <= 5; attempt++) yield* retry;
				yield* f.reactor.runOnce();
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([
					{ status: "failed", error_code: "provider_send_attempts_exhausted" },
				]);
				expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
					8,
				);
			}),
		),
);

it.effect(
	"a re-queued input's next dispatch gets a fresh transmission number, so no token repeats",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("cursor");
				yield* f.seed("retry", 1, 0);
				yield* f.recover;
				f.replaySend.execute = () =>
					Effect.succeed(
						terminalResult("error", {
							code: "transient",
							message: "try again",
							retryable: true,
						}),
					);
				const retry = Effect.gen(function* () {
					yield* f.reactor.runOnce();
					const [row] = yield* f.sql<{
						next_attempt_at: number;
					}>`SELECT next_attempt_at FROM provider_command_outbox`;
					yield* TestClock.adjust(
						(row?.next_attempt_at ?? 0) - (yield* Clock.currentTimeMillis),
					);
				});
				yield* retry;
				yield* retry;
				yield* f.commit([
					canonicalEvent(
						"input.sent",
						"s",
						{ sessionId: "s", inputId: "retry" },
						{ provider: "cursor" },
					),
				]);
				yield* retry;
				const dispatched = yield* f.sql<{
					n: number;
				}>`SELECT json_extract(data, '$.transmission') AS n FROM events
					WHERE type = 'run.dispatched' ORDER BY sequence`;
				expect(dispatched.map(({ n }) => n)).toEqual([1, 2, 3]);
			}),
		),
);

for (const stale of ["claim", "transmission"] as const)
	it.effect(
		`F74 retained reply from stale ${stale} cannot mutate run, receipt, state or draft`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.seed("stale", 1, 1, "held");
					yield* f.hello(
						journalHello("stale", undefined, undefined, "running"),
					);
					yield* f.recover;
					if (stale === "claim")
						yield* f.sql`UPDATE provider_command_outbox SET attempt_count = 2 WHERE command_id = 'stale'`;
					else {
						yield* (yield* makeCommitAndSignal)([
							canonicalEvent("run.released", "s", {
								runId: "run:stale",
								runnerId: "131313131313",
								commandId: "stale",
								transmission: 1,
								reason: "JournalAbsent",
							}),
							canonicalEvent("run.dispatched", "s", {
								runId: "run:stale",
								runnerId: "131313131313",
								commandId: "stale",
								transmission: 2,
							}),
						]);
					}
					const before = yield* f.sql`SELECT status FROM command_receipts`;
					yield* f.sql`INSERT INTO input_drafts (draft_key, project_id, kind, text, updated_at) VALUES ('s', 'test-project', 'session', 'newer draft', 1)`;
					const attachment = f.attachments[0];
					if (!attachment?.onCommandReply)
						return yield* Effect.die("missing retained reply interface");
					yield* attachment.onCommandReply({
						type: "command-reply",
						commandId: sendToken("hold", "stale", 1),
						result: {
							...terminalResult("error", {
								code: "late",
								message: "old failure",
							}),
							providerStateUpdates: [{ key: "stale-write", value: true }],
						},
					});
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox`,
					).toEqual([{ status: "running" }]);
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "pending" },
					]);
					expect(yield* f.sql`SELECT status FROM command_receipts`).toEqual(
						before,
					);
					expect(
						yield* f.sql`SELECT value FROM provider_state WHERE key = 'stale-write'`,
					).toEqual([]);
					expect(yield* f.sql`SELECT input_id FROM messages`).toEqual([]);
					expect(
						yield* f.sql`SELECT text FROM input_drafts WHERE draft_key = 's'`,
					).toEqual([{ text: "newer draft" }]);
				}),
			),
	);

it.effect(
	"P1-1 a placed send that fails permanently leaves the composer draft alone",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("placed", 1, 1, "held");
				yield* f.hello(journalHello("placed", undefined, undefined, "running"));
				yield* f.recover;
				yield* f.persist.persistUserMessage("s", "text placed", {
					messageId: "placed",
					inputId: "placed",
					runId: "run:placed",
				});
				yield* f.sql`INSERT INTO input_drafts (draft_key, project_id, kind, text, updated_at) VALUES ('s', 'test-project', 'session', 'next draft', 1)`;
				const attachment = f.attachments[0];
				if (!attachment?.onCommandReply)
					return yield* Effect.die("missing retained reply interface");
				yield* attachment.onCommandReply({
					type: "command-reply",
					commandId: sendToken("hold", "placed", 1),
					result: terminalResult("error", {
						code: "permanent_refusal",
						message: "refused",
					}),
				});
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "failed", error_code: "permanent_refusal" }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([{ type: "turn.error" }]);
				expect(
					yield* f.sql`SELECT text FROM input_drafts WHERE draft_key = 's'`,
				).toEqual([{ text: "next draft" }]);
			}),
		),
);

for (const intake of [
	"accepted",
	"joined",
	"indeterminate",
	"missing",
	"resume-rejected",
] as const)
	it.effect(
		`F78 adoption ${intake} evidence cannot produce a generic permanent terminal`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.seed("intake", 1, 1, "held");
					const fallbackWritten = yield* Deferred.make<void>();
					const fallbackReply = yield* Deferred.make<TurnResult>();
					if (intake === "resume-rejected")
						f.replaySend.execute = () =>
							Deferred.succeed(fallbackWritten, undefined).pipe(
								Effect.andThen(Deferred.await(fallbackReply)),
							);
					const result =
						intake === "missing"
							? undefined
							: intake === "resume-rejected"
								? {
										...terminalResult("error", {
											code: "resume_rejected",
											message: "native resume rejected",
										}),
										nativeResumeRejected: true,
									}
								: terminalResult(intake);
					yield* f.hello(journalHello("intake", result));
					yield* f.recover;
					if (intake === "resume-rejected")
						yield* Deferred.await(fallbackWritten);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([]);
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "pending" },
					]);
					if (intake === "resume-rejected") {
						yield* Deferred.succeed(fallbackReply, terminalResult());
						yield* TestClock.adjust(0);
						expect(
							yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
						).toEqual([{ type: "turn.completed" }]);
						expect(
							yield* f.sql`SELECT status FROM provider_command_outbox`,
						).toEqual([{ status: "completed" }]);
						expect(
							f.commands.filter((c) => c.type === "send-turn"),
						).toHaveLength(1);
					}
				}),
			),
	);

it.effect(
	"F78 explicit cancelled reply records interrupted rather than failed",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("cancelled", 1, 1, "held");
				yield* f.hello(journalHello("cancelled", terminalResult("cancelled")));
				yield* f.recover;
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "failed", error_code: "interrupted" }]);
				expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
					{ status: "interrupted" },
				]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([{ type: "turn.interrupted" }]);
			}),
		),
);

it.effect(
	"F79 protocol rejection is diagnosed once instead of retrying as store unavailable",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("protocol", 1, 1, "held");
				const connected = yield* Deferred.make<void>();
				let attempts = 0;
				vi.mocked(f.driver.connect).mockImplementation(() =>
					Effect.gen(function* () {
						attempts++;
						yield* Deferred.succeed(connected, undefined);
						return yield* Effect.fail({
							...runnerFailure("hello", "unsupported runner protocol"),
							code: "runner_incompatible",
						});
					}),
				);
				const recovering = yield* f.recover.pipe(Effect.forkChild);
				yield* Deferred.await(connected);
				yield* TestClock.adjust("10 seconds");
				expect(attempts).toBe(1);
				expect(recovering.pollUnsafe()).toMatchObject({ _tag: "Success" });
				expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
			}),
		),
);

// CONTRACT 1802-1807: the wait behind a delivery_unknown send is the hold's. A fresh
// fallback goes out only behind a ResumeRejected release, which needs a finished answer.
it.effect(
	"an uncertain primary keeps its hold and sends no fresh fallback",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("uncertain", 1, 1, "held");
				const token = sendToken("hold", "uncertain", 1);
				yield* f.hello((hello) => ({
					...hello,
					bindings: [],
					sendTokens: [token],
					sendAnswers: [{ token, status: "uncertain" }],
				}));
				yield* f.recover;
				yield* TestClock.adjust("1 second");
				expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
				expect(
					yield* f.sql`SELECT json_extract(payload_json, '$.nativeResumeFallback') AS fallback FROM provider_command_outbox`,
				).toEqual([{ fallback: null }]);
				expect(
					yield* f.sql`SELECT type, json_extract(data, '$.transmission') AS transmission FROM events WHERE type IN ('run.dispatched', 'run.released')`,
				).toEqual([{ type: "run.dispatched", transmission: 1 }]);
			}),
		),
);

// CONTRACT 7.3: a runner refused as an older build settles its held sends
// delivery_indeterminate without reading its journal, so no record of it is answered.
it.effect(
	"a refused older-build runner's held send settles without its journal being read",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				const matches = vi
					.spyOn(runnerRegistry, "runnerPidMatchesRegistration")
					.mockReturnValue(true);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => matches.mockRestore()),
				);
				yield* f.seed("older", 1, 1, "held");
				// A finished answer that would complete the turn if the journal were read.
				yield* new RunnerSendJournal(
					prepareRunnerDirectory(f.root, f.root),
					"s",
					"claude",
				).execute(
					sendToken("hold", "older", 1),
					Effect.succeed(terminalResult()),
				);
				vi.mocked(f.driver.connect).mockImplementation(() =>
					Effect.fail({
						...runnerFailure("hello", "unsupported runner protocol"),
						code: "runner_incompatible",
					}),
				);
				yield* f.recover;
				f.processes.clear();
				yield* TestClock.adjust("10 seconds");
				expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([{ type: "turn.error" }]);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "failed" }]);
			}),
		),
);

// 32.47: the ledger build (4b2fe6ee) omits every journal answer when one retained file is
// unreadable, though it still answers command-status. Its held send is never left held.
it.effect(
	"a ledger-build runner whose hello omits its journal answers is refused, never left held",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				const matches = vi
					.spyOn(runnerRegistry, "runnerPidMatchesRegistration")
					.mockReturnValue(true);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => matches.mockRestore()),
				);
				// The live host exits only when it is signalled.
				Object.assign(f.processTable, {
					signal: (pid: number) => f.processes.delete(pid),
				});
				yield* f.seed("incomplete", 1, 1, "held");
				yield* f.hello(({ sendAnswers: _omitted, ...hello }) => ({
					...hello,
					drainsConnections: true,
					sendTokens: [sendToken("hold", "incomplete", 1)],
				}));
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect) return yield* Effect.die("missing fixture connection");
				vi.mocked(f.driver.connect).mockImplementation((options) =>
					connect({
						...options,
						onHello: (hello, connection, replay) =>
							options.onHello(
								hello,
								Object.assign(connection, {
									commandStatusEffect: () => Effect.succeed("failed" as const),
								}),
								replay,
							),
					}),
				);
				yield* f.recover;
				yield* TestClock.adjust("10 seconds");
				expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "failed", error_code: "delivery_indeterminate" }]);
			}),
		),
);

// CONTRACT 4.9, 6.7: a send that meets a refused runner during its failure
// stop must not retire it again as an interrupted adoption; Settle still
// reads the refusal's code for the runs it owned.
it.effect(
	"a send during an incompatible runner's failure stop keeps its failure code",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				const matches = vi
					.spyOn(runnerRegistry, "runnerPidMatchesRegistration")
					.mockReturnValue(true);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => matches.mockRestore()),
				);
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at, runner_id) VALUES ('owned', 's', 'running', 1, '131313131313')`;
				// Hold the store so the failure stop's commit waits while the send
				// selects the refused runner.
				const locked = yield* Deferred.make<void>();
				const unlock = yield* Deferred.make<void>();
				vi.mocked(f.driver.connect).mockImplementation(() =>
					Effect.gen(function* () {
						yield* Effect.forkDetach(
							f.sql.withTransaction(
								Deferred.succeed(locked, undefined).pipe(
									Effect.andThen(Deferred.await(unlock)),
								),
							),
						);
						yield* Deferred.await(locked);
						return yield* Effect.fail({
							...runnerFailure("hello", "unsupported runner protocol"),
							code: "runner_incompatible",
						});
					}),
				);
				const recovering = yield* f.recover.pipe(Effect.forkChild);
				yield* Deferred.await(locked);
				yield* TestClock.adjust("1 millis");
				const warming = yield* f.manager
					.executeEffect({ type: "pre-warm", sessionId: "s", input: f.input })
					.pipe(Effect.exit, Effect.forkChild);
				yield* TestClock.adjust("1 millis");
				yield* Deferred.succeed(unlock, undefined);
				yield* TestClock.adjust("1 millis");
				f.processes.clear();
				yield* TestClock.adjust("10 seconds");
				yield* Fiber.join(warming);
				expect(recovering.pollUnsafe()).toMatchObject({ _tag: "Success" });
				expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
					{ status: "error" },
				]);
				const [settled] = yield* f.sql<{
					data: string;
				}>`SELECT data FROM events WHERE type IN ('turn.error', 'turn.interrupted')`;
				expect(JSON.parse(settled?.data ?? "{}")).toMatchObject({
					code: "runner_incompatible",
				});
			}),
		),
);

// Fail the second half of the actual SQLite projection transaction. The run
// terminal and its status have already been written when the outbox write fails.
const failSettlementWrite = (
	sql: SqlClient.SqlClient,
	holdUnavailable?: Deferred.Deferred<void>,
) =>
	Effect.gen(function* () {
		const connection = yield* Effect.scoped(sql.reserve);
		const entered = yield* Deferred.make<void>();
		const attemptedTerminals: string[] = [];
		let unavailable = true;
		const execute = connection.execute;
		const injected = vi
			.spyOn(connection, "execute")
			.mockImplementation((query, params, transform) =>
				Effect.suspend(() => {
					if (
						holdUnavailable &&
						query.includes(
							"SELECT owner.id, session.provider, owner.status, owner.runner_id",
						)
					)
						return Deferred.succeed(holdUnavailable, undefined).pipe(
							Effect.andThen(
								Effect.fail(
									new SqlError({
										reason: new ConnectionError({ cause: "hold unavailable" }),
									}),
								),
							),
						);
					if (query.includes("INSERT INTO events")) {
						const terminalIndex = params.findIndex(
							(value) =>
								value === "turn.completed" ||
								value === "turn.error" ||
								value === "turn.interrupted",
						);
						if (terminalIndex >= 0)
							attemptedTerminals.push(String(params[terminalIndex + 1]));
					}
					if (
						unavailable &&
						query.includes("UPDATE provider_command_outbox") &&
						query.includes("next_attempt_at") &&
						query.includes("payload_json = CASE")
					)
						return Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(
								Effect.fail(
									new SqlError({
										reason: new ConnectionError({
											cause: "injected unavailable projection write",
										}),
									}),
								),
							),
						);
					return execute(query, params, transform);
				}),
			);
		yield* Effect.addFinalizer(() => Effect.sync(() => injected.mockRestore()));
		return {
			entered,
			attemptedTerminals,
			recover: () => {
				unavailable = false;
			},
		};
	});

for (const source of ["adoption", "retained reply", "reactor reply"] as const)
	it.effect(
		`${source} retains terminal evidence after SQLite rolls back run and outbox`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					const reactor = source === "reactor reply";
					yield* f.seed("atomic", 1, reactor ? 0 : 1);
					const result = {
						...terminalResult(
							reactor ? "error" : "completed",
							reactor
								? { code: "refused", message: "permanent reply" }
								: undefined,
						),
						providerStateUpdates: [{ key: "atomic-state", value: "saved" }],
					};
					yield* f.hello(
						journalHello(
							"atomic",
							source === "adoption" ? result : undefined,
							undefined,
							source === "adoption" ? "finished" : "running",
						),
					);
					if (source !== "adoption") yield* f.recover;
					f.replaySend.execute = () => Effect.succeed(result);
					const fault = yield* failSettlementWrite(f.sql);
					const attachment = f.attachments[0];
					const settling = yield* (
						source === "adoption"
							? f.recover
							: source === "reactor reply"
								? f.reactor.runOnce()
								: (attachment?.onCommandReply?.({
										type: "command-reply",
										commandId: sendToken("hold", "atomic", 1),
										result,
									}) ?? Effect.die("missing retained reply interface"))
					).pipe(Effect.forkChild);
					yield* Deferred.await(fault.entered);
					yield* TestClock.adjust(0);
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "pending" },
					]);
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox`,
					).toEqual([{ status: "running" }]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([]);
					expect(
						yield* f.sql`SELECT value FROM provider_state WHERE key = 'atomic-state'`,
					).toEqual([]);
					expect(yield* f.sql`SELECT status FROM command_receipts`).toEqual([
						{ status: "side_effect_requested" },
					]);
					expect(
						yield* f.sql`SELECT text FROM input_drafts WHERE draft_key = 's'`,
					).toEqual([]);
					const transmissions = f.commands.filter(
						(c) => c.type === "send-turn",
					).length;
					fault.recover();
					yield* TestClock.adjust("1 second");
					expect(settling.pollUnsafe()).toMatchObject({ _tag: "Success" });
					yield* Fiber.join(settling);
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: reactor ? "error" : "completed" },
					]);
					expect(
						yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
					).toEqual([
						{
							status: reactor ? "failed" : "completed",
							error_code: reactor ? "refused" : null,
						},
					]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([{ type: reactor ? "turn.error" : "turn.completed" }]);
					expect(
						yield* f.sql`SELECT value FROM provider_state WHERE key = 'atomic-state'`,
					).toEqual(reactor ? [] : [{ value: "saved" }]);
					expect(
						yield* f.sql`SELECT text FROM input_drafts WHERE draft_key = 's'`,
					).toEqual(reactor ? [{ text: "text atomic" }] : []);
					expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
						transmissions,
					);
					expect(fault.attemptedTerminals.length).toBeGreaterThanOrEqual(2);
					expect(new Set(fault.attemptedTerminals).size).toBe(1);
				}),
			),
	);

for (const gate of ["Covered", "Exhausted"] as const)
	it.effect(
		`holdRun ${gate} rolls back both run and outbox and retains settlement until recovery`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("cursor");
					yield* f.seed("gate", 1, 0);
					yield* f.recover;
					if (gate === "Covered")
						yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at) VALUES (2, 'stop', 'test-project', 's', 'account', 'interrupt_turn', ${JSON.stringify({ stop: { owners: [{ runId: "run:gate" }] } })}, 'completed', 1, 1, 1)`;
					else
						for (let transmission = 1; transmission <= 5; transmission++) {
							const runId = `prior:${transmission}`;
							yield* f.commit([
								canonicalEvent("run.requested", "s", {
									runId,
									inputId: "gate",
								}),
								canonicalEvent("run.dispatched", "s", {
									runId,
									runnerId: "131313131313",
									commandId: "gate",
									transmission,
								}),
								canonicalEvent(
									"turn.error",
									"s",
									{
										messageId: "",
										error: "prior transient failure",
										code: "transient",
										retryable: true,
									},
									{ metadata: { runId } },
								),
							]);
						}
					const fault = yield* failSettlementWrite(f.sql);
					const sending = yield* f.reactor.runOnce().pipe(Effect.forkChild);
					yield* Deferred.await(fault.entered);
					yield* TestClock.adjust(0);
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run:gate'`,
					).toEqual([{ status: "pending" }]);
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id = 'gate'`,
					).toEqual([{ status: "running" }]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE json_extract(metadata, '$.runId') = 'run:gate' AND type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([]);
					fault.recover();
					yield* TestClock.adjust("1 second");
					expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run:gate'`,
					).toEqual([{ status: gate === "Covered" ? "interrupted" : "error" }]);
					expect(
						yield* f.sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'gate'`,
					).toEqual([
						{
							status: "failed",
							error_code:
								gate === "Covered"
									? "interrupted"
									: "provider_send_attempts_exhausted",
						},
					]);
					expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
				}),
			),
	);

for (const source of [
	"Settle finished journal",
	"Settle delivery unknown",
	"Gone explicit running journal",
	"Gone explicit process lost",
] as const)
	it.effect(
		`${source} retains evidence and rolls back run and outbox together`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.seed("gone", 1, 1, "held");
					yield* f.hello(journalHello("gone", undefined, undefined, "running"));
					yield* f.recover;
					const journal = new RunnerSendJournal(
						runnerRegistry.runnerDirectory(f.root, f.root),
						"s",
						"claude",
					);
					if (
						source === "Settle finished journal" ||
						source === "Gone explicit process lost"
					)
						yield* journal.execute(
							sendToken("hold", "gone", 1),
							Effect.succeed(
								terminalResult(
									source === "Gone explicit process lost"
										? "accepted"
										: "completed",
								),
							),
						);
					else {
						const started = yield* Deferred.make<void>();
						yield* journal
							.execute(
								sendToken("hold", "gone", 1),
								Deferred.succeed(started, undefined).pipe(
									Effect.andThen(Effect.never),
								),
							)
							.pipe(Effect.forkChild);
						yield* Deferred.await(started);
					}
					const fault = yield* failSettlementWrite(f.sql);
					f.processes.clear();
					const attachment = f.attachments[0];
					if (!attachment)
						return yield* Effect.die("missing recovered attachment");
					const stopping =
						source === "Gone explicit process lost" ||
						source === "Gone explicit running journal"
							? yield* f.manager
									.executeEffect({ type: "end-session", sessionId: "s" })
									.pipe(Effect.forkChild)
							: undefined;
					if (
						source !== "Gone explicit process lost" &&
						source !== "Gone explicit running journal"
					)
						attachment.onClose({
							...runnerFailure("runner", "process exited"),
							code: "process_exited",
						});
					yield* Deferred.await(fault.entered);
					yield* TestClock.adjust(0);
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "pending" },
					]);
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox`,
					).toEqual([{ status: "running" }]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([]);
					rmSync(
						join(runnerRegistry.runnerDirectory(f.root, f.root), "sends", "s"),
						{ recursive: true, force: true },
					);
					fault.recover();
					yield* TestClock.adjust("1 second");
					const completed = source === "Settle finished journal";
					const explicit = source.startsWith("Gone explicit");
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{
							status: completed
								? "completed"
								: explicit
									? "interrupted"
									: "error",
						},
					]);
					expect(
						yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
					).toEqual([
						{
							status: completed ? "completed" : "failed",
							error_code: completed
								? null
								: explicit
									? "interrupted"
									: "delivery_indeterminate",
						},
					]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([
						{
							type: completed
								? "turn.completed"
								: explicit
									? "turn.interrupted"
									: "turn.error",
						},
					]);
					if (stopping)
						expect(stopping.pollUnsafe()).toMatchObject({ _tag: "Success" });
					expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
					expect(new Set(fault.attemptedTerminals).size).toBe(1);
				}),
			),
	);

it.effect(
	"P2-3 a Gone journal failure places the failed message and pushes the restored draft",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("gone", 1, 1, "held");
				yield* f.hello(journalHello("gone", undefined, undefined, "running"));
				yield* f.recover;
				yield* new RunnerSendJournal(
					runnerRegistry.runnerDirectory(f.root, f.root),
					"s",
					"claude",
				).execute(
					sendToken("hold", "gone", 1),
					Effect.succeed(
						terminalResult("error", {
							code: "permanent_refusal",
							message: "refused",
						}),
					),
				);
				const pushes: InputDraftEnvelope[] = [];
				yield* f.drafts.subscribe({ session: "s" }).pipe(
					Stream.runForEach((envelope) =>
						Effect.sync(() => pushes.push(envelope)),
					),
					Effect.forkChild,
				);
				yield* TestClock.adjust(0);
				f.processes.clear();
				const stopping = yield* f.manager
					.executeEffect({ type: "end-session", sessionId: "s" })
					.pipe(Effect.forkChild);
				yield* TestClock.adjust("1 second");
				expect(stopping.pollUnsafe()).toMatchObject({ _tag: "Success" });
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "failed", error_code: "permanent_refusal" }]);
				expect(
					yield* f.sql`SELECT input_id FROM messages WHERE role = 'user'`,
				).toEqual([{ input_id: "gone" }]);
				expect(
					yield* f.sql`SELECT text FROM input_drafts WHERE draft_key = 's'`,
				).toEqual([{ text: "text gone" }]);
				expect(pushes).toContainEqual(
					expect.objectContaining({ text: "text gone", restored: "text gone" }),
				);
			}),
		),
);

it.effect(
	"start refusal retains the same failure through rollback without starting again",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("start", 1, 0);
				vi.mocked(f.driver.connect).mockImplementation(() =>
					Effect.fail({
						...runnerFailure("start", "binary rejected"),
						code: "startup_refused",
					}),
				);
				const fault = yield* failSettlementWrite(f.sql);
				const sending = yield* f.reactor.runOnce().pipe(Effect.forkChild);
				yield* Deferred.await(fault.entered);
				yield* TestClock.adjust(0);
				expect(
					yield* f.sql`SELECT status, runner_id FROM provider_runs`,
				).toEqual([{ status: "pending", runner_id: null }]);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "running" }]);
				expect(spawned.spawn).toHaveBeenCalledTimes(1);
				expect(
					yield* f.sql`SELECT input_id FROM messages WHERE role = 'user'`,
				).toEqual([]);
				expect(
					yield* f.sql`SELECT text FROM input_drafts WHERE draft_key = 's'`,
				).toEqual([]);
				fault.recover();
				yield* TestClock.adjust("1 second");
				expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
				expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
					{ status: "error" },
				]);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "failed", error_code: "startup_refused" }]);
				expect(
					yield* f.sql`SELECT input_id FROM messages WHERE role = 'user'`,
				).toEqual([{ input_id: "start" }]);
				expect(
					yield* f.sql`SELECT text FROM input_drafts WHERE draft_key = 's'`,
				).toEqual([{ text: "text start" }]);
				expect(spawned.spawn).toHaveBeenCalledTimes(1);
				expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
			}),
		),
);

for (const source of ["adoption", "Settle"] as const)
	it.effect(
		`${source} retryable settlement wakes the real reactor at retryAt without periodic drain`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.seed("retry-wake", 1, 1, "held");
					const retry = terminalResult("error", {
						code: "temporary",
						message: "transient terminal",
						retryable: true,
					});
					yield* f.hello(
						journalHello(
							"retry-wake",
							source === "adoption" ? retry : undefined,
							undefined,
							source === "adoption" ? "finished" : "running",
						),
					);
					let wakes = 0;
					Object.assign(f.recovery, {
						wakeReactor: Effect.sync(() => {
							wakes++;
						}).pipe(Effect.andThen(f.reactor.drain()), Effect.orDie),
					});
					f.replaySend.execute = () =>
						Effect.succeed(
							terminalResult("error", {
								code: "second-final",
								message: "completed retry",
							}),
						);
					yield* f.recover;
					if (source === "Settle") {
						const journal = new RunnerSendJournal(
							runnerRegistry.runnerDirectory(f.root, f.root),
							"s",
							"claude",
						);
						yield* journal.execute(
							sendToken("hold", "retry-wake", 1),
							Effect.succeed(retry),
						);
						f.processes.clear();
						const attachment = f.attachments[0];
						if (!attachment)
							return yield* Effect.die("missing recovered attachment");
						attachment.onClose({
							...runnerFailure("runner", "process exited"),
							code: "process_exited",
						});
					}
					yield* TestClock.adjust(0);
					expect(wakes).toBeGreaterThan(0);
					expect(
						yield* f.sql`SELECT status, next_attempt_at FROM provider_command_outbox`,
					).toEqual([{ status: "retryable_failed", next_attempt_at: 1000 }]);
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "error" },
					]);
					yield* TestClock.adjust("999 millis");
					expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
					yield* TestClock.adjust("1 millis");
					expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
						1,
					);
					expect(
						yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox`,
					).toEqual([{ status: "failed", attempt_count: 2 }]);
					expect(
						yield* f.sql`SELECT status FROM provider_runs ORDER BY requested_at`,
					).toEqual([{ status: "error" }, { status: "error" }]);
				}),
			),
	);

for (const source of ["adoption", "retained reply", "reactor reply"] as const)
	it.effect(
		`${source} retries the same retryable evidence with a stable retryAt after a failed commit`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					const reactor = source === "reactor reply";
					yield* f.seed("stable", 1, reactor ? 0 : 1);
					const result = terminalResult("error", {
						code: "temporary",
						message: "transient terminal",
						retryable: true,
					});
					yield* f.hello(
						journalHello(
							"stable",
							source === "adoption" ? result : undefined,
							undefined,
							source === "adoption" ? "finished" : "running",
						),
					);
					if (source !== "adoption") yield* f.recover;
					f.replaySend.execute = () => Effect.succeed(result);
					const fault = yield* failSettlementWrite(f.sql);
					const attachment = f.attachments[0];
					const settling = yield* (
						source === "adoption"
							? f.recover
							: reactor
								? f.reactor.runOnce()
								: (attachment?.onCommandReply?.({
										type: "command-reply",
										commandId: sendToken("hold", "stable", 1),
										result,
									}) ?? Effect.die("missing retained reply interface"))
					).pipe(Effect.forkChild);
					yield* Deferred.await(fault.entered);
					yield* TestClock.adjust(0);
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "pending" },
					]);
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox`,
					).toEqual([{ status: "running" }]);
					fault.recover();
					yield* TestClock.adjust("1 second");
					expect(settling.pollUnsafe()).toMatchObject({ _tag: "Success" });
					expect(
						yield* f.sql`SELECT status, next_attempt_at FROM provider_command_outbox`,
					).toEqual([{ status: "retryable_failed", next_attempt_at: 1000 }]);
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "error" },
					]);
					expect(
						yield* f.sql`SELECT json_extract(data, '$.retryAt') AS retryAt FROM events WHERE type = 'turn.error'`,
					).toEqual([{ retryAt: 1000 }]);
					expect(fault.attemptedTerminals).toHaveLength(2);
					expect(new Set(fault.attemptedTerminals).size).toBe(1);
					expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
						reactor ? 1 : 0,
					);
				}),
			),
	);

it.effect(
	"F79 corrupt stored payload is rejected once rather than retried as unavailable",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("corrupt", 1, 1, "held");
				yield* f.hello(
					journalHello("corrupt", undefined, undefined, "running"),
				);
				yield* f.recover;
				yield* f.sql`UPDATE provider_command_outbox SET payload_json = '{' WHERE command_id = 'corrupt'`;
				const connection = yield* Effect.scoped(f.sql.reserve);
				const execute = connection.execute;
				let reads = 0;
				const observed = vi
					.spyOn(connection, "execute")
					.mockImplementation((query, params, transform) => {
						if (query.includes("SELECT outbox.request_sequence")) reads++;
						return execute(query, params, transform);
					});
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => observed.mockRestore()),
				);
				const attachment = f.attachments[0];
				if (!attachment?.onCommandReply)
					return yield* Effect.die("missing retained reply interface");
				const replying = yield* attachment
					.onCommandReply({
						type: "command-reply",
						commandId: sendToken("hold", "corrupt", 1),
						result: terminalResult(),
					})
					.pipe(Effect.result, Effect.forkChild);
				yield* TestClock.adjust("10 seconds");
				expect(reads).toBe(1);
				expect(replying.pollUnsafe()).toMatchObject({
					_tag: "Success",
					value: { _tag: "Failure" },
				});
				expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
					{ status: "pending" },
				]);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "running" }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([]);
				expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
			}),
		),
);

it.effect(
	"P2-2 an undecodable stored payload still settles its terminal without payload duties",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("legacy", 1, 1, "held");
				yield* f.hello(journalHello("legacy", undefined, undefined, "running"));
				yield* f.recover;
				yield* f.sql`UPDATE provider_command_outbox SET payload_json = '{"inputId":"legacy"}' WHERE command_id = 'legacy'`;
				const attachment = f.attachments[0];
				if (!attachment?.onCommandReply)
					return yield* Effect.die("missing retained reply interface");
				yield* attachment.onCommandReply({
					type: "command-reply",
					commandId: sendToken("hold", "legacy", 1),
					result: terminalResult("error", {
						code: "permanent_refusal",
						message: "refused",
					}),
				});
				expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
					{ status: "error" },
				]);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "failed", error_code: "permanent_refusal" }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([{ type: "turn.error" }]);
				expect(
					yield* f.sql`SELECT input_id FROM messages WHERE role = 'user'`,
				).toEqual([]);
				expect(yield* f.sql`SELECT text FROM input_drafts`).toEqual([]);
			}),
		),
);

it.effect(
	"reactor recall leaves a held send and its uncertainty marker to Settle",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("held-recall", 1, 0);
				yield* f.recover;
				const written = yield* Deferred.make<void>();
				f.replaySend.execute = () =>
					Deferred.succeed(written, undefined).pipe(
						Effect.andThen(Effect.never),
					);
				yield* f.reactor.runOnce().pipe(Effect.forkChild);
				yield* Deferred.await(written);
				yield* TestClock.adjust("2 minutes");
				yield* TestClock.adjust("1 second");
				expect(
					yield* f.sql`SELECT status, runner_id, held_transmission FROM provider_runs`,
				).toEqual([
					{
						status: "pending",
						runner_id: "131313131313",
						held_transmission: 1,
					},
				]);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "running", error_code: null }]);
				expect(
					yield* f.sql`SELECT status, error_code FROM command_receipts`,
				).toEqual([{ status: "side_effect_requested", error_code: null }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([]);
				expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
					1,
				);
			}),
		),
);

// From 32.5 a joined steer is sent through the feeder, so the reactor settles its own reply
// through Send Settlement while its owner's Run is open (CONTRACT 1625-1632, 2021-2025).
// How it could fail: the reactor skips the reply because the steer's own Run is joined, not
// open; the settlement ends its owner's Run; or the steer is sent outside the feeder's hold.
it.effect(
	"reactor settles a joined steer's terminal reply and leaves its owner's Run open",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("head", 1, 1, "held");
				yield* f.hello(journalHello("head", undefined, undefined, "running"));
				yield* f.recover;
				yield* f.seed("steer", 2, 0);
				// Its claim requests its Run, so it is joined once claimed, before the feeder's submit.
				f.preparation.gate =
					f.sql`UPDATE provider_runs SET joined_into = 'run:head', status = 'joined' WHERE id = 'run:steer'`.pipe(
						Effect.orDie,
						Effect.asVoid,
					);
				f.replaySend.execute = () =>
					Effect.succeed(
						terminalResult("error", {
							code: "permanent_refusal",
							message: "refused",
						}),
					);
				yield* f.reactor.runCommand("steer").pipe(Effect.forkChild);
				yield* TestClock.adjust("1 second");
				expect(
					yield* f.sql`SELECT id, status FROM provider_runs WHERE id IN ('run:head', 'run:steer') ORDER BY id`,
				).toEqual([
					{ id: "run:head", status: "pending" },
					{ id: "run:steer", status: "joined" },
				]);
				expect(
					yield* f.sql`SELECT command_id, status, error_code FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([
					{ command_id: "head", status: "running", error_code: null },
					{
						command_id: "steer",
						status: "failed",
						error_code: "permanent_refusal",
					},
				]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.commandId') AS commandId FROM events WHERE type = 'run.dispatched' AND json_extract(data, '$.runId') = 'run:steer'`,
				).toEqual([{ commandId: "steer" }]);
			}),
		),
);

// From 32.5 a joined steer's retry after a retryable reply is its own Run's next transmission,
// held by the feeder under its own run id, never a fresh Run (CONTRACT 1864-1870, 2021-2025, 2667).
// How it could fail: the retry is claimed on a fresh Run, so the steer leaves its owner's Run and
// restarts its cap; it is re-sent before its backoff; it is never re-sent and stays stranded; or
// its outcome ends its owner's Run.
it.effect(
	"a joined steer's retryable reply is re-held as its own Run's next transmission, never a fresh Run",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("head", 1, 1, "held");
				yield* f.hello(journalHello("head", undefined, undefined, "running"));
				yield* f.recover;
				yield* f.seed("steer", 2, 0);
				f.preparation.gate =
					f.sql`UPDATE provider_runs SET joined_into = 'run:head', status = 'joined' WHERE id = 'run:steer'`.pipe(
						Effect.orDie,
						Effect.asVoid,
					);
				const replies = [
					terminalResult("error", {
						code: "temporary",
						message: "transient",
						retryable: true,
					}),
					terminalResult("joined"),
				];
				const sent: string[] = [];
				f.replaySend.execute = (_id, command) =>
					Effect.sync(() => {
						sent.push(command.input.inputId);
						return replies.shift() ?? terminalResult("joined");
					});
				yield* f.reactor.runCommand("steer").pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				// Its reply leaves the steer's command open and unheld until its backoff.
				expect(
					yield* f.sql`SELECT command.status, command.run_id, run.runner_id, run.held_transmission
						FROM provider_command_outbox command JOIN provider_runs run ON run.id = command.run_id
						WHERE command.command_id = 'steer'`,
				).toEqual([
					{
						status: "running",
						run_id: "run:steer",
						runner_id: null,
						held_transmission: null,
					},
				]);
				expect(sent).toEqual(["steer"]);
				yield* TestClock.adjust("999 millis");
				expect(sent).toEqual(["steer"]);
				yield* TestClock.adjust("1 millis");
				expect(sent).toEqual(["steer", "steer"]);
				expect(
					yield* f.sql`SELECT id, status FROM provider_runs WHERE joined_into IS NULL`,
				).toEqual([{ id: "run:head", status: "pending" }]);
				expect(
					yield* f.sql`SELECT status, joined_into FROM provider_runs WHERE id = 'run:steer'`,
				).toEqual([{ status: "joined", joined_into: "run:head" }]);
				expect(
					yield* f.sql`SELECT command_id, status, attempt_count, run_id FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([
					{
						command_id: "head",
						status: "running",
						attempt_count: 1,
						run_id: "run:head",
					},
					{
						command_id: "steer",
						status: "running",
						attempt_count: 1,
						run_id: "run:steer",
					},
				]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.commandId') AS commandId, json_extract(data, '$.transmission') AS transmission
						FROM events WHERE type = 'run.dispatched' AND json_extract(data, '$.runId') = 'run:steer' ORDER BY sequence`,
				).toEqual([
					{ commandId: "steer", transmission: 1 },
					{ commandId: "steer", transmission: 2 },
				]);
			}),
		),
);

// An account revoked under the reactor's call fails that call before any hold.
const revoked = (retryable: boolean | undefined) =>
	new ProviderInstanceFailure({
		providerId: "account",
		operation: "prepare turn",
		cause: {
			code: "account_unavailable",
			message: "Account was removed",
			...(retryable === undefined ? {} : { retryable }),
		},
	});

for (const retryable of [undefined, true])
	it.effect(
		`F83 account revocation ends an unheld send once by its flag (retryable ${String(retryable)})`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.seed("revoked", 1, 0);
					yield* f.recover;
					f.preparation.gate = Effect.fail(revoked(retryable));
					yield* f.reactor.runOnce();
					yield* TestClock.adjust(0);
					expect(
						yield* f.sql`SELECT status, runner_id, held_transmission FROM provider_runs`,
					).toEqual([
						{ status: "error", runner_id: null, held_transmission: null },
					]);
					expect(
						yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
					).toEqual([
						{
							status: retryable ? "retryable_failed" : "failed",
							error_code: "account_unavailable",
						},
					]);
					expect(
						yield* f.sql`SELECT json_extract(data, '$.retryable') AS retryable FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([{ retryable: retryable ? 1 : 0 }]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type = 'run.dispatched'`,
					).toEqual([]);
					expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
				}),
			),
	);

it.effect(
	"F83 account revocation after another owner holds the send leaves it to that owner",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("revoked-held", 1, 0);
				yield* f.recover;
				// Another owner commits its hold while the reactor's call is still
				// preparing; the revocation then fails that call.
				f.preparation.gate = f
					.commit([
						canonicalEvent("run.dispatched", "s", {
							runId: "run:revoked-held",
							runnerId: "131313131313",
							commandId: "revoked-held",
							transmission: 1,
						}),
					])
					.pipe(Effect.orDie, Effect.andThen(Effect.fail(revoked(undefined))));
				yield* f.reactor.runOnce();
				yield* TestClock.adjust("1 second");
				expect(
					yield* f.sql`SELECT status, runner_id, held_transmission FROM provider_runs`,
				).toEqual([
					{
						status: "pending",
						runner_id: "131313131313",
						held_transmission: 1,
					},
				]);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "running", error_code: null }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([]);
				expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
			}),
		),
);

const failSessionRegistration = (sql: SqlClient.SqlClient) =>
	Effect.gen(function* () {
		const connection = yield* Effect.scoped(sql.reserve);
		const execute = connection.execute;
		const entered = yield* Deferred.make<void>();
		let unavailable = true;
		let attempts = 0;
		const injected = vi
			.spyOn(connection, "execute")
			.mockImplementation((query, params, transform) =>
				Effect.suspend(() => {
					if (
						query.includes("INSERT INTO claude_runner_cursors") &&
						query.includes("role")
					) {
						attempts++;
						if (unavailable)
							return Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(
									Effect.fail(
										new SqlError({
											reason: new ConnectionError({
												cause: "injected register unavailable",
											}),
										}),
									),
								),
							);
					}
					return execute(query, params, transform);
				}),
			);
		yield* Effect.addFinalizer(() => Effect.sync(() => injected.mockRestore()));
		return {
			entered,
			attempts: () => attempts,
			recover: () => {
				unavailable = false;
			},
		};
	});

it.effect(
	"F79 unavailable registration ends its start retryable and the reactor retries a fresh run",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("register-fault", 1, 0);
				f.replaySend.execute = () =>
					Effect.succeed(
						terminalResult("error", { code: "final", message: "final reply" }),
					);
				const fault = yield* failSessionRegistration(f.sql);
				const sending = yield* f.reactor.runOnce().pipe(Effect.forkChild);
				yield* Deferred.await(fault.entered);
				yield* TestClock.adjust(0);
				expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
				expect(
					yield* f.sql`SELECT status, runner_id FROM provider_runs`,
				).toEqual([{ status: "error", runner_id: null }]);
				expect(
					yield* f.sql`SELECT status, attempt_count, next_attempt_at FROM provider_command_outbox`,
				).toEqual([
					{
						status: "retryable_failed",
						attempt_count: 1,
						next_attempt_at: 1000,
					},
				]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.retryable') AS retryable FROM events WHERE type = 'turn.error'`,
				).toEqual([{ retryable: 1 }]);
				expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
				expect(spawned.spawn).toHaveBeenCalledTimes(1);
				fault.recover();
				yield* TestClock.adjust("1 second");
				const retrying = yield* f.reactor.runOnce().pipe(Effect.forkChild);
				yield* TestClock.adjust("4 seconds");
				expect(retrying.pollUnsafe()).toMatchObject({ _tag: "Success" });
				expect(fault.attempts()).toBe(2);
				expect(spawned.spawn).toHaveBeenCalledTimes(2);
				expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
					1,
				);
				expect(
					yield* f.sql`SELECT status, attempt_count, error_code FROM provider_command_outbox`,
				).toEqual([
					{ status: "failed", attempt_count: 2, error_code: "final" },
				]);
				expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
					{ status: "error" },
					{ status: "error" },
				]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.error', 'turn.completed', 'turn.interrupted')`,
				).toEqual([{ type: "turn.error" }, { type: "turn.error" }]);
			}),
		),
);

for (const stale of ["claim", "transmission"] as const)
	it.effect(
		`F74 adoption retains its finished journal evidence across rollback and rejects a newer ${stale}`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.seed("journal-stale", 1, 1, "held");
					yield* f.hello(
						journalHello(
							"journal-stale",
							terminalResult("error", { code: "old", message: "old refusal" }),
						),
					);
					const fault = yield* failSettlementWrite(f.sql);
					const recovering = yield* f.recover.pipe(Effect.forkChild);
					yield* Deferred.await(fault.entered);
					yield* TestClock.adjust(0);
					if (stale === "claim")
						yield* f.sql`UPDATE provider_command_outbox SET attempt_count = 2 WHERE command_id = 'journal-stale'`;
					else
						yield* f.commit([
							canonicalEvent("run.released", "s", {
								runId: "run:journal-stale",
								runnerId: "131313131313",
								commandId: "journal-stale",
								transmission: 1,
								reason: "JournalAbsent",
							}),
							canonicalEvent("run.dispatched", "s", {
								runId: "run:journal-stale",
								runnerId: "131313131313",
								commandId: "journal-stale",
								transmission: 2,
							}),
						]);
					fault.recover();
					yield* TestClock.adjust("1 second");
					expect(recovering.pollUnsafe()).toMatchObject({ _tag: "Success" });
					expect(
						yield* f.sql`SELECT status, held_transmission FROM provider_runs`,
					).toEqual([
						{ status: "pending", held_transmission: stale === "claim" ? 1 : 2 },
					]);
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox`,
					).toEqual([{ status: "running" }]);
					expect(yield* f.sql`SELECT status FROM command_receipts`).toEqual([
						{ status: "side_effect_requested" },
					]);
					expect(
						yield* f.sql`SELECT input_id FROM messages WHERE role = 'user'`,
					).toEqual([]);
					expect(
						yield* f.sql`SELECT text FROM input_drafts WHERE draft_key = 's'`,
					).toEqual([]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([]);
				}),
			),
	);

for (const policy of ["retry handled", "steer declined"] as const)
	it.effect(
		`F51 ${policy} reply cannot copy retryable true into a permanent terminal`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.seed("policy", 1, 1, "held");
					yield* f.hello(
						journalHello(
							"policy",
							terminalResult(
								policy === "steer declined" ? "steer-declined" : "error",
								{
									code: "final",
									message: "final result",
									retryable: true,
									...(policy === "retry handled" ? { retryHandled: true } : {}),
								},
							),
						),
					);
					yield* f.recover;
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "error" },
					]);
					expect(
						yield* f.sql`SELECT status, next_attempt_at FROM provider_command_outbox`,
					).toEqual([{ status: "failed", next_attempt_at: null }]);
					expect(
						yield* f.sql`SELECT json_extract(data, '$.retryable') AS retryable FROM events WHERE type = 'turn.error'`,
					).toEqual([{ retryable: 0 }]);
					expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
				}),
			),
	);

it.effect(
	"a steer joined during its NotSent transmission is re-held through the feeder while its owner's Run is open",
	() =>
		runRetirement(
			Effect.gen(function* () {
				// 4.8: its re-hold is the feeder's, under its own transmissions, and lives
				// as long as its owner's Run (CONTRACT 1413, 1535-1537, 1868-1869).
				const f = yield* s7Fixture("claude");
				yield* f.seed("head", 1, 1, "held");
				yield* f.hello(journalHello("head", undefined, undefined, "running"));
				yield* f.recover;
				const steer = yield* f.seed("steer", 2, 1, "unheld");
				let sends = 0;
				// Its run.started joins it to the owner before the NotSent reply lands.
				f.replaySend.execute = () =>
					++sends === 1
						? f.sql`UPDATE provider_runs SET joined_into = 'run:head', status = 'joined' WHERE id = 'run:steer'`.pipe(
								Effect.orDie,
								Effect.andThen(
									Effect.fail({
										operation: "send-turn",
										code: "not_sent",
										message: "no bytes",
										delivery: { _tag: "NotSent" },
									}),
								),
							)
						: Effect.succeed(terminalResult("joined"));
				const sending = yield* f.instance
					.sendTurnEffect(steer)
					.pipe(Effect.forkChild);
				yield* TestClock.adjust("5 seconds");
				expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
				expect((yield* Fiber.join(sending))?.status).toBe("joined");
				expect(
					yield* f.sql`SELECT type, json_extract(data, '$.commandId') AS commandId,
						json_extract(data, '$.transmission') AS transmission, json_extract(data, '$.reason') AS reason FROM events
						WHERE type IN ('run.dispatched', 'run.released') AND json_extract(data, '$.runId') = 'run:steer' ORDER BY sequence`,
				).toEqual([
					{
						type: "run.dispatched",
						commandId: "steer",
						transmission: 1,
						reason: null,
					},
					{
						type: "run.released",
						commandId: "steer",
						transmission: 1,
						reason: "NotSent",
					},
					{
						type: "run.dispatched",
						commandId: "steer",
						transmission: 2,
						reason: null,
					},
				]);
				expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
					2,
				);
			}),
		),
);
