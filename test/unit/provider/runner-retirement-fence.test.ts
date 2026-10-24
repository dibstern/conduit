import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { sessionPickEvents } from "../../../src/lib/domain/relay/Services/session-pick.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { STOP_ABORT_WAIT_MS } from "../../../src/lib/provider/orchestration-command-contracts.js";
import {
	makeProcessSessionRunner,
	type ProcessRunnerDriver,
} from "../../../src/lib/provider/runner/process-session-runner.js";
import {
	type RunnerSocket,
	runnerBuildId,
	runnerFailure,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import { currentRunnerOutput } from "../../../src/lib/provider/runner/runner-receipts.js";
import {
	discoverAllRunners,
	prepareRunnerDirectory,
} from "../../../src/lib/provider/runner/runner-registry.js";
import type {
	SessionFailure,
	SessionOutput,
} from "../../../src/lib/provider/runner/session-runner.js";
import { makeSessionBackgroundLiveness } from "../../../src/lib/session/background-liveness.js";

const spawned = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: spawned.spawn,
}));

const retirementFixture = (recover = true) =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.sync(() => mkdtempSync(join(tmpdir(), "runner-cleanup-fence-"))),
			(path) =>
				Effect.sync(() => rmSync(path, { recursive: true, force: true })),
		);
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('s', 'test-project', 'claude', 1, 1)`;
		const runnerId = "131313131313";
		const pid = 100_088;
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
		const processes = new Map([
			[pid, { state: "running" as const, startTime: "original" }],
		]);
		const childProcesses = new Map<number, EventEmitter>();
		spawned.spawn.mockImplementation(() => {
			const child = Object.assign(new EventEmitter(), {
				pid: 100_020,
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
		const pending = yield* Deferred.make<never, SessionFailure>();
		const sending = yield* Deferred.make<void>();
		const destroyed = vi.fn();
		const commands: Array<{ runnerId: string; type: string }> = [];
		const replacementGate = { hold: false };
		const replacementConnecting = yield* Deferred.make<void>();
		const replacementReady = yield* Deferred.make<void>();
		const driver: ProcessRunnerDriver = {
			driverKind: "claude",
			connect: vi.fn<ProcessRunnerDriver["connect"]>((options) =>
				Effect.gen(function* () {
					attachments.push(options);
					if (options.runnerId !== runnerId && replacementGate.hold) {
						yield* Deferred.succeed(replacementConnecting, undefined);
						yield* Deferred.await(replacementReady);
					}
					const connection = {
						closed: false,
						commandEffect: (_id: string, command: { readonly type: string }) =>
							Effect.suspend(() => {
								commands.push({
									runnerId: options.runnerId,
									type: command.type,
								});
								return command.type === "send-turn" &&
									options.runnerId === runnerId
									? Deferred.succeed(sending, undefined).pipe(
											Effect.andThen(Deferred.await(pending)),
										)
									: Effect.void;
							}),
						retireEffect: () => Effect.succeed(true),
						destroy: () => destroyed(options.runnerId),
						write: () => {},
					} as unknown as RunnerSocket;
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
									? [{ sinkId: "retained", sessionId: "s" }]
									: [],
							sendCommands: [],
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
			recoverCommands: () => Effect.succeed([]),
		};
		const outputs: SessionOutput[] = [];
		const retained = new Set(["retained"]);
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
		const processTable = {
			inspect: (pid: number) =>
				processes.get(pid) ?? { state: "gone" as const },
			signal: () => {},
		};
		const manager = yield* makeProcessSessionRunner(
			{
				daemonConfigDir: root,
				projectRootForSession: () => Effect.succeed(root),
				processTable,
			},
			output,
			driver,
		);
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
			input,
			attachments,
			pending,
			sending,
			destroyed,
			commands,
			replacementGate,
			replacementConnecting,
			replacementReady,
			outputs,
			retained,
			background,
			output,
		};
	});

const runRetirement = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
	const persistence = makePersistenceEffectLayer(":memory:", "test-project");
	return Effect.scoped(effect).pipe(
		Effect.provide(
			Layer.merge(
				persistence,
				ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
			),
		),
	);
};

for (const blocked of [
	"sql",
	"receipt",
	"release-sink",
	"background-task",
] as const) {
	it.effect(
		`bounds retirement waiting for ${blocked} before releasing admission`,
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* retirementFixture();
					const old = f.attachments[0];
					if (!old?.receipts)
						return yield* Effect.fail(
							runnerFailure("test", "No receipt store"),
						);
					const entered = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					const attach = old.receipts.attach;
					if (blocked === "sql" || blocked === "receipt")
						vi.spyOn(old.receipts, "attach").mockImplementation((...args) =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(
									blocked === "receipt" ? Deferred.await(release) : Effect.void,
								),
								Effect.andThen(attach(...args)),
							),
						);
					else {
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
					}
					const locked = yield* Deferred.make<void>();
					if (blocked === "sql") {
						yield* Effect.forkChild(
							f.sql.withTransaction(
								Deferred.succeed(locked, undefined).pipe(
									Effect.andThen(Deferred.await(release)),
								),
							),
						);
						yield* Deferred.await(locked);
					}
					yield* Effect.gen(function* () {
						const stopping = yield* Effect.forkChild(
							f.manager.executeEffect({ type: "end-session", sessionId: "s" }),
						);
						yield* TestClock.adjust("4 seconds");
						yield* Deferred.await(entered);
						yield* TestClock.adjust(STOP_ABORT_WAIT_MS);
						const completedWhileBlocked = stopping.pollUnsafe() !== undefined;
						yield* Deferred.succeed(release, undefined);
						yield* Fiber.await(stopping);
						expect(completedWhileBlocked).toBe(true);
						expect(existsSync(`${f.socketPath}.retired`)).toBe(true);
						expect(
							yield* f.manager.hasLiveProcessEffect("s", old.runnerId),
						).toBe(false);
					}).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
				}),
			),
	);
}

it.effect(
	"bounds a masked retirement settlement and rejects its delayed commit",
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
				yield* f.sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES ('old-run', 's', 'running', 1)`;
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
					const stopping = yield* Effect.forkChild(
						f.manager.executeEffect({ type: "end-session", sessionId: "s" }),
					);
					yield* TestClock.adjust("4 seconds");
					yield* Deferred.await(entered);
					yield* TestClock.adjust("1 second");
					const completedWhileBlocked = stopping.pollUnsafe() !== undefined;
					yield* Deferred.succeed(release, undefined);
					yield* Deferred.await(finished);
					yield* Fiber.await(stopping);
					expect(completedWhileBlocked).toBe(true);
					expect(
						yield* f.sql`SELECT event_id FROM events WHERE session_id = 's'`,
					).toEqual([]);
					expect(
						yield* f.sql`SELECT status FROM provider_runs WHERE id = 'old-run'`,
					).toEqual([{ status: "running" }]);
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
										sendCommands: [{ commandId: "old-command", attempt: 1 }],
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
					else yield* f.sql`DROP TABLE provider_runs`;
					const stopping = yield* Effect.forkChild(
						f.manager.executeEffect({ type: "end-session", sessionId: "s" }),
					);
					yield* TestClock.adjust("4 seconds");
					yield* Fiber.await(stopping);
					expect(existsSync(`${f.socketPath}.retired`)).toBe(true);
					expect(discoverAllRunners(f.root, f.processTable)).toMatchObject([
						{ role: "retired" },
					]);
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
			`fences subagent persistence after retirement when receipt fencing ${fencing}, ${boundary}`,
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
						yield* Fiber.await(stopping);
						expect(existsSync(`${f.socketPath}.retired`)).toBe(true);
						yield* Deferred.succeed(release, undefined);
						yield* Fiber.await(output);
						expect(
							yield* f.sql`SELECT id FROM sessions WHERE id = 'retired-child'`,
						).toEqual([]);
						expect(
							yield* f.sql`SELECT event_id FROM events WHERE session_id = 'retired-child'`,
						).toEqual([]);
					}),
				),
		);
	}
}

