import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "@effect/vitest";
import {
	Cause,
	Clock,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Logger,
	Option,
	Scheduler,
	Scope,
	Stream,
} from "effect";
import { SqlClient, Statement } from "effect/sql";
import {
	ConnectionError,
	LockTimeoutError,
	SqlError,
	UnknownError,
} from "effect/sql/SqlError";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import { Usage } from "../../../src/lib/domain/daemon/Services/usage.js";
import { ContinuationTag } from "../../../src/lib/domain/relay/Services/continuation.js";
import {
	InputDraftsTag,
	makeInputDrafts,
} from "../../../src/lib/domain/relay/Services/input-drafts.js";
import {
	makePendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ProviderTurnServiceTag } from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	SessionInboxLive,
	SessionInboxTag,
} from "../../../src/lib/domain/relay/Services/session-inbox.js";
import { sessionPickEvents } from "../../../src/lib/domain/relay/Services/session-pick.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import {
	currentRunnerWriteOrigin,
	currentWriteAuthorization,
	makeCommitAndSignal,
} from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import {
	ProviderSideEffectReactor,
	type ProviderSideEffectReactorOptions,
} from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type { SendToken } from "../../../src/lib/provider/run-ledger/run-ledger-model.js";
import { makeInProcessSessionRunner } from "../../../src/lib/provider/runner/in-process-session-runner.js";
import type { ProcessRunnerDriver } from "../../../src/lib/provider/runner/process-runner-types.js";
import { makeProcessSessionRunner } from "../../../src/lib/provider/runner/process-session-runner.js";
import {
	isLegacyRunner,
	legacyRunnerRunQuery,
} from "../../../src/lib/provider/runner/runner-legacy-classification.js";
import {
	type RunnerCommandFailure,
	type RunnerHello,
	type RunnerSocket,
	type RunnerWriteGate,
	runnerBuildId,
	runnerFailure,
	runnerSinkId,
	sendToken,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import {
	makeRunnerProviderInstance,
	type RunnerProviderInstanceDeps,
	type RunnerRecoveryDependencies,
} from "../../../src/lib/provider/runner/runner-provider-instance.js";
import {
	currentRunnerOutput,
	makeRunnerReceiptStore,
} from "../../../src/lib/provider/runner/runner-receipts.js";
import * as runnerRegistry from "../../../src/lib/provider/runner/runner-registry.js";
import { prepareRunnerDirectory } from "../../../src/lib/provider/runner/runner-registry.js";
import { makeRunnerRunLifecycle } from "../../../src/lib/provider/runner/runner-retirement.js";
import { RunnerSendJournal } from "../../../src/lib/provider/runner/runner-send-journal.js";
import type { RunnerSinkBindings } from "../../../src/lib/provider/runner/runner-sink-bindings.js";
import { SendAdmissionTimeout } from "../../../src/lib/provider/runner/send-admission.js";
import type { SendScope } from "../../../src/lib/provider/runner/send-scope.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionRunner,
} from "../../../src/lib/provider/runner/session-runner.js";
import type { EventSink, TurnResult } from "../../../src/lib/provider/types.js";
import { makeSessionBackgroundLiveness } from "../../../src/lib/session/background-liveness.js";
import { MainRunnerSendJournal } from "../../helpers/main-runner-send-journal.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";
import {
	createMockEventSink,
	makeBaseSendTurnInput,
} from "../../helpers/mock-sdk.js";
import {
	admitRunnerCommand,
	makeRunnerAdmission,
	reserveTestRun,
} from "../../helpers/runner-provider-admission.js";
import { gatedWrite } from "../../helpers/runner-write-gate.js";

const spawned = vi.hoisted(() => ({
	spawn: vi.fn(),
	// `ps` command lines by pid, for fake runners that must pass the pid match.
	commands: new Map<string, string>(),
}));
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: spawned.spawn,
		execFileSync: (...args: Parameters<typeof actual.execFileSync>) =>
			(args[0] === "ps" && spawned.commands.get(args[1]?.at(-1) ?? "")) ||
			actual.execFileSync(...args),
	};
});

const retirementFixture = (
	recover = true,
	recoveryForSession?: RunnerProviderInstanceDeps["recoveryForSession"],
	withAccountScope?: ProcessRunnerDriver["withAccountScope"],
	retainedSinkIds: readonly string[] = ["retained"],
	driverKind: "claude" | "cursor" = "claude",
) =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.sync(() => mkdtempSync(join(tmpdir(), "runner-cleanup-fence-"))),
			(path) =>
				Effect.sync(() => rmSync(path, { recursive: true, force: true })),
		);
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('s', 'test-project', 'claude', 1, 1)`;
		// Owner sends settle through persistence, which requires a live session.
		yield* sql`INSERT INTO session_providers (id, session_id, provider, status, activated_at) VALUES ('s:initial', 's', 'claude', 'active', 1)`;
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
		const processes = new Map([
			[pid, { state: "running" as const, startTime: "original" }],
		]);
		const childProcesses = new Map<number, EventEmitter>();
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
			childProcesses.set(child.pid, child);
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
		const pending = yield* Deferred.make<TurnResult, RunnerCommandFailure>();
		const sending = yield* Deferred.make<void>();
		const replaySend: {
			execute?: (
				token: SendToken,
				command: Extract<SessionCommand, { type: "send-turn" }>,
			) => Effect.Effect<TurnResult | undefined, SessionFailure>;
		} = {};
		const destroyed = vi.fn();
		const commands: Array<{ runnerId: string; type: string }> = [];
		const replacementGate = { hold: false };
		const replacementConnecting = yield* Deferred.make<void>();
		const replacementReady = yield* Deferred.make<void>();
		// The next original attachment loses its socket during backlog replay.
		const replayLoss = { armed: false };
		const driver: ProcessRunnerDriver = {
			driverKind,
			legacyPrepareTurnEffect: (input) =>
				Effect.succeed({
					input: {
						...input,
						prompt: input.text ?? "send",
						history: [],
						facts: { _tag: "Claude" as const },
					},
				}),
			...(withAccountScope ? { withAccountScope } : {}),
			connect: vi.fn<ProcessRunnerDriver["connect"]>((options) =>
				Effect.gen(function* () {
					attachments.push(options);
					const journal = new RunnerSendJournal(
						runnerRegistry.runnerDirectory(root, root),
						"s",
						driverKind,
					);
					if (options.runnerId !== runnerId && replacementGate.hold) {
						yield* Deferred.succeed(replacementConnecting, undefined);
						yield* Deferred.await(replacementReady);
					}
					const connection = {
						closed: false,
						// A send's frame id is its Send Token.
						commandEffect: (
							id: SendToken,
							command: SessionCommand,
							canWrite?: RunnerWriteGate,
						) =>
							gatedWrite(
								canWrite,
								Effect.suspend<TurnResult | undefined, SessionFailure, never>(
									() => {
										commands.push({
											runnerId: options.runnerId,
											type: command.type,
										});
										if (command.type === "send-turn" && replaySend.execute)
											return replaySend.execute(id, command);
										return command.type === "send-turn" &&
											options.runnerId === runnerId
											? journal.execute(
													id,
													Deferred.succeed(sending, undefined).pipe(
														Effect.andThen(Deferred.await(pending)),
													),
												)
											: command.type === "send-turn"
												? journal.execute(
														id,
														Effect.succeed({
															status: "completed" as const,
															cost: 0,
															tokens: { input: 0, output: 0 },
															durationMs: 0,
															providerStateUpdates: [],
														}),
													)
												: Effect.succeed(undefined);
									},
								),
							),
						retireEffect: () => Effect.succeed(true),
						destroy: () => destroyed(options.runnerId),
						write: () => {},
					} as unknown as RunnerSocket;
					// A real connection's hello claim records that this runner journals.
					yield* sql`UPDATE claude_runner_cursors SET journals_before_execution = 1 WHERE runner_id = ${options.runnerId}`.pipe(
						Effect.orDie,
					);
					yield* options.onHello(
						{
							type: "hello",
							protocolVersion: 1,
							buildId: runnerBuildId(),
							stampsRunIds: true,
							runnerId: options.runnerId,
							sessionId: "s",
							pid: options.pid ?? 0,
							bindings:
								options.runnerId === runnerId
									? retainedSinkIds.map((sinkId) => ({
											token: sendToken("tx", sinkId, 0),
											sinkId,
											sessionId: "s",
											released: false,
										}))
									: [],
							sendJournalAnswers: true,
							sendAnswers:
								options.runnerId === runnerId
									? retainedSinkIds.map((commandId) => ({
											token: sendToken("tx", commandId, 0),
											status: "running" as const,
										}))
									: [],
						},
						connection,
						replayLoss.armed && options.runnerId === runnerId
							? Effect.sync(() => {
									replayLoss.armed = false;
									Object.assign(connection, { closed: true });
								})
							: undefined,
					);
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
		const outputs: SessionOutput[] = [];
		const retained = new Set(retainedSinkIds);
		const background = makeSessionBackgroundLiveness(undefined, () => 1);
		const output = vi.fn<Parameters<typeof makeProcessSessionRunner>[1]>(
			(output) =>
				Effect.sync(() => {
					outputs.push(output);
					if (output.type === "release-sink") retained.delete(output.sinkId);
					if (output.type === "background-task")
						background.record(output.transition);
					return {};
				}),
		);
		const processTable: runnerRegistry.RunnerProcessTable = {
			inspect: (pid: number) =>
				processes.get(pid) ?? { state: "gone" as const },
			signal: () => {},
		};
		// A held gate parks every accounts read until the test opens it.
		const accountsGate: { hold?: Deferred.Deferred<void> } = {};
		const manager = yield* makeProcessSessionRunner(
			{
				daemonConfigDir: root,
				accounts: Effect.suspend(() =>
					accountsGate.hold ? Deferred.await(accountsGate.hold) : Effect.void,
				).pipe(
					Effect.as(
						accountsStateFromInstances(
							[{ id: "account", driver: driverKind, name: "Account" }],
							configuredClaudeConfigDir(root),
						),
					),
				),
				projectRootForSession: () => Effect.succeed(root),
				processTable,
				...(recoveryForSession ? { recoveryForSession } : {}),
			},
			output,
			driver,
		);
		// The registry fixture represents an already-created process. Seed its
		// durable slot when a test elects to recover it; fresh-spawn tests do not.
		const recoverRegistered = manager.recoverEffect;
		let registered = false;
		Object.defineProperty(manager, "recoverEffect", {
			value: Effect.gen(function* () {
				if (!registered) {
					const [serving] =
						yield* sql`SELECT runner_id FROM claude_runner_cursors WHERE session_id = 's' AND retired_at IS NULL AND role = 'serving'`;
					yield* receipts.register(
						runnerId,
						{ sessionId: "s", pid, startTime: "original", driverKind },
						serving ? "candidate" : "serving",
					);
					registered = true;
				}
				yield* recoverRegistered;
			}),
		});
		const sendHandles: SendScope[] = [];
		const owner = manager.sendScopes;
		if (!owner) return yield* Effect.die("missing send owner");
		const open = owner.open;
		vi.spyOn(owner, "open").mockImplementation((sinkId, sessionId) =>
			open(sinkId, sessionId).pipe(
				Effect.tap((send) => Effect.sync(() => sendHandles.push(send))),
			),
		);
		const provider = yield* makeRunnerAdmission(manager, driverKind);
		if (recover) yield* manager.recoverEffect;
		const input = {
			sessionId: "s",
			workspaceRoot: root,
			extraFolders: [],
			providerState: {},
			configDir: configuredClaudeConfigDir(root),
		};
		return {
			root,
			sql,
			socketPath,
			driver,
			processTable,
			processes,
			childProcesses,
			manager,
			provider,
			admitCommand: (
				command: Extract<
					import("../../../src/lib/provider/runner/session-runner.js").SessionCommand,
					{ type: "send-turn" }
				>,
			) => admitRunnerCommand(provider, manager, command),
			sendHandles,
			input,
			attachments,
			pending,
			replaySend,
			sending,
			destroyed,
			commands,
			replacementGate,
			replacementConnecting,
			replacementReady,
			replayLoss,
			accountsGate,
			outputs,
			retained,
			background,
			output,
		};
	});

it.effect(
	"a lost attachment after replay fails the attach, not the retained send",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture(
					false,
					undefined,
					(_accountId, work) => work,
				);
				yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at)
					VALUES (1, 'retained', 'test-project', 's', 'account', 'send_turn', '{}', 'running', 0, 1, 1)`;
				f.replayLoss.armed = true;
				const recovery = yield* Effect.forkChild(f.manager.recoverEffect);
				yield* TestClock.adjust("10 seconds");
				yield* Fiber.join(recovery);
				expect(f.replayLoss.armed).toBe(false);
				// Recovery retried the attach and the send stayed live.
				expect(f.attachments).toHaveLength(2);
				expect(f.outputs).toEqual([]);
				expect(f.retained.has("retained")).toBe(true);
			}),
		),
);

it.effect("whole-manager recovery holds upgrades back until it ends", () =>
	runRetirement(
		Effect.gen(function* () {
			const f = yield* retirementFixture(false);
			const hold = yield* Deferred.make<void>();
			const connect = vi.mocked(f.driver.connect).getMockImplementation();
			if (!connect) return yield* Effect.die("missing connect");
			// The previous build's runner parks recovery's owner-send sweep after it attaches.
			vi.mocked(f.driver.connect).mockImplementationOnce((options) =>
				connect({
					...options,
					onHello: (hello, connection, replay) =>
						options
							.onHello(
								{ ...hello, buildId: "previous-build" },
								connection,
								replay,
							)
							.pipe(
								Effect.tap(() =>
									Effect.sync(() => {
										f.accountsGate.hold = hold;
									}),
								),
							),
				}),
			);
			const recovery = yield* Effect.forkChild(f.manager.recoverEffect);
			yield* TestClock.adjust(0);
			const old = f.attachments[0];
			if (!old?.onUpgradeState)
				return yield* Effect.die("missing upgrade callback");
			old.onUpgradeState({
				quiescent: true,
				revision: 1,
				snapshot: {
					input: {
						...f.input,
						configDir: configuredClaudeConfigDir(f.root),
						folderSource: "implicitDefault",
					},
					options: {},
				},
			});
			yield* TestClock.adjust("4 seconds");
			expect(f.attachments).toHaveLength(1);
			delete f.accountsGate.hold;
			yield* Deferred.succeed(hold, undefined);
			yield* Fiber.join(recovery);
			yield* TestClock.adjust("4 seconds");
			expect(f.attachments.length).toBeGreaterThan(1);
		}),
	),
);

it.effect(
	"S7 recovery requeues a missing send without dispatch or visible events",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture(undefined, undefined, "cursor");
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('s7-run', 's', 'pending', 1)`;
				yield* (yield* makeCommitAndSignal)([
					canonicalEvent("run.dispatched", "s", {
						runId: "s7-run",
						runnerId: "131313131313",
					}),
				]);
				yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at, run_id)
		VALUES (7, 's7-command', 'test-project', 's', 'account', 'send_turn', ${JSON.stringify({ ...f.input, prompt: "queued", history: [] })}, 'running', 2, 1, 1, 's7-run')`;
				yield* f.instance.recoverProjectContextsEffect(() =>
					Effect.succeed(undefined),
				);
				expect(
					yield* f.sql`SELECT status, attempt_count, request_sequence, run_id, next_attempt_at FROM provider_command_outbox WHERE command_id = 's7-command'`,
				).toEqual([
					{
						status: "retryable_failed",
						attempt_count: 2,
						request_sequence: 7,
						run_id: "s7-run",
						next_attempt_at: expect.any(Number),
					},
				]);
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
				expect(f.sendHandles).toEqual([]);
				expect(f.terminalCount()).toBe(0);
			}),
		),
);

it.effect(
	"R2 missing journal answer preserves owner intake and retained steer replay",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture();
				yield* f.seed("active-owner");
				yield* f.seed("joined-steer", 2);
				yield* f.sql`UPDATE provider_runs SET status='running', started_at=1 WHERE id='run:active-owner'`;
				yield* f.sql`UPDATE provider_runs SET status='joined', joined_into='run:active-owner' WHERE id='run:joined-steer'`;
				yield* f.hello((hello) => ({
					...hello,
					bindings: [],
					sendAnswers: [],
					sendJournalAnswers: true,
				}));
				yield* f.recover;
				expect(
					yield* f.sql`SELECT command_id, status FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([
					{ command_id: "active-owner", status: "running" },
					{ command_id: "joined-steer", status: "retryable_failed" },
				]);
				expect(
					yield* f.sql`SELECT id, status FROM provider_runs ORDER BY id`,
				).toEqual([
					{ id: "run:active-owner", status: "running" },
					{ id: "run:joined-steer", status: "joined" },
				]);
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
			}),
		),
);

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

const sendScopeFixture = (
	accountResources?: RunnerProviderInstanceDeps["accountResources"],
	managerAccountScope?: ProcessRunnerDriver["withAccountScope"],
	driverKind: "claude" | "cursor" = "claude",
	recoveryForSession?: RunnerProviderInstanceDeps["recoveryForSession"],
) =>
	Effect.gen(function* () {
		const account = { acquired: 0, released: 0 };
		const f = yield* retirementFixture(
			false,
			recoveryForSession,
			(_id, work) =>
				Effect.acquireUseRelease(
					Effect.sync(() => account.acquired++),
					() => managerAccountScope?.(_id, work) ?? work,
					() => Effect.sync(() => account.released++),
				),
			driverKind === "cursor" ? [] : ["retained"],
			driverKind,
		);
		const accounts = accountsStateFromInstances(
			[{ id: "account", driver: driverKind, name: "Account" }],
			configuredClaudeConfigDir(f.root),
		);
		const commit = yield* makeCommitAndSignal;
		const store = yield* EventStoreEffectTag;
		yield* commit([
			canonicalEvent(
				"session.created",
				"s",
				{ sessionId: "s", title: "Send scope", provider: "claude" },
				{ provider: "claude" },
			),
		]);
		const eventSink = createMockEventSink();
		const abort = new AbortController();
		const removed = vi.spyOn(abort.signal, "removeEventListener");
		const input = makeBaseSendTurnInput({
			...f.input,
			inputId: "scoped-input",
			account: accounts.accounts[0],
			eventSink,
			abortSignal: abort.signal,
		});
		const sinkId = runnerSinkId(input.inputId);
		const record = f.output.getMockImplementation();
		if (!record) return yield* Effect.die("missing output recorder");
		let preparedRuns = 0;
		let preparedRunId: string | undefined;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const instance = yield* makeRunnerProviderInstance(
			{
				daemonConfigDir: f.root,
				accounts: Effect.succeed(accounts),
				...(accountResources ? { accountResources } : {}),
			},
			{
				driverKind,
				discoverEffect: () => Effect.die("unused discovery"),
				generateTextEffect: () => Effect.die("unused generation"),
				prepareTurnEffect: (input) =>
					Effect.gen(function* () {
						const runId = input.runId ?? `fixture-send-scope:${++preparedRuns}`;
						preparedRunId = runId;
						if (!input.runId)
							yield* commit
								.write((project) =>
									Effect.gen(function* () {
										yield* project(
											yield* store.appendBatch([
												canonicalEvent("run.requested", input.sessionId, {
													runId,
													inputId: input.inputId,
												}),
											]),
										);
										// A real send is claimed durably before manager dispatch. Its row
										// lets retirement distinguish delivery evidence from an old cohort.
										const [next] = yield* f.sql<{
											sequence: number;
										}>`SELECT COALESCE(MAX(request_sequence), 0) + 1 AS sequence FROM provider_command_outbox`;
										const sequence = next?.sequence ?? 1;
										const commandId = input.inputId;
										yield* f.sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, command_type, project_key, fingerprint_hash, fingerprint_version, side_effect_sequence, updated_at)
										VALUES (${commandId}, ${input.sessionId}, 'side_effect_requested', 1, 'send_turn', 'test-project', 'sha256:send-scope', 1, ${sequence}, 1)
										ON CONFLICT (command_id) DO UPDATE SET status = 'side_effect_requested'`;
										yield* f.sql`DELETE FROM provider_command_outbox WHERE command_id = ${commandId}`;
										yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at, run_id)
										VALUES (${sequence}, ${commandId}, 'test-project', ${input.sessionId}, ${input.account?.id ?? driverKind}, 'send_turn', ${JSON.stringify({ ...input, runId })}, 'running', ${input.commandAttempt ?? 0}, 1, 1, ${runId})`;
									}),
								)
								.pipe(Effect.orDie);
						return {
							input: {
								...input,
								runId,
								prompt: input.text ?? "send",
								history: [],
								facts: { _tag: "Claude" as const },
							},
						};
					}),
			},
			(emit) => {
				f.output.mockImplementation((output, sessionId, send) =>
					record(output, sessionId, send).pipe(
						Effect.andThen(emit(output, sessionId, send)),
					),
				);
				return Effect.succeed(f.manager);
			},
		);
		const terminalCount = () =>
			vi
				.mocked(eventSink.push)
				.mock.calls.filter(([event]) =>
					["turn.completed", "turn.error", "turn.interrupted"].includes(
						event.type,
					),
				).length;
		const terminal = (
			type: "turn.completed" | "turn.interrupted" | "turn.error",
			runId = preparedRunId,
		) =>
			Effect.gen(function* () {
				const attachment = f.attachments.at(-1);
				if (!attachment) return yield* Effect.die("missing send attachment");
				const event = {
					eventId: `scoped-${type}:${runId ?? "unowned"}`,
					type,
					providerId: "claude",
					sessionId: "s",
					...(runId ? { runId } : {}),
					providerRefs: {},
					rawSource: { kind: "test" },
					createdAt: 1,
					data:
						type === "turn.error"
							? { code: "provider_failure", message: "native send rejected" }
							: { messageId: "", duration: 0 },
				};
				yield* attachment.emit({ type: "event", sinkId, event }, "s");
				yield* ingestion
					.ingest(event)
					.pipe(
						Effect.mapError((cause) =>
							runnerFailure("test native terminal", cause),
						),
					);
			});
		const assertReleased = (acceptCommands = true) =>
			Effect.gen(function* () {
				yield* TestClock.adjust(0);
				expect(account.acquired).toBe(1);
				expect(account.released).toBe(1);
				expect(
					removed.mock.calls.filter(([type]) => type === "abort"),
				).toHaveLength(1);
				expect(
					f.outputs.filter(
						(output) =>
							output.type === "release-sink" && output.sinkId === sinkId,
					),
				).toHaveLength(1);
				if (acceptCommands) {
					const commands = f.commands.length;
					yield* f.manager.executeEffect({ type: "abort", sinkId });
					expect(f.commands).toHaveLength(commands);
				}
				const pushed = vi.mocked(eventSink.push).mock.calls.length;
				yield* instance.handleOutputEffect({
					type: "event",
					sinkId,
					event: {
						eventId: "late-closed-send",
						type: "turn.notice",
						providerId: "claude",
						sessionId: "s",
						providerRefs: {},
						rawSource: { kind: "test" },
						createdAt: 1,
						data: { text: "closed" },
					},
				});
				expect(vi.mocked(eventSink.push).mock.calls).toHaveLength(pushed);
			});
		return {
			...f,
			instance,
			acceptStop: commit.write(() =>
				Effect.gen(function* () {
					const owners = yield* f.sql<{
						runId: string;
					}>`SELECT id AS runId FROM provider_runs WHERE session_id = 's' AND status IN ('pending', 'running')`;
					const [next] = yield* f.sql<{
						sequence: number;
					}>`SELECT COALESCE(MAX(request_sequence), 0) + 1 AS sequence FROM provider_command_outbox`;
					yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at)
				VALUES (${next?.sequence ?? 1}, ${`stop:${owners.map(({ runId }) => runId).join(":")}`}, 'test-project', 's', 'account', 'interrupt_turn', ${JSON.stringify({ type: "interrupt_turn", sessionId: "s", stop: { owners, turnIds: owners.map(({ runId }) => runId), deadlineAt: 3000, runnerBacked: true, retainedSteers: false } })}, 'completed', 1, 1)`;
				}),
			),
			account,
			input,
			sinkId,
			eventSink,
			abort,
			removed,
			terminal,
			terminalCount,
			assertReleased,
		};
	});

it.effect(
	"a send starts from the durable serving slot while the previous stop cache is stale",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				yield* f.manager.recoverEffect;
				const old = f.attachments[0];
				if (!old) return yield* Effect.die("missing old runner");
				// release invokes its feeder wake after this commit and before afterStop
				// refreshes the reconciler's route cache. Keep that committed snapshot.
				yield* f.sql`UPDATE claude_runner_cursors SET retired_at = 1, stop_state = 'Requested', stop_reason = '{"_tag":"Idle"}' WHERE runner_id = ${old.runnerId}`;
				const sending = yield* f.instance
					.sendTurnEffect(f.input)
					.pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				expect(f.attachments).toHaveLength(1);
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
				expect(f.terminalCount()).toBe(0);
				yield* TestClock.adjust("4001 millis");
				expect(f.attachments).toHaveLength(2);
				const replacement = f.attachments[1];
				if (!replacement)
					return yield* Effect.die("missing replacement runner");
				expect((yield* Fiber.join(sending)).status).toBe("completed");
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([{ runnerId: replacement.runnerId, type: "send-turn" }]);
				expect(
					yield* f.sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = (SELECT run_id FROM provider_command_outbox WHERE command_id = ${f.input.inputId})`,
				).toEqual([{ runner_id: replacement.runnerId, held_transmission: 1 }]);
				yield* f.terminal("turn.completed");
			}),
		),
);

it.effect(
	// C 4.7: an admission timeout is a daemon refusal, so the held send is released
	// unwritten and settled permanently, never requeued.
	"a held send whose local admission times out before the socket write settles permanently",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				yield* f.manager.recoverEffect;
				const old = f.attachments[0];
				if (!old?.onUpgradeState)
					return yield* Effect.die("missing old runner");
				old.onUpgradeState({
					quiescent: false,
					turnInFlight: true,
					revision: 1,
					snapshot: {
						input: {
							...f.input,
							configDir: configuredClaudeConfigDir(f.root),
							folderSource: "implicitDefault",
						},
						options: {},
					},
				});
				const nextRoot = join(f.root, "next-workspace");
				const sending = yield* f.instance
					.sendTurnEffect({ ...f.input, workspaceRoot: nextRoot })
					.pipe(Effect.forkChild);
				yield* TestClock.adjust("1100 millis");
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.reason') AS reason FROM events WHERE type = 'run.released'`,
				).toEqual([{ reason: "NotSent" }]);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = ${f.input.inputId}`,
				).toEqual([{ status: "failed", error_code: "send_admission_timeout" }]);
				expect(
					yield* f.sql`SELECT json_extract(data, '$.code') AS code FROM events WHERE type = 'turn.error'`,
				).toEqual([{ code: "send_admission_timeout" }]);
				expect((yield* Fiber.join(sending)).status).toBe("cancelled");
				old.onUpgradeState({
					quiescent: true,
					turnInFlight: false,
					revision: 2,
					snapshot: {
						input: {
							...f.input,
							configDir: configuredClaudeConfigDir(f.root),
							workspaceRoot: nextRoot,
							folderSource: "implicitDefault",
						},
						options: {},
					},
				});
				yield* TestClock.adjust("30 seconds");
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
			}),
		),
);

it.effect(
	"an interrupted caller's committed hold continues on the live manager without a restart",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				const bus = yield* SessionEventBusTag;
				const committed = yield* Deferred.make<void>();
				const reply = yield* Deferred.make<void>();
				const publish = bus.publish;
				let paused = false;
				const block = vi
					.spyOn(bus, "publish")
					.mockImplementation((events, ended) =>
						publish(events, ended).pipe(
							Effect.andThen(
								Effect.suspend(() => {
									if (
										paused ||
										!events.some((event) => event.type === "run.dispatched")
									)
										return Effect.void;
									paused = true;
									return Deferred.succeed(committed, undefined).pipe(
										Effect.andThen(Deferred.await(reply)),
									);
								}),
							),
						),
					);
				yield* Effect.gen(function* () {
					const sending = yield* f.instance
						.sendTurnEffect(f.input)
						.pipe(Effect.forkChild);
					yield* Deferred.await(committed);
					yield* TestClock.adjust(0);
					expect(
						f.commands.filter((command) => command.type === "send-turn"),
					).toEqual([]);
					yield* Fiber.interrupt(sending);
					expect(f.terminalCount()).toBe(0);
					yield* Deferred.succeed(reply, undefined);
					yield* TestClock.adjust(0);
					expect(
						yield* f.sql`SELECT type, json_extract(data, '$.transmission') AS transmission FROM events WHERE type IN ('run.dispatched', 'run.released') ORDER BY rowid`,
					).toEqual([{ type: "run.dispatched", transmission: 1 }]);
					expect(
						f.commands.filter((command) => command.type === "send-turn"),
					).toHaveLength(1);
					expect(
						yield* f.sql`SELECT COUNT(DISTINCT id) AS runs FROM provider_runs`,
					).toEqual([{ runs: 1 }]);
					// The host fixture returns the command receipt separately from the
					// native terminal event, just as a real runner delivers both frames.
					yield* f.terminal("turn.completed");
					expect(
						yield* f.sql`SELECT COUNT(*) AS terminals FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([{ terminals: 1 }]);
				}).pipe(
					Effect.ensuring(Deferred.succeed(reply, undefined)),
					Effect.ensuring(Effect.sync(() => block.mockRestore())),
				);
			}),
		),
);

