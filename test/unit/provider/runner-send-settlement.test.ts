import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
} from "../../../src/lib/domain/relay/Services/input-drafts.js";
import {
	makePendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { ProviderSideEffectReactor } from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import {
	makeProcessSessionRunner,
	type ProcessRunnerDriver,
} from "../../../src/lib/provider/runner/process-session-runner.js";
import {
	type RunnerHello,
	type RunnerSocket,
	runnerBuildId,
	runnerFailure,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import {
	makeRunnerProviderInstance,
	type RunnerRecoveryDependencies,
} from "../../../src/lib/provider/runner/runner-provider-instance.js";
import { makeRunnerReceiptStore } from "../../../src/lib/provider/runner/runner-receipts.js";
import * as runnerRegistry from "../../../src/lib/provider/runner/runner-registry.js";
import { prepareRunnerDirectory } from "../../../src/lib/provider/runner/runner-registry.js";
import { RunnerSendJournal } from "../../../src/lib/provider/runner/runner-send-journal.js";
import type {
	SessionCommand,
	SessionFailure,
} from "../../../src/lib/provider/runner/session-runner.js";
import type { TurnResult } from "../../../src/lib/provider/types.js";
import {
	createMockEventSink,
	makeBaseSendTurnInput,
} from "../../helpers/mock-sdk.js";

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
			Effect.sync(() =>
				mkdtempSync(join("/private/tmp/r2-c1", "runner-settlement-")),
			),
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
		const replaySend: {
			execute?: (
				commandId: string,
				command: Extract<SessionCommand, { type: "send-turn" }>,
				attempt: number,
			) => Effect.Effect<TurnResult | undefined, SessionFailure>;
		} = {};
		const driver: ProcessRunnerDriver = {
			driverKind,
			legacyPrepareTurnEffect: (input) =>
				Effect.succeed({
					input: { ...input, prompt: input.text ?? "send", history: [] },
				}),
			connect: vi.fn<ProcessRunnerDriver["connect"]>((options) =>
				Effect.gen(function* () {
					attachments.push(options);
					const connection = {
						closed: false,
						commandEffect: (
							id: string,
							command: SessionCommand,
							attempt: number,
						) =>
							Effect.suspend(() => {
								commands.push({
									runnerId: options.runnerId,
									type: command.type,
								});
								return command.type === "send-turn"
									? (replaySend.execute?.(id, command, attempt) ??
											Effect.succeed(terminalResult()))
									: Effect.succeed(undefined);
							}),
						retireEffect: () => Effect.succeed(true),
						destroy: () => {},
						write: () => {},
					} as unknown as RunnerSocket;
					yield* options.onHello(
						{
							type: "hello",
							protocolVersion: 1,
							buildId: runnerBuildId(),
							stampsRunIds: true,
							crossAttemptNativeResumeFallback: true,
							runnerId: options.runnerId,
							sessionId: "s",
							pid: options.pid ?? 0,
							bindings: [],
							sendJournalAnswers: true,
							sendAnswers: [],
						},
						connection,
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
		const input = makeBaseSendTurnInput({
			sessionId: "s",
			workspaceRoot: root,
			extraFolders: [],
			providerState: {},
			configDir: configuredClaudeConfigDir(root),
			inputId: "input",
			account: accounts.accounts[0],
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
					Effect.succeed({
						input: { ...turn, prompt: turn.text ?? "send", history: [] },
					}),
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
		recovery = {
			projectId: "test-project",
			ingestion,
			inputDrafts: drafts,
			pending: yield* PendingInteractionServiceTag,
			persist,
			timeoutHooks: {},
			resolveCallContext: () => Effect.die("unused context"),
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
			transmission: "legacy" | "held" = "legacy",
		) =>
			Effect.gen(function* () {
				const turn = {
					...input,
					inputId: commandId,
					runId: `run:${commandId}`,
					prompt: `text ${commandId}`,
					text: `text ${commandId}`,
					history: [],
				};
				yield* sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES (${turn.runId}, 's', 'pending', 1)`;
				yield* sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, command_type, project_key, fingerprint_hash, fingerprint_version, side_effect_sequence, updated_at) VALUES (${commandId}, 's', 'side_effect_requested', 1, 'send_turn', 'test-project', 'sha256:settlement', 1, ${sequence}, 1)`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at, run_id) VALUES (${sequence}, ${commandId}, 'test-project', 's', 'account', 'send_turn', ${JSON.stringify(turn)}, ${attempt === 0 ? "pending" : "running"}, ${attempt}, 1, 1, ${turn.runId})`;
				if (attempt > 0)
					yield* commit([
						canonicalEvent(
							"run.dispatched",
							"s",
							{
								runId: turn.runId,
								runnerId,
								...(transmission === "held"
									? { commandId, transmission: 1 }
									: {}),
							},
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
							get: () => retained.sendCommands,
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
			manager,
			instance,
			input,
			replaySend,
			persist,
			ingestion,
			reactor,
			recovery,
			drafts,
			wakes,
			seed,
			hello,
			recover: instance.recoverProjectContextsEffect(() =>
				Effect.succeed(recovery),
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
		sendCommands: [],
		sendJournalAnswers: true,
		sendAnswers: [
			{
				commandId,
				attempt: 1,
				nativeResumeFallback: false,
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
	"F69 legacy replay with retryable unset fails once without replay",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("cursor");
				yield* f.seed("legacy");
				yield* f.hello(
					({
						sendJournalAnswers: _capability,
						sendAnswers: _answers,
						...hello
					}) => ({
						...hello,
						bindings: [],
						sendCommands: [],
						completedCommands: [],
					}),
				);
				let attempts = 0;
				f.replaySend.execute = () =>
					Effect.suspend(() => {
						attempts++;
						return Effect.fail({
							operation: "send-turn",
							code: "bad_configuration",
							message: "configuration rejected",
						});
					});
				yield* f.recover;
				yield* TestClock.adjust("5 seconds");
				expect(attempts).toBe(1);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "failed", error_code: "bad_configuration" }]);
				expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
					{ status: "error" },
				]);
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
						commandId: "stale",
						attempt: 1,
						nativeResumeFallback: false,
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
					commandId: "placed",
					attempt: 1,
					nativeResumeFallback: false,
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
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([]);
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "pending" },
					]);
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

it.effect(
	"legacy safe replay retains its dedup key through explicitly transient failure",
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
						sendCommands: [],
						completedCommands: [],
					}),
				);
				const attempted = yield* Deferred.make<void>();
				const keys: Array<{ commandId: string; attempt: number }> = [];
				f.replaySend.execute = (commandId, _command, attempt) =>
					Effect.gen(function* () {
						keys.push({ commandId, attempt });
						if (keys.length === 1) {
							yield* Deferred.succeed(attempted, undefined);
							return yield* Effect.fail({
								operation: "send-turn",
								code: "account_switch_busy",
								message: "busy before intake",
								retryable: true,
							});
						}
						return terminalResult();
					});
				yield* f.recover;
				yield* Deferred.await(attempted);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "running" }]);
				yield* TestClock.adjust("1 second");
				expect(keys).toEqual([
					{ commandId: "legacy-transient", attempt: 1 },
					{ commandId: "legacy-transient", attempt: 1 },
				]);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "completed" }]);
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
					yield* f.seed(
						"atomic",
						1,
						reactor ? 0 : 1,
						reactor ? "legacy" : "held",
					);
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
										commandId: "atomic",
										attempt: 1,
										nativeResumeFallback: false,
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
							"gone",
							1,
							false,
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
								"gone",
								1,
								false,
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
					"gone",
					1,
					false,
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
							"retry-wake",
							1,
							false,
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
					yield* f.seed(
						"stable",
						1,
						reactor ? 0 : 1,
						reactor ? "legacy" : "held",
					);
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
										commandId: "stable",
										attempt: 1,
										nativeResumeFallback: false,
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
	"reactor recall of an unheld send retains processing-timeout evidence across rollback",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* s7Fixture("claude");
				yield* f.seed("recall", 1, 0);
				yield* f.recover;
				const enteredHold = yield* Deferred.make<void>();
				const fault = yield* failSettlementWrite(f.sql, enteredHold);
				const sending = yield* f.reactor.runOnce().pipe(Effect.forkChild);
				yield* Deferred.await(enteredHold);
				yield* TestClock.adjust("2 minutes");
				yield* Deferred.await(fault.entered);
				yield* TestClock.adjust(0);
				expect(
					yield* f.sql`SELECT status, runner_id FROM provider_runs`,
				).toEqual([{ status: "pending", runner_id: null }]);
				expect(
					yield* f.sql`SELECT status FROM provider_command_outbox`,
				).toEqual([{ status: "running" }]);
				fault.recover();
				yield* TestClock.adjust("2 seconds");
				expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
				expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
					{ status: "error" },
				]);
				expect(
					yield* f.sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "failed", error_code: "processing_timeout" }]);
				expect(
					yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
				).toEqual([{ type: "turn.error" }]);
				expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
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
						commandId: "corrupt",
						attempt: 1,
						nativeResumeFallback: false,
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
					commandId: "legacy",
					attempt: 1,
					nativeResumeFallback: false,
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

const failSessionStore = (
	sql: SqlClient.SqlClient,
	operation: "read" | "register",
) =>
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
					const selected =
						operation === "read"
							? query.includes(
									"SELECT joined_into, runner_id, held_transmission",
								)
							: query.includes("INSERT INTO claude_runner_cursors") &&
								query.includes("role");
					if (selected) {
						attempts++;
						if (unavailable)
							return Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(
									Effect.fail(
										new SqlError({
											reason: new ConnectionError({
												cause: `injected ${operation} unavailable`,
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

for (const operation of ["read", "register"] as const)
	it.effect(
		`F79 unavailable ${operation} retries its owned store operation without a new process or claim`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* s7Fixture("claude");
					yield* f.seed("store", 1, 0);
					if (operation === "read") yield* f.recover;
					f.replaySend.execute = () =>
						Effect.succeed(
							terminalResult("error", {
								code: "final",
								message: "final reply",
							}),
						);
					const fault = yield* failSessionStore(f.sql, operation);
					const sending = yield* f.reactor.runOnce().pipe(Effect.forkChild);
					yield* Deferred.await(fault.entered);
					yield* TestClock.adjust(0);
					expect(
						yield* f.sql`SELECT status, runner_id FROM provider_runs`,
					).toEqual([{ status: "pending", runner_id: null }]);
					expect(
						yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox`,
					).toEqual([{ status: "running", attempt_count: 1 }]);
					expect(
						yield* f.sql`SELECT type FROM events WHERE type IN ('turn.completed', 'turn.error', 'turn.interrupted')`,
					).toEqual([]);
					expect(f.commands.filter((c) => c.type === "send-turn")).toEqual([]);
					const starts = spawned.spawn.mock.calls.length;
					expect(starts).toBe(operation === "read" ? 0 : 1);
					fault.recover();
					yield* TestClock.adjust("1 second");
					expect(sending.pollUnsafe()).toMatchObject({ _tag: "Success" });
					expect(fault.attempts()).toBe(2);
					expect(spawned.spawn).toHaveBeenCalledTimes(starts);
					expect(f.commands.filter((c) => c.type === "send-turn")).toHaveLength(
						1,
					);
					expect(
						yield* f.sql`SELECT status, attempt_count FROM provider_command_outbox`,
					).toEqual([{ status: "failed", attempt_count: 1 }]);
					expect(yield* f.sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "error" },
					]);
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