it.effect(
	"finishes durable retirement before interrupted recovery releases admission",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture(false);
				const lastAttempt = yield* Deferred.make<void>();
				const failConnect = yield* Deferred.make<void>();
				const locked = yield* Deferred.make<void>();
				const unlock = yield* Deferred.make<void>();
				const retiring = yield* Deferred.make<void>();
				let attempts = 0;
				vi.mocked(f.driver.connect).mockImplementation((options) =>
					Effect.gen(function* () {
						if (++attempts === 5) {
							if (!options.receipts)
								return yield* Effect.fail(
									runnerFailure("test", "No receipt store"),
								);
							const attach = options.receipts.attach;
							vi.spyOn(options.receipts, "attach").mockImplementation(
								(...args) =>
									Deferred.succeed(retiring, undefined).pipe(
										Effect.andThen(attach(...args)),
									),
							);
							yield* Deferred.succeed(lastAttempt, undefined);
							yield* Deferred.await(failConnect);
						}
						return yield* Effect.fail(
							runnerFailure("test connect", "Unreachable survivor"),
						);
					}),
				);
				const recovering = yield* Effect.forkChild(f.manager.recoverEffect);
				yield* TestClock.adjust("1500 millis");
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
					yield* Deferred.await(retiring);
					recovering.interruptUnsafe();
					yield* TestClock.adjust(0);
					const releasedWhileBlocked = f.outputs.some(
						(output) =>
							output.type === "background-task" &&
							output.transition.kind === "session-ended",
					);
					yield* Deferred.succeed(unlock, undefined);
					yield* Fiber.join(transaction);
					yield* Fiber.await(recovering);
					expect(releasedWhileBlocked).toBe(false);
					expect(existsSync(`${f.socketPath}.retired`)).toBe(true);
					expect(discoverAllRunners(f.root, f.processTable)).toMatchObject([
						{ role: "retired" },
					]);
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

it.effect(
	"fences a cancelled warming candidate while its stop is pending",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture(false);
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
													if (hello.pid !== undefined) {
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
				yield* Deferred.await(warmed);
				const candidate = f.attachments[1];
				if (!candidate)
					return yield* Effect.fail(
						runnerFailure("test", "No candidate attachment"),
					);
				const task: SessionOutput = {
					type: "background-task",
					transition: {
						sessionId: "s",
						kind: "snapshot",
						tasks: [
							{ id: "active", type: "local_bash", description: "Active task" },
						],
					},
				};
				yield* candidate.emit(task, "s");
				expect(f.background.backgroundOf("s")?.tasks[0]?.id).toBe("active");
				yield* old.emit(task, "s");
				const sending = yield* Effect.forkChild(
					f.manager.executeEffect({
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
				f.processes.delete(100_088);
				yield* Deferred.fail(
					f.pending,
					runnerFailure("test", "Finish test send"),
				);
				yield* Fiber.await(sending);
				yield* TestClock.adjust("4 seconds");
				expect(staleOutputs).toEqual([]);
				expect(background?.tasks[0]?.id).toBe("active");
				expect(owner).toBe(old.runnerId);
			}),
		),
);

it.effect(
	"fences superseded upgrade output while preserving warming candidate output",
	() =>
		runRetirement(
			Effect.gen(function* () {
				const f = yield* retirementFixture(false);
				const shutdownEntered = yield* Deferred.make<void>();
				const releaseShutdown = yield* Deferred.make<void>();
				const shutdownEmitted = yield* Deferred.make<void>();
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
				yield* Deferred.await(shutdownEntered);
				expect(f.background.backgroundOf("s")?.tasks[0]?.id).toBe("warming");
				const replacement = f.attachments[1];
				if (!replacement)
					return yield* Effect.fail(
						runnerFailure("test", "No replacement attachment"),
					);
				yield* f.manager.executeEffect({
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
				f.outputs.length = 0;
				yield* Deferred.succeed(releaseShutdown, undefined);
				yield* Deferred.await(shutdownEmitted);
				yield* TestClock.adjust(0);
				expect(f.outputs).toEqual([
					{ type: "release-sink", sinkId: "retained" },
				]);
				expect(f.retained.has("retained")).toBe(false);
				expect(f.background.backgroundOf("s")?.tasks[0]?.id).toBe("new");
				expect(f.retained.has("new-sink")).toBe(true);
				const commandsBeforeReleasedAbort = f.commands.length;
				yield* f.manager.executeEffect({ type: "abort", sinkId: "retained" });
				expect(f.commands).toHaveLength(commandsBeforeReleasedAbort);
				yield* f.manager.executeEffect({ type: "abort", sinkId: "new-sink" });
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
			? "finishes retirement cleanup before admitting a replacement"
			: pendingReplacement
				? "preserves cancellation of a replacement awaiting readiness"
				: "drops stranded send cleanup after a replacement starts",
		() =>
			runRetirement(
				Effect.gen(function* () {
					const f = yield* retirementFixture();
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
						f.manager
							.executeEffect({
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
							f.manager
								.executeEffect({
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
								f.manager
									.executeEffect({
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
						yield* f.manager.executeEffect({
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
						const aborting = yield* Effect.forkChild(
							f.manager.executeEffect({ type: "abort", sinkId: "old-sink" }),
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
					expect(admittedBeforeCleanup).toBe(false);
					expect(f.outputs).toEqual(
						blockedRetirement
							? []
							: [{ type: "release-sink", sinkId: "block" }],
					);
					expect(f.background.backgroundOf("s")).toMatchObject({
						tasks: [{ id: "new" }],
					});
					expect(
						yield* f.manager.hasLiveProcessEffect("s", replacement.runnerId),
					).toBe(true);
					expect(f.retained.has("old-sink")).toBe(true);
					yield* f.manager.executeEffect({ type: "abort", sinkId: "old-sink" });
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
									sendCommands: [],
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
					recoverCommands: () => Effect.succeed([]),
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