const s7Fixture = (
	driverKind: "claude" | "cursor" = "cursor",
	isProjectReady?: ProviderSideEffectReactorOptions["isProjectReady"],
) =>
	Effect.gen(function* () {
		let recovery: RunnerRecoveryDependencies | undefined;
		const f = yield* sendScopeFixture(undefined, undefined, driverKind, () =>
			Effect.succeed(recovery),
		);
		const persist = yield* ClaudeEventPersistEffectTag;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const commit = yield* makeCommitAndSignal;
		const eventStore = yield* EventStoreEffectTag;
		const discover = runnerRegistry.discoverAllRunners;
		const discovery = vi
			.spyOn(runnerRegistry, "discoverAllRunners")
			.mockImplementation((config) => discover(config, f.processTable));
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => discovery.mockRestore()),
		);
		const wakes: Array<
			ReadonlyArray<{ readonly command_id: string; readonly status: string }>
		> = [];
		recovery = {
			projectId: "test-project",
			ingestion,
			pending: yield* PendingInteractionServiceTag,
			persist,
			timeoutHooks: {},
			resolveCallContext: () => Effect.die("unused recovery context"),
			retirePrompts: () => Effect.succeed(0),
			wakeReactor: Effect.gen(function* () {
				wakes.push(
					yield* f.sql<{
						readonly command_id: string;
						readonly status: string;
					}>`SELECT command_id, status FROM provider_command_outbox ORDER BY request_sequence`,
				);
			}).pipe(Effect.orDie),
		};
		const reactor = new ProviderSideEffectReactor({
			projectId: "test-project",
			sql: f.sql,
			registry: new ProviderRegistry([f.instance]),
			ingestion,
			write: commit.write,
			...(isProjectReady ? { isProjectReady } : {}),
			persistUserMessage: (...args) => persist.persistUserMessage(...args),
		});
		const seed = (
			commandId: string,
			sequence = 1,
			attempt = 1,
			transmission: "legacy" | "held" = "legacy",
		) =>
			Effect.gen(function* () {
				const input = {
					...f.input,
					inputId: commandId,
					runId: `run:${commandId}`,
					prompt: `text ${commandId}`,
					text: `text ${commandId}`,
					history: [],
				};
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES (${input.runId}, 's', 'pending', 1)`;
				yield* f.sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, command_type, project_key, fingerprint_hash, fingerprint_version, side_effect_sequence, updated_at)
				VALUES (${commandId}, 's', 'side_effect_requested', 1, 'send_turn', 'test-project', 'sha256:s7', 1, ${sequence}, 1)`;
				yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at, run_id)
				VALUES (${sequence}, ${commandId}, 'test-project', 's', 'account', 'send_turn', ${JSON.stringify(input)}, 'running', ${attempt}, 1, 1, ${input.runId})`;
				if (attempt === 0)
					yield* f.sql`UPDATE provider_command_outbox SET status = 'pending' WHERE command_id = ${commandId}`;
				// Attempt zero is a queued successor that has never been transmitted.
				// Older transmitted sends retain the command-less legacy dispatch.
				if (attempt > 0)
					yield* commit([
						canonicalEvent(
							"run.dispatched",
							"s",
							{
								runId: input.runId,
								runnerId: "131313131313",
								...(transmission === "held"
									? { commandId, transmission: 1 }
									: {}),
							},
							{ provider: driverKind, metadata: { runId: input.runId } },
						),
					]);
				return input;
			});
		const hello = (transform: (hello: RunnerHello) => RunnerHello) => {
			const connect = vi.mocked(f.driver.connect).getMockImplementation();
			if (!connect) return Effect.die("missing fixture connection");
			vi.mocked(f.driver.connect).mockImplementation((options) =>
				connect({
					...options,
					onHello: (hello, connection, replay) => {
						const retained = transform(hello);
						Object.defineProperty(connection, "retainedSends", {
							configurable: true,
							get: () => retained.sendTokens,
						});
						return f.sql`UPDATE claude_runner_cursors SET journals_before_execution = ${Number(!isLegacyRunner(retained))} WHERE runner_id = ${options.runnerId}`.pipe(
							Effect.orDie,
							Effect.andThen(options.onHello(retained, connection, replay)),
						);
					},
				}),
			);
			return Effect.void;
		};
		const reply = (
			input: Parameters<typeof f.instance.sendTurnEffect>[0],
			result: TurnResult,
		) =>
			Effect.gen(function* () {
				if (!input.runId) return yield* Effect.die("Missing send run");
				if (yield* legacyRunnerRunQuery(f.sql, input.sessionId, input.runId))
					return result;
				const [command] = yield* f.sql<{
					command_id: string;
				}>`SELECT command_id FROM provider_command_outbox
					WHERE session_id = ${input.sessionId} AND run_id = ${input.runId}
					ORDER BY request_sequence DESC LIMIT 1`;
				if (!command) return yield* Effect.die("Missing send command");
				const hold = yield* makeRunnerRunLifecycle({
					sql: f.sql,
					commit,
					eventStore,
				}).holdRun({
					sessionId: input.sessionId,
					runId: input.runId,
					commandId: command.command_id,
				});
				if (hold._tag !== "Held")
					return yield* Effect.die("Missing test transmission");
				return {
					...result,
					runnerSend: {
						runnerId: hold.runner,
						transmission: hold.transmission,
					},
				};
			}).pipe(Effect.orDie);
		return {
			...f,
			reply,
			persist,
			ingestion,
			reactor,
			recovery,
			wakes,
			seed,
			hello,
			recover: f.instance.recoverProjectContextsEffect(() =>
				Effect.succeed(recovery),
			),
		};
	});

// S10 answer mapping must not reconstruct journal state from legacy hello fields.
for (const answer of ["running", "finished", "uncertain", "absent"] as const)
	it.effect(`S10 current journal ${answer} owns or settles the send once`, () =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture();
				yield* f.seed(
					"answer",
					1,
					1,
					answer === "uncertain" ? "held" : "legacy",
				);
				yield* f.seed("answer-next", 2, 0);
				if (answer === "finished") {
					yield* f.sql`CREATE TEMP TABLE s10_finished_writes (command_id TEXT)`;
					yield* f.sql`CREATE TEMP TRIGGER s10_finished_write AFTER UPDATE ON provider_command_outbox WHEN NEW.command_id = 'answer' AND NEW.status = 'completed' BEGIN INSERT INTO s10_finished_writes VALUES (NEW.command_id); END`;
				}
				const result = {
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				} satisfies TurnResult;
				// A held send's token is its hold's transmission, else its claim's.
				const token = sendToken(
					answer === "uncertain" ? "hold" : "tx",
					"answer",
					1,
				);
				yield* f.hello((hello) => ({
					...hello,
					sendJournalAnswers: true,
					sendAnswers:
						answer === "absent"
							? []
							: [
									{
										token,
										status: answer,
										...(answer === "finished" ? { result } : {}),
									},
								],
					bindings:
						answer === "running"
							? [
									{
										token,
										sessionId: "s",
										sinkId: runnerSinkId("answer", 1),
										released: false,
									},
								]
							: [],
					sendTokens: answer === "absent" ? [] : [token],
					completedCommands: [],
				}));
				yield* f.recover;
				if (answer === "finished") {
					const attachment = f.attachments[0];
					if (!attachment?.onCommandReply)
						return yield* Effect.die("missing answer reply handler");
					const reply = {
						type: "command-reply",
						commandId: token,
						result,
					} as const;
					yield* attachment.onCommandReply(reply);
					yield* attachment.onCommandReply(reply);
					expect(
						yield* f.sql`SELECT command_id FROM s10_finished_writes`,
					).toEqual([{ command_id: "answer" }]);
				}
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'answer'`,
				).toEqual([
					{
						status:
							answer === "running" || answer === "uncertain"
								? "running"
								: answer === "finished"
									? "completed"
									: "retryable_failed",
						error_code: null,
					},
				]);
				expect(f.sendHandles).toHaveLength(answer === "running" ? 1 : 0);
				const send = vi
					.spyOn(f.instance, "sendTurnEffect")
					.mockImplementation((input) => f.reply(input, result));
				yield* f.reactor.drain();
				yield* f.reactor.drain();
				if (answer === "running" || answer === "uncertain")
					expect(send).not.toHaveBeenCalled();
				else {
					expect(send.mock.calls.map(([input]) => input.inputId)).toEqual(
						answer === "absent" ? ["answer", "answer-next"] : ["answer-next"],
					);
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id = 'answer-next'`,
					).toEqual([{ status: "completed" }]);
				}
				if (answer === "uncertain")
					expect(
						yield* f.sql`SELECT status, runner_id, held_transmission FROM provider_runs WHERE id = 'run:answer'`,
					).toEqual([
						{
							status: "pending",
							runner_id: "131313131313",
							held_transmission: 1,
						},
					]);
			}),
		),
	);

for (const status of ["accepted", "joined", "indeterminate"] as const)
	for (const fallback of [false, true])
		it.effect(
			`S10 finished ${status} answer retains native output and account ownership (fallback=${fallback})`,
			() =>
				runRetirement(
					Effect.gen(function* () {
						const f = yield* s7Fixture("claude");
						yield* f.seed("native-held");
						yield* f.seed("native-next", 2, 0);
						const result: TurnResult = {
							status,
							cost: 0,
							tokens: { input: 0, output: 0 },
							durationMs: 0,
							providerStateUpdates: [],
						};
						const sinkId = runnerSinkId("native-held", 1, fallback);
						// The send's mode lives on its payload; its token is the claim's.
						if (fallback)
							yield* f.sql`UPDATE provider_command_outbox SET payload_json = json_set(payload_json, '$.nativeResumeFallback', json('true')) WHERE command_id = 'native-held'`;
						const token = sendToken("tx", "native-held", 1);
						yield* f.hello((hello) => ({
							...hello,
							sendTokens: [],
							bindings: [{ token, sessionId: "s", sinkId, released: false }],
							sendJournalAnswers: true,
							sendAnswers: [{ status: "finished", token, result }],
						}));
						yield* f.recover;
						expect(f.sendHandles).toHaveLength(1);
						expect(f.account).toEqual({ acquired: 1, released: 0 });
						expect(
							yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id = 'native-held'`,
						).toEqual([{ status: "running" }]);
						const send = vi.spyOn(f.instance, "sendTurnEffect").mockReturnValue(
							Effect.succeed({
								status: "completed",
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 0,
								providerStateUpdates: [],
							}),
						);
						yield* f.reactor.drain();
						expect(send).not.toHaveBeenCalled();
						const attachment = f.attachments[0];
						if (!attachment)
							return yield* Effect.die("Missing native attachment");
						for (const type of ["run.started", "turn.completed"] as const)
							yield* attachment.emit(
								{
									type: "event",
									sinkId,
									event: {
										eventId: `native-held:${type}`,
										type,
										providerId: "claude",
										sessionId: "s",
										runId: "run:native-held",
										providerRefs: {},
										rawSource: { kind: "test.native" },
										createdAt: 3,
										data:
											type === "run.started"
												? {
														inputId: "native-held",
														requestedRunId: "run:native-held",
													}
												: { messageId: "", duration: 1 },
									},
								},
								"s",
							);
						yield* attachment.emit({ type: "release-sink", sinkId }, "s");
						yield* Effect.all([f.reactor.drain(), f.reactor.drain()]);
						expect(send).toHaveBeenCalledTimes(1);
						expect(send.mock.calls[0]?.[0].inputId).toBe("native-next");
						expect(f.account).toEqual({ acquired: 1, released: 1 });
						expect(f.sendHandles[0]?.assignment._tag).toBe("Closed");
						expect(
							f.commands.filter((command) => command.type === "send-turn"),
						).toEqual([]);
						expect(
							yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id = 'native-held'`,
						).toEqual([{ status: "completed" }]);
						expect(
							yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
						).toEqual([{ type: "turn.completed" }]);
					}),
				),
		);

it.effect(
	"S10 main attachment retry never replays on the previous closed connection",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture();
				yield* f.seed("attach-retry");
				yield* f.seed("attach-next", 2, 0);
				yield* f.sql`UPDATE provider_command_outbox SET status='pending' WHERE command_id='attach-next'`;
				yield* f.sql`CREATE TEMP TABLE s10_attach_settled (command_id TEXT)`;
				yield* f.sql`CREATE TEMP TRIGGER s10_attach_settled AFTER UPDATE ON provider_command_outbox WHEN NEW.command_id='attach-retry' AND NEW.status='completed' BEGIN INSERT INTO s10_attach_settled VALUES (NEW.command_id); END`;
				vi.spyOn(f.processTable, "signal").mockImplementation(() => {
					f.processes.delete(100_088);
				});
				const result = {
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				} satisfies TurnResult;
				const journal = new MainRunnerSendJournal(
					runnerRegistry.runnerDirectory(f.root, f.root),
					"s",
					"cursor",
				);
				// An older build keys a send by the frame id it was sent, attempt 0.
				const token = sendToken("tx", "attach-retry", 1);
				yield* journal.execute(token, 0, false, Effect.succeed(result));
				const replayed = vi.fn();
				f.replaySend.execute = (id, command) =>
					Effect.sync(() => replayed()).pipe(
						Effect.andThen(
							journal.execute(
								id,
								0,
								command.input.nativeResumeFallback === true,
								Effect.die("cached retry key must not execute"),
							),
						),
					);
				yield* f.hello(
					({
						sendJournalAnswers: _capability,
						sendAnswers: _answers,
						...hello
					}) => ({
						...hello,
						bindings: [],
						sendTokens: [token],
						completedCommands: [],
					}),
				);
				const firstClosed = yield* Deferred.make<void>();
				const oldCommand = vi.fn(() =>
					Effect.fail(runnerFailure("send-turn", "old connection is closed")),
				);
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect) return yield* Effect.die("missing retry connection");
				let first = true;
				vi.mocked(f.driver.connect).mockImplementation((options) =>
					connect(options).pipe(
						Effect.tap((connection) => {
							if (!first) return Effect.void;
							first = false;
							Object.assign(connection, { closed: true });
							vi.spyOn(connection, "commandEffect").mockImplementation(
								oldCommand,
							);
							return Deferred.succeed(firstClosed, undefined);
						}),
					),
				);
				const recovering = yield* f.recover.pipe(Effect.forkChild);
				yield* Deferred.await(firstClosed);
				yield* TestClock.adjust("150 millis");
				yield* Fiber.join(recovering);
				yield* TestClock.adjust("6 seconds");
				expect(f.attachments).toHaveLength(2);
				expect(oldCommand).not.toHaveBeenCalled();
				expect(replayed).toHaveBeenCalledTimes(1);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id='attach-retry'`,
				).toEqual([{ status: "completed" }]);
				expect(yield* f.sql`SELECT command_id FROM s10_attach_settled`).toEqual(
					[{ command_id: "attach-retry" }],
				);
				expect(f.sendHandles.map((send) => send.assignment._tag)).toEqual([
					"Closed",
				]);
				expect(f.account).toEqual({ acquired: 1, released: 1 });
				const next = vi
					.spyOn(f.instance, "sendTurnEffect")
					.mockImplementation((input) => f.reply(input, result));
				yield* f.reactor.drain();
				yield* f.reactor.drain();
				expect(next.mock.calls.map(([input]) => input.inputId)).toEqual([
					"attach-next",
				]);
			}),
		),
);

it.effect(
	"S10 main cached reply settlement failure during held hello cannot lose the send owner",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture();
				yield* f.seed("main-race");
				vi.spyOn(f.processTable, "signal").mockImplementation(() => {
					f.processes.delete(100_088);
				});
				const result = {
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				} satisfies TurnResult;
				const journal = new MainRunnerSendJournal(
					runnerRegistry.runnerDirectory(f.root, f.root),
					"s",
					"cursor",
				);
				const token = sendToken("tx", "main-race", 1);
				yield* journal.execute(token, 0, false, Effect.succeed(result));
				f.replaySend.execute = (id, command) =>
					journal.execute(
						id,
						0,
						command.input.nativeResumeFallback === true,
						Effect.die("cached main key must not execute"),
					);
				yield* f.hello(
					({
						sendJournalAnswers: _capability,
						sendAnswers: _answers,
						...hello
					}) => ({
						...hello,
						bindings: [],
						sendTokens: [token],
						completedCommands: [],
					}),
				);
				const sqlConnection = yield* Effect.scoped(f.sql.reserve);
				const execute = sqlConnection.execute;
				let storeAvailable = false;
				const failedWrite = vi
					.spyOn(sqlConnection, "execute")
					.mockImplementation((query, params, transform) =>
						Effect.suspend(() =>
							!storeAvailable &&
							query.includes("UPDATE provider_command_outbox") &&
							params.includes("completed")
								? Effect.fail(
										new SqlError({
											reason: new ConnectionError({
												cause: "S10 cached reply write unavailable",
											}),
										}),
									)
								: execute(query, params, transform),
						),
					);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => failedWrite.mockRestore()),
				);
				const helloDone = yield* Deferred.make<void>();
				const releaseHello = yield* Deferred.make<void>();
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect) return yield* Effect.die("missing race connection");
				vi.mocked(f.driver.connect).mockImplementation((options) =>
					connect({
						...options,
						onHello: (hello, connection, replay) =>
							options
								.onHello(hello, connection, replay)
								.pipe(
									Effect.andThen(Deferred.succeed(helloDone, undefined)),
									Effect.andThen(Deferred.await(releaseHello)),
								),
					}),
				);
				const recovering = yield* f.recover.pipe(Effect.forkChild);
				yield* Deferred.await(helloDone);
				yield* TestClock.adjust(0);
				yield* Deferred.succeed(releaseHello, undefined);
				yield* TestClock.adjust("6 seconds");
				yield* Fiber.join(recovering);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id='main-race'`,
				).toEqual([{ status: "running" }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.error', 'turn.interrupted')`,
				).toEqual([]);
				storeAvailable = true;
				yield* TestClock.adjust("30 seconds");
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id='main-race'`,
				).toEqual([{ status: "completed" }]);
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id='run:main-race'`,
				).toEqual([{ status: "completed" }]);
			}),
		),
);

for (const binding of ["missing", "released"] as const)
	it.effect(
		`S10 current running answer owns the send with ${binding} output binding`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture();
					yield* f.seed("owned-answer");
					yield* f.seed("owned-next", 2, 0);
					const token = sendToken("tx", "owned-answer", 1);
					yield* f.hello((hello) => ({
						...hello,
						sendJournalAnswers: true,
						sendTokens: [token],
						sendAnswers: [{ token, status: "running" }],
						bindings:
							binding === "missing"
								? []
								: [
										{
											token,
											sinkId: runnerSinkId("owned-answer", 1),
											sessionId: "s",
											released: true,
										},
									],
					}));
					yield* f.recover;
					expect(f.sendHandles).toHaveLength(1);
					expect(
						yield* f.sql`SELECT status,error_code FROM provider_command_outbox WHERE command_id='owned-answer'`,
					).toEqual([{ status: "running", error_code: null }]);
					const result = {
						status: "completed",
						cost: 0,
						tokens: { input: 0, output: 0 },
						durationMs: 0,
						providerStateUpdates: [],
					} satisfies TurnResult;
					const send = vi
						.spyOn(f.instance, "sendTurnEffect")
						.mockImplementation((input) => f.reply(input, result));
					yield* f.reactor.drain();
					expect(send).not.toHaveBeenCalled();
					const attachment = f.attachments[0];
					if (!attachment?.onCommandReply)
						return yield* Effect.die("missing owned-answer attachment");
					yield* attachment.onCommandReply({
						type: "command-reply",
						commandId: token,
						result,
					});
					yield* f.reactor.drain();
					yield* f.reactor.drain();
					expect(send.mock.calls.map(([input]) => input.inputId)).toEqual([
						"owned-next",
					]);
				}),
			),
	);

for (const scenario of [
	"attemptless historical completion",
	"finished inherited sendCommands",
	"unfinished inherited sendCommands",
	"replayed cached key",
	// The claim's send went out before main held the run: it keeps its claim's token.
	"replayed cached key once held",
	"input-keyed live retry",
	"started without dispatch",
	"transmitted before start without dispatch",
] as const)
	it.effect(
		`S10 main replay ${scenario} follows main journal semantics and unblocks the next send`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture();
					const committed = yield* Deferred.make<void>();
					const wake = f.recovery.wakeReactor ?? Effect.void;
					Object.assign(f.recovery, {
						wakeReactor: Effect.gen(function* () {
							yield* wake;
							const [command] = yield* f.sql<{
								status: string;
							}>`SELECT status FROM provider_command_outbox WHERE command_id = 'main-command'`;
							if (command?.status === "completed")
								yield* Deferred.succeed(committed, undefined);
						}).pipe(Effect.orDie),
					});
					const attempt =
						scenario === "attemptless historical completion" ||
						scenario === "input-keyed live retry"
							? 2
							: 1;
					yield* f.seed(
						"main-command",
						1,
						attempt,
						scenario === "replayed cached key once held" ? "held" : "legacy",
					);
					if (scenario.endsWith("without dispatch")) {
						yield* f.sql`DELETE FROM events WHERE type = 'run.dispatched' AND json_extract(data, '$.runId') = 'run:main-command'`;
						yield* f.sql`UPDATE provider_runs SET runner_id = NULL, held_transmission = NULL,
							status = ${scenario === "started without dispatch" ? "running" : "pending"},
							started_at = ${scenario === "started without dispatch" ? 1 : null}
						WHERE id = 'run:main-command'`;
						yield* f.sql`CREATE TEMP TABLE r2_legacy_completed (command_id TEXT)`;
						yield* f.sql`CREATE TEMP TRIGGER r2_legacy_completed_write AFTER UPDATE ON provider_command_outbox
						WHEN OLD.status <> 'completed' AND NEW.command_id = 'main-command' AND NEW.status = 'completed'
						BEGIN INSERT INTO r2_legacy_completed VALUES (NEW.command_id); END`;
					}
					yield* f.seed("main-next", 2, 0);
					yield* f.sql`UPDATE provider_command_outbox SET status = 'pending' WHERE command_id = 'main-next'`;
					const inputId =
						scenario === "input-keyed live retry"
							? "distinct-main-input"
							: "main-command";
					yield* f.sql`UPDATE provider_command_outbox SET payload_json = json_set(payload_json, '$.inputId', ${inputId}) WHERE command_id = 'main-command'`;
					const directory = runnerRegistry.runnerDirectory(f.root, f.root);
					const original = new MainRunnerSendJournal(directory, "s", "cursor");
					const result = {
						status: "completed",
						cost: 0,
						tokens: { input: 0, output: 0 },
						durationMs: 0,
						providerStateUpdates: [],
					} satisfies TurnResult;
					const failure = {
						operation: "send-turn",
						message: "account unavailable",
						code: "auth_required",
						retryable: false,
					};
					const liveResult = yield* Deferred.make<TurnResult>();
					const begun = yield* Deferred.make<void>();
					const live =
						scenario === "input-keyed live retry" ||
						scenario === "unfinished inherited sendCommands";
					// An older build keys a send by the frame id it was sent, attempt 0.
					const executed = sendToken("tx", "main-command", live ? attempt : 1);
					const active = live
						? yield* original
								.execute(
									executed,
									0,
									false,
									Deferred.succeed(begun, undefined).pipe(
										Effect.andThen(Deferred.await(liveResult)),
									),
								)
								.pipe(Effect.forkChild)
						: undefined;
					if (active) yield* Deferred.await(begun);
					else
						yield* Effect.result(
							original.execute(
								executed,
								0,
								false,
								scenario === "finished inherited sendCommands"
									? Effect.fail(failure)
									: Effect.succeed(result),
							),
						);
					const retained = new MainRunnerSendJournal(directory, "s", "cursor");
					const replayed = yield* Deferred.make<void>();
					const deliveries = vi.fn();
					const keys: Array<{
						token: SendToken;
						fallback: boolean;
						sinkId: string;
					}> = [];
					f.replaySend.execute = (token, command) =>
						Effect.gen(function* () {
							keys.push({
								token,
								fallback: command.input.nativeResumeFallback === true,
								sinkId: command.sinkId,
							});
							// Main's host joins the already pending RPC before consulting its journal.
							if (scenario === "input-keyed live retry" && active) {
								yield* Deferred.succeed(replayed, undefined);
								return yield* Fiber.join(active);
							}
							return yield* retained
								.execute(
									token,
									0,
									command.input.nativeResumeFallback === true,
									Effect.sync(() => deliveries()).pipe(Effect.as(result)),
								)
								.pipe(
									Effect.onExit(() => Deferred.succeed(replayed, undefined)),
								);
						});
					yield* f.hello(
						({
							sendJournalAnswers: _capability,
							sendAnswers: _answers,
							...hello
						}) => ({
							...hello,
							bindings: scenario.startsWith("replayed cached key")
								? []
								: [
										{
											token: sendToken("tx", "main-command", 1),
											sessionId: "s",
											sinkId: runnerSinkId("main-command", 1),
											released: true,
										},
										...(scenario === "input-keyed live retry"
											? [
													{
														token: sendToken("tx", "main-command", 2),
														sessionId: "s",
														sinkId: runnerSinkId(inputId, 2),
														released: false,
													},
												]
											: []),
									],
							sendTokens: [executed],
							completedCommands:
								scenario === "finished inherited sendCommands" ||
								scenario === "unfinished inherited sendCommands" ||
								scenario === "input-keyed live retry"
									? []
									: [{ commandId: "main-command", result }],
						}),
					);
					yield* f.recover;
					yield* Deferred.await(replayed);
					if (scenario === "input-keyed live retry") {
						expect(keys).toEqual([
							{
								token: sendToken("tx", "main-command", 2),
								fallback: false,
								sinkId: runnerSinkId(inputId, 2),
							},
						]);
						expect(
							yield* f.sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'main-command'`,
						).toEqual([{ status: "running", error_code: null }]);
						const later = vi
							.spyOn(f.instance, "sendTurnEffect")
							.mockImplementation((input) => f.reply(input, result));
						yield* f.reactor.drain();
						expect(later).not.toHaveBeenCalled();
						yield* f.ingestion.ingest({
							eventId: "main-live-completed",
							type: "turn.completed",
							providerId: "cursor",
							sessionId: "s",
							runId: "run:main-command",
							providerRefs: {},
							rawSource: { kind: "test.main" },
							createdAt: 3,
							data: { messageId: "", duration: 1 },
						});
						yield* Deferred.succeed(liveResult, result);
						yield* TestClock.adjust(0);
					} else {
						expect(keys).toEqual([
							{
								token: sendToken("tx", "main-command", attempt),
								fallback: false,
								sinkId: runnerSinkId("main-command", attempt),
							},
						]);
						expect(deliveries).toHaveBeenCalledTimes(
							scenario === "attemptless historical completion" ? 1 : 0,
						);
					}
					yield* TestClock.adjust(0);
					if (scenario === "transmitted before start without dispatch")
						yield* Deferred.await(committed);
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id = 'main-command'`,
					).toEqual([
						{
							status: scenario.endsWith("inherited sendCommands")
								? "failed"
								: "completed",
						},
					]);
					if (scenario === "unfinished inherited sendCommands")
						expect(
							yield* f.sql`SELECT error_code FROM provider_command_outbox WHERE command_id='main-command'`,
						).toEqual([{ error_code: "runner_send_uncertain" }]);
					if (scenario.startsWith("replayed cached key")) {
						expect(f.sendHandles).toHaveLength(1);
						expect(f.sendHandles.map((send) => send.assignment._tag)).toEqual([
							"Closed",
						]);
						expect(f.account).toEqual({ acquired: 1, released: 1 });
					}
					if (scenario.endsWith("without dispatch")) {
						yield* f.instance.attachSessionsEffect(["s"], () =>
							Effect.succeed(f.recovery),
						);
						yield* TestClock.adjust(0);
						expect(deliveries).not.toHaveBeenCalled();
						expect(
							yield* f.sql`SELECT command_id FROM r2_legacy_completed`,
						).toEqual([{ command_id: "main-command" }]);
					}
					if (scenario === "started without dispatch") {
						expect(
							yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run:main-command'`,
						).toEqual([{ status: "completed" }]);
						expect(
							yield* f.sql`SELECT COUNT(*) AS count FROM events WHERE type = 'turn.completed' AND json_extract(metadata, '$.runId') = 'run:main-command'`,
						).toEqual([{ count: 1 }]);
					}
					const next = vi
						.spyOn(f.instance, "sendTurnEffect")
						.mockImplementation((input) => f.reply(input, result));
					yield* f.reactor.drain();
					yield* f.reactor.drain();
					expect(next.mock.calls.map(([input]) => input.inputId)).toEqual([
						"main-next",
					]);
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox ORDER BY request_sequence`,
					).toEqual([
						{
							status: scenario.endsWith("inherited sendCommands")
								? "failed"
								: "completed",
						},
						{ status: "completed" },
					]);
				}),
			),
	);

for (const current of [true, false])
	for (const markerCommitted of [false, true])
		it.effect(
			`S10 ${current ? "current" : "main"} primary rejection delivers one fallback with its journal key (markerCommitted=${markerCommitted})`,
			() =>
				runRetirement(
					Effect.gen(function* () {
						const f = yield* s7Fixture("claude");
						yield* f.seed("fallback-answer");
						if (markerCommitted)
							yield* f.sql`UPDATE provider_command_outbox SET payload_json=json_set(payload_json, '$.nativeResumeFallback', json('true')) WHERE command_id='fallback-answer'`;
						yield* f.seed("fallback-next", 2, 0);
						yield* f.sql`UPDATE provider_command_outbox SET status = 'pending' WHERE command_id = 'fallback-next'`;
						Object.assign(f.recovery, {
							resolveCallContext: () =>
								Effect.succeed({
									projectId: "test-project",
									sessionId: "s",
									account: { id: "account", name: "Account", driver: "claude" },
									workspaceRoot: f.root,
									extraFolders: [],
									shellEnv: {},
								}),
						});
						yield* f.sql`INSERT INTO provider_state (session_id,key,value) VALUES ('s','nativeThread:account',${JSON.stringify({ configDir: configuredClaudeConfigDir(f.root), resumeSessionId: "stale", firstSequence: 0, deliveredThrough: 0 })})`;
						const directory = runnerRegistry.runnerDirectory(f.root, f.root);
						const journal = current
							? new RunnerSendJournal(directory, "s", "claude")
							: new MainRunnerSendJournal(directory, "s", "claude");
						const rejection = {
							status: "error",
							nativeResumeRejected: true,
							error: {
								code: "claude_resume_refused",
								message:
									"Resume rejected by --resume-drops-turn: native context cannot be preserved",
							},
							cost: 0,
							tokens: { input: 0, output: 0 },
							durationMs: 0,
							providerStateUpdates: [],
						} satisfies TurnResult;
						const result = {
							status: "completed",
							cost: 0,
							tokens: { input: 0, output: 0 },
							durationMs: 0,
							providerStateUpdates: [],
						} satisfies TurnResult;
						// The claim's token; an older build keys it by frame id, attempt 0.
						const token = sendToken("tx", "fallback-answer", 1);
						yield* journal instanceof RunnerSendJournal
							? journal.execute(token, Effect.succeed(rejection))
							: journal.execute(token, 0, false, Effect.succeed(rejection));
						const delivered = vi.fn();
						const keys: Array<{ token: SendToken; fallback: boolean }> = [];
						f.replaySend.execute = (id, command) => {
							const fallback = command.input.nativeResumeFallback === true;
							keys.push({ token: id, fallback });
							const delivery = Effect.sync(() => delivered()).pipe(
								Effect.as(result),
							);
							return journal instanceof RunnerSendJournal
								? journal.execute(id, delivery)
								: journal.execute(id, 0, fallback, delivery);
						};
						yield* f.hello(
							({
								sendJournalAnswers: _capability,
								sendAnswers: _answers,
								...hello
							}) => ({
								...hello,
								...(current
									? {
											sendJournalAnswers: true as const,
											sendAnswers: [
												{
													token,
													status: "finished" as const,
													result: rejection,
												},
											],
										}
									: {
											sendTokens: [token],
											completedCommands: [
												{ commandId: "fallback-answer", result: rejection },
											],
										}),
								bindings: [],
							}),
						);
						yield* f.recover;
						const send = vi
							.spyOn(f.instance, "sendTurnEffect")
							.mockImplementation((input) =>
								(journal instanceof RunnerSendJournal
									? journal.execute(
											sendToken("tx", input.inputId, input.commandAttempt ?? 0),
											Effect.sync(() => delivered()).pipe(Effect.as(result)),
										)
									: journal.execute(
											input.inputId,
											input.commandAttempt ?? 0,
											input.nativeResumeFallback === true,
											Effect.sync(() => delivered()).pipe(Effect.as(result)),
										)
								).pipe(
									Effect.flatMap((value) =>
										value
											? f.reply(input, value)
											: Effect.die("missing fallback result"),
									),
									Effect.mapError(
										(cause) =>
											new ProviderInstanceFailure({
												providerId: "claude",
												operation: "send-turn",
												cause,
											}),
									),
								),
							);
						yield* TestClock.adjust(0);
						yield* f.reactor.drain();
						yield* TestClock.adjust(0);
						yield* f.reactor.drain();
						// An older journal sends a fallback only under its rejected primary's
						// key, but a token names one transmission (CONTRACT 66-67): the claim
						// requeues, and the older journal refuses the fresh token's fallback.
						const refused = !current && !markerCommitted;
						expect(
							yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox WHERE command_id = 'fallback-answer'`,
						).toEqual([
							refused
								? { status: "failed", attempt_count: 2 }
								: { status: "completed", attempt_count: current ? 2 : 1 },
						]);
						if (!current) {
							expect(f.sendHandles.map((send) => send.assignment._tag)).toEqual(
								["Closed"],
							);
							expect(f.account).toEqual({ acquired: 1, released: 1 });
						}
						expect(delivered).toHaveBeenCalledTimes(refused ? 1 : 2);
						if (!markerCommitted || current)
							expect(send.mock.calls[0]?.[0]).toMatchObject({
								inputId: "fallback-answer",
								commandAttempt: 2,
								nativeResumeFallback: true,
							});
						if (!current)
							expect(keys).toEqual([{ token, fallback: markerCommitted }]);
						expect(
							yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id = 'fallback-next'`,
						).toEqual([{ status: "completed" }]);
					}),
				),
		);

it.effect(
	"S10 an adopted fallback ignores an earlier transmission's reply and settles its own reply once",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("held-fallback", 1, 2);
				yield* f.seed("held-fallback-next", 2, 0);
				yield* f.sql`UPDATE provider_command_outbox SET payload_json=json_set(payload_json,'$.nativeResumeFallback',json('true')) WHERE command_id='held-fallback'`;
				const sinkId = runnerSinkId("held-fallback", 2, true);
				// The fallback is its own transmission (4.8), so its own token.
				const token = sendToken("tx", "held-fallback", 2);
				yield* f.hello((hello) => ({
					...hello,
					sendJournalAnswers: true,
					// The host recorded this transmission as the fresh fallback (4.8).
					sendAnswers: [{ token, fresh: true, status: "running" }],
					bindings: [
						{
							token,
							sinkId,
							sessionId: "s",
							released: false,
						},
					],
				}));
				yield* f.recover;
				expect(f.sendHandles).toHaveLength(1);
				const attachment = f.attachments[0];
				if (!attachment?.onCommandReply)
					return yield* Effect.die("missing fallback attachment");
				const rejection = {
					status: "error",
					nativeResumeRejected: true,
					error: {
						code: "resume_rejected",
						message: "native resume was rejected",
					},
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				} satisfies TurnResult;
				yield* attachment.onCommandReply({
					type: "command-reply",
					commandId: sendToken("tx", "held-fallback", 1),
					result: rejection,
				});
				expect(
					yield* f.sql`SELECT status,error_code FROM provider_command_outbox WHERE command_id='held-fallback'`,
				).toEqual([{ status: "running", error_code: null }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed','turn.error','turn.interrupted')`,
				).toEqual([]);
				const reply = {
					type: "command-reply",
					commandId: token,
					result: rejection,
				} as const;
				yield* attachment.onCommandReply(reply);
				yield* attachment.onCommandReply(reply);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id='held-fallback'`,
				).toEqual([{ status: "failed" }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed','turn.error','turn.interrupted')`,
				).toEqual([{ type: "turn.error" }]);
				const send = vi.spyOn(f.instance, "sendTurnEffect").mockReturnValue(
					Effect.succeed({
						status: "completed",
						cost: 0,
						tokens: { input: 0, output: 0 },
						durationMs: 0,
						providerStateUpdates: [],
					}),
				);
				yield* f.reactor.drain();
				yield* f.reactor.drain();
				expect(send.mock.calls.map(([input]) => input.inputId)).toEqual([
					"held-fallback-next",
				]);
			}),
		),
);

for (const finished of [false, true])
	it.effect(
		`S10 current predecessor journal ${finished ? "finished" : "unfinished"} key never gains a phantom owner`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture();
					yield* f.seed("predecessor", 1, 1, finished ? "legacy" : "held");
					yield* f.seed("predecessor-next", 2, 0);
					const directory = runnerRegistry.runnerDirectory(f.root, f.root);
					const previous = new RunnerSendJournal(directory, "s", "cursor");
					const begun = yield* Deferred.make<void>();
					const gate = yield* Deferred.make<TurnResult>();
					const result = {
						status: "completed",
						cost: 0,
						tokens: { input: 0, output: 0 },
						durationMs: 0,
						providerStateUpdates: [],
					} satisfies TurnResult;
					// A held send's token is its hold's transmission, else its claim's.
					const token = sendToken(finished ? "tx" : "hold", "predecessor", 1);
					if (finished) yield* previous.execute(token, Effect.succeed(result));
					else {
						yield* previous
							.execute(
								token,
								Deferred.succeed(begun, undefined).pipe(
									Effect.andThen(Deferred.await(gate)),
								),
							)
							.pipe(Effect.forkChild);
						yield* Deferred.await(begun);
					}
					const journal = new RunnerSendJournal(directory, "s", "cursor");
					yield* f.hello((hello) => ({
						...hello,
						sendJournalAnswers: true,
						sendAnswers: journal.answers,
						bindings: [],
						sendTokens: journal.tokens,
						completedCommands: [],
					}));
					yield* f.recover;
					expect(f.sendHandles).toEqual([]);
					expect(
						yield* f.sql`SELECT status,error_code FROM provider_command_outbox WHERE command_id='predecessor'`,
					).toEqual([
						{
							status: finished ? "completed" : "running",
							error_code: null,
						},
					]);
					const send = vi
						.spyOn(f.instance, "sendTurnEffect")
						.mockImplementation((input) => f.reply(input, result));
					yield* f.reactor.drain();
					yield* f.reactor.drain();
					expect(send.mock.calls.map(([input]) => input.inputId)).toEqual(
						finished ? ["predecessor-next"] : [],
					);
					if (!finished)
						expect(
							yield* f.sql`SELECT runner_id, held_transmission FROM provider_runs WHERE id = 'run:predecessor'`,
						).toEqual([{ runner_id: "131313131313", held_transmission: 1 }]);
				}),
			),
	);

for (const outcome of ["completed", "failed", "older attempt"] as const)
	it.effect(
		`S7 completed hello ${outcome} settles only its exact attempt without dispatch`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture();
					yield* f.seed("finished");
					yield* f.hello((hello) => ({
						...hello,
						sendJournalAnswers: true,
						sendAnswers: [
							{
								status: "finished",
								token: sendToken(
									"tx",
									"finished",
									outcome === "older attempt" ? 0 : 1,
								),
								...(outcome === "failed"
									? {
											failure: {
												...runnerFailure("send-turn", "runner failed"),
												code: "runner_failed",
												retryable: false,
											},
										}
									: {
											result: {
												status: "completed",
												cost: 0,
												tokens: { input: 0, output: 0 },
												durationMs: 0,
												providerStateUpdates: [
													{ key: "s7-completed", value: "yes" },
												],
											},
										}),
							},
						],
					}));
					yield* f.recover;
					expect(
						yield* f.sql`SELECT status, attempt_count, run_id FROM provider_command_outbox`,
					).toEqual([
						{
							status:
								outcome === "older attempt"
									? "retryable_failed"
									: outcome === "failed"
										? "failed"
										: "completed",
							attempt_count: 1,
							run_id: "run:finished",
						},
					]);
					expect(
						f.commands.filter((command) => command.type === "send-turn"),
					).toEqual([]);
					expect(f.sendHandles).toEqual([]);
					expect(
						yield* f.sql`SELECT value FROM provider_state WHERE key = 's7-completed'`,
					).toEqual(outcome === "completed" ? [{ value: "yes" }] : []);
					if (outcome === "failed") {
						expect(
							yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run:finished'`,
						).toEqual([{ status: "error" }]);
						expect(
							yield* f.sql`SELECT input_id FROM messages WHERE role = 'user'`,
						).toEqual([{ input_id: "finished" }]);
						expect(
							yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
						).toEqual([{ type: "turn.error" }]);
					}
				}),
			),
	);

it.effect(
	"S7 a terminal cached hello reply creates no retained admission or account demand",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture();
				yield* f.seed("finished");
				const token = sendToken("tx", "finished", 1);
				yield* f.hello((hello) => ({
					...hello,
					bindings: [
						{
							token,
							sinkId: runnerSinkId("finished", 1),
							sessionId: "s",
							released: false,
						},
					],
					sendJournalAnswers: true,
					sendAnswers: [
						{
							status: "finished",
							token,
							result: {
								status: "completed",
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 0,
								providerStateUpdates: [],
							},
						},
					],
				}));
				yield* f.recover;
				expect(f.sendHandles).toEqual([]);
				expect(f.account).toEqual({ acquired: 0, released: 0 });
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "completed" }]);
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
			}),
		),
);

for (const driverKind of ["claude", "cursor"] as const)
	it.effect(
		`S7 ${driverKind} indeterminate delivery stays owned and is never resent`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture(driverKind);
					yield* f.seed("unknown");
					yield* f.sql`UPDATE provider_command_outbox SET error_code = 'delivery_indeterminate'`;
					yield* f.recover;
					expect(
						yield* f.sql`SELECT status, error_code, attempt_count FROM provider_command_outbox`,
					).toEqual([
						{
							status: "running",
							error_code: "delivery_indeterminate",
							attempt_count: 1,
						},
					]);
					expect(
						f.commands.filter((command) => command.type === "send-turn"),
					).toEqual([]);
					const attachment = f.attachments[0];
					if (!attachment)
						return yield* Effect.die("missing indeterminate runner");
					for (const type of ["run.started", "turn.completed"] as const)
						yield* attachment.emit(
							{
								type: "event",
								sinkId: runnerSinkId("unknown", 1),
								event: {
									eventId: `s7-indeterminate:${type}`,
									type,
									providerId: driverKind,
									sessionId: "s",
									runId: "run:unknown",
									providerRefs: {},
									rawSource: { kind: "test.indeterminate" },
									createdAt: 2,
									data:
										type === "run.started"
											? { inputId: "unknown", requestedRunId: "run:unknown" }
											: { messageId: "", duration: 1 },
								},
							},
							"s",
						);
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox`,
					).toEqual([{ status: "completed" }]);
				}),
			),
	);

for (const [helloAttempt, bindingAttempt, rowAttempt] of [
	[0, 0, 1],
	[1, 1, 1],
	[2, 1, 2],
] as const)
	it.effect(
		`S7 adoption matches held ${helloAttempt}, binding ${bindingAttempt}, and row ${rowAttempt} attempts`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture();
					yield* f.seed("held", 1, rowAttempt);
					yield* f.hello((hello) => ({
						...hello,
						bindings: [
							{
								token: sendToken("tx", "held", bindingAttempt),
								sinkId: runnerSinkId("held", bindingAttempt),
								sessionId: "s",
								released: false,
							},
						],
						sendJournalAnswers: true,
						sendTokens: [sendToken("tx", "held", helloAttempt)],
						sendAnswers: [
							{
								status: "running",
								token: sendToken("tx", "held", helloAttempt),
							},
						],
					}));
					yield* f.recover;
					expect(
						yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox`,
					).toEqual([
						{
							status:
								helloAttempt === rowAttempt ? "running" : "retryable_failed",
							attempt_count: rowAttempt,
						},
					]);
					expect(f.sendHandles).toHaveLength(
						helloAttempt === rowAttempt ? 1 : 0,
					);
					expect(
						f.commands.filter((command) => command.type === "send-turn"),
					).toEqual([]);
				}),
			),
	);

it.effect(
	"S10 exact running answer owns despite a historical binding attempt",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture();
				yield* f.seed("held", 1, 2);
				yield* f.hello((hello) => ({
					...hello,
					sendJournalAnswers: true,
					sendTokens: [sendToken("tx", "held", 2)],
					sendAnswers: [
						{ status: "running", token: sendToken("tx", "held", 2) },
					],
					bindings: [
						{
							token: sendToken("tx", "held", 1),
							sinkId: runnerSinkId("held", 2),
							sessionId: "s",
							released: false,
						},
					],
				}));
				yield* f.recover;
				expect(f.sendHandles).toHaveLength(1);
				expect(
					yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([{ status: "running", attempt_count: 2 }]);
			}),
		),
);

it.effect(
	"S7 reactor retries the original run once and keeps the next send behind it",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture();
				yield* f.seed("first");
				yield* f.seed("second", 2, 0);
				yield* f.sql`UPDATE provider_command_outbox SET status = 'pending' WHERE command_id = 'second'`;
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const calls: Array<{
					inputId: string;
					runId: string | undefined;
					attempt: number | undefined;
				}> = [];
				const send = f.instance.sendTurnEffect.bind(f.instance);
				vi.spyOn(f.instance, "sendTurnEffect").mockImplementation((input) =>
					Effect.gen(function* () {
						calls.push({
							inputId: input.inputId,
							runId: input.runId,
							attempt: input.commandAttempt,
						});
						if (input.inputId === "first") {
							yield* Deferred.succeed(entered, undefined);
							yield* Deferred.await(release);
						}
						const result = yield* send(input);
						const attachment = f.attachments.at(-1);
						if (!attachment)
							return yield* Effect.die("missing native attachment");
						yield* attachment.emit(
							{
								type: "place-user-message",
								sinkId: runnerSinkId(input.inputId, input.commandAttempt),
								input: {
									sessionId: "s",
									inputId: input.inputId,
									text: input.text ?? input.prompt,
									...(input.runId ? { runId: input.runId } : {}),
								},
							},
							"s",
						);
						const now = yield* Clock.currentTimeMillis;
						for (const type of ["run.started", "turn.completed"] as const)
							yield* input.eventSink.push({
								eventId: `s7-native:${input.inputId}:${type}`,
								type,
								providerId: "cursor",
								sessionId: "s",
								runId: input.runId,
								providerRefs: {},
								rawSource: { kind: "test.runner" },
								createdAt: now,
								data:
									type === "run.started"
										? { inputId: input.inputId, requestedRunId: input.runId }
										: { messageId: "", duration: 1 },
							});
						yield* attachment.emit(
							{
								type: "release-sink",
								sinkId: runnerSinkId(input.inputId, input.commandAttempt),
							},
							"s",
						);
						return result;
					}).pipe(
						Effect.mapError((cause) =>
							cause instanceof ProviderInstanceFailure
								? cause
								: new ProviderInstanceFailure({
										providerId: "cursor",
										operation: "test native output",
										cause,
									}),
						),
					),
				);
				yield* Deferred.succeed(f.pending, {
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				});
				yield* f.recover;
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id = 'first'`,
				).toEqual([{ status: "retryable_failed" }]);
				expect(calls).toEqual([]);
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
				const draining = yield* Effect.forkChild(f.reactor.drain());
				yield* Deferred.await(entered);
				yield* Effect.all([f.reactor.drain(), f.reactor.drain()]);
				expect(calls).toEqual([
					{ inputId: "first", runId: "run:first", attempt: 2 },
				]);
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(draining);
				expect(calls).toEqual([
					{ inputId: "first", runId: "run:first", attempt: 2 },
					{ inputId: "second", runId: "run:second", attempt: 1 },
				]);
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toHaveLength(2);
				expect(
					yield* f.sql`SELECT command_id, status, run_id, attempt_count FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([
					{
						command_id: "first",
						status: "completed",
						run_id: "run:first",
						attempt_count: 2,
					},
					{
						command_id: "second",
						status: "completed",
						run_id: "run:second",
						attempt_count: 1,
					},
				]);
				expect(
					yield* f.sql`SELECT input_id FROM messages WHERE role = 'user' ORDER BY created_at, input_id`,
				).toEqual([{ input_id: "first" }, { input_id: "second" }]);
				expect(
					yield* f.sql`SELECT json_extract(metadata, '$.runId') AS run_id, COUNT(*) AS count FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted') GROUP BY run_id ORDER BY run_id`,
				).toEqual([
					{ run_id: "run:first", count: 1 },
					{ run_id: "run:second", count: 1 },
				]);
			}),
		),
);

it.effect(
	"S7 requeued admission timeout places one failed message and restores one draft",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture();
				yield* f.seed("refused");
				const drafts = yield* makeInputDrafts;
				const restore = vi.spyOn(drafts, "restoreChange");
				const place = vi.spyOn(f.persist, "persistUserMessage");
				const execute = f.manager.executeEffect.bind(f.manager);
				vi.spyOn(f.manager, "executeEffect").mockImplementation(
					(command, send) =>
						command.type === "send-turn"
							? Effect.fail(
									new SendAdmissionTimeout({ reason: "retunePending" }),
								)
							: execute(command, send).pipe(Effect.as(undefined)),
				);
				yield* f.recover;
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id = 'refused'`,
				).toEqual([{ status: "retryable_failed" }]);
				expect(restore).not.toHaveBeenCalled();
				expect(yield* drafts.read({ session: "s" })).toBeUndefined();
				expect(place).not.toHaveBeenCalled();
				expect(
					yield* f.reactor
						.runCommand("refused")
						.pipe(Effect.provideService(InputDraftsTag, drafts)),
				).toMatchObject({ status: "error" });
				expect(place).toHaveBeenCalledTimes(1);
				expect(restore).toHaveBeenCalledExactlyOnceWith(
					{ session: "s" },
					"refused",
					[],
					"text refused",
					yield* Clock.currentTimeMillis,
				);
				expect(yield* drafts.read({ session: "s" })).toBe("text refused");
				expect(
					yield* f.sql`SELECT input_id FROM messages WHERE role = 'user'`,
				).toEqual([{ input_id: "refused" }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([{ type: "turn.error" }]);
				expect(
					yield* f.sql`SELECT status, error_code, attempt_count, run_id FROM provider_command_outbox`,
				).toEqual([
					{
						status: "failed",
						error_code: "send_admission_timeout",
						attempt_count: 2,
						run_id: "run:refused",
					},
				]);
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
			}),
		),
);

it.effect("S7 recovery wakes the reactor only after the requeue commits", () =>
	runRetirement(
		Effect.gen(function* () {
			const f = yield* s7Fixture();
			yield* f.seed("wake");
			yield* f.recover;
			yield* TestClock.adjust(0);
			expect(f.wakes).toEqual([
				[{ command_id: "wake", status: "retryable_failed" }],
			]);
		}),
	),
);

it.effect(
	"S7 a live reactor claim wins and its original failure path settles the send",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture();
				yield* f.seed("live", 1, 0);
				yield* f.sql`UPDATE provider_command_outbox SET status = 'pending'`;
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				vi.spyOn(f.instance, "sendTurnEffect").mockImplementation(() =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
						Effect.andThen(
							Effect.fail(
								new ProviderInstanceFailure({
									providerId: "cursor",
									operation: "sendTurn",
									cause: new SendAdmissionTimeout({ reason: "retunePending" }),
								}),
							),
						),
					),
				);
				const sending = yield* Effect.forkChild(f.reactor.runCommand("live"));
				yield* Deferred.await(entered);
				expect(f.reactor.ownsPendingSend("s", "live", 1, 1)).toBe(true);
				const owns = vi.fn(f.reactor.ownsPendingSend.bind(f.reactor));
				yield* f.instance.attachSessionsEffect(
					["s"],
					() => Effect.succeed(f.recovery),
					owns,
				);
				expect(owns).toHaveBeenCalledWith("s", "live", 1, 1);
				expect(
					yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([{ status: "running", attempt_count: 1 }]);
				expect(sending.pollUnsafe()).toBeUndefined();
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
				yield* Deferred.succeed(release, undefined);
				expect(yield* Fiber.join(sending)).toMatchObject({ status: "error" });
				expect(
					yield* f.sql`SELECT status, error_code, attempt_count FROM provider_command_outbox`,
				).toEqual([
					{
						status: "failed",
						error_code: "send_admission_timeout",
						attempt_count: 1,
					},
				]);
				expect(f.reactor.ownsPendingSend("s", "live", 1, 1)).toBe(false);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([{ type: "turn.error" }]);
			}),
		),
);

it.effect(
	"S7 a held hello cannot adopt over a live reactor claim after its admission closed",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture();
				// attachSessions adopts production's durable serving row directly;
				// this path does not call the fixture's recoverEffect registration.
				yield* (yield* makeRunnerReceiptStore(f.sql)).register(
					"131313131313",
					{
						sessionId: "s",
						pid: 100_088,
						startTime: "original",
						driverKind: "cursor",
					},
					"serving",
				);
				const input = yield* f.seed("live", 1, 0);
				yield* f.sql`UPDATE provider_command_outbox SET status = 'pending'`;
				const prior = Option.getOrThrow(
					yield* f.instance.admitSendEffect(
						{
							origin: { _tag: "Fresh" },
							sinkId: runnerSinkId("live", 1),
							input,
						},
						(send) => Effect.succeed(send),
					),
				);
				expect(prior.assignment._tag).toBe("Closed");
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				vi.spyOn(f.instance, "sendTurnEffect").mockImplementation(() =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
						Effect.andThen(
							Effect.fail(
								new ProviderInstanceFailure({
									providerId: "cursor",
									operation: "sendTurn",
									cause: new SendAdmissionTimeout({ reason: "retunePending" }),
								}),
							),
						),
					),
				);
				yield* f.hello((hello) => ({
					...hello,
					sendJournalAnswers: true,
					sendAnswers: [
						{
							status: "running",
							token: sendToken("tx", "live", 1),
						},
					],
					bindings: [
						{
							token: sendToken("tx", "live", 1),
							sinkId: runnerSinkId("live", 1),
							sessionId: "s",
							released: false,
						},
					],
				}));
				yield* Effect.gen(function* () {
					const sending = yield* Effect.forkChild(f.reactor.runCommand("live"));
					yield* Deferred.await(entered);
					expect(f.reactor.ownsPendingSend("s", "live", 1, 1)).toBe(true);
					yield* f.instance.attachSessionsEffect(
						["s"],
						() => Effect.succeed(f.recovery),
						f.reactor.ownsPendingSend.bind(f.reactor),
					);
					expect(f.sendHandles).toHaveLength(1);
					expect(f.sendHandles[0]).toBe(prior);
					expect(f.account).toEqual({ acquired: 0, released: 0 });
					expect(
						yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox`,
					).toEqual([{ status: "running", attempt_count: 1 }]);
					expect(
						f.commands.filter((command) => command.type === "send-turn"),
					).toEqual([]);
					yield* Deferred.succeed(release, undefined);
					expect(yield* Fiber.join(sending)).toMatchObject({ status: "error" });
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
			}),
		),
);

it.effect(
	"S7 recovery leaves a live reactor failure settlement to its original owner",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				let deliveryFailed = false;
				const f = yield* s7Fixture("cursor", () =>
					deliveryFailed
						? Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.as(true),
							)
						: Effect.succeed(true),
				);
				yield* f.seed("settling", 1, 0);
				yield* f.sql`UPDATE provider_command_outbox SET status = 'pending'`;
				vi.spyOn(f.instance, "sendTurnEffect").mockImplementation(() =>
					Effect.sync(() => {
						deliveryFailed = true;
					}).pipe(
						Effect.andThen(
							Effect.fail(
								new ProviderInstanceFailure({
									providerId: "cursor",
									operation: "sendTurn",
									cause: new SendAdmissionTimeout({ reason: "retunePending" }),
								}),
							),
						),
					),
				);
				yield* Effect.gen(function* () {
					const sending = yield* Effect.forkChild(
						f.reactor.runCommand("settling"),
					);
					yield* Deferred.await(entered);
					yield* f.instance.attachSessionsEffect(
						["s"],
						() => Effect.succeed(f.recovery),
						f.reactor.ownsPendingSend.bind(f.reactor),
					);
					expect(
						yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox`,
					).toEqual([{ status: "running", attempt_count: 1 }]);
					expect(f.reactor.ownsPendingSend("s", "settling", 1, 1)).toBe(true);
					yield* Deferred.succeed(release, undefined);
					expect(yield* Fiber.join(sending)).toMatchObject({ status: "error" });
					expect(
						yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox`,
					).toEqual([{ status: "failed", attempt_count: 1 }]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([{ type: "turn.error" }]);
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
			}),
		),
);

for (const fault of ["read", "settlement"] as const)
	it.effect(
		`S7 recovery ${fault} failure rolls back and reconnect settles every row`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture();
					yield* f.seed("finished");
					yield* f.seed("missing", 2);
					yield* f.hello((hello) => ({
						...hello,
						sendJournalAnswers: true,
						sendAnswers: [
							{
								status: "finished",
								token: sendToken("tx", "finished", 1),
								result: {
									status: "completed",
									cost: 0,
									tokens: { input: 0, output: 0 },
									durationMs: 0,
									providerStateUpdates: [
										{ key: "s7-atomic", value: "committed" },
									],
								},
							},
						],
					}));
					if (fault === "settlement")
						yield* f.sql`CREATE TEMP TRIGGER fail_s7_requeue BEFORE UPDATE ON provider_command_outbox
					WHEN OLD.command_id = 'missing' AND NEW.status = 'retryable_failed'
					BEGIN SELECT RAISE(ABORT, 'injected S7 settlement failure'); END`;
					const firstHello =
						yield* Deferred.make<Exit.Exit<void, SessionFailure>>();
					const connect = vi.mocked(f.driver.connect).getMockImplementation();
					if (!connect) return yield* Effect.die("missing recovery connection");
					vi.mocked(f.driver.connect).mockImplementation((options) =>
						connect({
							...options,
							onHello: (hello, connection, replay) =>
								options
									.onHello(hello, connection, replay)
									.pipe(
										Effect.onExit((exit) => Deferred.succeed(firstHello, exit)),
									),
						}),
					);
					let readFailed = false;
					const recovering = yield* Effect.forkChild(
						f.recover.pipe(
							Effect.provideService(
								Statement.CurrentTransformer,
								(statement) => {
									const [query] = statement.compile();
									if (
										fault !== "read" ||
										readFailed ||
										!query.includes("SELECT outbox.request_sequence")
									)
										return Effect.succeed(statement);
									readFailed = true;
									return Effect.succeed(
										f.sql`SELECT * FROM s7_injected_missing_read_table`,
									);
								},
							),
						),
					);
					expect(yield* Deferred.await(firstHello)).toMatchObject({
						_tag: "Failure",
					});
					expect(
						yield* f.sql`SELECT command_id, status FROM provider_command_outbox ORDER BY request_sequence`,
					).toEqual([
						{ command_id: "finished", status: "running" },
						{ command_id: "missing", status: "running" },
					]);
					expect(
						yield* f.sql`SELECT value FROM provider_state WHERE key = 's7-atomic'`,
					).toEqual([]);
					expect(recovering.pollUnsafe()).toBeUndefined();
					expect(f.wakes).toEqual([]);
					if (fault === "settlement")
						yield* f.sql`DROP TRIGGER fail_s7_requeue`;
					yield* TestClock.adjust("150 millis");
					yield* Fiber.join(recovering);
					expect(
						yield* f.sql`SELECT command_id, status FROM provider_command_outbox ORDER BY request_sequence`,
					).toEqual([
						{ command_id: "finished", status: "completed" },
						{ command_id: "missing", status: "retryable_failed" },
					]);
					expect(
						yield* f.sql`SELECT value FROM provider_state WHERE key = 's7-atomic'`,
					).toEqual([{ value: "committed" }]);
					expect(f.attachments).toHaveLength(2);
					expect(
						f.commands.filter((command) => command.type === "send-turn"),
					).toEqual([]);
				}),
			),
	);

for (const outcome of ["completed", "failed"] as const)
	it.effect(
		`S7 ${outcome} hello drains native output once and never redelivers the cached command`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture();
					const input = yield* f.seed("finished");
					const connect = vi.mocked(f.driver.connect).getMockImplementation();
					if (!connect)
						return yield* Effect.die("missing completed connection");
					vi.mocked(f.driver.connect).mockImplementation((options) =>
						connect({
							...options,
							onHello: (hello, connection) =>
								options.onHello(
									{
										...hello,
										sendJournalAnswers: true,
										sendAnswers: [
											{
												status: "finished",
												token: sendToken("tx", "finished", 1),
												...(outcome === "failed"
													? {
															failure: {
																...runnerFailure("send-turn", "native failure"),
																code: "native_failed",
																retryable: false,
															},
														}
													: {
															result: {
																status: "completed",
																cost: 0,
																tokens: { input: 0, output: 0 },
																durationMs: 0,
																providerStateUpdates: [],
															},
														}),
											},
										],
									},
									connection,
									Effect.gen(function* () {
										const sinkId = runnerSinkId("finished", 1);
										yield* options.emit(
											{
												type: "place-user-message",
												sinkId,
												input: {
													sessionId: "s",
													inputId: "finished",
													text: input.text,
													runId: input.runId,
												},
											},
											"s",
										);
										for (const type of [
											"run.started",
											outcome === "failed" ? "turn.error" : "turn.completed",
										] as const)
											yield* options.emit(
												{
													type: "event",
													sinkId,
													event: {
														eventId: `s7-cached:${type}`,
														type,
														providerId: "cursor",
														sessionId: "s",
														runId: input.runId,
														providerRefs: {},
														rawSource: { kind: "test.cached-runner" },
														createdAt: 2,
														data:
															type === "run.started"
																? {
																		inputId: "finished",
																		requestedRunId: input.runId,
																	}
																: outcome === "failed"
																	? {
																			messageId: "",
																			error: "native failure",
																			code: "native_failed",
																			retryable: false,
																		}
																	: { messageId: "", duration: 1 },
													},
												},
												"s",
											);
									}).pipe(Effect.asVoid),
								),
						}),
					);
					yield* f.recover;
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run:finished'`,
					).toEqual([{ status: outcome === "failed" ? "error" : "completed" }]);
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox`,
					).toEqual([
						{ status: outcome === "failed" ? "failed" : "completed" },
					]);
					expect(
						yield* f.sql`SELECT input_id FROM messages WHERE role = 'user'`,
					).toEqual([{ input_id: "finished" }]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([
						{ type: outcome === "failed" ? "turn.error" : "turn.completed" },
					]);
					expect(
						f.commands.filter((command) => command.type === "send-turn"),
					).toEqual([]);
				}),
			),
	);

it.effect(
	"S7 persistent hello settlement failure retires the attachment and settles the unclaimed send",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture();
				yield* f.seed("unreceived");
				// Dispatch commits its holder before the runner can receive the command.
				yield* f.sql`UPDATE provider_runs SET runner_id = '131313131313' WHERE id = 'run:unreceived'`;
				vi.spyOn(f.processTable, "signal").mockImplementation(() => {
					f.processes.delete(100_088);
				});
				yield* f.sql`CREATE TEMP TRIGGER reject_s7_requeue BEFORE UPDATE ON provider_command_outbox
			WHEN NEW.status = 'retryable_failed' BEGIN SELECT RAISE(ABORT, 'persistent S7 settlement failure'); END`;
				const firstHello = yield* Deferred.make<void>();
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect)
					return yield* Effect.die("missing persistent-failure connection");
				vi.mocked(f.driver.connect).mockImplementation((options) =>
					connect({
						...options,
						onHello: (hello, connection, replay) =>
							options
								.onHello(hello, connection, replay)
								.pipe(
									Effect.onExit(() => Deferred.succeed(firstHello, undefined)),
								),
					}),
				);
				const recovering = yield* Effect.forkChild(f.recover);
				yield* Deferred.await(firstHello);
				yield* TestClock.adjust("2 seconds");
				yield* Fiber.join(recovering);
				expect(f.attachments).toHaveLength(5);
				expect(yield* f.manager.hasLiveProcessEffect("s", "131313131313")).toBe(
					false,
				);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "failed", error_code: "runner_stopped" }]);
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'run:unreceived'`,
				).toEqual([{ status: "error" }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([{ type: "turn.error" }]);
				expect(f.wakes).toEqual([]);
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
			}),
		),
);

for (const invalidation of ["none", "after retry"] as const) {
	const invalidateAfterRetry = invalidation === "after retry";
	it.effect(
		invalidateAfterRetry
			? "account invalidation follows an unaccepted send onto its replacement runner"
			: "an unaccepted send survives idle eviction and delivers the replacement outcome",
		() =>
			runRetirement(
				Effect.gen(function* () {
					const holder = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
					const f = yield* sendScopeFixture(undefined, (_id, work) =>
						Effect.fiber.pipe(
							Effect.tap((fiber) => Deferred.succeed(holder, fiber)),
							Effect.andThen(work),
						),
					);
					yield* f.manager.recoverEffect;
					const refusal = {
						...runnerFailure("send-turn", "Runner exited while idle"),
						code: "runner_idle_exit",
						delivery: { _tag: "Refused", reason: "exiting" },
					} as const;
					const entered = yield* Deferred.make<void>();
					const resume = yield* Deferred.make<void>();
					let transmissions = 0;
					f.replaySend.execute = () =>
						++transmissions === 1
							? Deferred.succeed(entered, undefined).pipe(
									Effect.andThen(Deferred.await(resume)),
									Effect.andThen(Deferred.await(f.pending)),
								)
							: Effect.succeed({
									status: "completed",
									cost: 0,
									tokens: { input: 0, output: 0 },
									durationMs: 0,
									providerStateUpdates: [],
								});
					yield* Effect.gen(function* () {
						const sending = yield* Effect.forkChild(
							f.instance.sendTurnEffect({ ...f.input, commandAttempt: 0 }),
						);
						yield* Deferred.await(entered);
						const old = f.attachments[0];
						if (!old) return yield* Effect.die("missing refused runner");
						f.processes.delete(100_088);
						old.onClose(refusal);
						yield* TestClock.adjust(0);
						yield* Deferred.fail(f.pending, refusal);
						yield* Deferred.succeed(resume, undefined);
						const result = yield* Fiber.join(sending);
						expect(result.status).toBe("completed");
						expect(f.driver.connect).toHaveBeenCalledTimes(2);
						expect(
							f.commands.filter((command) => command.type === "send-turn"),
						).toHaveLength(2);
						expect(f.terminalCount()).toBe(0);
						if (invalidateAfterRetry) {
							yield* Effect.forkChild(
								Fiber.interrupt(yield* Deferred.await(holder)),
							);
							yield* TestClock.adjust(0);
							expect(
								f.commands
									.filter((command) =>
										["abort", "interrupt"].includes(command.type),
									)
									.map((command) => command.runnerId),
							).toEqual([f.attachments.at(-1)?.runnerId]);
						}
						yield* f.terminal("turn.completed");
						expect(f.terminalCount()).toBe(1);
						const replacement = f.attachments.at(-1);
						if (!replacement) return yield* Effect.die("missing replacement");
						yield* replacement.emit(
							{ type: "release-sink", sinkId: f.sinkId },
							"s",
						);
						yield* f.assertReleased();
						// The refusal's real release retires the old runner in its stop commit, which
						// records the runner's loss once, after that commit's release (CONTRACT 6.5).
						const trail = yield* f.sql<{
							type: string;
						}>`SELECT type FROM events WHERE type IN ('run.released', 'evidence.process_lost') AND json_extract(data, '$.runnerId') = ${old.runnerId} ORDER BY sequence`;
						expect(trail.slice(0, 2)).toEqual([
							{ type: "run.released" },
							{ type: "evidence.process_lost" },
						]);
						expect(
							trail.filter(({ type }) => type === "evidence.process_lost"),
						).toHaveLength(1);
					}).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
				}),
			),
	);
}

it.effect(
	"retirement settles runs and prompts before a hanging send finalizer finishes",
	() => {
		const warnings: string[] = [];
		return runRetirement(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const resume = yield* Deferred.make<void>();
				const f = yield* sendScopeFixture(undefined, (_id, work) =>
					work.pipe(
						Effect.ensuring(
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(resume)),
								Effect.uninterruptible,
							),
						),
					),
				);
				yield* f.instance.sendTurnEffect(f.input);
				const old = f.attachments[0];
				if (!old) return yield* Effect.die("missing retiring runner");
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at, runner_id) VALUES ('old-run', 's', 'running', 1, ${old.runnerId})`;
				yield* f.sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, created_at)
					VALUES ('old-prompt', 's', 'permission', 'pending', ${old.runnerId}, 1)`;
				old.onOutputCommitted?.({
					type: "event",
					sinkId: f.sinkId,
					event: {
						eventId: "old-run-started",
						type: "run.started",
						providerId: "claude",
						sessionId: "s",
						runId: "old-run",
						providerRefs: {},
						rawSource: { kind: "test" },
						createdAt: 1,
						data: { inputId: f.input.inputId, requestedRunId: "old-run" },
					},
				});
				yield* Effect.gen(function* () {
					f.processes.delete(old.pid ?? 100_020);
					const stopping = yield* Effect.forkChild(
						f.instance.endSessionEffect("s"),
					);
					yield* TestClock.adjust("4 seconds");
					yield* Deferred.await(entered);
					yield* TestClock.adjust(0);
					expect(
						yield* f.sql`SELECT status FROM pending_approvals WHERE id = 'old-prompt'`,
					).toEqual([{ status: "resolved" }]);
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'old-run'`,
					).toEqual([{ status: "interrupted" }]);
					expect(stopping.pollUnsafe()).toMatchObject({ _tag: "Success" });
					expect(f.account.released).toBe(0);
					yield* TestClock.adjust("2 seconds");
					expect(
						warnings.filter((message) => message.includes("timed out")),
					).toHaveLength(1);
					yield* old.emit({ type: "release-sink", sinkId: f.sinkId }, "s");
					expect(
						f.outputs.filter(
							(output) =>
								output.type === "release-sink" && output.sinkId === f.sinkId,
						),
					).toHaveLength(1);
					yield* Deferred.succeed(resume, undefined);
					yield* f.assertReleased();
				}).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
			}),
		).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((options) => {
						if (options.logLevel === "Warn")
							warnings.push(String(options.message));
					}),
				]),
			),
		);
	},
);

it.effect(
	"send scope closes when eviction precedes a dispatched command's finalizer",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				yield* f.manager.recoverEffect;
				const sending = yield* Effect.forkChild(
					f.instance.sendTurnEffect(f.input).pipe(Effect.result),
				);
				yield* Deferred.await(f.sending);
				const old = f.attachments[0];
				if (!old) return yield* Effect.die("missing dispatched runner");
				f.processes.delete(100_088);
				const failure = runnerFailure("socket", "exit before send unwinds");
				old.onClose(failure);
				yield* TestClock.adjust(0);
				expect(yield* Fiber.join(sending)).toMatchObject({
					_tag: "Success",
					success: { status: "cancelled" },
				});
				expect(Deferred.isDoneUnsafe(f.pending)).toBe(false);
				yield* f.assertReleased();
				yield* Deferred.fail(f.pending, failure);
				yield* Fiber.join(sending);
				expect(f.terminalCount()).toBe(0);
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'fixture-send-scope:1'`,
				).toEqual([{ status: "error" }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([{ type: "turn.error" }]);
				yield* old.emit({ type: "release-sink", sinkId: f.sinkId }, "s");
				yield* f.assertReleased();
			}),
		),
);

it.effect(
	"send scope closes account demand when cancelled before the manager sink binds",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				const entered = yield* Deferred.make<void>();
				const resume = yield* Deferred.make<void>();
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect) return yield* Effect.die("missing connect");
				vi.mocked(f.driver.connect).mockImplementationOnce((options) =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(resume)),
						Effect.andThen(connect(options)),
					),
				);
				yield* Effect.gen(function* () {
					const recovering = yield* Effect.forkChild(f.manager.recoverEffect);
					yield* Deferred.await(entered);
					const sending = yield* Effect.forkChild(
						f.instance.sendTurnEffect(f.input),
					);
					yield* TestClock.adjust(0);
					expect(f.account.acquired).toBe(1);
					yield* f.acceptStop;
					f.abort.abort();
					yield* TestClock.adjust(0);
					expect(sending.pollUnsafe()).toBeDefined();
					expect(yield* Fiber.join(sending)).toMatchObject({
						status: "cancelled",
					});
					yield* f.assertReleased();
					expect(f.terminalCount()).toBe(0);
					expect(
						f.commands.filter((command) => command.type === "send-turn"),
					).toEqual([]);
					yield* Deferred.succeed(resume, undefined);
					yield* Fiber.join(recovering);
				}).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
			}),
		),
);

it.effect(
	"send scope releases the provider account resource before a dispatched command unwinds",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const outer = { acquired: 0, released: 0 };
				const f = yield* sendScopeFixture({
					use: (account, work) =>
						Effect.acquireUseRelease(
							Effect.sync(() => outer.acquired++),
							() => work(account),
							() => Effect.sync(() => outer.released++),
						),
				});
				yield* f.manager.recoverEffect;
				const sending = yield* Effect.forkChild(
					f.instance.sendTurnEffect(f.input).pipe(Effect.result),
				);
				yield* Deferred.await(f.sending);
				const old = f.attachments[0];
				if (!old) return yield* Effect.die("missing dispatched runner");
				const failure = runnerFailure(
					"socket",
					"account owner outlives native dispatch",
				);
				yield* Effect.gen(function* () {
					f.processes.delete(100_088);
					old.onClose(failure);
					yield* TestClock.adjust(0);
					expect(yield* Fiber.join(sending)).toMatchObject({
						_tag: "Success",
						success: { status: "cancelled" },
					});
					expect(Deferred.isDoneUnsafe(f.pending)).toBe(false);
					expect(outer.acquired).toBe(1);
					expect(outer.released).toBe(1);
					yield* f.assertReleased();
				}).pipe(Effect.ensuring(Deferred.fail(f.pending, failure)));
				yield* Fiber.join(sending);
				expect(f.terminalCount()).toBe(0);
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'fixture-send-scope:1'`,
				).toEqual([{ status: "error" }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([{ type: "turn.error" }]);
				expect(outer.released).toBe(1);
			}),
		),
);

for (const ending of [
	"completion",
	"runner exit",
	"supersede",
	"retire",
	"provider shutdown",
] as const) {
	it.effect(`send scope releases each resource once on ${ending}`, () =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				if (ending === "runner exit") {
					const journal = new RunnerSendJournal(
						runnerRegistry.runnerDirectory(f.root, f.root),
						"s",
						"claude",
					);
					f.replaySend.execute = (id) =>
						journal.execute(
							id,
							Effect.succeed({
								status: "accepted",
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 0,
								providerStateUpdates: [],
							}),
						);
				}
				if (ending === "supersede") {
					const connect = vi.mocked(f.driver.connect).getMockImplementation();
					if (!connect) return yield* Effect.die("missing connect");
					vi.mocked(f.driver.connect).mockImplementationOnce((options) =>
						connect({
							...options,
							onHello: (hello, connection, replay) =>
								options.onHello(
									{ ...hello, buildId: "previous-build" },
									connection,
									replay,
								),
						}),
					);
				}
				yield* f.instance.sendTurnEffect(f.input);
				const old = f.attachments[0];
				if (!old) return yield* Effect.die("missing live runner");
				expect(f.account.released).toBe(0);
				if (ending !== "runner exit") yield* f.terminal("turn.completed");
				if (ending === "completion") {
					yield* old.emit({ type: "release-sink", sinkId: f.sinkId }, "s");
				} else if (ending === "runner exit") {
					const child = f.childProcesses.get(100_020);
					if (!child) return yield* Effect.die("missing child");
					f.processes.delete(100_020);
					Object.assign(child, { exitCode: 0 });
					child.emit("exit", 0, null);
				} else if (ending === "supersede") {
					if (!old.onUpgradeState)
						return yield* Effect.die("missing upgrade callback");
					old.onUpgradeState({
						quiescent: true,
						revision: 1,
						snapshot: {
							input: {
								...f.input,
								configDir: configuredClaudeConfigDir(f.root),
								folderSource: "implicitDefault",
							},
							options: {},
						},
					});
					yield* TestClock.adjust("4 seconds");
					expect(f.attachments.length).toBeGreaterThan(1);
					f.processes.delete(old.pid ?? 100_020);
					yield* TestClock.adjust("6 seconds");
				} else if (ending === "retire") {
					const stopping = yield* Effect.forkChild(
						f.instance.endSessionEffect("s"),
					);
					yield* TestClock.adjust("4 seconds");
					yield* Fiber.join(stopping);
					// Escalated releases Stop; Gone releases the stopped runner's resources.
					f.processes.delete(old.pid ?? 100_020);
					yield* TestClock.adjust("6 seconds");
				} else {
					yield* f.instance.shutdownEffect();
				}
				yield* f.assertReleased(ending !== "provider shutdown");
				expect(f.terminalCount()).toBe(ending === "runner exit" ? 0 : 1);
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'fixture-send-scope:1'`,
				).toEqual([
					{ status: ending === "runner exit" ? "error" : "completed" },
				]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([
					{ type: ending === "runner exit" ? "turn.error" : "turn.completed" },
				]);
				yield* old.emit({ type: "release-sink", sinkId: f.sinkId }, "s");
				yield* f.assertReleased(ending !== "provider shutdown");
				expect(f.terminalCount()).toBe(ending === "runner exit" ? 0 : 1);
			}),
		),
	);
}

// CONTRACT.md 6.11: memory teardown needs no authority.
it.effect(
	"a runner killed mid-turn releases its prompt waiter and open sink once without consulting a grant",
	() => {
		const warnings: string[] = [];
		return runRetirement(
			Effect.gen(function* () {
				const releases: { authorized: boolean; origin: unknown }[] = [];
				const f = yield* sendScopeFixture({
					use: (account, work) =>
						Effect.acquireUseRelease(
							Effect.void,
							() => work(account),
							() =>
								Effect.gen(function* () {
									releases.push({
										authorized:
											(yield* currentWriteAuthorization) !== undefined,
										origin: yield* currentRunnerWriteOrigin,
									});
								}),
						),
				});
				const journal = new RunnerSendJournal(
					runnerRegistry.runnerDirectory(f.root, f.root),
					"s",
					"claude",
				);
				f.replaySend.execute = (id) =>
					journal.execute(
						id,
						Effect.succeed({
							status: "accepted",
							cost: 0,
							tokens: { input: 0, output: 0 },
							durationMs: 0,
							providerStateUpdates: [],
						}),
					);
				const asked = yield* Deferred.make<void>();
				let interrupted = 0;
				vi.mocked(f.eventSink.requestPermission).mockImplementation(() =>
					Deferred.succeed(asked, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.onInterrupt(() =>
							Effect.sync(() => {
								interrupted++;
							}),
						),
					),
				);
				yield* f.instance.sendTurnEffect(f.input);
				const old = f.attachments[0];
				const child = f.childProcesses.get(100_020);
				if (!old || !child) return yield* Effect.die("missing live runner");
				yield* old.emit(
					{
						type: "permission-request",
						sinkId: f.sinkId,
						request: {
							requestId: "pending-approval",
							sessionId: "s",
							turnId: f.input.inputId,
							providerItemId: "tool",
							toolName: "Bash",
							toolInput: { command: "pwd" },
						},
					},
					"s",
				);
				yield* Deferred.await(asked);
				f.processes.delete(100_020);
				Object.assign(child, { exitCode: 0 });
				child.emit("exit", 0, null);
				yield* f.assertReleased();
				expect(interrupted).toBe(1);
				expect(releases).toEqual([{ authorized: false, origin: undefined }]);
				yield* old.emit({ type: "release-sink", sinkId: f.sinkId }, "s");
				yield* f.assertReleased();
				expect(interrupted).toBe(1);
				expect(releases).toHaveLength(1);
				expect(
					warnings.filter((warning) =>
						warning.startsWith("Dropped stale runner write"),
					),
				).toEqual([]);
			}),
		).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((options) => {
						if (options.logLevel === "Warn")
							warnings.push(String(options.message));
					}),
				]),
			),
		);
	},
);

it.effect(
	"send scope releases each resource once on cancel after sink binding",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				f.replacementGate.hold = true;
				const sending = yield* Effect.forkChild(
					f.instance.sendTurnEffect(f.input),
				);
				yield* Deferred.await(f.replacementConnecting);
				yield* f.acceptStop;
				f.abort.abort();
				yield* TestClock.adjust(0);
				expect(sending.pollUnsafe()).toBeDefined();
				expect(yield* Fiber.join(sending)).toMatchObject({
					status: "cancelled",
				});
				yield* f.assertReleased();
				expect(f.terminalCount()).toBe(0);
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
				yield* Deferred.succeed(f.replacementReady, undefined);
			}),
		),
);

// The reactor's recall aborts a queued send and fails it as processing_timeout
// only once the runner reports it cancelled. A steer is not an owner send, so
// settleSend never writes for it and abort must keep its in-memory cancel.
it.effect(
	"abort cancels a queued steer into a joined run before its runner is ready",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture(false);
				yield* (yield* makeCommitAndSignal)([
					canonicalEvent(
						"session.created",
						"s",
						{ sessionId: "s", title: "Steer", provider: "claude" },
						{ provider: "claude" },
					),
					canonicalEvent("run.requested", "s", {
						runId: "run:owner",
						inputId: "owner",
					}),
					canonicalEvent("run.requested", "s", {
						runId: "run:steer",
						inputId: "steer",
					}),
				]);
				yield* f.sql`UPDATE provider_runs SET status = 'joined', joined_into = 'run:owner' WHERE id = 'run:steer'`;
				f.replacementGate.hold = true;
				const steering = yield* Effect.forkChild(
					f
						.admitCommand({
							type: "send-turn",
							sinkId: "steer-sink",
							aborted: false,
							input: {
								...f.input,
								inputId: "steer",
								runId: "run:steer",
								prompt: "steer",
								history: [],
							},
						})
						.pipe(Effect.result),
				);
				yield* Deferred.await(f.replacementConnecting);
				const aborting = yield* Effect.forkChild(
					f.manager.executeEffect(
						{ type: "abort", sinkId: "steer-sink" },
						f.sendHandles.at(-1),
					),
				);
				yield* TestClock.adjust(0);
				const cancelledBeforeReady = steering.pollUnsafe() !== undefined;
				yield* Deferred.succeed(f.replacementReady, undefined);
				yield* Fiber.join(aborting);
				expect(cancelledBeforeReady).toBe(true);
				expect(yield* Fiber.join(steering)).toMatchObject({
					_tag: "Success",
					success: { status: "cancelled" },
				});
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
			}),
		),
);

it.effect(
	"send scope releases each resource once on dispatched send failure",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				yield* f.manager.recoverEffect;
				const sending = yield* Effect.forkChild(
					f.instance.sendTurnEffect(f.input).pipe(Effect.result),
				);
				yield* Deferred.await(f.sending);
				yield* f.terminal("turn.error");
				yield* Deferred.fail(f.pending, {
					...runnerFailure("send-turn", "native send rejected"),
					replied: true,
				});
				expect(yield* Fiber.join(sending)).toMatchObject({
					_tag: "Success",
					success: { status: "error" },
				});
				expect(
					yield* f.sql`SELECT status FROM provider_runs WHERE id = 'fixture-send-scope:1'`,
				).toEqual([{ status: "error" }]);
				yield* f.assertReleased();
				expect(f.terminalCount()).toBe(1);
			}),
		),
);

it.effect(
	"send scope closes on native cancellation without the abort watcher waiting on itself",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect) return yield* Effect.die("missing connect");
				vi.mocked(f.driver.connect).mockImplementationOnce((options) =>
					connect({
						...options,
						onHello: (hello, connection, replay) => {
							const command = connection.commandEffect.bind(connection);
							vi.spyOn(connection, "commandEffect").mockImplementation(
								(id, payload) =>
									command(id, payload).pipe(
										Effect.tap(() =>
											payload.type === "abort"
												? f.terminal("turn.interrupted").pipe(
														Effect.andThen(
															options.emit(
																{ type: "release-sink", sinkId: f.sinkId },
																"s",
															),
														),
														Effect.andThen(
															Deferred.fail(f.pending, {
																...runnerFailure(
																	"send-turn",
																	"native cancellation",
																),
																code: "cancelled",
																replied: true,
															}),
														),
													)
												: Effect.void,
										),
									),
							);
							return options.onHello(hello, connection, replay);
						},
					}),
				);
				yield* f.manager.recoverEffect;
				const sending = yield* Effect.forkChild(
					f.instance.sendTurnEffect(f.input).pipe(Effect.result),
				);
				yield* Deferred.await(f.sending);
				f.abort.abort();
				yield* TestClock.adjust(0);
				yield* f.assertReleased();
				yield* Fiber.join(sending);
				expect(f.terminalCount()).toBe(1);
				expect(
					f.commands.filter((command) => command.type === "abort"),
				).toHaveLength(1);
			}),
		),
);

it.effect("closing the provider parent closes its live send scope", () =>
	runRetirement(
		Effect.gen(function* () {
			const owner = yield* Scope.fork(yield* Effect.scope, "sequential");
			const f = yield* sendScopeFixture().pipe(Scope.provide(owner));
			yield* f.instance.sendTurnEffect(f.input);
			yield* f.terminal("turn.completed");
			expect(f.account.released).toBe(0);
			yield* Scope.close(owner, Exit.void);
			yield* f.assertReleased(false);
			expect(f.terminalCount()).toBe(1);
		}),
	),
);

it.effect(
	"parent shutdown detaches a pending approval before closing its send",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const owner = yield* Scope.fork(yield* Effect.scope, "sequential");
				const instance = yield* makeRunnerProviderInstance(
					{
						accounts: Effect.succeed(
							accountsStateFromInstances([], configuredClaudeConfigDir("/tmp")),
						),
					},
					{
						driverKind: "claude",
						discoverEffect: () => Effect.die("unused discovery"),
						generateTextEffect: () => Effect.die("unused generation"),
						prepareTurnEffect: (input) =>
							Effect.succeed({
								input: {
									...input,
									prompt: "send",
									history: [],
									facts: { _tag: "Claude" as const },
								},
							}),
					},
					(emit) =>
						makeInProcessSessionRunner(
							(sinks) =>
								Effect.succeed({
									sendTurn: (_input, sink) =>
										Effect.sync(() => {
											sinks.retainSink(sink);
											return {
												status: "accepted" as const,
												cost: 0,
												tokens: { input: 0, output: 0 },
												durationMs: 0,
												providerStateUpdates: [],
											};
										}),
									interrupt: () => Effect.void,
									applySettings: () => Effect.void,
									endSession: () => Effect.void,
								}),
							emit,
						),
				).pipe(Scope.provide(owner));
				const asked = yield* Deferred.make<void>();
				const order: string[] = [];
				const sink = createMockEventSink();
				Object.assign(sink, {
					detachInteractions: () =>
						Effect.sync(() => {
							order.push("detached");
						}),
				});
				vi.mocked(sink.requestPermission).mockImplementation(() =>
					Deferred.succeed(asked, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.onInterrupt(() =>
							Effect.sync(() => {
								order.push("interrupted");
							}),
						),
					),
				);
				const abort = new AbortController();
				const removed = vi.spyOn(abort.signal, "removeEventListener");
				const input = makeBaseSendTurnInput({
					eventSink: sink,
					abortSignal: abort.signal,
				});
				yield* instance.sendTurnEffect(input);
				yield* instance.handleOutputEffect({
					type: "permission-request",
					sinkId: runnerSinkId(input.inputId),
					request: {
						requestId: "pending-approval",
						sessionId: input.sessionId,
						turnId: input.inputId,
						providerItemId: "tool",
						toolName: "Bash",
						toolInput: { command: "pwd" },
					},
				});
				yield* Deferred.await(asked);
				yield* TestClock.adjust(0);
				yield* Scope.close(owner, Exit.void);
				expect(order).toEqual(["detached", "interrupted"]);
				expect(
					removed.mock.calls.filter(([event]) => event === "abort"),
				).toHaveLength(1);
			}),
		),
);

it.effect(
	"a release-sink frame from another runner closes no send resource",
	() => {
		const warnings: string[] = [];
		return runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect) return yield* Effect.die("missing connect");
				vi.mocked(f.driver.connect).mockImplementationOnce((options) =>
					connect({
						...options,
						onHello: (hello, connection, replay) =>
							options.onHello(
								{ ...hello, buildId: "previous-build" },
								connection,
								replay,
							),
					}),
				);
				yield* f.manager.recoverEffect;
				const old = f.attachments[0];
				if (!old?.onUpgradeState)
					return yield* Effect.die("missing old runner");
				old.onUpgradeState({
					quiescent: true,
					revision: 1,
					snapshot: {
						input: {
							...f.input,
							configDir: configuredClaudeConfigDir(f.root),
							folderSource: "implicitDefault",
						},
						options: {},
					},
				});
				yield* TestClock.adjust("4 seconds");
				expect(f.attachments.length).toBeGreaterThan(1);
				yield* f.instance.sendTurnEffect(f.input);
				yield* old.emit({ type: "release-sink", sinkId: f.sinkId }, "s");
				yield* old.emit({ type: "release-sink", sinkId: f.sinkId }, "s");
				yield* TestClock.adjust(0);
				expect(f.account.released).toBe(0);
				expect(
					f.removed.mock.calls.filter(([type]) => type === "abort"),
				).toHaveLength(0);
				expect(
					f.outputs.filter(
						(output) =>
							output.type === "release-sink" && output.sinkId === f.sinkId,
					),
				).toEqual([]);
				yield* f.terminal("turn.completed");
				expect(f.terminalCount()).toBe(1);
				const current = f.attachments.at(-1);
				if (!current) return yield* Effect.die("missing current runner");
				yield* current.emit({ type: "release-sink", sinkId: f.sinkId }, "s");
				yield* f.assertReleased();
				expect(
					warnings.filter((message) => message.includes("release-sink")),
				).toHaveLength(1);
			}),
		).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((options) => {
						if (options.logLevel === "Warn")
							warnings.push(String(options.message));
					}),
				]),
			),
		);
	},
);

it.effect(
	"send scope bounds a hanging release and still runs the other resource finalizers",
	() => {
		const warnings: string[] = [];
		return runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				yield* f.instance.sendTurnEffect(f.input);
				yield* f.terminal("turn.completed");
				const old = f.attachments[0];
				if (!old) return yield* Effect.die("missing send runner");
				const entered = yield* Deferred.make<void>();
				const resume = yield* Deferred.make<void>();
				const record = f.output.getMockImplementation();
				if (!record) return yield* Effect.die("missing recorder");
				f.output.mockImplementation((output, sessionId) =>
					record(output, sessionId).pipe(
						Effect.tap(() =>
							output.type === "release-sink" && output.sinkId === f.sinkId
								? Deferred.succeed(entered, undefined).pipe(
										Effect.andThen(Deferred.await(resume)),
										Effect.uninterruptible,
									)
								: Effect.void,
						),
					),
				);
				yield* Effect.gen(function* () {
					const releasing = yield* Effect.forkChild(
						old.emit({ type: "release-sink", sinkId: f.sinkId }, "s"),
					);
					yield* Deferred.await(entered);
					yield* TestClock.adjust("4 seconds");
					expect(releasing.pollUnsafe()).toBeDefined();
					expect(
						warnings.filter((message) => message.includes("timed out")),
					).toHaveLength(1);
					yield* f.assertReleased();
					expect(f.terminalCount()).toBe(1);
				}).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
			}),
		).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((options) => {
						if (options.logLevel === "Warn")
							warnings.push(String(options.message));
					}),
				]),
			),
		);
	},
);

it.effect(
	"a resend waits for the closing send before reusing its sink ID",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const resume = yield* Deferred.make<void>();
				const f = yield* sendScopeFixture(undefined, (_id, work) =>
					work.pipe(
						Effect.ensuring(
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(resume)),
								Effect.uninterruptible,
							),
						),
					),
				);
				yield* f.instance.sendTurnEffect(f.input);
				yield* f.terminal("turn.completed");
				const old = f.attachments[0];
				if (!old) return yield* Effect.die("missing closing runner");
				yield* Effect.gen(function* () {
					const closing = yield* Effect.forkChild(
						old.emit({ type: "release-sink", sinkId: f.sinkId }, "s"),
					);
					yield* Deferred.await(entered);
					const replacementSink = createMockEventSink();
					const replacementAbort = new AbortController();
					const removed = vi.spyOn(
						replacementAbort.signal,
						"removeEventListener",
					);
					const resending = yield* Effect.forkChild(
						f.instance
							.sendTurnEffect({
								...f.input,
								eventSink: replacementSink,
								abortSignal: replacementAbort.signal,
							})
							.pipe(Effect.exit),
					);
					yield* TestClock.adjust(0);
					expect(resending.pollUnsafe()).toBeUndefined();
					yield* Deferred.succeed(resume, undefined);
					yield* Fiber.join(closing);
					expect(yield* Fiber.join(resending)).toMatchObject({
						_tag: "Success",
						value: { status: "completed" },
					});
					expect(f.account).toEqual({ acquired: 2, released: 1 });
					expect(removed).not.toHaveBeenCalled();
					yield* f.terminal("turn.completed");
					expect(
						vi
							.mocked(replacementSink.push)
							.mock.calls.filter(([event]) => event.type === "turn.completed"),
					).toHaveLength(1);
					expect(f.terminalCount()).toBe(1);
					yield* old.emit({ type: "release-sink", sinkId: f.sinkId }, "s");
					expect(f.account).toEqual({ acquired: 2, released: 2 });
					expect(
						removed.mock.calls.filter(([type]) => type === "abort"),
					).toHaveLength(1);
				}).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
			}),
		),
);

it.effect(
	"account invalidation cancels a queued retry before replacement dispatch",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const holder = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
				const f = yield* sendScopeFixture(undefined, (_id, work) =>
					Effect.fiber.pipe(
						Effect.tap((fiber) => Deferred.succeed(holder, fiber)),
						Effect.andThen(work),
					),
				);
				// This host refuses before receiving the command, so there is no
				// journal record. RunnerSocket supplies the typed refusal below.
				f.replaySend.execute = () =>
					Deferred.succeed(f.sending, undefined).pipe(
						Effect.andThen(Deferred.await(f.pending)),
					);
				yield* f.manager.recoverEffect;
				const sending = yield* Effect.forkChild(
					f.instance.sendTurnEffect(f.input),
				);
				yield* Deferred.await(f.sending);
				const old = f.attachments[0];
				if (!old) return yield* Effect.die("missing original runner");
				f.replacementGate.hold = true;
				const failure = {
					...runnerFailure("send-turn", "idle retry"),
					code: "runner_idle_exit",
					delivery: { _tag: "Refused", reason: "exiting" },
				} as const;
				f.processes.delete(100_088);
				old.onClose(failure);
				yield* Deferred.fail(f.pending, failure);
				yield* Deferred.await(f.replacementConnecting);
				yield* Effect.gen(function* () {
					yield* Effect.forkChild(
						Fiber.interrupt(yield* Deferred.await(holder)),
					);
					yield* TestClock.adjust(0);
					yield* Deferred.succeed(f.replacementReady, undefined);
					expect((yield* Fiber.join(sending)).status).toBe("cancelled");
					expect(
						f.commands.filter((command) => command.type === "send-turn"),
					).toHaveLength(1);
					expect(f.account).toEqual({ acquired: 1, released: 1 });
				}).pipe(
					Effect.ensuring(Deferred.succeed(f.replacementReady, undefined)),
				);
			}),
		),
);

it.effect(
	"reattachment restores account demand after replay failed before retention",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const holder = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
				const f = yield* sendScopeFixture(undefined, (_id, work) =>
					Effect.fiber.pipe(
						Effect.tap((fiber) => Deferred.succeed(holder, fiber)),
						Effect.andThen(work),
					),
				);
				yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at)
			VALUES (1, 'retained', 'test-project', 's', 'account', 'send_turn', ${JSON.stringify(f.input)}, 'running', 0, 1, 1)`;
				const firstReplay = yield* Deferred.make<void>();
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect) return yield* Effect.die("missing injected connection");
				vi.mocked(f.driver.connect).mockImplementationOnce((options) =>
					connect({
						...options,
						onHello: (hello, connection) =>
							options.onHello(
								hello,
								connection,
								Deferred.succeed(firstReplay, undefined).pipe(
									Effect.andThen(
										Effect.fail(runnerFailure("replay", "first replay failed")),
									),
								),
							),
					}),
				);
				const recovering = yield* Effect.forkChild(
					f.instance.recoverProjectContextsEffect(() =>
						Effect.succeed(undefined),
					),
				);
				yield* Deferred.await(firstReplay);
				yield* TestClock.adjust("150 millis");
				yield* Fiber.join(recovering);
				expect(f.attachments).toHaveLength(2);
				expect(f.sendHandles).toHaveLength(1);
				expect(f.account).toEqual({ acquired: 1, released: 0 });
				yield* Effect.forkChild(Fiber.interrupt(yield* Deferred.await(holder)));
				yield* TestClock.adjust(0);
				expect(
					f.commands.filter((command) => command.type === "interrupt"),
				).toHaveLength(1);
				const attachment = f.attachments.at(-1);
				if (!attachment) return yield* Effect.die("missing reattachment");
				yield* attachment.emit(
					{ type: "release-sink", sinkId: "retained" },
					"s",
				);
				expect(f.account).toEqual({ acquired: 1, released: 1 });
			}),
		),
);

it.effect(
	"parent-driven child finalization lets a waiting resend proceed after resources finish",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const resume = yield* Deferred.make<void>();
				const f = yield* sendScopeFixture(undefined, (_id, work) =>
					work.pipe(
						Effect.ensuring(
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(resume)),
							),
						),
					),
				);
				const proofPath = process.env["R2_S5_PARENT_PROOF"];
				if (proofPath) writeFileSync(proofPath, "parent-close fixture ready\n");
				const handles = f.sendHandles;
				yield* f.instance.sendTurnEffect(f.input);
				const original = handles[0];
				if (!original) return yield* Effect.die("missing admitted handle");
				yield* f.terminal("turn.completed");
				yield* Effect.gen(function* () {
					// Scope's parent finalizer invokes raw child close, bypassing handle.close.
					const closing = yield* Effect.forkChild(
						Scope.close(original.scope, Exit.void),
					);
					yield* Deferred.await(entered);
					if (proofPath)
						appendFileSync(
							proofPath,
							"raw child close reached the held resource finalizer\n",
						);
					const replacementSink = createMockEventSink();
					if (proofPath)
						appendFileSync(
							proofPath,
							"starting same-key resend with scheduler yields disabled\n",
						);
					const resending = yield* Effect.forkChild(
						f.instance
							.sendTurnEffect({
								...f.input,
								eventSink: replacementSink,
								abortSignal: new AbortController().signal,
							})
							.pipe(
								Effect.provideService(Scheduler.PreventSchedulerYield, true),
							),
					);
					yield* TestClock.adjust(0);
					expect(resending.pollUnsafe()).toBeUndefined();
					yield* Deferred.succeed(resume, undefined);
					yield* Fiber.join(closing);
					expect((yield* Fiber.join(resending)).status).toBe("completed");
					if (proofPath)
						appendFileSync(
							proofPath,
							"old finalizers finished and fresh-handle resend completed\n",
						);
					expect(handles).toHaveLength(2);
					expect(handles[1]).not.toBe(original);
					expect(f.account).toEqual({ acquired: 2, released: 1 });
					yield* f.terminal("turn.completed");
					expect(
						vi
							.mocked(replacementSink.push)
							.mock.calls.filter(([event]) => event.type === "turn.completed"),
					).toHaveLength(1);
					const current = f.attachments.at(-1);
					if (!current) return yield* Effect.die("missing runner");
					yield* current.emit({ type: "release-sink", sinkId: f.sinkId }, "s");
					expect(f.account).toEqual({ acquired: 2, released: 2 });
				}).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
			}),
		),
);

it.effect(
	"concurrent Fresh admissions reserve one key until all finalizers finish",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture(undefined, undefined, "cursor");
				yield* f.manager.recoverEffect;
				const owner = f.manager.sendScopes;
				if (!owner) return yield* Effect.die("missing send owner");
				const opening = yield* Deferred.make<void>();
				const allowOpen = yield* Deferred.make<void>();
				const finalizing = yield* Deferred.make<void>();
				const allowClose = yield* Deferred.make<void>();
				const open = vi.mocked(owner.open).getMockImplementation();
				if (!open) return yield* Effect.die("missing open implementation");
				const openingSpy = vi
					.spyOn(owner, "open")
					.mockImplementationOnce((sinkId, sessionId) =>
						Deferred.succeed(opening, undefined).pipe(
							Effect.andThen(Deferred.await(allowOpen)),
							Effect.andThen(open(sinkId, sessionId)),
						),
					);
				const releases: string[] = [];
				const acquire = owner.acquire;
				vi.spyOn(owner, "acquire").mockImplementation(
					(send, sinkId, resource, allocation, release) =>
						acquire(send, sinkId, resource, allocation, (value) =>
							Effect.sync(() => releases.push(resource)).pipe(
								Effect.andThen(
									resource === "provider admission" && send === f.sendHandles[0]
										? Deferred.succeed(finalizing, undefined).pipe(
												Effect.andThen(Deferred.await(allowClose)),
											)
										: Effect.void,
								),
								Effect.andThen(release(value)),
							),
						),
				);
				const commit = yield* makeCommitAndSignal;
				let admittedRuns = 0;
				const admit = () =>
					Effect.gen(function* () {
						const input = {
							...f.input,
							runId: `fresh-run:${++admittedRuns}`,
							commandAttempt: 0,
							prompt: "same input",
							history: [],
						};
						yield* commit([
							canonicalEvent("run.requested", "s", {
								runId: input.runId,
								inputId: input.inputId,
							}),
						]);
						const reserved = yield* reserveTestRun(input, {
							ownerForExistingRun: true,
						});
						return yield* f.instance.admitSendEffect(
							{ origin: { _tag: "Fresh" }, sinkId: f.sinkId, input: reserved },
							(send) =>
								f.manager.executeEffect(
									{
										type: "send-turn",
										sinkId: f.sinkId,
										input: reserved,
										aborted: false,
									},
									send,
								),
						);
					});
				yield* Effect.gen(function* () {
					const fresh = yield* Effect.forkChild(admit());
					yield* Deferred.await(opening);
					const second = yield* Effect.forkChild(admit());
					yield* TestClock.adjust(0);
					expect(openingSpy).toHaveBeenCalledTimes(1);
					expect(second.pollUnsafe()).toBeUndefined();
					yield* Deferred.succeed(allowOpen, undefined);
					yield* Deferred.await(f.sending);
					yield* Deferred.succeed(f.pending, {
						status: "completed",
						cost: 0,
						tokens: { input: 0, output: 0 },
						durationMs: 0,
						providerStateUpdates: [],
					});
					expect(Option.getOrThrow(yield* Fiber.join(fresh)).status).toBe(
						"completed",
					);
					yield* f.terminal("turn.completed", "fresh-run:1");
					const attachment = f.attachments.at(-1);
					if (!attachment) return yield* Effect.die("missing attachment");
					const closing = yield* Effect.forkChild(
						attachment.emit({ type: "release-sink", sinkId: f.sinkId }, "s"),
					);
					yield* Deferred.await(finalizing);
					yield* TestClock.adjust(0);
					expect(f.sendHandles).toHaveLength(1);
					expect(second.pollUnsafe()).toBeUndefined();
					yield* Deferred.succeed(allowClose, undefined);
					yield* Fiber.join(closing);
					expect(Option.getOrThrow(yield* Fiber.join(second)).status).toBe(
						"completed",
					);
					expect(f.sendHandles).toHaveLength(2);
					expect(f.sendHandles[1]).not.toBe(f.sendHandles[0]);
					yield* f.terminal("turn.completed", "fresh-run:2");
					yield* attachment.emit(
						{ type: "release-sink", sinkId: f.sinkId },
						"s",
					);
					yield* attachment.emit(
						{ type: "release-sink", sinkId: f.sinkId },
						"s",
					);
					expect(f.account).toEqual({ acquired: 2, released: 2 });
					for (const resource of [
						"provider admission",
						"manager sink",
						"pending send",
					])
						expect(releases.filter((name) => name === resource)).toHaveLength(
							2,
						);
					expect(
						f.outputs.filter(
							(output) =>
								output.type === "event" &&
								output.event.type === "turn.completed",
						),
					).toHaveLength(2);
					expect(f.sendHandles.map((send) => send.assignment._tag)).toEqual([
						"Closed",
						"Closed",
					]);
				}).pipe(
					Effect.ensuring(
						Effect.all(
							[
								Deferred.succeed(allowOpen, undefined),
								Deferred.succeed(allowClose, undefined),
							],
							{ discard: true },
						),
					),
				);
			}),
		),
);

for (const stage of ["open", "acquire", "registered acquire"] as const)
	for (const ending of ["failure", "interruption"] as const)
		it.effect(
			`a provider admission ${stage} ${ending} frees its key and any partial handle`,
			() =>
				runRetirement(
					Effect.gen(function* () {
						const f = yield* sendScopeFixture(undefined, undefined, "cursor");
						const owner = f.manager.sendScopes;
						if (!owner) return yield* Effect.die("missing send owner");
						const failure =
							ending === "interruption"
								? Effect.interrupt
								: Effect.die("injected admission failure");
						if (stage === "registered acquire") {
							const acquire = owner.acquire;
							vi.spyOn(owner, "acquire").mockImplementationOnce((...args) =>
								acquire(...args).pipe(Effect.andThen(failure)),
							);
						} else vi.spyOn(owner, stage).mockImplementationOnce(() => failure);
						const request = {
							origin: { _tag: "Fresh" as const },
							sinkId: f.sinkId,
							input: f.input,
						};
						expect(
							(yield* Effect.exit(
								f.instance.admitSendEffect(request, () => Effect.void),
							))._tag,
						).toBe("Failure");
						expect(
							f.sendHandles.every((send) => send.assignment._tag === "Closed"),
						).toBe(true);
						const next = yield* f.instance.admitSendEffect(request, (send) =>
							Effect.succeed(send),
						);
						expect(Option.getOrThrow(next).assignment._tag).toBe("Closed");
						expect(f.sendHandles.at(-1)).toBe(Option.getOrThrow(next));
					}),
				),
		);

it.effect(
	"an in-process accepted intake holds its handle until the final native sink release",
	() =>
		runRetirement(
			Effect.gen(function* () {
				let bindings: RunnerSinkBindings | undefined;
				let native: EventSink | undefined;
				const instance = yield* makeRunnerProviderInstance(
					{
						daemonConfigDir: "/tmp",
						accounts: Effect.succeed(
							accountsStateFromInstances([], configuredClaudeConfigDir("/tmp")),
						),
					},
					{
						driverKind: "claude",
						discoverEffect: () => Effect.die("unused discovery"),
						generateTextEffect: () => Effect.die("unused"),
						prepareTurnEffect: (input) =>
							Effect.succeed({
								input: {
									...input,
									prompt: "send",
									history: [],
									facts: { _tag: "Claude" as const },
								},
							}),
					},
					(emit) =>
						makeInProcessSessionRunner((sinks) => {
							bindings = sinks;
							return Effect.succeed({
								sendTurn: (_input, sink) =>
									Effect.sync(() => {
										sinks.retainSink(sink);
										native = sink;
										return {
											status: "accepted" as const,
											cost: 0,
											tokens: { input: 0, output: 0 },
											durationMs: 0,
											providerStateUpdates: [],
										};
									}),
								interrupt: () => Effect.void,
								applySettings: () => Effect.void,
								endSession: () => Effect.void,
							});
						}, emit),
				);
				const abort = new AbortController();
				const removed = vi.spyOn(abort.signal, "removeEventListener");
				const sink = createMockEventSink();
				const input = makeBaseSendTurnInput({
					inputId: "accepted-id",
					eventSink: sink,
					abortSignal: abort.signal,
				});
				expect((yield* instance.sendTurnEffect(input)).status).toBe("accepted");
				const captured = native;
				const owner = bindings;
				if (!captured || !owner)
					return yield* Effect.die("missing native retained sink");
				yield* Effect.gen(function* () {
					expect(removed).not.toHaveBeenCalled();
					yield* captured.push({
						eventId: "native-completed",
						type: "turn.completed",
						providerId: "claude",
						sessionId: input.sessionId,
						providerRefs: {},
						rawSource: { kind: "test" },
						createdAt: 1,
						data: {},
					});
					expect(
						vi
							.mocked(sink.push)
							.mock.calls.filter(([event]) => event.type === "turn.completed"),
					).toHaveLength(1);
					yield* owner.releaseSinkEffect(captured);
					expect(
						removed.mock.calls.filter(([type]) => type === "abort"),
					).toHaveLength(1);
				}).pipe(Effect.ensuring(owner.releaseSinkEffect(captured)));
			}),
		),
);

it.effect(
	"an in-process send keeps a delayed abort attached to its original handle",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const first = yield* Deferred.make<void>();
				const second = yield* Deferred.make<void>();
				const started = yield* Deferred.make<void>();
				const abortEntered = yield* Deferred.make<void>();
				const abortResume = yield* Deferred.make<void>();
				const signals: AbortSignal[] = [];
				let runner: SessionRunner | undefined;
				const instance = yield* makeRunnerProviderInstance(
					{
						daemonConfigDir: "/tmp",
						accounts: Effect.succeed(
							accountsStateFromInstances([], configuredClaudeConfigDir("/tmp")),
						),
					},
					{
						driverKind: "claude",
						discoverEffect: () => Effect.die("unused discovery"),
						generateTextEffect: () => Effect.die("unused"),
						prepareTurnEffect: (input) =>
							Effect.succeed({
								input: {
									...input,
									prompt: "send",
									history: [],
									facts: { _tag: "Claude" as const },
								},
							}),
					},
					(emit) =>
						makeInProcessSessionRunner(
							() =>
								Effect.succeed({
									sendTurn: (_input, _sink, signal) =>
										Effect.gen(function* () {
											signals.push(signal);
											yield* Deferred.succeed(started, undefined);
											yield* Deferred.await(
												signals.length === 1 ? first : second,
											);
											return {
												status: "completed" as const,
												cost: 0,
												tokens: { input: 0, output: 0 },
												durationMs: 0,
												providerStateUpdates: [],
											};
										}),
									interrupt: () => Effect.void,
									applySettings: () => Effect.void,
									endSession: () => Effect.void,
								}),
							emit,
						).pipe(
							Effect.tap((value) =>
								Effect.sync(() => {
									runner = value;
								}),
							),
						),
				);
				if (!runner) return yield* Effect.die("missing injected runner");
				const nativeRunner = runner;
				const execute = runner.executeEffect.bind(runner);
				vi.spyOn(runner, "executeEffect").mockImplementation(
					(command, ...rest) =>
						(command.type === "abort"
							? Deferred.succeed(abortEntered, undefined).pipe(
									Effect.andThen(Deferred.await(abortResume)),
								)
							: Effect.void
						).pipe(Effect.andThen(() => execute(command, ...rest))),
				);
				const abort = new AbortController();
				const input = makeBaseSendTurnInput({
					inputId: "same-id",
					abortSignal: abort.signal,
				});
				yield* Effect.gen(function* () {
					const sending = yield* Effect.forkChild(
						instance.sendTurnEffect(input),
					);
					yield* Deferred.await(started);
					abort.abort();
					yield* Deferred.await(abortEntered);
					yield* Deferred.succeed(first, undefined);
					yield* Fiber.join(sending);
					const replacement = yield* Effect.forkChild(
						instance.sendTurnEffect({
							...input,
							abortSignal: new AbortController().signal,
						}),
					);
					yield* TestClock.adjust(0);
					expect(signals).toHaveLength(2);
					yield* Deferred.succeed(abortResume, undefined);
					yield* TestClock.adjust(0);
					expect(signals[1]?.aborted).toBe(false);
					// Native hosts receive already-fenced wire commands without daemon handles.
					yield* nativeRunner.executeEffect({
						type: "abort",
						sinkId: runnerSinkId(input.inputId),
					});
					expect(signals[1]?.aborted).toBe(true);
					yield* Deferred.succeed(second, undefined);
					yield* Fiber.join(replacement);
				}).pipe(
					Effect.ensuring(
						Effect.all([
							Deferred.succeed(first, undefined),
							Deferred.succeed(second, undefined),
							Deferred.succeed(abortResume, undefined),
						]),
					),
				);
			}),
		),
);

it.effect(
	"an adopted send closes on its runner release-sink and releases resources once",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				const input = { ...f.input, prompt: "adopted", history: [] };
				yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at) VALUES (1, 'retained', 'test-project', 's', 'account', 'send_turn', ${JSON.stringify(input)}, 'running', 0, 1, 1)`;
				yield* f.instance.recoverProjectContextsEffect(() =>
					Effect.succeed(undefined),
				);
				expect(f.sendHandles).toHaveLength(1);
				expect(f.account).toEqual({ acquired: 1, released: 0 });
				const attachment = f.attachments[0];
				if (!attachment) return yield* Effect.die("missing adopted runner");
				yield* attachment.emit(
					{ type: "release-sink", sinkId: "retained" },
					"s",
				);
				yield* attachment.emit(
					{ type: "release-sink", sinkId: "retained" },
					"s",
				);
				yield* TestClock.adjust(0);
				expect(f.sendHandles[0]?.assignment._tag).toBe("Closed");
				expect(f.account).toEqual({ acquired: 1, released: 1 });
				expect(
					f.outputs.filter(
						(output) =>
							output.type === "release-sink" && output.sinkId === "retained",
					),
				).toHaveLength(1);
			}),
		),
);

for (const origin of ["Adopted"] as const)
	it.effect(`a closed retained ${origin} admission is a typed no-op`, () =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture(undefined, undefined, "cursor");
				const first = yield* f.instance.admitSendEffect(
					{ origin: { _tag: "Fresh" }, sinkId: f.sinkId, input: f.input },
					(send) => Effect.succeed(send),
				);
				const retained = Option.getOrThrow(first);
				const work = vi.fn(() => Effect.void);
				const refuse = vi.fn(() => Effect.void);
				const result = yield* f.instance.admitSendEffect(
					{
						origin: { _tag: origin },
						sinkId: f.sinkId,
						input: f.input,
						retained,
						refuse,
					},
					work,
				);
				expect(result).toEqual(Option.none());
				expect(work).not.toHaveBeenCalled();
				expect(refuse).not.toHaveBeenCalled();
				expect(f.sendHandles).toHaveLength(1);
				expect(
					f.outputs.filter((output) => output.type === "release-sink"),
				).toHaveLength(1);
			}),
		),
	);

for (const origin of ["continuation", "retry"] as const)
	it.effect(
		`S7 recovery requeues a current ${origin} despite an older turn terminal`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* sendScopeFixture(undefined, undefined, "cursor");
					const input = {
						...f.input,
						prompt: "recovered",
						history: [],
						...(origin === "continuation"
							? { continuation: { cutOffMessageId: "old-input" } }
							: {}),
					};
					yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('current-run', 's', 'pending', 1)`;
					yield* (yield* makeCommitAndSignal)([
						canonicalEvent("run.dispatched", "s", {
							runId: "current-run",
							runnerId: "131313131313",
						}),
					]);
					yield* f.sql`INSERT INTO turns (id, session_id, state, user_message_id, requested_at, run_id) VALUES ('old-turn', 's', 'interrupted', ${origin === "continuation" ? "old-input" : input.inputId}, 1, 'old-run')`;
					yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at, run_id)
		VALUES (1, 'current-command', 'test-project', 's', 'account', 'send_turn', ${JSON.stringify(input)}, 'running', 0, 1, 1, 'current-run')`;
					yield* Deferred.succeed(f.pending, {
						status: "completed",
						cost: 0,
						tokens: { input: 0, output: 0 },
						durationMs: 0,
						providerStateUpdates: [],
					});
					yield* f.instance.recoverProjectContextsEffect(() =>
						Effect.succeed(undefined),
					);
					yield* TestClock.adjust(0);
					expect(
						f.commands.filter((command) => command.type === "send-turn"),
					).toHaveLength(0);
					expect(f.sendHandles).toEqual([]);
					expect(
						yield* f.sql`SELECT status, run_id FROM provider_command_outbox`,
					).toEqual([{ status: "retryable_failed", run_id: "current-run" }]);
					expect(f.account).toEqual({ acquired: 0, released: 0 });
				}),
			),
	);

it.effect(
	"an acknowledged command completed at intake keeps its active native run resources",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture(undefined, undefined, "cursor");
				const input = {
					...f.input,
					prompt: "adopted",
					history: [],
					continuation: { cutOffMessageId: "old-adopted-input" },
				};
				yield* f.sql`INSERT INTO turns (id, session_id, state, user_message_id, requested_at, run_id) VALUES ('old-adopted-turn', 's', 'interrupted', 'old-adopted-input', 1, 'old-run')`;
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('adopted-active-run', 's', 'running', 1)`;
				yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at, run_id)
	VALUES (1, 'intake-completed', 'test-project', 's', 'account', 'send_turn', ${JSON.stringify(input)}, 'completed', 0, 1, 1, 'adopted-active-run')`;
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect) return yield* Effect.die("missing connection");
				vi.mocked(f.driver.connect).mockImplementation((options) =>
					connect({
						...options,
						onHello: (hello, connection, replay) =>
							options.onHello(
								{
									...hello,
									sendJournalAnswers: true,
									sendAnswers: [],
									bindings: [
										{
											sinkId: f.sinkId,
											token: sendToken("tx", "intake-completed", 0),
											sessionId: "s",
											released: false,
										},
									],
								},
								connection,
								replay,
							),
					}),
				);
				yield* f.instance.recoverProjectContextsEffect(() =>
					Effect.succeed(undefined),
				);
				yield* TestClock.adjust(0);
				expect(f.sendHandles.map((send) => send.assignment._tag)).toEqual([
					"Dispatched",
				]);
				expect(f.account).toEqual({ acquired: 1, released: 0 });
				const attachment = f.attachments[0];
				if (!attachment) return yield* Effect.die("missing adopted attachment");
				yield* attachment.emit({ type: "release-sink", sinkId: f.sinkId }, "s");
				expect(f.account).toEqual({ acquired: 1, released: 1 });
			}),
		),
);

it.effect(
	"a Cursor adoption released during backlog replay keeps its healthy attachment and skips account restoration",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture(undefined, undefined, "cursor");
				const input = { ...f.input, prompt: "adopted", history: [] };
				yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at)
		VALUES (1, 'adopted-command', 'test-project', 's', 'account', 'send_turn', ${JSON.stringify(input)}, 'running', 0, 1, 1)`;
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect) return yield* Effect.die("missing connection");
				let hellos = 0;
				const helloResult =
					yield* Deferred.make<Exit.Exit<void, SessionFailure>>();
				vi.mocked(f.driver.connect).mockImplementation((options) =>
					connect({
						...options,
						onHello: (hello, connection) =>
							options
								.onHello(
									{
										...hello,
										sendJournalAnswers: true,
										sendAnswers: [
											{
												token: sendToken("tx", "adopted-command", 0),
												status: "running",
											},
										],
										bindings: [
											{
												sinkId: f.sinkId,
												token: sendToken("tx", "adopted-command", 0),
												sessionId: "s",
												released: false,
											},
										],
									},
									connection,
									options
										.emit({ type: "release-sink", sinkId: f.sinkId }, "s")
										.pipe(Effect.asVoid),
								)
								.pipe(
									Effect.onExit((exit) => Deferred.succeed(helloResult, exit)),
									Effect.tap(() => Effect.sync(() => hellos++)),
								),
					}),
				);
				const recovering = yield* Effect.forkChild(
					f.instance.recoverProjectContextsEffect(() =>
						Effect.succeed(undefined),
					),
				);
				expect(yield* Deferred.await(helloResult)).toMatchObject({
					_tag: "Success",
				});
				yield* Fiber.join(recovering);
				yield* TestClock.adjust(0);
				expect(hellos).toBe(1);
				expect(f.attachments).toHaveLength(1);
				expect(f.destroyed).not.toHaveBeenCalled();
				expect(f.account).toEqual({ acquired: 0, released: 0 });
				expect(f.sendHandles.map((send) => send.assignment._tag)).toEqual([
					"Closed",
				]);
				expect(
					f.outputs.filter((output) => output.type === "release-sink"),
				).toHaveLength(1);
				expect(
					f.outputs.filter((output) => output.type === "cancel-interactions"),
				).toHaveLength(0);
			}),
		),
);

for (const trigger of [
	"user abort",
	"provider account invalidation",
] as const) {
	it.effect(
		`a delayed ${trigger} cannot cancel a replacement with the same sink ID`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const holder = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
					const f = yield* sendScopeFixture(
						trigger === "provider account invalidation"
							? {
									use: (account, work) =>
										Effect.fiber.pipe(
											Effect.tap((fiber) => Deferred.succeed(holder, fiber)),
											Effect.andThen(work(account)),
										),
								}
							: undefined,
					);
					const entered = yield* Deferred.make<void>();
					const resume = yield* Deferred.make<void>();
					const execute = f.manager.executeEffect.bind(f.manager);
					vi.spyOn(f.manager, "executeEffect").mockImplementation(
						(command, ...rest) =>
							(command.type === "abort"
								? Deferred.succeed(entered, undefined).pipe(
										Effect.andThen(Deferred.await(resume)),
									)
								: Effect.void
							).pipe(Effect.andThen(() => execute(command, ...rest))),
					);
					yield* f.instance.sendTurnEffect(f.input);
					yield* Effect.gen(function* () {
						if (trigger === "user abort") {
							yield* TestClock.adjust(0);
							f.abort.abort();
						} else
							yield* Effect.forkChild(
								Fiber.interrupt(yield* Deferred.await(holder)),
							);
						yield* Deferred.await(entered);
						yield* f.terminal("turn.completed");
						const old = f.attachments[0];
						if (!old) return yield* Effect.die("missing original runner");
						yield* old.emit({ type: "release-sink", sinkId: f.sinkId }, "s");
						const replacementSink = createMockEventSink();
						yield* f.instance.sendTurnEffect({
							...f.input,
							eventSink: replacementSink,
							abortSignal: new AbortController().signal,
						});
						const aborts = f.commands.filter(
							(command) => command.type === "abort",
						).length;
						yield* Deferred.succeed(resume, undefined);
						yield* TestClock.adjust(0);
						expect(
							f.commands.filter((command) => command.type === "abort"),
						).toHaveLength(aborts);
						expect(f.account).toEqual({ acquired: 2, released: 1 });
						yield* f.terminal("turn.completed");
						expect(
							vi
								.mocked(replacementSink.push)
								.mock.calls.filter(
									([event]) => event.type === "turn.completed",
								),
						).toHaveLength(1);
						yield* old.emit({ type: "release-sink", sinkId: f.sinkId }, "s");
						expect(f.account).toEqual({ acquired: 2, released: 2 });
					}).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
				}),
			),
	);
}

it.effect(
	"a delayed daemon close notification cannot close a replacement send",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				yield* f.instance.sendTurnEffect(f.input);
				yield* f.terminal("turn.completed");
				const old = f.attachments[0];
				if (!old) return yield* Effect.die("missing runner");
				const entered = yield* Deferred.make<void>();
				const resume = yield* Deferred.make<void>();
				const record = f.output.getMockImplementation();
				if (!record) return yield* Effect.die("missing recorder");
				f.output.mockImplementationOnce((output, sessionId) =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(resume)),
						Effect.andThen(record(output, sessionId)),
					),
				);
				yield* Effect.gen(function* () {
					const closing = yield* Effect.forkChild(
						old.emit({ type: "release-sink", sinkId: f.sinkId }, "s"),
					);
					yield* Deferred.await(entered);
					const replacementSink = createMockEventSink();
					const replacementAbort = new AbortController();
					const removed = vi.spyOn(
						replacementAbort.signal,
						"removeEventListener",
					);
					const resending = yield* Effect.forkChild(
						f.instance.sendTurnEffect({
							...f.input,
							eventSink: replacementSink,
							abortSignal: replacementAbort.signal,
						}),
					);
					yield* TestClock.adjust(0);
					expect(resending.pollUnsafe()).toBeUndefined();
					expect(f.account.acquired).toBe(1);
					expect(f.account.released).toBe(1);
					yield* Deferred.succeed(resume, undefined);
					yield* Fiber.join(closing);
					yield* Fiber.join(resending);
					expect(f.account.acquired).toBe(2);
					yield* TestClock.adjust(0);
					expect(f.account.released).toBe(1);
					expect(removed).not.toHaveBeenCalled();
					yield* f.terminal("turn.completed");
					expect(
						vi
							.mocked(replacementSink.push)
							.mock.calls.filter(([event]) => event.type === "turn.completed"),
					).toHaveLength(1);
					yield* old.emit({ type: "release-sink", sinkId: f.sinkId }, "s");
					expect(f.account.released).toBe(2);
					expect(
						removed.mock.calls.filter(([type]) => type === "abort"),
					).toHaveLength(1);
				}).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
			}),
		),
);

it.effect(
	"account invalidation does not wait on the send scope that joins its holder",
	() => {
		const warnings: string[] = [];
		return runRetirement(
			Effect.gen(function* () {
				const holder = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
				const outer = { acquired: 0, released: 0 };
				const f = yield* sendScopeFixture({
					use: (account, work) =>
						Effect.acquireUseRelease(
							Effect.sync(() => outer.acquired++),
							() =>
								Effect.fiber.pipe(
									Effect.tap((fiber) => Deferred.succeed(holder, fiber)),
									Effect.andThen(work(account)),
								),
							() => Effect.sync(() => outer.released++),
						),
				});
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect) return yield* Effect.die("missing connect");
				vi.mocked(f.driver.connect).mockImplementationOnce((options) =>
					connect({
						...options,
						onHello: (hello, connection, replay) => {
							const command = connection.commandEffect.bind(connection);
							vi.spyOn(connection, "commandEffect").mockImplementation(
								(id, payload) =>
									command(id, payload).pipe(
										Effect.tap(() =>
											payload.type === "abort"
												? options
														.emit(
															{
																type: "event",
																sinkId: f.sinkId,
																event: {
																	eventId: "account-native-cancel",
																	type: "turn.interrupted",
																	providerId: "claude",
																	sessionId: "s",
																	providerRefs: {},
																	rawSource: { kind: "test" },
																	createdAt: 1,
																	data: {},
																},
															},
															"s",
														)
														.pipe(
															Effect.andThen(
																options.emit(
																	{ type: "release-sink", sinkId: f.sinkId },
																	"s",
																),
															),
														)
												: Effect.void,
										),
									),
							);
							return options.onHello(hello, connection, replay);
						},
					}),
				);
				yield* f.manager.recoverEffect;
				yield* Effect.forkChild(
					f.instance.sendTurnEffect(f.input).pipe(Effect.result),
				);
				yield* Deferred.await(f.sending);
				yield* Effect.gen(function* () {
					const invalidating = yield* Effect.forkChild(
						Fiber.interrupt(yield* Deferred.await(holder)),
					);
					yield* TestClock.adjust(0);
					expect(invalidating.pollUnsafe()).toBeDefined();
					yield* f.assertReleased();
					expect(outer).toEqual({ acquired: 1, released: 1 });
					expect(f.terminalCount()).toBe(1);
					expect(
						warnings.filter((message) => message.includes("timed out")),
					).toEqual([]);
				}).pipe(
					Effect.ensuring(
						Deferred.fail(
							f.pending,
							runnerFailure("test", "finished invalidation test"),
						).pipe(Effect.andThen(TestClock.adjust("2 seconds"))),
					),
				);
			}),
		).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((options) => {
						if (options.logLevel === "Warn")
							warnings.push(String(options.message));
					}),
				]),
			),
		);
	},
);

it.effect(
	"manager account invalidation does not join a native interrupt that is closing its send",
	() => {
		const warnings: string[] = [];
		return runRetirement(
			Effect.gen(function* () {
				const holder = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
				const f = yield* sendScopeFixture(undefined, (_id, work) =>
					Effect.fiber.pipe(
						Effect.tap((fiber) => Deferred.succeed(holder, fiber)),
						Effect.andThen(work),
					),
				);
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect) return yield* Effect.die("missing connect");
				vi.mocked(f.driver.connect).mockImplementationOnce((options) =>
					connect({
						...options,
						onHello: (hello, connection, replay) => {
							const command = connection.commandEffect.bind(connection);
							vi.spyOn(connection, "commandEffect").mockImplementation(
								(id, payload) =>
									command(id, payload).pipe(
										Effect.tap(() =>
											payload.type === "interrupt"
												? options
														.emit(
															{
																type: "event",
																sinkId: f.sinkId,
																event: {
																	eventId: "manager-account-native-cancel",
																	type: "turn.interrupted",
																	providerId: "claude",
																	sessionId: "s",
																	providerRefs: {},
																	rawSource: { kind: "test" },
																	createdAt: 1,
																	data: {},
																},
															},
															"s",
														)
														.pipe(
															Effect.andThen(
																options.emit(
																	{ type: "release-sink", sinkId: f.sinkId },
																	"s",
																),
															),
														)
												: Effect.void,
										),
									),
							);
							return options.onHello(hello, connection, replay);
						},
					}),
				);
				yield* f.manager.recoverEffect;
				yield* Effect.forkChild(
					f.instance.sendTurnEffect(f.input).pipe(Effect.result),
				);
				yield* Deferred.await(f.sending);
				yield* Effect.gen(function* () {
					const invalidating = yield* Effect.forkChild(
						Fiber.interrupt(yield* Deferred.await(holder)),
					);
					yield* TestClock.adjust(0);
					expect(invalidating.pollUnsafe()).toBeDefined();
					yield* f.assertReleased();
					expect(f.terminalCount()).toBe(1);
					expect(
						warnings.filter((message) => message.includes("timed out")),
					).toEqual([]);
				}).pipe(
					Effect.ensuring(
						Deferred.fail(
							f.pending,
							runnerFailure("test", "finished manager invalidation"),
						).pipe(Effect.andThen(TestClock.adjust("2 seconds"))),
					),
				);
			}),
		).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((options) => {
						if (options.logLevel === "Warn")
							warnings.push(String(options.message));
					}),
				]),
			),
		);
	},
);

it.effect(
	"a delayed result for another run does not consume this send's failure outcome",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("run.requested", "s", {
						runId: "current-run",
						inputId: f.input.inputId,
					}),
				]);
				yield* f.manager.recoverEffect;
				const reserved = yield* reserveTestRun(
					{ ...f.input, runId: "current-run", commandAttempt: 0 },
					{ ownerForExistingRun: true },
				);
				const sending = yield* Effect.forkChild(
					f.instance.sendTurnEffect(reserved).pipe(Effect.result),
				);
				yield* Deferred.await(f.sending);
				const old = f.attachments[0];
				if (!old) return yield* Effect.die("missing dispatched runner");
				const event = (type: "run.started" | "turn.completed", runId: string) =>
					old.emit(
						{
							type: "event",
							sinkId: f.sinkId,
							event: {
								eventId: `${runId}-${type}`,
								type,
								runId,
								providerId: "claude",
								sessionId: "s",
								providerRefs: {},
								rawSource: { kind: "test" },
								createdAt: 1,
								data:
									type === "run.started"
										? { inputId: f.input.inputId, requestedRunId: runId }
										: {},
							},
						},
						"s",
					);
				yield* event("run.started", "current-run");
				yield* event("turn.completed", "earlier-run");
				yield* f.terminal("turn.error", "current-run");
				yield* Deferred.fail(f.pending, {
					...runnerFailure("send-turn", "current run failed"),
					replied: true,
				});
				yield* Fiber.join(sending);
				const delivered = vi
					.mocked(f.eventSink.push)
					.mock.calls.map(([event]) => event);
				expect(
					delivered.filter(
						(event) =>
							event.type === "turn.error" && event.runId === "current-run",
					),
				).toHaveLength(1);
				expect(
					delivered.filter(
						(event) =>
							event.type === "turn.completed" && event.runId === "earlier-run",
					),
				).toHaveLength(1);
				yield* f.assertReleased();
			}),
		),
);

for (const released of [true, false]) {
	it.effect(
		`recovery keeps an acknowledged historical send closed while ingesting trailing output (${released ? "released flag" : "legacy hello"})`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* sendScopeFixture();
					const connect = vi.mocked(f.driver.connect).getMockImplementation();
					if (!connect) return yield* Effect.die("missing connect");
					vi.mocked(f.driver.connect).mockImplementationOnce((options) =>
						connect({
							...options,
							onHello: (hello, connection, replay) =>
								options.onHello(
									{
										...hello,
										bindings: [
											{
												sinkId: "historical",
												sessionId: "s",
												...(released ? { released: true } : {}),
											},
										],
									},
									connection,
									replay,
								),
						}),
					);
					const recovery: RunnerRecoveryDependencies = {
						projectId: "test-project",
						ingestion: yield* ProviderRuntimeIngestionTag,
						pending: yield* PendingInteractionServiceTag,
						persist: yield* ClaudeEventPersistEffectTag,
						timeoutHooks: {},
						resolveCallContext: () => Effect.die("unused call context"),
						retirePrompts: () => Effect.succeed(0),
					};
					yield* f.instance.recoverProjectContextsEffect(() =>
						Effect.succeed(recovery),
					);
					const old = f.attachments[0];
					if (!old) return yield* Effect.die("missing recovered runner");
					yield* old.emit(
						{
							type: "event",
							sinkId: "historical",
							event: {
								eventId: "historical-trailing-idle",
								type: "session.status",
								providerId: "claude",
								sessionId: "s",
								providerRefs: {},
								rawSource: { kind: "test" },
								createdAt: 1,
								data: { sessionId: "s", status: "idle" },
							},
						},
						"s",
					);
					expect(
						yield* f.sql`SELECT event_id FROM events WHERE event_id = 'historical-trailing-idle'`,
					).toHaveLength(1);
					const commands = f.commands.length;
					yield* f.manager.executeEffect({
						type: "abort",
						sinkId: "historical",
					});
					expect(f.commands).toHaveLength(commands);
					yield* f.instance.shutdownEffect();
					expect(
						f.outputs.filter(
							(output) =>
								output.type === "release-sink" &&
								output.sinkId === "historical",
						),
					).toEqual([]);
				}),
			),
	);
}

it.effect(
	"releases a cold send's sink and account demand after Live promotion",
	() =>
		runRetirement(
			Effect.gen(function* () {
				let accountDemand = 0;
				const f = yield* retirementFixture(
					false,
					undefined,
					(_accountId, work) =>
						Effect.acquireUseRelease(
							Effect.sync(() => accountDemand++),
							() => work,
							() => Effect.sync(() => accountDemand--),
						),
				);
				f.retained.add("cold");
				yield* f.admitCommand({
					type: "send-turn",
					sinkId: "cold",
					aborted: false,
					input: {
						...f.input,
						account: accountsStateFromInstances(
							[{ id: "account", driver: "claude", name: "Account" }],
							configuredClaudeConfigDir(f.root),
						).accounts[0],
						inputId: "cold-input",
						prompt: "cold",
						history: [],
					},
				});
				expect(accountDemand).toBe(1);
				const attachment = f.attachments[0];
				if (!attachment)
					return yield* Effect.fail(
						runnerFailure("test", "No cold attachment"),
					);
				yield* attachment.emit({ type: "release-sink", sinkId: "cold" }, "s");
				yield* TestClock.adjust(0);
				expect(f.retained.has("cold")).toBe(false);
				expect(accountDemand).toBe(0);
			}),
		),
);

it.effect("releases retained sinks and account demand on normal exit", () =>
	runRetirement(
		Effect.gen(function* () {
			let accountDemand = 0;
			const f = yield* retirementFixture(false, undefined, (_accountId, work) =>
				Effect.acquireUseRelease(
					Effect.sync(() => accountDemand++),
					() => work,
					() => Effect.sync(() => accountDemand--),
				),
			);
			f.retained.add("cold");
			yield* f.admitCommand({
				type: "send-turn",
				sinkId: "cold",
				aborted: false,
				input: {
					...f.input,
					account: accountsStateFromInstances(
						[{ id: "account", driver: "claude", name: "Account" }],
						configuredClaudeConfigDir(f.root),
					).accounts[0],
					inputId: "cold-input",
					prompt: "cold",
					history: [],
				},
			});
			expect(accountDemand).toBe(1);
			const child = f.childProcesses.get(100_020);
			if (!child) return yield* Effect.die("missing spawned child");
			f.processes.delete(100_020);
			Object.assign(child, { exitCode: 0 });
			child.emit("exit", 0, null);
			yield* TestClock.adjust(0);
			expect(yield* f.manager.hasLiveProcessEffect("s")).toBe(false);
			expect(f.retained.has("cold")).toBe(false);
			expect(accountDemand).toBe(0);
			const before = f.outputs.length;
			yield* f.manager.executeEffect({ type: "abort", sinkId: "cold" });
			expect(f.outputs).toHaveLength(before);
		}),
	),
);

it.effect("an unsent failure cannot release a sink rebound after detach", () =>
	runRetirement(
		Effect.gen(function* () {
			const f = yield* retirementFixture(false);
			const commit = yield* makeCommitAndSignal;
			// This pre-amendment retry uses the legacy unsent-failure path. Its
			// command-less dispatch must keep it outside C2 and C3.
			yield* commit([
				canonicalEvent("run.requested", "s", {
					runId: "unsent-first",
					inputId: "first",
				}),
				canonicalEvent("run.dispatched", "s", {
					runId: "unsent-first",
					runnerId: "131313131313",
				}),
			]);
			const entered = yield* Deferred.make<void>();
			const resume = yield* Deferred.make<void>();
			const record = f.output.getMockImplementation();
			if (!record) return yield* Effect.die("missing output recorder");
			f.output.mockImplementation((output, sessionId) =>
				(output.type === "place-user-message"
					? Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(resume)),
						)
					: Effect.void
				).pipe(Effect.andThen(record(output, sessionId))),
			);
			vi.mocked(f.driver.connect).mockImplementationOnce(() =>
				Effect.gen(function* () {
					const child = f.childProcesses.get(100_020);
					if (!child) return yield* Effect.die("missing cold child");
					f.processes.delete(100_020);
					Object.assign(child, { exitCode: 1 });
					return yield* Effect.fail(
						runnerFailure("hello", "cold startup failed"),
					);
				}),
			);
			const first = yield* Effect.forkChild(
				f
					.admitCommand({
						type: "send-turn",
						sinkId: "reused",
						aborted: false,
						input: {
							...f.input,
							inputId: "first",
							runId: "unsent-first",
							prompt: "first",
							history: [],
						},
					})
					.pipe(Effect.result),
			);
			yield* Deferred.await(entered);
			if (!f.manager.detachSessionEffect)
				return yield* Effect.die("missing detach");
			yield* f.manager.detachSessionEffect("s");
			const second = yield* Effect.forkChild(
				f.admitCommand({
					type: "send-turn",
					sinkId: "reused",
					aborted: false,
					input: {
						...f.input,
						inputId: "second",
						prompt: "second",
						history: [],
					},
				}),
			);
			yield* TestClock.adjust(0);
			expect(second.pollUnsafe()).toBeUndefined();
			yield* Deferred.succeed(resume, undefined);
			yield* Fiber.join(first);
			yield* Fiber.join(second);
			expect(f.sendHandles[0]?.assignment._tag).toBe("Closed");
			expect(f.sendHandles.at(-1)?.assignment._tag).toBe("Dispatched");
			expect(
				f.outputs.filter(
					(output) =>
						output.type === "release-sink" && output.sinkId === "reused",
				),
			).toHaveLength(1);
			yield* f.manager.executeEffect(
				{ type: "abort", sinkId: "reused" },
				f.sendHandles.at(-1),
			);
			expect(f.commands.at(-1)?.type).toBe("abort");
		}),
	),
);

for (const failure of ["connection failure", "process exit"] as const) {
	it.effect(
		`cleans daemon-owned cold-send resources and reports one failure after ${failure} before hello`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					let accountDemand = 0;
					let acquired = 0;
					let released = 0;
					const f = yield* retirementFixture(false, undefined, (_id, work) =>
						Effect.acquireUseRelease(
							Effect.sync(() => {
								accountDemand++;
								acquired++;
							}),
							() => work,
							() =>
								Effect.sync(() => {
									accountDemand--;
									released++;
								}),
						),
					);
					const accounts = accountsStateFromInstances(
						[{ id: "account", driver: "claude", name: "Account" }],
						configuredClaudeConfigDir(f.root),
					);
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent(
							"session.created",
							"s",
							{
								sessionId: "s",
								title: "Cold startup",
								provider: "claude",
							},
							{ provider: "claude" },
						),
					]);
					const sinkId = runnerSinkId("cold-input");
					const eventSink = createMockEventSink();
					const abort = new AbortController();
					const removed = vi.spyOn(abort.signal, "removeEventListener");
					const record = f.output.getMockImplementation();
					if (!record) return yield* Effect.die("missing output recorder");
					const instance = yield* makeRunnerProviderInstance(
						{ daemonConfigDir: f.root, accounts: Effect.succeed(accounts) },
						{
							driverKind: "claude",
							discoverEffect: () => Effect.die("unused discovery"),
							generateTextEffect: () => Effect.die("unused generation"),
							prepareTurnEffect: () =>
								Effect.succeed({
									input: {
										...f.input,
										inputId: "cold-input",
										prompt: "cold",
										history: [],
										account: accounts.accounts[0],
										facts: { _tag: "Claude" as const },
									},
								}),
						},
						(emit) => {
							f.output.mockImplementation((output, sessionId) =>
								record(output, sessionId).pipe(
									Effect.andThen(emit(output, sessionId)),
								),
							);
							return Effect.succeed(f.manager);
						},
					);
					const lateOutput: SessionOutput = {
						type: "event",
						sinkId,
						event: {
							eventId: "refused-starting-output",
							type: "turn.notice",
							providerId: "claude",
							sessionId: "s",
							providerRefs: {},
							rawSource: { kind: "test" },
							createdAt: 1,
							data: { text: "must be refused" },
						},
					};
					const connect = vi.mocked(f.driver.connect);
					const originalConnect = connect.getMockImplementation();
					if (!originalConnect)
						return yield* Effect.die("missing original connect");
					connect.mockImplementation((options) =>
						Effect.gen(function* () {
							f.attachments.push(options);
							yield* options.emit(lateOutput, "s");
							const child = f.childProcesses.get(100_020);
							if (!child) return yield* Effect.die("missing cold child");
							f.processes.delete(100_020);
							Object.assign(child, { exitCode: 1 });
							if (failure === "process exit") child.emit("exit", 1, null);
							return yield* Effect.fail(
								runnerFailure("hello", "cold startup failed"),
							);
						}),
					);
					const result = yield* instance
						.sendTurnEffect(
							makeBaseSendTurnInput({
								...f.input,
								inputId: "cold-input",
								account: accounts.accounts[0],
								eventSink,
								abortSignal: abort.signal,
							}),
						)
						.pipe(Effect.result);
					expect(result._tag).toBe("Failure");
					yield* TestClock.adjust(0);
					expect(
						f.commands.filter((command) => command.type === "send-turn"),
					).toEqual([]);
					expect(
						f.outputs.filter(
							(output) =>
								output.type === "event" &&
								output.event.eventId === "refused-starting-output",
						),
					).toEqual([]);
					if (failure === "connection failure") {
						expect(accountDemand).toBe(0);
						expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
					}
					expect(
						f.outputs.filter(
							(output) =>
								output.type === "event" && output.event.type === "turn.error",
						),
					).toHaveLength(1);
					expect(
						vi
							.mocked(eventSink.push)
							.mock.calls.filter(([event]) => event.type === "turn.error"),
					).toHaveLength(1);
					expect(accountDemand).toBe(0);
					expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
					expect(acquired).toBe(1);
					expect(released).toBe(1);
					expect(
						removed.mock.calls.filter(([type]) => type === "abort"),
					).toHaveLength(1);
					expect(
						f.outputs.filter(
							(output) =>
								output.type === "release-sink" && output.sinkId === sinkId,
						),
					).toHaveLength(1);
					expect(
						vi
							.mocked(eventSink.push)
							.mock.calls.filter(([event]) =>
								["turn.completed", "turn.error", "turn.interrupted"].includes(
									event.type,
								),
							),
					).toHaveLength(1);
					const pushed = vi.mocked(eventSink.push).mock.calls.length;
					yield* instance.handleOutputEffect(lateOutput);
					expect(vi.mocked(eventSink.push).mock.calls).toHaveLength(pushed);
					connect.mockImplementation(originalConnect);
					yield* f.manager.executeEffect({
						type: "pre-warm",
						sessionId: "s",
						input: f.input,
					});
					const commandCount = f.commands.length;
					yield* f.manager.executeEffect({ type: "abort", sinkId });
					abort.abort();
					yield* TestClock.adjust(0);
					expect(f.commands).toHaveLength(commandCount);
					removed.mockRestore();
				}),
			),
	);
}

it.effect(
	"waits for the retirement commit before signalling a runner when SQL is busy",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture();
				const old = f.attachments[0];
				if (!old?.receipts)
					return yield* Effect.fail(runnerFailure("test", "No receipt store"));
				const attach = vi.spyOn(old.receipts, "attach");
				const signal = vi.spyOn(f.processTable, "signal");
				const commit = yield* makeCommitAndSignal;
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const writer = yield* Effect.forkChild(
					commit.write(() =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
					),
				);
				yield* Deferred.await(entered);
				yield* Effect.gen(function* () {
					const stopping = yield* Effect.forkChild(
						f.manager.executeEffect({ type: "end-session", sessionId: "s" }),
					);
					// R3 forbids signalling before the write-ahead transaction commits.
					yield* TestClock.adjust("4001 millis");
					expect(stopping.pollUnsafe()).toBeUndefined();
					expect(signal).not.toHaveBeenCalled();
					expect(attach).not.toHaveBeenCalled();
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.join(writer);
					yield* TestClock.adjust("4 seconds");
					yield* Fiber.join(stopping);
					expect(
						yield* f.sql`SELECT attachment_id FROM claude_runner_cursors WHERE runner_id = ${old.runnerId} AND retired_at IS NOT NULL`,
					).toEqual([{ attachment_id: "" }]);
					f.processes.delete(old.pid ?? 100_088);
					yield* TestClock.adjust("6 seconds");
					expect(f.retained.size).toBe(0);
					expect(yield* f.manager.hasLiveProcessEffect("s", old.runnerId)).toBe(
						false,
					);
					expect(
						yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${old.runnerId}`,
					).toEqual([]);
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
			}),
		),
);

it.effect(
	"a runner ending its own session stays live to the recovery sweep until its End escalates",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture();
				const old = f.attachments[0];
				if (!old)
					return yield* Effect.fail(runnerFailure("test", "No old attachment"));
				const commit = yield* makeCommitAndSignal;
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const writer = yield* Effect.forkChild(
					commit.write(() =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
					),
				);
				yield* Deferred.await(entered);
				yield* Effect.gen(function* () {
					const stopping = yield* Effect.forkChild(
						f.manager.executeEffect({ type: "end-session", sessionId: "s" }),
					);
					yield* TestClock.adjust("1 second");
					// The End's Stop is Committing behind the busy writer: the sweep must not take it.
					expect(stopping.pollUnsafe()).toBeUndefined();
					expect(yield* f.manager.hasLiveProcessEffect("s", old.runnerId)).toBe(
						true,
					);
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.join(writer);
					yield* TestClock.adjust("1 second");
					expect(yield* f.manager.hasLiveProcessEffect("s", old.runnerId)).toBe(
						true,
					);
					yield* TestClock.adjust("3 seconds");
					yield* Fiber.join(stopping);
					expect(yield* f.manager.hasLiveProcessEffect("s", old.runnerId)).toBe(
						false,
					);
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
			}),
		),
);

for (const cleanupFailure of ["deadline", "unavailable services"] as const)
	it.effect(
		`orphan recovery settles a retired cohort after ${cleanupFailure} and remains idempotent`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					yield* (yield* ProjectionRunnerEffectTag).recover();
					const ingestion = yield* ProviderRuntimeIngestionTag;
					const pending = yield* PendingInteractionServiceTag;
					const persist = yield* ClaudeEventPersistEffectTag;
					let servicesAvailable = true;
					const recovery: RunnerRecoveryDependencies = {
						projectId: "test-project",
						ingestion,
						pending,
						persist,
						timeoutHooks: {},
						retirePrompts: () => Effect.succeed(0),
						resolveCallContext: () =>
							Effect.die("Recovery does not send turns"),
					};
					const recoveryForSession = () =>
						Effect.sync(() => (servicesAvailable ? recovery : undefined));
					const f = yield* retirementFixture(true, recoveryForSession);
					const old = f.attachments[0];
					if (!old)
						return yield* Effect.fail(
							runnerFailure("test", "No old attachment"),
						);
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("run.requested", "s", {
							runId: "old-run",
							inputId: "old-input",
						}),
						canonicalEvent(
							"run.started",
							"s",
							{ requestedRunId: "old-run", inputId: "old-input" },
							{ metadata: { runId: "old-run" } },
						),
					]);
					yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at) VALUES (1, 'old-command', 'test-project', 's', 'test-claude', 'send_turn', '{"inputId":"old-input"}', 'old-run', 'running', 1, 1, 1)`;
					yield* makeRunnerRunLifecycle({
						sql: f.sql,
						commit,
						eventStore: yield* EventStoreEffectTag,
					}).holdRun({
						sessionId: "s",
						runId: "old-run",
						commandId: "old-command",
					});
					const journal = new RunnerSendJournal(
						runnerRegistry.runnerDirectory(f.root, f.root),
						"s",
						"claude",
					);
					const received = yield* Deferred.make<void>();
					yield* journal
						.execute(
							sendToken("hold", "old-command", 1),
							Deferred.succeed(received, undefined).pipe(
								Effect.andThen(Effect.never),
							),
						)
						.pipe(Effect.forkChild);
					yield* Deferred.await(received);
					old.onOutputCommitted?.({
						type: "event",
						sinkId: "retained",
						event: {
							eventId: "old-run-started",
							type: "run.started",
							providerId: "claude",
							sessionId: "s",
							runId: "old-run",
							providerRefs: {},
							rawSource: { kind: "test" },
							createdAt: 1,
							data: { inputId: "old-input", requestedRunId: "old-run" },
						},
					});
					const entered = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					const ingest = ingestion.ingestBatch;
					const blocked = vi
						.spyOn(ingestion, "ingestBatch")
						.mockImplementation((events, options) =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.andThen(ingest(events, options)),
							),
						);
					const instance = yield* makeRunnerProviderInstance(
						{
							daemonConfigDir: f.root,
							accounts: Effect.succeed(
								accountsStateFromInstances(
									[
										{
											id: "test-claude",
											name: "Test Claude",
											driver: "claude",
										},
									],
									configuredClaudeConfigDir(f.root),
								),
							),
						},
						{
							driverKind: "claude",
							discoverEffect: () => Effect.die("No provider discovery"),
							generateTextEffect: () => Effect.die("No provider generation"),
							prepareTurnEffect: () => Effect.die("No provider turns"),
						},
						() => Effect.succeed(f.manager),
					);
					yield* Effect.gen(function* () {
						if (cleanupFailure === "unavailable services")
							servicesAvailable = false;
						f.processes.delete(old.pid ?? 100_088);
						const stopping = yield* Effect.forkChild(
							f.manager.executeEffect({ type: "end-session", sessionId: "s" }),
						);
						yield* TestClock.adjust("4 seconds");
						if (cleanupFailure === "deadline") {
							yield* Deferred.await(entered);
							// An explicit stop of a running journal settles the modern owner
							// send before the blocked legacy ingestion and prompt cleanup.
							expect(
								yield* f.sql`SELECT status FROM provider_runs WHERE id = 'old-run'`,
							).toEqual([{ status: "interrupted" }]);
							yield* TestClock.adjust("3 seconds");
						}
						expect(
							yield* f.sql`SELECT owned_run_ids FROM claude_runner_cursors WHERE runner_id = ${old.runnerId}`,
						).toEqual([{ owned_run_ids: "[]" }]);
						servicesAvailable = true;
						blocked.mockRestore();
						yield* Deferred.succeed(release, undefined);
						yield* Fiber.join(stopping);
						yield* TestClock.adjust("10 seconds");
						yield* instance.attachSessionsEffect(["s"], recoveryForSession);
						yield* instance.attachSessionsEffect(["s"], recoveryForSession);
						expect(
							yield* f.sql`SELECT status FROM provider_runs WHERE id = 'old-run'`,
						).toEqual([{ status: "interrupted" }]);
						expect(
							yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id = 'old-command'`,
						).toEqual([{ status: "failed" }]);
						expect(
							yield* f.sql`SELECT type FROM events WHERE type IN ('turn.error', 'turn.interrupted')`,
						).toEqual([{ type: "turn.interrupted" }]);
						expect(
							yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${old.runnerId}`,
						).toEqual([]);
					}).pipe(
						Effect.ensuring(Deferred.succeed(release, undefined)),
						Effect.ensuring(Effect.sync(() => blocked.mockRestore())),
					);
				}),
			),
	);

for (const blocked of ["release-sink", "background-task"] as const) {
	it.effect(
		`bounds retirement cleanup waiting for ${blocked} before releasing admission`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* retirementFixture();
					const old = f.attachments[0];
					if (!old)
						return yield* Effect.fail(
							runnerFailure("test", "No old attachment"),
						);
					const entered = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					const record = f.output.getMockImplementation();
					if (!record)
						return yield* Effect.fail(
							runnerFailure("test", "No output recorder"),
						);
					f.output.mockImplementation((output, sessionId) =>
						Effect.gen(function* () {
							if (output.type === blocked) {
								yield* Deferred.succeed(entered, undefined);
								yield* Deferred.await(release);
							}
							return yield* record(output, sessionId);
						}),
					);
					yield* Effect.gen(function* () {
						f.processes.delete(old.pid ?? 100_088);
						const stopping = yield* Effect.forkChild(
							f.manager.executeEffect({ type: "end-session", sessionId: "s" }),
						);
						yield* TestClock.adjust("4 seconds");
						yield* Deferred.await(entered);
						yield* TestClock.adjust("3 seconds");
						expect(stopping.pollUnsafe()).toMatchObject({ _tag: "Success" });
						yield* Deferred.succeed(release, undefined);
						yield* Fiber.join(stopping);
						expect(
							yield* f.manager.hasLiveProcessEffect("s", old.runnerId),
						).toBe(false);
					}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
				}),
			),
	);
}

it.effect(
	"releases Stop while the commit permit is held past cleanup expiry and commits settlement",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const projector = yield* ProjectionRunnerEffectTag;
				yield* projector.recover();
				const f = yield* retirementFixture();
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const old = f.attachments[0];
				if (!old)
					return yield* Effect.fail(runnerFailure("test", "No old attachment"));
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at, runner_id) VALUES ('old-run', 's', 'running', 1, ${old.runnerId})`;
				old.onOutputCommitted?.({
					type: "event",
					sinkId: "retained",
					event: {
						eventId: "old-run-started",
						type: "run.started",
						providerId: "claude",
						sessionId: "s",
						runId: "old-run",
						providerRefs: {},
						rawSource: { kind: "test" },
						createdAt: 1,
						data: { inputId: "old-input", requestedRunId: "old-run" },
					},
				});
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const finished = yield* Deferred.make<void>();
				const ingest = ingestion.ingestBatch;
				vi.spyOn(ingestion, "ingestBatch").mockImplementation(
					(events, options) =>
						ingest(events, {
							...options,
							beforeProject: Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.andThen(options?.beforeProject ?? Effect.void),
							),
						}).pipe(Effect.ensuring(Deferred.succeed(finished, undefined))),
				);
				yield* Effect.gen(function* () {
					f.processes.delete(old.pid ?? 100_088);
					const stopping = yield* Effect.forkChild(
						f.manager.executeEffect({ type: "end-session", sessionId: "s" }),
					);
					yield* TestClock.adjust("4 seconds");
					yield* Deferred.await(entered);
					yield* TestClock.adjust("3 seconds");
					const completedWhileBlocked = stopping.pollUnsafe() !== undefined;
					// A late close cannot discard the watcher's pending obligation.
					f.processes.delete(old.pid ?? 100_088);
					old.onClose(
						runnerFailure("test", "retired process exited during settlement"),
					);
					yield* Deferred.succeed(release, undefined);
					yield* Deferred.await(finished);
					yield* Fiber.await(stopping);
					expect(completedWhileBlocked).toBe(true);
					expect(
						yield* f.sql`SELECT type FROM events WHERE session_id = 's' AND type = 'turn.interrupted'`,
					).toEqual([{ type: "turn.interrupted" }]);
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'old-run'`,
					).toEqual([{ status: "interrupted" }]);
					yield* TestClock.adjust("10 seconds");
					expect(
						yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = ${old.runnerId}`,
					).toEqual([]);
				}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
			}),
		),
);

it.effect(
	"retires only the survivor's prompts and controls while preserving its End",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const projector = yield* ProjectionRunnerEffectTag;
				yield* projector.recover();
				const f = yield* retirementFixture();
				const old = f.attachments[0];
				if (!old)
					return yield* Effect.fail(runnerFailure("test", "No old attachment"));
				yield* f.sql`INSERT INTO pending_approvals (id, session_id, type, status, provider_process_id, created_at)
			VALUES ('old-prompt', 's', 'permission', 'pending', ${old.runnerId}, 1), ('new-prompt', 's', 'question', 'pending', 'new-owner', 2)`;
				yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, provider_process_id, payload_json, status, attempt_count, requested_at, updated_at)
			VALUES (1, 'current-end', 'test-project', 's', 'claude', 'end_session', ${old.runnerId}, '{}', 'running', 1, 1, 1),
			(2, 'old-answer', 'test-project', 's', 'claude', 'reply_permission', ${old.runnerId}, '{}', 'pending', 0, 2, 2),
			(3, 'new-answer', 'test-project', 's', 'claude', 'reply_permission', 'new-owner', '{}', 'pending', 0, 3, 3)`;
				const stopping = yield* Effect.forkChild(
					f.manager.executeEffect({
						type: "end-session",
						sessionId: "s",
						control: {
							commandId: "current-end",
							providerProcessId: old.runnerId,
						},
					}),
				);
				yield* TestClock.adjust("4 seconds");
				yield* Fiber.join(stopping);
				expect(
					yield* f.sql`SELECT status FROM pending_approvals WHERE id = 'old-prompt'`,
				).toEqual([{ status: "pending" }]);
				f.processes.delete(old.pid ?? 100_088);
				yield* TestClock.adjust("6 seconds");
				const [prompt] = yield* f.sql<{
					status: string;
				}>`SELECT status FROM pending_approvals WHERE id = 'old-prompt'`;
				expect(prompt?.status).not.toBe("pending");
				expect(
					yield* f.sql`SELECT status FROM pending_approvals WHERE id = 'new-prompt'`,
				).toEqual([{ status: "pending" }]);
				expect(
					yield* f.sql`SELECT command_id, status FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([
					{ command_id: "current-end", status: "running" },
					{ command_id: "old-answer", status: "cancelled" },
					{ command_id: "new-answer", status: "pending" },
				]);
			}),
		),
);

for (const failed of ["receipt", "ownership SQL"] as const) {
	it.effect(
		`keeps a survivor retired across restart after ${failed} failure`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* retirementFixture(false);
					const connect = vi.mocked(f.driver.connect).getMockImplementation();
					if (!connect)
						return yield* Effect.fail(
							runnerFailure("test", "No connection factory"),
						);
					vi.mocked(f.driver.connect).mockImplementation((options) =>
						connect({
							...options,
							onHello: (hello, connection, replay) =>
								options.onHello(
									{
										...hello,
										sendJournalAnswers: true,
										sendAnswers: [
											{
												status: "running",
												token: sendToken("tx", "old-command", 1),
											},
										],
									},
									connection,
									replay,
								),
						}),
					);
					yield* f.manager.recoverEffect;
					const old = f.attachments[0];
					if (!old?.receipts)
						return yield* Effect.fail(
							runnerFailure("test", "No receipt store"),
						);
					if (failed === "receipt")
						vi.spyOn(old.receipts, "attach").mockReturnValue(
							Effect.fail(
								new SqlError({
									reason: new UnknownError({
										cause: "injected attachment failure",
									}),
								}),
							),
						);
					else
						yield* f.sql`ALTER TABLE provider_runs RENAME TO unavailable_provider_runs`;
					const stopping = yield* Effect.forkChild(
						f.manager.executeEffect({ type: "end-session", sessionId: "s" }),
					);
					yield* TestClock.adjust("4 seconds");
					if (failed === "ownership SQL") {
						// The stop commit reads the runner's held runs (4.5), so it
						// retries the store fault until the table returns.
						yield* f.sql`ALTER TABLE unavailable_provider_runs RENAME TO provider_runs`;
						yield* TestClock.adjust("30 seconds");
					}
					yield* Fiber.await(stopping);
					expect(
						yield* f.sql`SELECT attachment_id FROM claude_runner_cursors WHERE runner_id = ${old.runnerId} AND retired_at IS NOT NULL`,
					).toEqual([{ attachment_id: "" }]);

					vi.mocked(f.driver.connect).mockClear();
					const restarted = yield* makeProcessSessionRunner(
						{
							daemonConfigDir: f.root,
							projectRootForSession: () => Effect.succeed(f.root),
							processTable: f.processTable,
						},
						f.output,
						f.driver,
					);
					yield* restarted.recoverEffect;
					expect(f.driver.connect).not.toHaveBeenCalled();
				}),
			),
	);
}

for (const boundary of ["before persistence", "inside write"] as const) {
	for (const fencing of ["succeeds", "fails", "times out"] as const) {
		it.effect(
			`${boundary === "inside write" ? "preserves subagent output committed before Stop" : "fences subagent persistence after retirement"} when receipt fencing ${fencing}, ${boundary}`,
			() =>
				runRetirement(
					Effect.gen(function* () {
						const f = yield* retirementFixture();
						const persist = yield* ClaudeEventPersistEffectTag;
						const projector = yield* ProjectionRunnerEffectTag;
						const eventStore = yield* EventStoreEffectTag;
						yield* projector.recover();
						const seeded = yield* eventStore.appendBatch([
							canonicalEvent(
								"session.created",
								"s",
								{
									sessionId: "s",
									title: "Parent",
									provider: "claude",
									providerSessionId: "s",
								},
								{ provider: "claude" },
							),
							...sessionPickEvents("s", {
								harness: "claude",
								model: { providerId: "claude", modelId: "sonnet" },
								effort: "high",
								contextWindow: "1m",
							}),
						]);
						yield* projector.projectBatch(seeded);
						const old = f.attachments[0];
						if (!old?.receipts)
							return yield* Effect.fail(
								runnerFailure("test", "No receipt store"),
							);
						const attachmentId = "subagent-attachment";
						yield* old.receipts.attach(old.runnerId, attachmentId);
						const entered = yield* Deferred.make<void>();
						const release = yield* Deferred.make<void>();
						if (boundary === "inside write") {
							const append = eventStore.appendBatch;
							vi.spyOn(eventStore, "appendBatch").mockImplementation(
								(events, projectId) =>
									Effect.gen(function* () {
										if (
											events.some(
												(event) => event.sessionId === "retired-child",
											)
										) {
											yield* Deferred.succeed(entered, undefined);
											yield* Deferred.await(release);
										}
										return yield* append(events, projectId);
									}),
							);
						}
						f.output.mockImplementation((output) =>
							Effect.gen(function* () {
								if (output.type !== "ensure-subagent-session") return {};
								if (
									boundary === "before persistence" &&
									output.input.childSessionId === "retired-child"
								) {
									yield* Deferred.succeed(entered, undefined);
									yield* Deferred.await(release);
								}
								yield* persist
									.ensureClaudeSubagentSession(output.input)
									.pipe(
										Effect.mapError((cause) =>
											runnerFailure("test persist", cause),
										),
									);
								return {};
							}),
						);
						const input = {
							childSessionId: "live-child",
							parentSessionId: "s",
							providerSessionId: "agent-native",
							title: "Live child",
						};
						yield* old.emit(
							{ type: "ensure-subagent-session", sinkId: "retained", input },
							"s",
						);
						expect(
							yield* f.sql`SELECT id FROM sessions WHERE id = 'live-child'`,
						).toEqual([{ id: "live-child" }]);
						const committed = yield* Deferred.make<void>();
						const output = yield* Effect.forkChild(
							old
								.emit(
									{
										type: "ensure-subagent-session",
										sinkId: "retained",
										input: {
											...input,
											childSessionId: "retired-child",
											title: "Retired child",
										},
									},
									"s",
								)
								.pipe(
									Effect.provideService(currentRunnerOutput, {
										runnerId: old.runnerId,
										sequence: 1,
										attachmentId,
										committed,
										consumed: false,
									}),
								),
						);
						yield* Deferred.await(entered);
						if (fencing !== "succeeds")
							vi.spyOn(old.receipts, "attach").mockReturnValue(
								fencing === "times out"
									? Effect.never
									: Effect.fail(
											new SqlError({
												reason: new UnknownError({
													cause: "injected attachment failure",
												}),
											}),
										),
							);
						const stopping = yield* Effect.forkChild(
							f.manager.executeEffect({ type: "end-session", sessionId: "s" }),
						);
						yield* TestClock.adjust("5 seconds");
						// The SQL writer orders output and Stop. Output already inside
						// the write commits before Stop can install its durable fence.
						if (boundary === "inside write") {
							expect(stopping.pollUnsafe()).toBeUndefined();
							yield* Deferred.succeed(release, undefined);
							yield* Fiber.await(output);
							yield* TestClock.adjust("4 seconds");
						}
						yield* Fiber.await(stopping);
						expect(
							yield* f.manager.hasLiveProcessEffect("s", old.runnerId),
						).toBe(false);
						yield* Deferred.succeed(release, undefined);
						yield* Fiber.await(output);
						const commit = yield* makeCommitAndSignal;
						yield* commit.write(() => Effect.void);
						expect(
							yield* f.sql`SELECT attachment_id FROM claude_runner_cursors WHERE runner_id = ${old.runnerId} AND retired_at IS NOT NULL`,
						).toEqual([{ attachment_id: "" }]);
						expect(
							yield* f.sql`SELECT id FROM sessions WHERE id = 'retired-child'`,
						).toEqual(
							boundary === "inside write" ? [{ id: "retired-child" }] : [],
						);
						const childEvents =
							yield* f.sql`SELECT event_id FROM events WHERE session_id = 'retired-child'`;
						if (boundary === "inside write")
							expect(childEvents.length).toBeGreaterThan(0);
						else expect(childEvents).toEqual([]);
					}),
				),
		);
	}
}

it.effect(
	"releases admission during interrupted recovery without waiting for SQL",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture(false);
				const lastAttempt = yield* Deferred.make<void>();
				const failConnect = yield* Deferred.make<void>();
				const locked = yield* Deferred.make<void>();
				const unlock = yield* Deferred.make<void>();
				let attempts = 0;
				vi.mocked(f.driver.connect).mockImplementation(() =>
					Effect.gen(function* () {
						if (++attempts === 5) {
							yield* Deferred.succeed(lastAttempt, undefined);
							yield* Deferred.await(failConnect);
						}
						return yield* Effect.fail(
							runnerFailure("test connect", "Unreachable survivor"),
						);
					}),
				);
				const recovering = yield* Effect.forkChild(f.manager.recoverEffect);
				yield* TestClock.adjust("2 seconds");
				yield* Deferred.await(lastAttempt);
				const transaction = yield* Effect.forkChild(
					f.sql.withTransaction(
						Deferred.succeed(locked, undefined).pipe(
							Effect.andThen(Deferred.await(unlock)),
						),
					),
				);
				yield* Effect.gen(function* () {
					yield* Deferred.await(locked);
					yield* Deferred.succeed(failConnect, undefined);
					yield* TestClock.adjust("1 millis");
					recovering.interruptUnsafe();
					yield* TestClock.adjust("1 millis");
					expect(
						f.outputs.some(
							(output) =>
								output.type === "background-task" &&
								output.transition.kind === "session-ended",
						),
					).toBe(false);
					yield* Deferred.succeed(unlock, undefined);
					yield* Fiber.join(transaction);
					yield* TestClock.adjust("4 seconds");
					yield* Fiber.await(recovering);
					const commit = yield* makeCommitAndSignal;
					yield* commit.write(() => Effect.void);
					expect(
						yield* f.sql`SELECT attachment_id FROM claude_runner_cursors WHERE runner_id = '131313131313' AND retired_at IS NOT NULL`,
					).toEqual([{ attachment_id: "" }]);
					f.processes.delete(100_088);
					yield* TestClock.adjust("6 seconds");
					expect(
						f.outputs.some(
							(output) =>
								output.type === "background-task" &&
								output.transition.kind === "session-ended",
						),
					).toBe(true);
					vi.mocked(f.driver.connect).mockClear();
					const restarted = yield* makeProcessSessionRunner(
						{
							daemonConfigDir: f.root,
							projectRootForSession: () => Effect.succeed(f.root),
							processTable: f.processTable,
						},
						f.output,
						f.driver,
					);
					yield* restarted.recoverEffect;
					expect(f.driver.connect).not.toHaveBeenCalled();
				}).pipe(Effect.ensuring(Deferred.succeed(unlock, undefined)));
			}),
		),
);

// The candidate's Stop is observed in progress while the send is still pending,
// and the clock moves through the Stop window then, never after the send ends.
// On failure `parks` and `stops` are written under CONDUIT_RUNNER_EVIDENCE_DIR.
// `parks` records the gate's predecessor SQL read, a proxy for feeder parks:
// the gate cannot answer Unserved{predecessor} without that read. `stops` is
// the reconciler's durable Stop rows.
for (const survived of [false, true])
	it.effect(
		survived
			? "refuses cleanup of owned runs from a cancelled Starting candidate that survives Stop"
			: "fences a cancelled warming candidate while its stop is pending",
		() => {
			const parks: Array<{ at: number; predecessors: unknown }> = [];
			const timeline: Array<{ at: number; sendDone: boolean; stops: unknown }> =
				[];
			return runRetirement(
				Effect.gen(function* () {
					const f = yield* retirementFixture(false);
					const clock = yield* Clock.Clock;
					const connection = yield* Effect.scoped(f.sql.reserve);
					const execute = connection.execute;
					const traced = vi
						.spyOn(connection, "execute")
						.mockImplementation((query, params, transform) =>
							query.includes(
								"SELECT runner_id AS runner, retired_at AS retiredAt",
							)
								? execute(query, params, transform).pipe(
										Effect.tap((rows) =>
											Effect.sync(() =>
												parks.push({
													at: clock.currentTimeMillisUnsafe(),
													predecessors: rows,
												}),
											),
										),
									)
								: execute(query, params, transform),
						);
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => traced.mockRestore()),
					);
					let sending: Fiber.Fiber<unknown, unknown> | undefined;
					const record = Effect.gen(function* () {
						timeline.push({
							at: clock.currentTimeMillisUnsafe(),
							sendDone: sending?.pollUnsafe() !== undefined,
							stops:
								yield* f.sql`SELECT runner_id, role, retired_at, stop_state, stop_started_at FROM claude_runner_cursors ORDER BY rowid`,
						});
					});
					const warmed = yield* Deferred.make<void>();
					const releaseWarm = yield* Deferred.make<void>();
					const stopping = yield* Deferred.make<void>();
					const releaseStop = yield* Deferred.make<void>();
					const stopped = yield* Deferred.make<void>();
					const connect = vi.mocked(f.driver.connect).getMockImplementation();
					if (!connect)
						return yield* Effect.fail(
							runnerFailure("test", "No connection factory"),
						);
					vi.mocked(f.driver.connect).mockImplementation((options) =>
						connect({
							...options,
							onHello: (hello, connection, replay) =>
								Effect.gen(function* () {
									const original = options.runnerId === "131313131313";
									if (!original) {
										const command = connection.commandEffect.bind(connection);
										vi.spyOn(connection, "commandEffect").mockImplementation(
											(id, payload) => {
												if (payload.type === "pre-warm")
													return Deferred.succeed(warmed, undefined).pipe(
														Effect.andThen(Deferred.await(releaseWarm)),
														Effect.as(undefined),
													);
												if (payload.type === "shutdown")
													return Effect.gen(function* () {
														yield* Deferred.succeed(stopping, undefined);
														yield* Deferred.await(releaseStop);
														yield* options.emit(
															{
																type: "background-task",
																transition: {
																	sessionId: "s",
																	kind: "session-ended",
																},
															},
															"s",
														);
														if (hello.pid !== undefined && !survived) {
															f.processes.delete(hello.pid);
															f.childProcesses
																.get(hello.pid)
																?.emit("exit", 0, null);
														}
														yield* Deferred.succeed(stopped, undefined);
														return undefined;
													});
												return command(id, payload);
											},
										);
									}
									yield* options.onHello(
										{
											...hello,
											buildId: original ? "previous-build" : hello.buildId,
										},
										connection,
										replay,
									);
								}),
						}),
					);
					yield* f.manager.recoverEffect;
					const old = f.attachments[0];
					if (!old?.onUpgradeState)
						return yield* Effect.fail(
							runnerFailure("test", "No old attachment"),
						);
					old.onUpgradeState({
						quiescent: true,
						revision: 1,
						snapshot: {
							input: { ...f.input, folderSource: "implicitDefault" },
							options: {},
						},
					});
					yield* TestClock.adjust(0);
					yield* Deferred.await(warmed);
					const candidate = f.attachments[1];
					if (!candidate)
						return yield* Effect.fail(
							runnerFailure("test", "No candidate attachment"),
						);
					if (survived) {
						yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('candidate-run', 's', 'running', 1)`;
						candidate.onOutputCommitted?.({
							type: "event",
							sinkId: "candidate-sink",
							event: {
								eventId: "candidate-run-started",
								type: "run.started",
								providerId: "claude",
								sessionId: "s",
								runId: "candidate-run",
								providerRefs: {},
								rawSource: { kind: "test" },
								createdAt: 1,
								data: {
									inputId: "candidate-input",
									requestedRunId: "candidate-run",
								},
							},
						});
					}
					const task: SessionOutput = {
						type: "background-task",
						transition: {
							sessionId: "s",
							kind: "snapshot",
							tasks: [
								{
									id: "active",
									type: "local_bash",
									description: "Active task",
								},
							],
						},
					};
					yield* candidate.emit(task, "s");
					expect(f.background.backgroundOf("s")).toBeUndefined();
					yield* old.emit(task, "s");
					sending = yield* Effect.forkChild(
						f.admitCommand({
							type: "send-turn",
							sinkId: "original-sink",
							aborted: false,
							input: {
								...f.input,
								inputId: "original-input",
								prompt: "Keep using the original",
								history: [],
							},
						}),
					);
					yield* Deferred.await(f.sending);
					// A runner serving a turn is not quiescent, so its end retries no
					// upgrade; a retry's candidate would wait out its own Stop window.
					old.onUpgradeState({
						quiescent: false,
						revision: 2,
						snapshot: {
							input: { ...f.input, folderSource: "implicitDefault" },
							options: {},
						},
					});
					yield* Deferred.succeed(releaseWarm, undefined);
					yield* Deferred.await(stopping);
					f.outputs.length = 0;
					yield* candidate.emit(
						{
							type: "background-task",
							transition: { sessionId: "s", kind: "snapshot", tasks: [] },
						},
						"s",
					);
					yield* Deferred.succeed(releaseStop, undefined);
					yield* Deferred.await(stopped);
					const staleOutputs = [...f.outputs];
					const background = f.background.backgroundOf("s");
					const owner = yield* f.manager.getControlProcessIdEffect?.("s") ??
						Effect.succeed(undefined);
					for (const step of [0, 1000, 1000, 1000, 999, 1]) {
						yield* TestClock.adjust(step);
						yield* record;
					}
					const stops = (stop: string) => [
						{
							runner_id: "131313131313",
							role: "serving",
							retired_at: null,
							stop_state: "Requested",
							stop_started_at: null,
						},
						...(survived
							? [
									{
										runner_id: candidate.runnerId,
										role: "candidate",
										retired_at: 0,
										stop_state: stop,
										stop_started_at: 0,
									},
								]
							: []),
					];
					// TERM is ignored, so the Stop escalates at its window end, 4 s;
					// a Stop that observes exit is Gone and its row is pruned at once.
					expect(timeline).toEqual([
						{ at: 0, sendDone: false, stops: stops("Escalating") },
						{ at: 1000, sendDone: false, stops: stops("Escalating") },
						{ at: 2000, sendDone: false, stops: stops("Escalating") },
						{ at: 3000, sendDone: false, stops: stops("Escalating") },
						{ at: 3999, sendDone: false, stops: stops("Escalating") },
						{ at: 4000, sendDone: false, stops: stops("Escalated") },
					]);
					// The old runner still serves, so the gate never names a predecessor.
					expect(parks).toEqual([]);
					f.processes.delete(100_088);
					yield* Deferred.fail(f.pending, {
						...runnerFailure("test", "Finish test send"),
						replied: true,
					});
					yield* Fiber.await(sending);
					expect(staleOutputs).toEqual([]);
					expect(background?.tasks[0]?.id).toBe("active");
					expect(owner).toBe(old.runnerId);
					if (survived) {
						expect(
							yield* f.sql`SELECT attachment_id FROM claude_runner_cursors WHERE runner_id = ${candidate.runnerId} AND retired_at IS NOT NULL`,
						).toEqual([{ attachment_id: "" }]);
						expect(
							yield* f.sql`SELECT status FROM provider_runs WHERE id = 'candidate-run'`,
						).toEqual([{ status: "running" }]);
						const restarted = yield* makeProcessSessionRunner(
							{
								daemonConfigDir: f.root,
								projectRootForSession: () => Effect.succeed(f.root),
								processTable: f.processTable,
							},
							f.output,
							f.driver,
						);
						yield* restarted.recoverEffect;
						yield* TestClock.adjust(0);
						expect(
							yield* f.sql`SELECT status FROM provider_runs WHERE id = 'candidate-run'`,
						).toEqual([{ status: "running" }]);
					}
				}).pipe(
					Effect.onExit((exit) =>
						Exit.isSuccess(exit)
							? Effect.void
							: Effect.sync(() => {
									const directory =
										process.env["CONDUIT_RUNNER_EVIDENCE_DIR"] ??
										join(tmpdir(), "conduit-runner-evidence");
									mkdirSync(directory, { recursive: true });
									writeFileSync(
										join(
											directory,
											`starting-candidate-survived-${survived}-${process.pid}-${Date.now()}.json`,
										),
										JSON.stringify(
											{
												survived,
												cause: Cause.pretty(exit.cause),
												parks,
												timeline,
											},
											null,
											2,
										),
									);
								}),
					),
				),
			);
		},
	);

it.effect(
	"fences Starting and superseded output while allowing only the superseded runner's own releases",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture(false);
				const shutdownEntered = yield* Deferred.make<void>();
				const releaseShutdown = yield* Deferred.make<void>();
				const shutdownEmitted = yield* Deferred.make<void>();
				const warmingEmitted = yield* Deferred.make<void>();
				const warmingReceipts: Array<{
					committed: Deferred.Deferred<void>;
					consumed: boolean;
				}> = [];
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect)
					return yield* Effect.fail(
						runnerFailure("test", "No connection factory"),
					);
				const staleOutputs: SessionOutput[] = [
					{
						type: "background-task",
						transition: { sessionId: "s", kind: "session-ended" },
					},
					{
						type: "background-task",
						transition: { sessionId: "s", kind: "snapshot", tasks: [] },
					},
					{ type: "release-sink", sinkId: "new-sink" },
					{
						type: "event",
						sinkId: "new-sink",
						event: {
							eventId: "superseded-failure",
							type: "turn.error",
							providerId: "claude",
							sessionId: "s",
							providerRefs: {},
							rawSource: { kind: "test" },
							createdAt: 1,
							data: {
								messageId: "new-message",
								error: "Old shutdown failure",
								code: "old_failure",
								retryable: false,
							},
						},
					},
				];
				vi.mocked(f.driver.connect).mockImplementation((options) =>
					connect({
						...options,
						onHello: (hello, connection, replay) =>
							Effect.gen(function* () {
								const original = options.runnerId === "131313131313";
								if (original) {
									const command = connection.commandEffect.bind(connection);
									vi.spyOn(connection, "commandEffect").mockImplementation(
										(id, payload) =>
											payload.type === "shutdown"
												? Effect.gen(function* () {
														yield* Deferred.succeed(shutdownEntered, undefined);
														yield* Deferred.await(releaseShutdown);
														yield* options.emit(
															{ type: "release-sink", sinkId: "retained" },
															"s",
														);
														for (const output of staleOutputs)
															yield* options.emit(output, "s");
														if (hello.pid !== undefined)
															f.processes.delete(hello.pid);
														yield* Deferred.succeed(shutdownEmitted, undefined);
														return undefined;
													})
												: command(id, payload),
									);
								} else {
									const requests: readonly SessionOutput[] = [
										{
											type: "permission-request",
											sinkId: "warming",
											request: {
												requestId: "warming-permission",
												sessionId: "s",
												turnId: "warming-turn",
												providerItemId: "warming-tool",
												toolName: "Bash",
												toolInput: { command: "pwd" },
											},
										},
										{
											type: "question-request",
											sinkId: "warming",
											request: { requestId: "warming-question", questions: [] },
										},
									];
									for (const [index, request] of requests.entries()) {
										const committed = yield* Deferred.make<void>();
										const receipt = {
											runnerId: options.runnerId,
											sequence: index + 1,
											attachmentId: "warming-attachment",
											committed,
											consumed: false,
										};
										yield* options
											.emit(request, "s")
											.pipe(
												Effect.provideService(currentRunnerOutput, receipt),
											);
										warmingReceipts.push(receipt);
									}
									yield* options.emit(
										{
											type: "background-task",
											transition: {
												sessionId: "s",
												kind: "snapshot",
												tasks: [
													{
														id: "warming",
														type: "local_bash",
														description: "Warming task",
													},
												],
											},
										},
										"s",
									);
									yield* Deferred.succeed(warmingEmitted, undefined);
								}
								yield* options.onHello(
									{
										...hello,
										buildId: original ? "previous-build" : hello.buildId,
									},
									connection,
									replay,
								);
							}),
					}),
				);
				yield* f.manager.recoverEffect;
				const old = f.attachments[0];
				if (!old?.onUpgradeState)
					return yield* Effect.fail(runnerFailure("test", "No old attachment"));
				old.onUpgradeState({
					quiescent: true,
					revision: 1,
					snapshot: {
						input: { ...f.input, folderSource: "implicitDefault" },
						options: {},
					},
				});
				yield* TestClock.adjust(0);
				yield* Deferred.await(warmingEmitted);
				expect(warmingReceipts).toHaveLength(2);
				for (const receipt of warmingReceipts) {
					const replied = yield* Deferred.isDone(receipt.committed);
					if (!replied) yield* Deferred.succeed(releaseShutdown, undefined);
					expect(replied).toBe(true);
					expect(receipt.consumed).toBe(false);
					// The connection can reply and release its output permit before Live output.
					yield* Deferred.await(receipt.committed);
				}
				expect(f.background.backgroundOf("s")).toBeUndefined();
				yield* Deferred.await(shutdownEntered);
				const replacement = f.attachments[1];
				if (!replacement)
					return yield* Effect.fail(
						runnerFailure("test", "No replacement attachment"),
					);
				yield* f.admitCommand({
					type: "send-turn",
					sinkId: "new-sink",
					aborted: false,
					input: {
						...f.input,
						inputId: "new-input",
						prompt: "Replacement turn",
						history: [],
					},
				});
				f.retained.add("new-sink");
				yield* replacement.emit(
					{
						type: "background-task",
						transition: {
							sessionId: "s",
							kind: "snapshot",
							tasks: [
								{
									id: "new",
									type: "local_bash",
									description: "Replacement task",
								},
							],
						},
					},
					"s",
				);
				expect(
					f.outputs.filter(
						(output) =>
							output.type === "release-sink" && output.sinkId === "retained",
					),
				).toHaveLength(1);
				f.outputs.length = 0;
				yield* Deferred.succeed(releaseShutdown, undefined);
				yield* Deferred.await(shutdownEmitted);
				yield* TestClock.adjust(0);
				expect(f.outputs).toEqual([]);
				expect(f.retained.has("retained")).toBe(false);
				expect(f.background.backgroundOf("s")?.tasks[0]?.id).toBe("new");
				expect(f.retained.has("new-sink")).toBe(true);
				const commandsBeforeReleasedAbort = f.commands.length;
				yield* f.manager.executeEffect({ type: "abort", sinkId: "retained" });
				expect(f.commands).toHaveLength(commandsBeforeReleasedAbort);
				yield* f.manager.executeEffect(
					{ type: "abort", sinkId: "new-sink" },
					f.sendHandles.at(-1),
				);
				expect(f.commands.at(-1)).toEqual({
					runnerId: replacement.runnerId,
					type: "abort",
				});
				expect(
					yield* f.manager.hasLiveProcessEffect("s", replacement.runnerId),
				).toBe(true);
				if (!f.manager.detachSessionEffect)
					return yield* Effect.fail(runnerFailure("test", "No session detach"));
				yield* f.manager.detachSessionEffect("s");
				f.outputs.length = 0;
				for (const output of staleOutputs) yield* old.emit(output, "s");
				expect(f.outputs).toEqual([]);
			}),
		),
);

for (const interleaving of ["replacement", "retirement", "pending"] as const) {
	const blockedRetirement = interleaving === "retirement";
	const pendingReplacement = interleaving === "pending";
	it.effect(
		blockedRetirement
			? "admits a replacement while retired sink cleanup is blocked"
			: pendingReplacement
				? "preserves cancellation of a replacement awaiting readiness"
				: "drops stranded send cleanup after a replacement starts",
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* retirementFixture(true, undefined, undefined, [
						"retained",
						"block",
					]);
					const old = f.attachments[0];
					if (!old)
						return yield* Effect.fail(
							runnerFailure("test", "No old attachment"),
						);
					const blockedEntered = yield* Deferred.make<void>();
					const unblock = yield* Deferred.make<void>();
					const retirementEntered = yield* Deferred.make<void>();
					const finishRetirement = yield* Deferred.make<void>();
					const record = f.output.getMockImplementation();
					if (!record)
						return yield* Effect.fail(
							runnerFailure("test", "No output recorder"),
						);
					f.output.mockImplementation((output, sessionId) =>
						Effect.gen(function* () {
							if (
								blockedRetirement &&
								output.type === "release-sink" &&
								output.sinkId === "retained"
							) {
								yield* Deferred.succeed(retirementEntered, undefined);
								yield* Deferred.await(finishRetirement);
							}
							if (output.type === "release-sink" && output.sinkId === "block") {
								yield* Deferred.succeed(blockedEntered, undefined);
								yield* Deferred.await(unblock);
							}
							return yield* record(output, sessionId);
						}),
					);
					const sending = yield* Effect.forkChild(
						f
							.admitCommand({
								type: "send-turn",
								sinkId: "old-sink",
								aborted: false,
								input: {
									...f.input,
									inputId: "old-input",
									prompt: "old",
									history: [],
								},
							})
							.pipe(Effect.result),
					);
					yield* Deferred.await(f.sending);
					// A pending turn defers the driver's release until intake settles.
					yield* old.emit({ type: "release-sink", sinkId: "old-sink" }, "s");
					const blocked = yield* Effect.forkChild(
						old.emit({ type: "release-sink", sinkId: "block" }, "s"),
					);
					yield* Deferred.await(blockedEntered);
					const failure = runnerFailure("socket", "Unexpected disconnect");
					// The old process has exited; its daemon cleanup remains blocked.
					// A live disconnected process would keep this transmission held.
					f.processes.delete(old.pid ?? 100_088);
					old.onClose(failure);
					yield* Deferred.fail(f.pending, failure);
					yield* TestClock.adjust("4 seconds");
					let admittedBeforeCleanup = false;
					if (blockedRetirement) {
						yield* Deferred.await(retirementEntered);
						yield* Deferred.succeed(unblock, undefined);
						yield* Fiber.join(blocked);
						yield* Fiber.join(sending);
						const warming = yield* Effect.forkChild(
							f
								.admitCommand({
									type: "send-turn",
									sinkId: "old-sink",
									aborted: false,
									input: {
										...f.input,
										inputId: "new-input",
										prompt: "new",
										history: [],
									},
								})
								.pipe(Effect.result),
						);
						yield* TestClock.adjust(0);
						admittedBeforeCleanup = f.attachments.length > 1;
						yield* Deferred.succeed(finishRetirement, undefined);
						yield* Fiber.join(warming);
					}
					f.replacementGate.hold = pendingReplacement;
					const pending = pendingReplacement
						? yield* Effect.forkChild(
								f
									.admitCommand({
										type: "send-turn",
										sinkId: "old-sink",
										aborted: false,
										input: {
											...f.input,
											inputId: "new-input",
											prompt: "new",
											history: [],
										},
									})
									.pipe(Effect.result),
							)
						: undefined;
					if (pending) yield* Deferred.await(f.replacementConnecting);
					else
						yield* f.manager.executeEffect({
							type: "pre-warm",
							sessionId: "s",
							input: f.input,
						});
					const replacement = f.attachments[1];
					if (!replacement)
						return yield* Effect.fail(
							runnerFailure("test", "No replacement attachment"),
						);
					f.retained.add("old-sink");
					if (!blockedRetirement && !pendingReplacement)
						yield* f.admitCommand({
							type: "send-turn",
							sinkId: "old-sink",
							aborted: false,
							input: {
								...f.input,
								inputId: "new-input",
								prompt: "new",
								history: [],
							},
						});
					yield* replacement.emit(
						{
							type: "background-task",
							transition: {
								sessionId: "s",
								kind: "snapshot",
								tasks: [
									{ id: "new", type: "local_bash", description: "New task" },
								],
							},
						},
						"s",
					);
					f.outputs.length = 0;
					yield* Deferred.succeed(unblock, undefined);
					yield* Fiber.join(blocked);
					yield* Fiber.join(sending);
					yield* TestClock.adjust(0);
					if (pending) {
						// Abort is not an in-memory cancel of an undispatched owner send;
						// the committed Stop ends the readiness wait.
						yield* (yield* makeCommitAndSignal).write(() =>
							Effect.gen(function* () {
								const owners = yield* f.sql<{
									runId: string;
								}>`SELECT id AS runId FROM provider_runs WHERE session_id = 's' AND status IN ('pending', 'running')`;
								yield* f.sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at)
									VALUES ((SELECT COALESCE(MAX(request_sequence), 0) + 1 FROM provider_command_outbox), 'stop:pending', 'test-project', 's', 'account', 'interrupt_turn', ${JSON.stringify({ type: "interrupt_turn", sessionId: "s", stop: { owners, turnIds: owners.map(({ runId }) => runId), deadlineAt: 3000, runnerBacked: true, retainedSteers: false } })}, 'completed', 1, 1)`;
							}),
						);
						const aborting = yield* Effect.forkChild(
							f.manager.executeEffect(
								{ type: "abort", sinkId: "old-sink" },
								f.sendHandles.at(-1),
							),
						);
						yield* TestClock.adjust(0);
						const cancelledBeforeReady = pending.pollUnsafe() !== undefined;
						yield* Deferred.succeed(f.replacementReady, undefined);
						yield* Fiber.join(aborting);
						yield* Fiber.join(pending);
						expect(cancelledBeforeReady).toBe(true);
						expect(
							f.commands.filter(
								(command) =>
									command.runnerId === replacement.runnerId &&
									command.type === "send-turn",
							),
						).toEqual([]);
						return;
					}
					expect(admittedBeforeCleanup).toBe(blockedRetirement);
					expect(f.outputs).toEqual([]);
					expect(f.background.backgroundOf("s")).toMatchObject({
						tasks: [{ id: "new" }],
					});
					expect(
						yield* f.manager.hasLiveProcessEffect("s", replacement.runnerId),
					).toBe(true);
					expect(f.retained.has("old-sink")).toBe(true);
					yield* f.manager.executeEffect(
						{ type: "abort", sinkId: "old-sink" },
						f.sendHandles.at(-1),
					);
					expect(f.commands.at(-1)).toEqual({
						runnerId: replacement.runnerId,
						type: "abort",
					});
				}),
			),
	);
}

it.effect(
	"retirement releases recovered sinks and background without a replacement",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture();
				const old = f.attachments[0];
				if (!old)
					return yield* Effect.fail(runnerFailure("test", "No old attachment"));
				yield* old.emit(
					{
						type: "background-task",
						transition: {
							sessionId: "s",
							kind: "snapshot",
							tasks: [
								{ id: "old", type: "local_bash", description: "Old task" },
							],
						},
					},
					"s",
				);
				const ending = yield* Effect.forkChild(
					f.manager.executeEffect({ type: "end-session", sessionId: "s" }),
				);
				yield* TestClock.adjust("4 seconds");
				yield* Fiber.join(ending);
				f.processes.delete(old.pid ?? 100_088);
				yield* TestClock.adjust("6 seconds");
				expect({
					retainedSinks: [...f.retained],
					background: f.background.backgroundOf("s"),
				}).toEqual({ retainedSinks: [], background: undefined });
				expect(
					f.outputs.filter((output) => output.type === "release-sink"),
				).toEqual([{ type: "release-sink", sinkId: "retained" }]);
				expect(
					f.outputs.filter(
						(output) =>
							output.type === "background-task" &&
							output.transition.kind === "session-ended",
					),
				).toHaveLength(1);
				expect(f.destroyed).toHaveBeenCalledWith(old.runnerId);
				expect(yield* f.manager.hasLiveProcessEffect("s", old.runnerId)).toBe(
					false,
				);
				f.outputs.length = 0;
				yield* old.emit({ type: "release-sink", sinkId: "retained" }, "s");
				expect(f.outputs).toEqual([]);
			}),
		),
);

// Failure cases were recorded first in art-3216/fence-failures.md.
it.effect(
	"fences an old attachment already waiting to ingest when its runner retires",
	() => {
		const persistence = makePersistenceEffectLayer(":memory:", "test-project");
		return Effect.scoped(
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() =>
						mkdtempSync(join(tmpdir(), "runner-retirement-fence-")),
					),
					(path) =>
						Effect.sync(() => rmSync(path, { recursive: true, force: true })),
				);
				const sql = yield* SqlClient.SqlClient;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at)
			VALUES ('s', 'test-project', 'claude', 1, 1)`;
				const runnerId = "111111111111";
				const attachmentId = "attachment-before-retirement";
				const pid = 100_099;
				const receipts = yield* makeRunnerReceiptStore(sql);
				yield* receipts.register(
					runnerId,
					{ sessionId: "s", pid, startTime: "original", driverKind: "claude" },
					"serving",
				);
				const socketPath = join(prepareRunnerDirectory(root, root), runnerId);
				writeFileSync(
					`${socketPath}.json`,
					JSON.stringify({
						driverKind: "claude",
						runnerId,
						sessionId: "s",
						socketPath,
						buildId: runnerBuildId(),
						pid,
						startTime: "original",
						registeredAt: 1,
					}),
				);
				const attached =
					yield* Deferred.make<Parameters<ProcessRunnerDriver["connect"]>[0]>();
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const driver: ProcessRunnerDriver = {
					driverKind: "claude",
					connect: (options) =>
						Effect.gen(function* () {
							if (!options.receipts)
								return yield* Effect.fail(
									runnerFailure("test connect", "Receipt store is required"),
								);
							yield* options.receipts
								.attach(runnerId, attachmentId)
								.pipe(
									Effect.mapError((cause) =>
										runnerFailure("test receipt", cause),
									),
								);
							const connection = {
								closed: false,
								commandEffect: () => Effect.void,
								destroy: () => {},
								write: () => {},
							} as unknown as RunnerSocket;
							yield* options.onHello(
								{
									type: "hello",
									protocolVersion: 1,
									buildId: runnerBuildId(),
									stampsRunIds: true,
									runnerId,
									sessionId: "s",
									pid,
									bindings: [],
									sendJournalAnswers: true,
									sendAnswers: [],
								},
								connection,
							);
							yield* Deferred.succeed(attached, options);
							return connection;
						}),
					settingsDeferredCode: "test-deferred",
					warmCommand: (sessionId, _state, snapshot) => ({
						type: "pre-warm",
						sessionId,
						input: { ...snapshot.input, sessionId },
					}),
					snapshotCommandSettings: () => ({}),
					loginChange: () => "None",
				};
				const manager = yield* makeProcessSessionRunner(
					{
						daemonConfigDir: root,
						projectRootForSession: () => Effect.succeed(root),
						processTable: {
							inspect: () => ({ state: "running", startTime: "original" }),
							signal: () => {},
						},
					},
					(output) =>
						Effect.gen(function* () {
							if (output.type !== "event") return {};
							yield* Deferred.succeed(entered, undefined);
							yield* Deferred.await(release);
							yield* ingestion
								.ingest(output.event)
								.pipe(
									Effect.mapError((cause) =>
										runnerFailure("test ingestion", cause),
									),
								);
							return {};
						}),
					driver,
				);
				yield* manager.recoverEffect;
				const connection = yield* Deferred.await(attached);
				const committed = yield* Deferred.make<void>();
				const oldOutput = yield* Effect.forkChild(
					connection
						.emit(
							{
								type: "event",
								sinkId: "old-sink",
								event: {
									eventId: "old-output-after-retirement",
									type: "turn.notice",
									providerId: "claude",
									sessionId: "s",
									providerRefs: {},
									rawSource: { kind: "test" },
									createdAt: 1,
									data: { text: "This retired runner must not add a notice" },
								},
							},
							"s",
						)
						.pipe(
							Effect.provideService(currentRunnerOutput, {
								runnerId,
								sequence: 1,
								attachmentId,
								committed,
								consumed: false,
							}),
						),
				);
				yield* Deferred.await(entered);
				const stopping = yield* Effect.forkChild(
					manager.executeEffect({ type: "end-session", sessionId: "s" }),
				);
				yield* TestClock.adjust("4 seconds");
				expect(stopping.pollUnsafe()).toMatchObject({ _tag: "Success" });
				yield* Fiber.join(stopping);
				expect(yield* manager.hasLiveProcessEffect("s", runnerId)).toBe(false);
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(oldOutput);
				expect(
					yield* sql`SELECT event_id FROM events WHERE event_id = 'old-output-after-retirement'`,
				).toEqual([]);
				expect(
					yield* sql`SELECT text FROM message_parts WHERE text = 'This retired runner must not add a notice'`,
				).toEqual([]);
			}),
		).pipe(
			Effect.provide(
				Layer.merge(
					persistence,
					ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
				),
			),
		);
	},
);
it.effect("R2audit cached failed unplaced steer returns to queued", () =>
	runRetirement(
		Effect.gen(function* () {
			const f = yield* s7Fixture();
			yield* f.seed("steer");
			const commit = yield* makeCommitAndSignal;
			yield* commit([
				canonicalEvent("input.admitted", "s", {
					sessionId: "s",
					inputId: "steer",
					delivery: "steer",
					request: { text: "steer text" },
				}),
				canonicalEvent("input.sent", "s", {
					sessionId: "s",
					inputId: "steer",
					steer: true,
				}),
			]);
			yield* f.hello((hello) => ({
				...hello,
				bindings: [],
				sendTokens: [],
				sendJournalAnswers: true,
				sendAnswers: [
					{
						status: "finished",
						token: sendToken("tx", "steer", 1),
						failure: {
							operation: "send-turn",
							code: "provider_failure",
							message: "send refused",
							retryable: false,
						},
					},
				],
			}));
			yield* f.recover;
			expect(yield* f.sql`SELECT status FROM provider_command_outbox`).toEqual([
				{ status: "failed" },
			]);
			expect(
				yield* f.sql`SELECT input_id FROM messages WHERE role = 'user'`,
			).toEqual([]);
			expect(
				yield* f.sql`SELECT state FROM pending_inputs WHERE input_id = 'steer'`,
			).toEqual([{ state: "queued" }]);
		}),
	),
);

it.effect(
	"R2audit cached native resume rejection without a fallback must not fail the input",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("resume");
				yield* f.hello((hello) => ({
					...hello,
					bindings: [],
					sendTokens: [],
					sendJournalAnswers: true,
					sendAnswers: [
						{
							status: "finished",
							token: sendToken("tx", "resume", 1),
							result: {
								status: "error",
								nativeResumeRejected: true,
								error: {
									code: "resume_rejected",
									message: "native resume was rejected",
								},
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 0,
								providerStateUpdates: [],
							},
						},
					],
				}));
				yield* f.recover;
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).not.toEqual([{ status: "failed" }]);
			}),
		),
);

it.effect(
	"R2audit an adopted send settling by reply after hello must release the durable claim",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("late-reply");

				const { createServer } = yield* Effect.promise(
					() => import("node:net"),
				);
				const { RunnerSocket: Peer, RUNNER_PROTOCOL_VERSION } =
					yield* Effect.promise(
						() => import("../../../src/lib/provider/runner/runner-protocol.js"),
					);
				const { connectRunner } = yield* Effect.promise(
					() => import("../../../src/lib/provider/runner/runner-connection.js"),
				);
				let peer: InstanceType<typeof Peer> | undefined;
				const server = createServer((socket) => {
					peer = new Peer(
						socket,
						(message) => {
							if (message.type === "hello")
								peer?.write({
									type: "hello",
									driverKind: "claude",
									protocolVersion: RUNNER_PROTOCOL_VERSION,
									buildId: runnerBuildId(),
									runnerId: "131313131313",
									sessionId: "s",
									pid: 100_088,
									stampsRunIds: true,
									sendTokens: [],
									sendJournalAnswers: true,
									sendAnswers: [
										{
											status: "running",
											token: sendToken("tx", "late-reply", 1),
										},
									],
									bindings: [
										{
											token: sendToken("tx", "late-reply", 1),
											sessionId: "s",
											sinkId: runnerSinkId("late-reply", 1),
											released: false,
										},
									],
								});
							if (message.type === "replay")
								peer?.write({
									type: "upgrade-state",
									state: { quiescent: false, turnInFlight: true, revision: 0 },
								});
						},
						() => {},
					);
				});
				yield* Effect.addFinalizer(() =>
					Effect.promise(
						() =>
							new Promise<void>((resolve) => {
								peer?.destroy();
								server.close(() => resolve());
							}),
					),
				);
				yield* Effect.promise(
					() =>
						new Promise<void>((resolve, reject) => {
							server.once("error", reject);
							server.listen(f.socketPath, resolve);
						}),
				);
				vi.mocked(f.driver.connect).mockImplementation((options) =>
					connectRunner(options),
				);
				yield* f.recover;
				expect(f.sendHandles).toHaveLength(1);
				yield* Effect.sync(() => {
					peer?.write({
						type: "output",
						outputId: "release",
						sequence: 1,
						output: {
							type: "release-sink",
							sinkId: runnerSinkId("late-reply", 1),
						},
					});
					const reply = {
						type: "command-reply",
						commandId: sendToken("tx", "late-reply", 1),
						result: {
							status: "error",
							nativeResumeRejected: true,
							error: {
								code: "provider_error",
								message: "No conversation found with session ID missing",
							},
							cost: 0,
							tokens: { input: 0, output: 0 },
							durationMs: 0,
							providerStateUpdates: [],
						},
					} satisfies {
						readonly type: "command-reply";
						readonly commandId: string;
						readonly result: TurnResult;
					};

					peer?.write(reply);
				});
				yield* Effect.promise(
					() => new Promise<void>((resolve) => setTimeout(resolve, 50)),
				);
				expect(f.sendHandles[0]?.assignment._tag).toBe("Closed");
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).not.toEqual([{ status: "running" }]);
			}),
		),
);

it.effect(
	"R2audit an S7 requeued steer failing in the background returns to the inbox",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture();
				yield* f.seed("background-steer");
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("input.admitted", "s", {
						sessionId: "s",
						inputId: "background-steer",
						delivery: "steer",
						request: { text: "steer text" },
					}),
					canonicalEvent("input.sent", "s", {
						sessionId: "s",
						inputId: "background-steer",
						steer: true,
					}),
				]);
				yield* f.hello((hello) => ({
					...hello,
					bindings: [],
					sendTokens: [],
					sendJournalAnswers: true,
					sendAnswers: [],
				}));
				yield* f.recover;
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "retryable_failed" }]);
				// The inbox startup sweep precedes this later background provider failure.
				const { requeueFailedSteers } = yield* Effect.promise(
					() =>
						import(
							"../../../src/lib/persistence/effect/input-requeue-effect.js"
						),
				);
				yield* requeueFailedSteers(f.sql, f.persist, "s");
				vi.spyOn(f.instance, "sendTurnEffect").mockReturnValue(
					Effect.fail(
						new ProviderInstanceFailure({
							providerId: "cursor",
							operation: "send-turn",
							cause: {
								code: "provider_failure",
								message: "send failed",
								retryable: false,
							},
						}),
					),
				);
				yield* f.reactor.runOnce();
				expect(
					yield* f.sql`SELECT status,attempt_count FROM provider_command_outbox`,
				).toEqual([{ status: "failed", attempt_count: 2 }]);
				expect(
					yield* f.sql`SELECT input_id FROM messages WHERE role = 'user'`,
				).toEqual([]);
				expect(
					yield* f.sql`SELECT state FROM pending_inputs WHERE input_id = 'background-steer'`,
				).toEqual([{ state: "queued" }]);
			}),
		),
);

it.effect(
	"S7fix cached native rejection clears the stale cursor and ordinary reactor preparation sends fresh once",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("fresh-resume");
				const stale = JSON.stringify({
					configDir: configuredClaudeConfigDir(f.root),
					resumeSessionId: "missing-native",
					firstSequence: 0,
					deliveredThrough: 0,
				});
				const other = JSON.stringify({
					configDir: configuredClaudeConfigDir(f.root),
					resumeSessionId: "other-native",
					firstSequence: 0,
					deliveredThrough: 0,
				});
				for (const [key, value] of [
					["nativeThread:account", stale],
					["nativeThread:other", other],
					["resumeSessionId", "missing-native"],
					["claudeConfigDir", f.root],
				] as const)
					yield* f.sql`INSERT INTO provider_state (session_id, key, value) VALUES ('s', ${key}, ${value})`;
				yield* f.hello((hello) => ({
					...hello,
					bindings: [],
					sendTokens: [],
					sendJournalAnswers: true,
					sendAnswers: [
						{
							status: "finished",
							token: sendToken("tx", "fresh-resume", 1),
							result: {
								status: "error",
								nativeResumeRejected: true,
								error: {
									code: "resume_rejected",
									message:
										"No conversation found with session ID missing-native",
								},
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 0,
								providerStateUpdates: [],
							},
						},
					],
				}));
				yield* f.recover;
				expect(
					yield* f.sql`SELECT status, json_extract(payload_json, '$.nativeResumeFallback') AS fallback FROM provider_command_outbox`,
				).toEqual([{ status: "retryable_failed", fallback: 1 }]);
				expect(
					yield* f.sql`SELECT key, value FROM provider_state WHERE key IN ('nativeThread:account', 'nativeThread:other', 'resumeSessionId', 'claudeConfigDir') ORDER BY key`,
				).toEqual([{ key: "nativeThread:other", value: other }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([]);
				const send = vi
					.spyOn(f.instance, "sendTurnEffect")
					.mockImplementation((input) =>
						Effect.gen(function* () {
							expect(input).toMatchObject({
								inputId: "fresh-resume",
								runId: "run:fresh-resume",
								commandAttempt: 2,
								nativeResumeFallback: true,
								startFreshNativeSession: true,
							});
							expect(input.resumeSessionId).toBeUndefined();
							expect(input.nativeThread).toBeUndefined();
							yield* input.eventSink.push({
								eventId: "fresh-resume-completed",
								type: "turn.completed",
								providerId: "claude",
								sessionId: "s",
								runId: input.runId,
								providerRefs: {},
								rawSource: { kind: "test.native" },
								createdAt: 2,
								data: { messageId: "", duration: 1 },
							});
							return {
								status: "completed",
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 0,
								providerStateUpdates: [],
							} satisfies TurnResult;
						}).pipe(
							Effect.mapError(
								(cause) =>
									new ProviderInstanceFailure({
										providerId: "claude",
										operation: "test native output",
										cause,
									}),
							),
						),
					);
				yield* Effect.all([f.reactor.drain(), f.reactor.drain()]);
				yield* f.reactor.drain();
				expect(send).toHaveBeenCalledTimes(1);
				expect(
					yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([{ status: "completed", attempt_count: 2 }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([{ type: "turn.completed" }]);
				expect(
					yield* f.sql`SELECT value FROM provider_state WHERE key = 'nativeThread:other'`,
				).toEqual([{ value: other }]);
			}),
		),
);

it.effect(
	"S7fix a rejected fresh fallback settles once without another fallback",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("rejected-fallback");
				yield* f.sql`UPDATE provider_command_outbox SET payload_json = json_set(payload_json, '$.nativeResumeFallback', json('true'))`;
				yield* f.hello((hello) => ({
					...hello,
					bindings: [],
					sendTokens: [],
					sendJournalAnswers: true,
					sendAnswers: [
						{
							status: "finished",
							token: sendToken("tx", "rejected-fallback", 1),
							// The host recorded this transmission as the fresh fallback (4.8).
							fresh: true,
							result: {
								status: "error",
								nativeResumeRejected: true,
								error: {
									code: "resume_rejected",
									message: "native resume was rejected",
								},
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 0,
								providerStateUpdates: [],
							},
						},
					],
				}));
				yield* f.recover;
				expect(
					yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([{ status: "failed", attempt_count: 1 }]);
				yield* f.reactor.drain();
				yield* f.reactor.drain();
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([{ type: "turn.error" }]);
			}),
		),
);

it.effect(
	"S7fix cached admission timeout restores original text and images once",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture();
				yield* f.seed("cached-timeout");
				const { makeAttachmentStore } = yield* Effect.promise(
					() => import("../../../src/lib/persistence/attachment-store.js"),
				);
				const attachmentStore = yield* makeAttachmentStore;
				const image = yield* attachmentStore.put(
					"data:image/png;base64,aW1hZ2U=",
				);
				yield* f.sql`UPDATE provider_command_outbox SET payload_json = json_set(payload_json, '$.text', 'original text', '$.images', json(${JSON.stringify([image])}))`;
				const drafts = yield* makeInputDrafts;
				Object.assign(f.recovery, { inputDrafts: drafts });
				const restore = vi.spyOn(drafts, "restoreChange");
				yield* f.hello((hello) => ({
					...hello,
					bindings: [],
					sendTokens: [],
					sendJournalAnswers: true,
					sendAnswers: [
						{
							status: "finished",
							token: sendToken("tx", "cached-timeout", 1),
							failure: {
								operation: "send-turn",
								code: "send_admission_timeout",
								message: "admission timed out",
								retryable: false,
							},
						},
					],
				}));
				yield* f.recover;
				yield* f.reactor.drain();
				expect(restore).toHaveBeenCalledExactlyOnceWith(
					{ session: "s" },
					"cached-timeout",
					[image],
					"original text",
					yield* Clock.currentTimeMillis,
				);
				expect(yield* drafts.read({ session: "s" })).toBe("original text");
				expect(
					yield* f.sql`SELECT COUNT(*) AS count FROM draft_attachments WHERE draft_key = 's' AND state = 'live'`,
				).toEqual([{ count: 1 }]);
				expect(
					yield* f.sql`SELECT input_id FROM messages WHERE role = 'user'`,
				).toEqual([{ input_id: "cached-timeout" }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([{ type: "turn.error" }]);
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
			}),
		),
);

for (const admissionTimeout of [false, true])
	it.effect(
		`S7fix adopted ${admissionTimeout ? "timeout restores the draft" : "refusal unblocks the next send"} once after release and duplicate replies`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.seed("socket-held");

					yield* f.seed("socket-next", 2, 0);
					yield* f.sql`UPDATE provider_command_outbox SET status = 'pending' WHERE command_id = 'socket-next'`;
					const drafts = yield* makeInputDrafts;
					Object.assign(f.recovery, { inputDrafts: drafts });
					const restore = vi.spyOn(drafts, "restoreChange");
					const { makeAttachmentStore } = yield* Effect.promise(
						() => import("../../../src/lib/persistence/attachment-store.js"),
					);
					const attachmentStore = yield* makeAttachmentStore;
					const image = yield* attachmentStore.put(
						"data:image/png;base64,aW1hZ2U=",
					);
					yield* f.sql`UPDATE provider_command_outbox SET payload_json = json_set(payload_json, '$.text', 'original socket text', '$.images', json(${JSON.stringify([image])})) WHERE command_id = 'socket-held'`;
					const { createServer } = yield* Effect.promise(
						() => import("node:net"),
					);
					const { RunnerSocket: Peer, RUNNER_PROTOCOL_VERSION } =
						yield* Effect.promise(
							() =>
								import("../../../src/lib/provider/runner/runner-protocol.js"),
						);
					const { connectRunner } = yield* Effect.promise(
						() =>
							import("../../../src/lib/provider/runner/runner-connection.js"),
					);
					let peer: InstanceType<typeof Peer> | undefined;
					const sent: string[] = [];
					let sequence = 0;
					const server = createServer((socket) => {
						peer = new Peer(
							socket,
							(message) => {
								if (message.type === "hello")
									peer?.write({
										type: "hello",
										driverKind: "claude",
										protocolVersion: RUNNER_PROTOCOL_VERSION,
										buildId: runnerBuildId(),
										runnerId: "131313131313",
										sessionId: "s",
										pid: 100_088,
										stampsRunIds: true,
										sendTokens: [],
										sendJournalAnswers: true,
										sendAnswers: [
											{
												status: "running",
												token: sendToken("tx", "socket-held", 1),
											},
										],
										bindings: [
											{
												token: sendToken("tx", "socket-held", 1),
												sessionId: "s",
												sinkId: runnerSinkId("socket-held", 1),
												released: false,
											},
										],
									});
								if (message.type === "replay")
									peer?.write({
										type: "upgrade-state",
										state: {
											quiescent: false,
											turnInFlight: true,
											revision: 0,
										},
									});
								if (
									message.type === "command" &&
									message.command.type === "send-turn"
								) {
									const input = message.command.input;
									sent.push(input.inputId);
									const sinkId = message.command.sinkId;
									peer?.write({
										type: "output",
										outputId: "socket-next-place",
										sequence: ++sequence,
										output: {
											type: "place-user-message",
											sinkId,
											input: {
												sessionId: "s",
												inputId: input.inputId,
												text: input.text ?? input.prompt,
												...(input.runId ? { runId: input.runId } : {}),
											},
										},
									});
									for (const type of ["run.started", "turn.completed"] as const)
										peer?.write({
											type: "output",
											outputId: `socket-next-${type}`,
											sequence: ++sequence,
											output: {
												type: "event",
												sinkId,
												event: {
													eventId: `socket-next-${type}`,
													type,
													providerId: "claude",
													sessionId: "s",
													runId: input.runId,
													providerRefs: {},
													rawSource: { kind: "test.native" },
													createdAt: 3,
													data:
														type === "run.started"
															? {
																	inputId: input.inputId,
																	requestedRunId: input.runId,
																}
															: { messageId: "", duration: 1 },
												},
											},
										});
									peer?.write({
										type: "output",
										outputId: "socket-next-release",
										sequence: ++sequence,
										output: { type: "release-sink", sinkId },
									});
									peer?.write({
										type: "command-reply",
										commandId: message.commandId,
										result: {
											status: "completed",
											cost: 0,
											tokens: { input: 0, output: 0 },
											durationMs: 0,
											providerStateUpdates: [],
										},
									});
								}
							},
							() => {},
						);
					});
					yield* Effect.addFinalizer(() =>
						Effect.promise(
							() =>
								new Promise<void>((resolve) => {
									peer?.destroy();
									server.close(() => resolve());
								}),
						),
					);
					yield* Effect.promise(
						() =>
							new Promise<void>((resolve, reject) => {
								server.once("error", reject);
								server.listen(f.socketPath, resolve);
							}),
					);
					vi.mocked(f.driver.connect).mockImplementation((options) =>
						connectRunner(options),
					);
					yield* f.recover;
					expect(sent).toEqual([]);
					const failure = {
						operation: "send-turn",
						code: admissionTimeout
							? "send_admission_timeout"
							: "provider_failure",
						message: "send was refused",
						retryable: false,
					};
					peer?.write({
						type: "command-reply",
						commandId: sendToken("tx", "socket-held", 0),
						failure,
					});
					yield* Effect.promise(
						() => new Promise<void>((resolve) => setTimeout(resolve, 20)),
					);
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox WHERE command_id = 'socket-held'`,
					).toEqual([{ status: "running" }]);
					peer?.write({
						type: "output",
						outputId: "held-release",
						sequence: ++sequence,
						output: {
							type: "release-sink",
							sinkId: runnerSinkId("socket-held", 1),
						},
					});

					peer?.write({
						type: "command-reply",
						commandId: sendToken("tx", "socket-held", 1),
						failure,
					});
					peer?.write({
						type: "command-reply",
						commandId: sendToken("tx", "socket-held", 1),
						failure,
					});
					for (let count = 0; count < 100; count++) {
						const rows = yield* f.sql<{
							status: string;
						}>`SELECT status FROM provider_command_outbox WHERE command_id = 'socket-held'`;
						if (
							rows[0]?.status === "failed" &&
							(!admissionTimeout || restore.mock.calls.length > 0)
						)
							break;
						yield* Effect.promise(
							() => new Promise<void>((resolve) => setTimeout(resolve, 5)),
						);
					}
					expect(
						yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox WHERE command_id = 'socket-held'`,
					).toEqual([{ status: "failed", attempt_count: 1 }]);
					expect(f.sendHandles[0]?.assignment._tag).toBe("Closed");
					if (admissionTimeout) {
						expect(restore).toHaveBeenCalledExactlyOnceWith(
							{ session: "s" },
							"socket-held",
							[image],
							"original socket text",
							yield* Clock.currentTimeMillis,
						);
						expect(yield* drafts.read({ session: "s" })).toBe(
							"original socket text",
						);
						expect(
							yield* f.sql`SELECT COUNT(*) AS count FROM draft_attachments WHERE draft_key = 's' AND state = 'live'`,
						).toEqual([{ count: 1 }]);
					}
					yield* f.reactor.drain();
					expect(sent).toEqual(["socket-next"]);
					expect(
						yield* f.sql`SELECT command_id, status, attempt_count FROM provider_command_outbox ORDER BY request_sequence`,
					).toEqual([
						{ command_id: "socket-held", status: "failed", attempt_count: 1 },
						{
							command_id: "socket-next",
							status: "completed",
							attempt_count: 1,
						},
					]);
					expect(
						yield* f.sql`SELECT json_extract(metadata, '$.runId') AS run_id, COUNT(*) AS count FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted') GROUP BY run_id ORDER BY run_id`,
					).toEqual([
						{ run_id: "run:socket-held", count: 1 },
						{ run_id: "run:socket-next", count: 1 },
					]);
					expect(
						yield* f.sql`SELECT input_id FROM messages WHERE role = 'user' ORDER BY input_id`,
					).toEqual([{ input_id: "socket-held" }, { input_id: "socket-next" }]);
				}),
			),
	);

it.effect(
	"S7fix recovered fork refusal keeps later inputs fresh without a command fallback marker",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "parent", {
						sessionId: "parent",
						title: "Fork parent",
						provider: "account",
					}),
				]);
				yield* f.sql`UPDATE sessions SET forked_from = 'parent', provider = 'account' WHERE id = 's'`;
				yield* f.seed("fork-refusal");
				yield* f.hello((hello) => ({
					...hello,
					bindings: [],
					sendTokens: [],
					sendJournalAnswers: true,
					sendAnswers: [
						{
							status: "finished",
							token: sendToken("tx", "fork-refusal", 1),
							result: {
								status: "error",
								nativeResumeRejected: true,
								error: {
									code: "resume_rejected",
									message: "No conversation found with session ID s",
								},
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 0,
								providerStateUpdates: [],
							},
						},
					],
				}));
				yield* f.recover;
				expect(
					yield* f.sql`SELECT status, json_extract(payload_json, '$.nativeResumeFallback') AS fallback FROM provider_command_outbox`,
				).toEqual([{ status: "retryable_failed", fallback: 1 }]);
				const readTranscript = vi.fn(async () => []);
				const forkSession = vi.fn(async () => ({ sessionId: "unused" }));
				const { makePrepareTurn } = yield* Effect.promise(
					() => import("../../../src/lib/provider/claude/prepare-turn.js"),
				);
				const prepare = yield* makePrepareTurn({
					folderSource: "account",
					configDir: configuredClaudeConfigDir(f.root),
					workspaceRoot: f.root,
					sessionForkSdk: { readTranscript, forkSession },
				});
				const prepared = yield* prepare("s", "account", "later input");
				expect(prepared.resumeSessionId).toBeUndefined();
				expect(readTranscript).not.toHaveBeenCalled();
				expect(forkSession).not.toHaveBeenCalled();
				expect(
					yield* f.sql`SELECT value FROM provider_state WHERE session_id = 's' AND key = 'claude.forkRefused:account'`,
				).toEqual([{ value: "true" }]);
				expect(
					yield* f.sql`SELECT key FROM provider_state WHERE session_id = 's' AND key = 'nativeThread:account'`,
				).toEqual([]);
			}),
		),
);

// Failure modes: terminal/reply ordering, duplicate settlement, rollback and a stranded next inbox pass.
for (const order of [
	"native-first",
	"reply-first",
	"hello",
	"startup",
] as const)
	it.effect(
		`S7round2 ${order} returns an unplaced steer once and the next inbox pass drains it`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture();
					yield* f.seed("native-steer");
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("input.admitted", "s", {
							sessionId: "s",
							inputId: "native-steer",
							delivery: "steer",
							request: { text: "steer text" },
						}),
						canonicalEvent("input.sent", "s", {
							sessionId: "s",
							inputId: "native-steer",
							steer: true,
						}),
					]);
					const result = {
						status: "error",
						error: {
							code: "provider_error",
							message: "run failed before intake",
							retryable: false,
						},
						cost: 0,
						tokens: { input: 0, output: 0 },
						durationMs: 0,
						providerStateUpdates: [],
					} satisfies TurnResult;
					const native = () =>
						f.ingestion.ingest({
							eventId: "native-terminal",
							type: "turn.error",
							providerId: "cursor",
							sessionId: "s",
							runId: "run:native-steer",
							providerRefs: {},
							rawSource: { kind: "test.native" },
							createdAt: 2,
							data: {
								messageId: "",
								error: "run failed before intake",
								code: "provider_error",
								retryable: false,
							},
						});
					yield* f.hello((hello) => ({
						...hello,
						bindings: [],
						sendTokens: [],
						sendJournalAnswers: true,
						sendAnswers:
							order === "hello"
								? [
										{
											token: sendToken("tx", "native-steer", 1),
											status: "finished",
											result,
										},
									]
								: [],
					}));
					if (order !== "startup") yield* f.recover;
					if (order !== "hello" && order !== "startup") {
						vi.spyOn(f.instance, "sendTurnEffect").mockImplementation(() =>
							Effect.gen(function* () {
								if (order === "native-first") yield* native();
								return result;
							}).pipe(
								Effect.mapError(
									(cause) =>
										new ProviderInstanceFailure({
											providerId: "cursor",
											operation: "native-test",
											cause,
										}),
								),
							),
						);
						yield* f.reactor.runOnce();
					}
					if (order === "startup") {
						yield* f.sql`UPDATE provider_command_outbox SET status = 'failed', error_code = 'provider_error'`;
						yield* f.sql`UPDATE provider_runs SET status = 'error', completed_at = 2`;
					} else {
						yield* native();
						yield* native();
						yield* f.reactor.runOnce();
					}
					const handedOff = yield* Deferred.make<void>();
					const sendTurn = vi.fn<
						import("../../../src/lib/domain/relay/Services/provider-turn-service.js").ProviderTurnService["sendTurn"]
					>((input) =>
						f.persist
							.persistUserMessage("s", "steer text", {
								messageId: input.commandId,
								inputId: input.commandId,
							})
							.pipe(
								Effect.mapError(
									(cause) =>
										new ProviderInstanceFailure({
											providerId: "cursor",
											operation: "inbox placement",
											cause,
										}),
								),
								Effect.andThen(Deferred.succeed(handedOff, undefined)),
								Effect.asVoid,
							),
					);
					const context =
						yield* Effect.context<
							Layer.Success<ReturnType<typeof makePersistenceEffectLayer>>
						>();
					const deps = Layer.mergeAll(
						makeTestHandlerLayer({
							persistenceLayer: Layer.succeedContext(context),
						}),
						Layer.succeed(SessionEventBusTag, {
							publish: () => Effect.void,
							publishAdvance: () => Effect.void,
							subscribe: () => Effect.succeed(Stream.empty),
							subscribeAdvances: () => Effect.succeed(Stream.empty),
						}),
						Layer.succeed(Usage, {
							readings: Stream.empty,
							latest: () => Effect.succeed(undefined),
							refresh: () => Effect.succeed([]),
							turnEnded: () => Effect.void,
							pickFailover: () => Effect.succeed(undefined),
						}),
						Layer.succeed(ContinuationTag, {
							requestContinuation: () => Effect.void,
							intakeLimit: () => Effect.succeed(false),
							dismissCutOff: () => Effect.void,
							cancelContinuation: () => Effect.void,
							sweepDueContinuations: () => Effect.void,
							queueLimitPolicy: () => Effect.void,
							runLimitPolicies: Effect.never,
						}),
						Layer.succeed(ProviderTurnServiceTag, {
							holdUserTurnsForAccountSwitch: () => Effect.void,
							prepareTurnSession: () => Effect.succeed("cursor"),
							turnFences: () => ({ stopping: false, switching: false }),
							fenceLifts: Effect.succeed(Stream.never),
							beginStop: () => Effect.succeed(Effect.void),
							sendTurn,
						}),
					);
					yield* Effect.gen(function* () {
						const inbox = yield* SessionInboxTag;
						if (order === "startup") {
							yield* inbox.start;
							yield* TestClock.adjust("1 second");
						}
						expect(
							yield* f.sql`SELECT state FROM pending_inputs WHERE input_id = 'native-steer'`,
						).toEqual([{ state: "queued" }]);
						expect(
							yield* f.sql`SELECT type FROM events WHERE type = 'input.requeued'`,
						).toEqual([{ type: "input.requeued" }]);
						expect(
							yield* f.sql`SELECT input_id FROM messages WHERE role = 'user'`,
						).toEqual([]);

						expect(
							yield* inbox.sendNow({
								clientId: "client",
								sessionId: "s",
								inputId: "native-steer",
							}),
						).toBe("accepted");
						yield* inbox.start;
						yield* TestClock.adjust("1 second");
						expect(sendTurn).toHaveBeenCalledTimes(1);
						yield* Deferred.await(handedOff);
						yield* Effect.yieldNow;
						expect(sendTurn).toHaveBeenCalledTimes(1);
						expect(
							yield* f.sql`SELECT state FROM pending_inputs WHERE input_id = 'native-steer'`,
						).toEqual([{ state: "removed" }]);
						expect(
							yield* f.sql`SELECT type FROM events WHERE type = 'input.requeued'`,
						).toHaveLength(1);
					}).pipe(Effect.provide(SessionInboxLive.pipe(Layer.provide(deps))));
				}),
			),
	);

it.effect(
	"S7round2 cached primary rejection after fallback marker but before fallback delivery still requeues",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("fallback-window");
				const journal = new RunnerSendJournal(f.root, "s", "claude");
				const rejection = {
					status: "error",
					nativeResumeRejected: true,
					error: {
						code: "resume_rejected",
						message: "No conversation found with session ID stale",
					},
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				} satisfies TurnResult;
				yield* journal.execute(
					sendToken("tx", "fallback-window", 1),
					Effect.succeed(rejection),
				);
				yield* f.sql`INSERT INTO provider_state (session_id, key, value) VALUES ('s','nativeThread:account','stale')`;
				yield* f.sql`CREATE TABLE cursor_deletions (key TEXT)`;
				yield* f.sql`CREATE TRIGGER count_cursor_clear AFTER DELETE ON provider_state WHEN OLD.key = 'nativeThread:account' BEGIN INSERT INTO cursor_deletions VALUES (OLD.key); END`;
				const { recordClaudeNativeResumeFallback } = yield* Effect.promise(
					() => import("../../../src/lib/provider/claude/prepare-turn.js"),
				);
				yield* f.sql.withTransaction(
					recordClaudeNativeResumeFallback(f.sql, {
						sessionId: "s",
						instanceId: "account",
						commandId: "fallback-window",
					}),
				);
				yield* f.hello((hello) => ({
					...hello,
					bindings: [
						{
							token: sendToken("tx", "fallback-window", 1),
							sessionId: "s",
							sinkId: runnerSinkId("fallback-window", 1),
							released: true,
						},
					],
					sendTokens: [],
					sendJournalAnswers: true,
					sendAnswers: [
						{
							status: "finished",
							token: sendToken("tx", "fallback-window", 1),
							result: {
								status: "error",
								nativeResumeRejected: true,
								error: {
									code: "resume_rejected",
									message: "No conversation found with session ID stale",
								},
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 0,
								providerStateUpdates: [],
							},
						},
					],
				}));
				yield* f.recover;

				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "retryable_failed" }]);
				const delivered = vi.fn(() =>
					Effect.gen(function* () {
						yield* f.ingestion.ingest({
							eventId: "fallback-window-completed",
							type: "turn.completed",
							providerId: "claude",
							sessionId: "s",
							runId: "run:fallback-window",
							providerRefs: {},
							rawSource: { kind: "test.native" },
							createdAt: 3,
							data: { messageId: "", duration: 1 },
						});
						return {
							status: "completed",
							cost: 0,
							tokens: { input: 0, output: 0 },
							durationMs: 0,
							providerStateUpdates: [],
						} satisfies TurnResult;
					}),
				);
				vi.spyOn(f.instance, "sendTurnEffect").mockImplementation((input) => {
					expect(input.commandAttempt).toBe(2);
					expect(input.nativeResumeFallback).toBe(true);
					expect(input.startFreshNativeSession).toBe(true);
					expect(input.resumeSessionId).toBeUndefined();
					return journal
						.execute(
							sendToken("tx", "fallback-window", input.commandAttempt ?? 0),
							delivered().pipe(
								Effect.mapError((cause) =>
									runnerFailure("test native completion", cause),
								),
							),
						)
						.pipe(
							Effect.flatMap((result) =>
								result
									? Effect.succeed(result)
									: Effect.die("Missing journal completion"),
							),
							Effect.mapError(
								(cause) =>
									new ProviderInstanceFailure({
										providerId: "claude",
										operation: "journal fallback",
										cause,
									}),
							),
						);
				});
				yield* Effect.all([f.reactor.drain(), f.reactor.drain()]);
				yield* f.reactor.drain();
				expect(delivered).toHaveBeenCalledTimes(1);
				expect(
					yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([{ status: "completed", attempt_count: 2 }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed','turn.error','turn.interrupted')`,
				).toEqual([{ type: "turn.completed" }]);
				expect(yield* f.sql`SELECT key FROM cursor_deletions`).toEqual([
					{ key: "nativeThread:account" },
				]);
			}),
		),
);

it.effect(
	"S7round2 review rejection rollback preserves the native cursor and fallback eligibility",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("rollback-resume");
				yield* f.sql`INSERT INTO provider_state (session_id, key, value) VALUES ('s','nativeThread:account','old-cursor')`;
				yield* f.sql`CREATE TRIGGER abort_requeue BEFORE UPDATE ON provider_command_outbox WHEN NEW.status = 'retryable_failed' BEGIN SELECT RAISE(ABORT, 'probe rollback'); END`;
				const { runningRunnerCommands } = yield* Effect.promise(
					() => import("../../../src/lib/provider/runner/runner-recovery.js"),
				);
				const [row] = yield* runningRunnerCommands(
					f.sql,
					"claude",
					() => "claude",
					"s",
				);
				if (!row) return yield* Effect.die("Missing recovery command");
				const { LegacySendKey, settleLegacySend } = yield* Effect.promise(
					() =>
						import(
							"../../../src/lib/provider/runner/send-settlement-outbox.js"
						),
				);
				const key = yield* LegacySendKey.prove(f.sql, row);
				if (!key) return yield* Effect.die("Missing legacy recovery key");
				const commit = yield* makeCommitAndSignal;
				const exit = yield* Effect.exit(
					commit.write((project, stamp) =>
						settleLegacySend(
							{
								sql: f.sql,
								project,
								stamp,
								persistUserMessage: f.persist.persistUserMessage,
							},
							key,
							{
								status: "error",
								nativeResumeRejected: true,
								error: {
									code: "resume_rejected",
									message: "No conversation found with session ID stale",
								},
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 0,
								providerStateUpdates: [],
							},
							undefined,
							2,
							{
								nativeResumeFallback: false,
							},
						),
					),
				);
				expect(Exit.isFailure(exit)).toBe(true);
				expect(
					yield* f.sql`SELECT status, json_extract(payload_json, '$.nativeResumeFallback') AS fallback FROM provider_command_outbox`,
				).toEqual([{ status: "running", fallback: null }]);
				expect(
					yield* f.sql`SELECT value FROM provider_state WHERE key = 'nativeThread:account'`,
				).toEqual([{ value: "old-cursor" }]);
			}),
		),
);

// Failure mode: a key proved while the run was in a legacy cohort settles the run
// after it has left the cohort, though it was never started or dispatched.
it.effect(
	"BC-2 legacy settlement rechecks the legacy predicate, not only the outbox claim",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				const input = yield* f.seed("cohort-left", 1, 0);
				yield* f.sql`UPDATE provider_command_outbox SET status = 'running', attempt_count = 1`;
				yield* f.sql`INSERT INTO claude_runner_cursors (runner_id, sequence, session_id, owned_run_ids)
					VALUES ('legacy-cohort', 0, 's', ${JSON.stringify([input.runId])})`;
				const { runningRunnerCommands } = yield* Effect.promise(
					() => import("../../../src/lib/provider/runner/runner-recovery.js"),
				);
				const [row] = yield* runningRunnerCommands(
					f.sql,
					"claude",
					() => "claude",
					"s",
				);
				if (!row) return yield* Effect.die("Missing recovery command");
				const { LegacySendKey, settleLegacySend } = yield* Effect.promise(
					() =>
						import(
							"../../../src/lib/provider/runner/send-settlement-outbox.js"
						),
				);
				const key = yield* LegacySendKey.prove(f.sql, row);
				if (!key) return yield* Effect.die("Missing legacy recovery key");
				yield* f.sql`DELETE FROM claude_runner_cursors WHERE runner_id = 'legacy-cohort'`;
				expect(yield* legacyRunnerRunQuery(f.sql, "s", input.runId)).toBe(
					false,
				);
				const commit = yield* makeCommitAndSignal;
				yield* commit.write((project, stamp) =>
					settleLegacySend(
						{
							sql: f.sql,
							project,
							stamp,
							persistUserMessage: f.persist.persistUserMessage,
						},
						key,
						{
							status: "completed",
							cost: 0,
							tokens: { input: 0, output: 0 },
							durationMs: 0,
							providerStateUpdates: [],
						},
						undefined,
						2,
					),
				);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "running" }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed','turn.error','turn.interrupted')`,
				).toEqual([]);
			}),
		),
);

// Failure modes: terminal settlement commits without its returned input, or rollback announces it.
it.effect(
	"S7round2 failed-steer requeue rolls back with its native terminal and publishes only after commit",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture();
				yield* f.seed("atomic-steer");
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("input.admitted", "s", {
						sessionId: "s",
						inputId: "atomic-steer",
						delivery: "steer",
						request: { text: "steer text" },
					}),
					canonicalEvent("input.sent", "s", {
						sessionId: "s",
						inputId: "atomic-steer",
						steer: true,
					}),
				]);
				const published = vi.fn(() => Effect.void);
				yield* f.sql`CREATE TRIGGER abort_input_return BEFORE INSERT ON events WHEN NEW.type = 'input.requeued' BEGIN SELECT RAISE(ABORT, 'requeue rollback'); END`;
				const terminal = canonicalEvent(
					"turn.error",
					"s",
					{
						messageId: "",
						error: "failed before intake",
						code: "provider_error",
						retryable: false,
					},
					{
						metadata: { runId: "run:atomic-steer" },
					},
				);
				yield* Effect.gen(function* () {
					const write = yield* makeCommitAndSignal;
					const exit = yield* Effect.exit(write([terminal]));
					expect(Exit.isFailure(exit)).toBe(true);
					expect(published).not.toHaveBeenCalled();
					expect(
						yield* f.sql`SELECT status FROM provider_command_outbox`,
					).toEqual([{ status: "running" }]);
					expect(yield* f.sql`SELECT state FROM pending_inputs`).toEqual([
						{ state: "steering" },
					]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('input.requeued','turn.error')`,
					).toEqual([]);
					yield* f.sql`DROP TRIGGER abort_input_return`;
					yield* write([terminal]);
					expect(published).toHaveBeenCalledTimes(1);
					expect(
						yield* f.sql`SELECT state FROM pending_inputs WHERE input_id = 'atomic-steer'`,
					).toEqual([{ state: "queued" }]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type = 'input.requeued'`,
					).toHaveLength(1);
				}).pipe(
					Effect.provideService(SessionEventBusTag, {
						publish: published,
						publishAdvance: () => Effect.void,
						subscribe: () => Effect.succeed(Stream.empty),
						subscribeAdvances: () => Effect.succeed(Stream.empty),
					}),
				);
			}),
		),
);

for (const failure of ["attachment_missing", "account_unavailable"] as const)
	it.effect(
		`owner recovery settles permanent ${failure} once without retrying preparation`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("cursor");
					const commandId = `permanent-${failure}`;
					// An unheld pre-start owner is recovered by the owner feeder, rather
					// than the compatibility path for command-less dispatch events.
					const input = yield* f.seed(commandId, 1, 0);
					const payload = {
						...input,
						...(failure === "attachment_missing"
							? {
									images: [
										{ attachmentHash: "0".repeat(64), mime: "image/png" },
									],
								}
							: { account: { ...input.account, id: "missing-account" } }),
					};
					// Keep provider_id='account': driver discovery must select the row
					// before the missing payload account is classified permanently.
					yield* f.sql`UPDATE provider_command_outbox
						SET status = 'running', attempt_count = 1,
							payload_json = ${JSON.stringify(payload)}
						WHERE command_id = ${commandId}`;
					const prepare = vi.spyOn(f.driver, "legacyPrepareTurnEffect");
					yield* f.recover;
					yield* TestClock.adjust("1 second");
					expect(
						yield* f.sql`SELECT status, error_code, attempt_count
							FROM provider_command_outbox WHERE command_id = ${commandId}`,
					).toEqual([
						{ status: "failed", error_code: failure, attempt_count: 1 },
					]);
					expect(
						yield* f.sql`SELECT status, runner_id FROM provider_runs
							WHERE id = ${input.runId}`,
					).toEqual([{ status: "error", runner_id: null }]);
					expect(
						yield* f.sql`SELECT type FROM events
							WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')
								AND json_extract(metadata, '$.runId') = ${input.runId}`,
					).toEqual([{ type: "turn.error" }]);
					expect(prepare).not.toHaveBeenCalled();
					expect(f.sendHandles).toHaveLength(1);
					expect(f.sendHandles.map((send) => send.assignment._tag)).toEqual([
						"Closed",
					]);
					expect(
						f.commands.filter((command) => command.type === "send-turn"),
					).toEqual([]);
					// Another public recovery sweep sees the settled owner and admits no
					// new work; the completed recovery fiber retains no live handle.
					yield* f.instance.attachSessionsEffect(["s"], () =>
						Effect.succeed(f.recovery),
					);
					yield* TestClock.adjust("10 seconds");
					expect(f.sendHandles).toHaveLength(1);
					expect(prepare).not.toHaveBeenCalled();
					expect(
						yield* f.sql`SELECT COUNT(*) AS n FROM events
							WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')
								AND json_extract(metadata, '$.runId') = ${input.runId}`,
					).toEqual([{ n: 1 }]);
				}),
			),
	);

it.effect(
	"legacy recovery hides a transient preparation failure and retries the same owner",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("cursor");
				yield* f.seed("legacy-transient");
				yield* f.hello(
					({
						sendJournalAnswers: _capability,
						sendAnswers: _answers,
						...hello
					}) => ({
						...hello,
						bindings: [],
						sendTokens: [],
						completedCommands: [],
					}),
				);
				const originalPrepare = f.driver.legacyPrepareTurnEffect;
				if (!originalPrepare)
					return yield* Effect.die("missing fixture preparation");
				const firstFailure = yield* Deferred.make<void>();
				let attempts = 0;
				vi.spyOn(f.driver, "legacyPrepareTurnEffect").mockImplementation(
					(input) =>
						Effect.gen(function* () {
							attempts++;
							if (attempts === 1) {
								yield* Deferred.succeed(firstFailure, undefined);
								return yield* Effect.fail(
									new ProviderInstanceFailure({
										providerId: "cursor",
										operation: "prepare recovered turn",
										cause: {
											code: "SQLITE_BUSY",
											message: "SQLite busy",
											retryable: true,
										},
									}),
								);
							}
							return yield* originalPrepare(input);
						}),
				);
				f.replaySend.execute = () =>
					Effect.succeed({
						status: "completed",
						cost: 0,
						tokens: { input: 0, output: 0 },
						durationMs: 0,
						providerStateUpdates: [],
					});
				yield* f.recover;
				yield* Deferred.await(firstFailure);
				yield* TestClock.adjust(0);
				expect(
					yield* f.sql`SELECT status, error_code, attempt_count
						FROM provider_command_outbox WHERE command_id = 'legacy-transient'`,
				).toEqual([{ status: "running", error_code: null, attempt_count: 1 }]);
				expect(
					yield* f.sql`SELECT type FROM events
						WHERE type IN ('input.requeued', 'turn.error', 'turn.interrupted')`,
				).toEqual([]);
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
				yield* TestClock.adjust("1 second");
				expect(attempts).toBe(2);
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toHaveLength(1);
				expect(
					yield* f.sql`SELECT status, error_code, attempt_count
						FROM provider_command_outbox WHERE command_id = 'legacy-transient'`,
				).toEqual([
					{ status: "completed", error_code: null, attempt_count: 1 },
				]);
				expect(
					yield* f.sql`SELECT type FROM events
						WHERE type IN ('input.requeued', 'turn.error', 'turn.interrupted')`,
				).toEqual([]);
			}),
		),
);

for (const reason of ["ResumeRejected", "JournalAbsent"] as const)
	it.effect(
		`R2 released ${reason} run with legacy-shaped history is never legacy`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture();
					yield* f.seed("released-history");
					// A run.released is definitive provenance even for imported history.
					yield* (yield* makeCommitAndSignal)([
						canonicalEvent("run.released", "s", {
							runId: "run:released-history",
							runnerId: "131313131313",
							commandId: "released-history",
							transmission: 1,
							reason,
						}),
					]);
					expect(
						yield* legacyRunnerRunQuery(f.sql, "s", "run:released-history"),
					).toBe(false);
				}),
			),
	);

for (const answerAtHello of [true, false])
	it.effect(
		`R2 held indeterminate ${answerAtHello ? "hello" : "reply"} remains owned without adoption writing uncertainty`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.seed("held-uncertainty", 1, 1, "held");
					const result: TurnResult = {
						status: "indeterminate",
						cost: 0,
						tokens: { input: 0, output: 0 },
						durationMs: 0,
						providerStateUpdates: [],
					};
					yield* f.hello((hello) => ({
						...hello,
						bindings: [
							{
								token: sendToken("hold", "held-uncertainty", 1),
								sessionId: "s",
								sinkId: runnerSinkId("held-uncertainty", 1),
								released: false,
							},
						],
						sendTokens: [],
						sendJournalAnswers: true,
						sendAnswers: [
							{
								token: sendToken("hold", "held-uncertainty", 1),
								...(answerAtHello
									? { status: "finished" as const, result }
									: { status: "running" as const }),
							},
						],
					}));
					yield* f.recover;
					if (!answerAtHello) {
						const attachment = f.attachments[0];
						if (!attachment?.onCommandReply)
							return yield* Effect.die("Missing recovered reply boundary");
						const reply = {
							type: "command-reply" as const,
							commandId: sendToken("hold", "held-uncertainty", 1),
							result,
						};
						yield* attachment.onCommandReply(reply);
						yield* attachment.onCommandReply(reply);
					}
					expect(
						yield* f.sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'held-uncertainty'`,
					).toEqual([{ status: "running", error_code: null }]);
					expect(
						yield* f.sql`SELECT status, runner_id, held_transmission FROM provider_runs WHERE id = 'run:held-uncertainty'`,
					).toEqual([
						{
							status: "pending",
							runner_id: "131313131313",
							held_transmission: 1,
						},
					]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted', 'run.released')`,
					).toEqual([]);
				}),
			),
	);

it.effect(
	"R2 registration without cursor verifies and cleans a host without serving authority",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				const signals: Array<{ pid: number; signal: string }> = [];
				vi.spyOn(f.processTable, "signal").mockImplementation((pid, signal) => {
					signals.push({ pid, signal });
					f.processes.delete(pid);
				});
				const before = yield* f.sql`SELECT type FROM events ORDER BY sequence`;
				// This public entry bypasses only the fixture's cursor auto-registration.
				if (
					!f.manager.attachSessionsEffect ||
					!f.manager.getControlProcessIdEffect
				)
					return yield* Effect.die("Missing public recovery boundary");
				yield* f.manager.attachSessionsEffect(["s"]);
				yield* TestClock.adjust("5 seconds");
				expect(f.attachments).toHaveLength(1);
				expect(f.attachments[0]?.identityOnly).toBe(true);
				expect(yield* f.manager.getControlProcessIdEffect("s")).toBeUndefined();
				expect(
					yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE retired_at IS NULL AND role = 'serving'`,
				).toEqual([]);
				expect(signals).toEqual([{ pid: 100_088, signal: "SIGTERM" }]);
				expect(f.processes.has(100_088)).toBe(false);
				expect(
					f.commands.filter((command) => command.type === "send-turn"),
				).toEqual([]);
				// The retirement records the runner's loss once (CONTRACT 6.5).
				expect(yield* f.sql`SELECT type FROM events ORDER BY sequence`).toEqual(
					[...before, { type: "evidence.process_lost" }],
				);
			}),
		),
);

it.effect(
	"R2 a committed Stop after hold releases the host refusal before returning",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* sendScopeFixture();
				yield* f.manager.recoverEffect;
				const committed = yield* Deferred.make<void>();
				const resume = yield* Deferred.make<void>();
				const bus = yield* SessionEventBusTag;
				const publish = bus.publish;
				let paused = false;
				const publication = vi
					.spyOn(bus, "publish")
					.mockImplementation((events, ended) =>
						publish(events, ended).pipe(
							Effect.andThen(
								Effect.suspend(() => {
									if (
										paused ||
										!events.some((event) => event.type === "run.dispatched")
									)
										return Effect.void;
									paused = true;
									return Deferred.succeed(committed, undefined).pipe(
										Effect.andThen(Deferred.await(resume)),
									);
								}),
							),
						),
					);
				f.replaySend.execute = () =>
					Effect.fail({
						operation: "send-turn",
						code: "runner_stopping",
						message: "Accepted Stop covers this transmission",
						delivery: { _tag: "Refused", reason: "interrupted" },
					});
				yield* Effect.gen(function* () {
					const sending = yield* f.instance
						.sendTurnEffect(f.input)
						.pipe(Effect.forkChild);
					yield* Deferred.await(committed);
					yield* f.acceptStop;
					yield* Deferred.succeed(resume, undefined);
					yield* TestClock.adjust(0);
					expect(
						yield* f.sql`SELECT json_extract(data, '$.reason') AS reason FROM events WHERE type = 'run.released'`,
					).toEqual([{ reason: "Refused" }]);
					expect(
						f.commands.filter((command) => command.type === "send-turn"),
					).toHaveLength(1);
					expect((yield* Fiber.join(sending)).status).toBe("cancelled");
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "interrupted" },
					]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([{ type: "turn.interrupted" }]);
				}).pipe(
					Effect.ensuring(Deferred.succeed(resume, undefined)),
					Effect.ensuring(
						Effect.sync(() => {
							publication.mockRestore();
						}),
					),
				);
			}),
		),
);

// F55 and F57: a Stop commit that meets a store fault belongs to the
// reconciler. The caller neither retries it nor swallows it.
const failStopFences = (
	sql: SqlClient.SqlClient,
	fails: (runnerId: unknown) => boolean,
	error = new SqlError({
		reason: new ConnectionError({ cause: "Stop commit unavailable" }),
	}),
) =>
	Effect.gen(function* () {
		const fences: unknown[] = [];
		const connection = yield* Effect.scoped(sql.reserve);
		const execute = connection.execute;
		const injected = vi
			.spyOn(connection, "execute")
			.mockImplementation((query, params, transform) => {
				if (
					query.includes(
						"SELECT retired_at, role, session_id FROM claude_runner_cursors",
					)
				) {
					fences.push(params[0]);
					if (fails(params[0])) return Effect.fail(error);
				}
				return execute(query, params, transform);
			});
		yield* Effect.addFinalizer(() => Effect.sync(() => injected.mockRestore()));
		return fences;
	});

it.effect(
	"F55 an upgrade candidate's unavailable Stop commit lands through the reconciler with one shutdown",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture(false);
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect) return yield* Effect.die("missing connect");
				vi.mocked(f.driver.connect).mockImplementation((options) =>
					connect({
						...options,
						onHello: (hello, connection, replay) => {
							const original = options.runnerId === "131313131313";
							if (!original) {
								const command = connection.commandEffect.bind(connection);
								vi.spyOn(connection, "commandEffect").mockImplementation(
									(id, payload, attempt) =>
										payload.type === "pre-warm"
											? Effect.fail(runnerFailure("pre-warm", "warm failed"))
											: command(id, payload, attempt),
								);
							}
							return options.onHello(
								{
									...hello,
									buildId: original ? "previous-build" : hello.buildId,
								},
								connection,
								replay,
							);
						},
					}),
				);
				yield* f.manager.recoverEffect;
				let down = true;
				const fences = yield* failStopFences(
					f.sql,
					(runnerId) => down && runnerId !== "131313131313",
				);
				const old = f.attachments[0];
				if (!old?.onUpgradeState) return yield* Effect.die("missing old");
				old.onUpgradeState({
					quiescent: true,
					revision: 1,
					snapshot: {
						input: { ...f.input, folderSource: "implicitDefault" },
						options: {},
					},
				});
				yield* TestClock.adjust(0);
				const candidate = f.attachments[1];
				if (!candidate) return yield* Effect.die("missing candidate");
				const shutdowns = () =>
					f.commands.filter(
						(command) =>
							command.runnerId === candidate.runnerId &&
							command.type === "shutdown",
					);
				expect(fences).toEqual([candidate.runnerId]);
				expect(
					yield* f.sql`SELECT retired_at, role FROM claude_runner_cursors WHERE runner_id = ${candidate.runnerId}`,
				).toEqual([{ retired_at: null, role: "candidate" }]);
				expect(shutdowns()).toEqual([]);
				down = false;
				yield* TestClock.adjust("1 second");
				expect(fences).toEqual([candidate.runnerId, candidate.runnerId]);
				expect(
					yield* f.sql`SELECT retired_at, stop_reason FROM claude_runner_cursors WHERE runner_id = ${candidate.runnerId}`,
				).toEqual([
					{ retired_at: 1000, stop_reason: '{"_tag":"CandidateAbandoned"}' },
				]);
				expect(shutdowns()).toHaveLength(1);
				expect(
					yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE role = 'serving' AND retired_at IS NULL`,
				).toEqual([{ runner_id: "131313131313" }]);
				// The upgrade's ensuring waits out the candidate's bounded Stop window.
				yield* TestClock.adjust("4 seconds");
			}),
		),
);

it.effect(
	"F57 failure cleanup's unavailable Stop commit waits for the reconciler, with no caller retry",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture();
				let down = true;
				const fences = yield* failStopFences(f.sql, () => down);
				const old = f.attachments[0];
				if (!old) return yield* Effect.die("missing runner");
				old.onClose(runnerFailure("socket", "runner exited"));
				yield* TestClock.adjust("500 millis");
				expect(fences).toEqual(["131313131313"]);
				expect(
					yield* f.sql`SELECT retired_at FROM claude_runner_cursors WHERE runner_id = '131313131313'`,
				).toEqual([{ retired_at: null }]);
				down = false;
				yield* TestClock.adjust("500 millis");
				expect(fences).toEqual(["131313131313", "131313131313"]);
				expect(
					yield* f.sql`SELECT retired_at, stop_reason FROM claude_runner_cursors WHERE runner_id = '131313131313'`,
				).toEqual([{ retired_at: 1000, stop_reason: '{"_tag":"Exited"}' }]);
			}),
		),
);

it.effect(
	"32.29.3 R1 restart stops a deleted session's serving runner after its identity hello",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture(false);
				yield* f.sql`DELETE FROM session_providers WHERE session_id = 's'`;
				yield* f.sql`DELETE FROM sessions WHERE id = 's'`;
				const recovering = yield* f.manager.recoverEffect.pipe(
					Effect.forkChild,
				);
				yield* TestClock.adjust(0);
				expect(
					yield* f.sql`SELECT retired_at, stop_reason, role FROM claude_runner_cursors WHERE runner_id = '131313131313'`,
				).toEqual([
					{
						retired_at: 0,
						stop_reason: '{"_tag":"EndSession","orphan":true}',
						role: "serving",
					},
				]);
				expect(
					f.commands.filter((command) => command.type === "shutdown"),
				).toEqual([{ runnerId: "131313131313", type: "shutdown" }]);
				// Recovery waits for the stopped runner to exit.
				f.processes.delete(100_088);
				yield* TestClock.adjust("1 second");
				yield* Fiber.join(recovering);
			}),
		),
);

it.effect(
	"32.29.3 R2 startup never waits on a Stop commit on any recovery path while writes stay busy",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture(false);
				const runners = {
					orphan: { runnerId: "515151515151", sessionId: "gone", pid: 100_051 },
					incompatible: {
						runnerId: "525252525252",
						sessionId: "b",
						pid: 100_052,
					},
					dead: { runnerId: "535353535353", sessionId: "c", pid: 100_053 },
					survivor: { runnerId: "555555555555", sessionId: "e", pid: 100_055 },
					defect: { runnerId: "545454545454", sessionId: "d", pid: 100_054 },
				};
				// Recovery runs in sidebar order, then newest first among sessions
				// without a row: every path but the defect runs before the live
				// runner ('s', updated at 1), and the row-less defect runs last.
				for (const [index, runner] of Object.values(runners).entries()) {
					if (runner.sessionId !== "gone" && runner !== runners.defect)
						yield* f.sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES (${runner.sessionId}, 'test-project', 'claude', 1, ${10 - index})`;
					yield* f.sql`INSERT INTO claude_runner_cursors (runner_id, sequence, session_id, driver_kind, pid, start_time, role) VALUES (${runner.runnerId}, 0, ${runner.sessionId}, 'claude', ${runner.pid}, 'original', 'serving')`;
					const socketPath = join(dirname(f.socketPath), runner.runnerId);
					writeFileSync(
						`${socketPath}.json`,
						JSON.stringify({
							driverKind: "claude",
							runnerId: runner.runnerId,
							sessionId: runner.sessionId,
							socketPath,
							buildId: runnerBuildId(),
							pid: runner.pid,
							startTime: "original",
							registeredAt: runner === runners.defect ? 0 : 10 - index,
						}),
					);
					f.processes.set(runner.pid, {
						state: "running",
						startTime: "original",
					});
					spawned.commands.set(
						String(runner.pid),
						`node runner ${socketPath} ${runner.runnerId}`,
					);
				}
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => spawned.commands.clear()),
				);
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect) return yield* Effect.die("missing connect");
				vi.mocked(f.driver.connect).mockImplementation((options) => {
					switch (options.runnerId) {
						case runners.incompatible.runnerId:
							return Effect.fail({
								...runnerFailure(
									"runner hello",
									"Runner predates run ownership",
								),
								code: "runner_incompatible",
							});
						case runners.dead.runnerId:
							f.processes.delete(runners.dead.pid);
							return Effect.fail(
								runnerFailure("connect", "runner socket gone"),
							);
						case runners.survivor.runnerId:
							return Effect.fail(
								runnerFailure("connect", "runner socket busy"),
							);
						case runners.defect.runnerId:
							return Effect.die("runner socket defect");
						default:
							return connect({
								...options,
								onHello: (hello, connection, replay) =>
									options.onHello(
										{
											...hello,
											...(options.runnerId === runners.orphan.runnerId
												? { sessionId: runners.orphan.sessionId }
												: {}),
										},
										connection,
										replay,
									),
							});
					}
				});
				const stopped = Object.values(runners).map((runner) => runner.runnerId);
				let busy = true;
				const fences = yield* failStopFences(
					f.sql,
					(runnerId) => busy && stopped.includes(String(runnerId)),
					new SqlError({
						reason: new LockTimeoutError({ cause: "database is locked" }),
					}),
				);
				const recovering = yield* f.manager.recoverEffect.pipe(
					Effect.forkChild,
				);
				yield* TestClock.adjust("10 seconds");
				// The defect still fails startup, as it did before; nothing waits on a Stop.
				expect(recovering.pollUnsafe()?._tag).toBe("Failure");
				expect(f.attachments.map((options) => options.runnerId)).toContain(
					"131313131313",
				);
				expect(new Set(fences)).toEqual(new Set(stopped));
				expect(
					yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE retired_at IS NULL ORDER BY runner_id`,
				).toEqual(
					["131313131313", ...stopped]
						.sort()
						.map((runnerId) => ({ runner_id: runnerId })),
				);
				busy = false;
				yield* TestClock.adjust("1 minute");
				expect(
					yield* f.sql`SELECT runner_id FROM claude_runner_cursors WHERE retired_at IS NULL`,
				).toEqual([{ runner_id: "131313131313" }]);
			}),
		),
);

it.effect(
	"32.29.3 R3 a rejected startup Stop fails only its runner while recovery reattaches the rest",
	() => {
		const errors: string[] = [];
		return runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture(false);
				const orphan = "515151515151";
				const rejected = "535353535353";
				yield* f.sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('c', 'test-project', 'claude', 1, 2)`;
				for (const [runnerId, sessionId, pid, registeredAt] of [
					[orphan, "gone", 100_051, 10],
					[rejected, "c", 100_053, 9],
				] as const) {
					yield* f.sql`INSERT INTO claude_runner_cursors (runner_id, sequence, session_id, driver_kind, pid, start_time, role) VALUES (${runnerId}, 0, ${sessionId}, 'claude', ${pid}, 'original', 'serving')`;
					const socketPath = join(dirname(f.socketPath), runnerId);
					writeFileSync(
						`${socketPath}.json`,
						JSON.stringify({
							driverKind: "claude",
							runnerId,
							sessionId,
							socketPath,
							buildId: runnerBuildId(),
							pid,
							startTime: "original",
							registeredAt,
						}),
					);
					f.processes.set(pid, { state: "running", startTime: "original" });
					spawned.commands.set(
						String(pid),
						`node runner ${socketPath} ${runnerId}`,
					);
				}
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => spawned.commands.clear()),
				);
				const connect = vi.mocked(f.driver.connect).getMockImplementation();
				if (!connect) return yield* Effect.die("missing connect");
				vi.mocked(f.driver.connect).mockImplementation((options) =>
					options.runnerId === rejected
						? // The row moves to another session after recover read it, so
							// the dead runner's Stop meets the identity rejection.
							f.sql`UPDATE claude_runner_cursors SET session_id = 'moved' WHERE runner_id = ${rejected}`.pipe(
								Effect.orDie,
								Effect.andThen(Effect.sync(() => f.processes.delete(100_053))),
								Effect.andThen(
									Effect.fail(runnerFailure("connect", "runner socket gone")),
								),
							)
						: connect({
								...options,
								onHello: (hello, connection, replay) =>
									options.onHello(
										{
											...hello,
											...(options.runnerId === orphan
												? { sessionId: "gone" }
												: {}),
										},
										connection,
										replay,
									),
							}),
				);
				const recovering = yield* f.manager.recoverEffect.pipe(
					Effect.forkChild,
				);
				yield* TestClock.adjust("10 seconds");
				expect(recovering.pollUnsafe()?._tag).toBe("Success");
				// Sidebar order: the session-less orphan recovers last.
				expect(
					vi
						.mocked(f.driver.connect)
						.mock.calls.map(([options]) => options.runnerId),
				).toEqual([rejected, "131313131313", orphan]);
				expect(f.attachments.map((options) => options.runnerId)).toEqual([
					"131313131313",
					orphan,
				]);
				expect(
					yield* f.sql`SELECT runner_id, session_id, retired_at IS NOT NULL AS retired FROM claude_runner_cursors ORDER BY runner_id`,
				).toEqual([
					{ runner_id: "131313131313", session_id: "s", retired: 0 },
					{ runner_id: orphan, session_id: "gone", retired: 1 },
					{ runner_id: rejected, session_id: "moved", retired: 0 },
				]);
				expect(
					f.commands.filter((command) => command.type === "shutdown"),
				).toEqual([{ runnerId: orphan, type: "shutdown" }]);
				expect(
					errors.filter((line) =>
						line.startsWith("Runner recovery stop failed"),
					),
				).toEqual([expect.stringContaining("Runner session changed")]);
			}),
		).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((options) => {
						if (options.logLevel === "Error")
							errors.push(
								`${[options.message].flat().join(" ")} ${Cause.pretty(options.cause)}`,
							);
					}),
				]),
			),
		);
	},
);

it.effect(
	"32.29.3 R3 shutdown does not log a startup Stop still committing as failed",
	() => {
		const errors: string[] = [];
		return runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture(false);
				yield* f.sql`DELETE FROM session_providers WHERE session_id = 's'`;
				yield* f.sql`DELETE FROM sessions WHERE id = 's'`;
				yield* failStopFences(
					f.sql,
					() => true,
					new SqlError({
						reason: new LockTimeoutError({ cause: "database is locked" }),
					}),
				);
				const recovering = yield* f.manager.recoverEffect.pipe(
					Effect.forkChild,
				);
				yield* TestClock.adjust("5 seconds");
				expect(recovering.pollUnsafe()?._tag).toBe("Success");
				expect(
					yield* f.sql`SELECT retired_at FROM claude_runner_cursors WHERE runner_id = '131313131313'`,
				).toEqual([{ retired_at: null }]);
			}),
		).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((options) => {
						if (options.logLevel === "Error")
							errors.push([options.message].flat().map(String).join(" "));
					}),
				]),
			),
			// The scope closed above, with the orphan's EndSession still committing.
			Effect.andThen(
				Effect.sync(() =>
					expect(
						errors.filter((line) =>
							line.startsWith("Runner recovery stop failed"),
						),
					).toEqual([]),
				),
			),
		);
	},
);

it.effect(
	"32.29.3 R1 restart reattaches the serving runner while a dead runner's Stop writes stay busy",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture(false);
				// Another session's serving row whose process is gone.
				yield* f.sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('other', 'test-project', 'claude', 1, 1)`;
				yield* f.sql`INSERT INTO claude_runner_cursors (runner_id, sequence, session_id, driver_kind, pid, start_time, role) VALUES ('242424242424', 0, 'other', 'claude', 100099, 'gone', 'serving')`;
				let busy = true;
				const fences = yield* failStopFences(
					f.sql,
					(runnerId) => busy && runnerId === "242424242424",
					new SqlError({
						reason: new LockTimeoutError({ cause: "database is locked" }),
					}),
				);
				const recovering = yield* f.manager.recoverEffect.pipe(
					Effect.forkChild,
				);
				yield* TestClock.adjust("5 seconds");
				expect(recovering.pollUnsafe()?._tag).toBe("Success");
				expect(f.attachments.map((options) => options.runnerId)).toEqual([
					"131313131313",
				]);
				// Attempts at 0 s, 1 s and 3 s; the next backoff ends at 7 s.
				expect(fences).toEqual(Array(3).fill("242424242424"));
				expect(
					yield* f.sql`SELECT retired_at FROM claude_runner_cursors WHERE runner_id = '242424242424'`,
				).toEqual([{ retired_at: null }]);
				busy = false;
				yield* TestClock.adjust("2 seconds");
				expect(fences).toHaveLength(4);
				// The landed Stop finds the process gone, settles it and prunes the row.
				expect(
					yield* f.sql`SELECT runner_id FROM claude_runner_cursors ORDER BY runner_id`,
				).toEqual([{ runner_id: "131313131313" }]);
			}),
		),
);
