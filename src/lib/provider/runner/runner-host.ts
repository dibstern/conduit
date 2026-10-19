import { appendFileSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { Deferred, Effect, FiberSet, Scope } from "effect";
import * as Failure from "../../effect/failure-classification.js";
import { createLogger } from "../../logger.js";
import type { TurnResult } from "../types.js";
import { makeRunnerIdleExit } from "./runner-idle.js";
import {
	RUNNER_PROTOCOL_VERSION,
	type RunnerHello,
	RunnerSocket,
	type RunnerWireCodec,
	runnerBuildId,
	runnerFailure,
	runnerHelloFailure,
	runnerIdleFailure,
} from "./runner-protocol.js";
import { registerRunner, removeRunner } from "./runner-registry.js";
import { RunnerSendJournal } from "./runner-send-journal.js";
import { RunnerSpool } from "./runner-spool.js";
import type { RunnerUpgradeState } from "./runner-upgrade.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionRunner,
} from "./session-runner.js";

export interface RunnerLaunchCallbacks {
	readonly sessionId: string;
	readonly runFork: (effect: Effect.Effect<void>) => unknown;
	readonly stateChanged: () => void;
	/** Fence admission before a payload publishes its final turn outcome. */
	readonly retireAfterCommand?: (inputId: string) => void;
	readonly isCandidate: () => boolean;
	readonly turnStateChanged: (inFlight: boolean) => void;
	readonly readThread: RunnerSocket["threadReadEffect"];
}

export interface RunnerLaunch {
	/** Retire a poisoned payload after delivering its command result. */
	readonly shouldExitAfterCommand?: (
		command: SessionCommand,
		result: TurnResult | undefined,
	) => boolean;
	readonly wire?: RunnerWireCodec;
	readonly capabilities?: Pick<RunnerHello, "stopsTasks" | "taggedConfigDir">;
	readonly makeRunner: (
		config: NonNullable<RunnerHello["config"]>,
		emit: (
			output: SessionOutput,
		) => Effect.Effect<SessionOutputReply, SessionFailure>,
	) => Effect.Effect<SessionRunner, never, Scope.Scope>;
	readonly upgradeState: () => Omit<
		RunnerUpgradeState,
		"quiescent" | "revision"
	>;
	readonly acceptCommand: (command: SessionCommand) => void;
	readonly executeEffect: (
		runner: SessionRunner,
		command: SessionCommand,
	) => Effect.Effect<TurnResult | undefined, SessionFailure>;
}

const log = createLogger("session-runner");

export const runSessionRunner = (
	driverKind: string,
	makeLaunch: (
		callbacks: RunnerLaunchCallbacks,
	) => Effect.Effect<RunnerLaunch, SessionFailure>,
) =>
	Effect.gen(function* () {
		const socketPath = process.argv[2];
		const sessionId = process.argv[3];
		const runnerId = process.argv[4];
		if (!socketPath || !sessionId || !runnerId || !process.send)
			return yield* Effect.die("Runner requires a socket path and parent IPC");
		const stopped = yield* Deferred.make<void>();
		const scope = yield* Effect.scope;
		const runFork = yield* FiberSet.makeRuntime<never, void, never>();
		let attached = false;
		let exiting = false;
		let retiring = false;
		let retirementInputId: string | undefined;
		let role: "candidate" | "retiring" | undefined =
			process.argv[5] === "upgrade" ? "candidate" : undefined;
		const register = () =>
			registerRunner({
				socketPath,
				sessionId,
				runnerId,
				driverKind,
				buildId: runnerBuildId(),
				pid: process.pid,
				...(role ? { role } : {}),
			});
		let connection: RunnerSocket | undefined;
		let idle: ReturnType<typeof makeRunnerIdleExit> | undefined;
		let exitDeadline: ReturnType<typeof setTimeout> | undefined;
		const beginExit = () => {
			if (exiting) return;
			exiting = true;
			idle?.close();
			// Neither an absent server acknowledgement nor SDK disposal can hold exit.
			exitDeadline = setTimeout(() => {
				removeRunner(socketPath);
				process.exit(0);
			}, 2000);
			exitDeadline.unref();
			if (connection) connection.write({ type: "idle-exit" });
			else finishExit();
		};
		function finishExit() {
			const delay =
				process.env["NODE_ENV"] === "test"
					? Number(process.env["CONDUIT_TEST_RUNNER_IDLE_EXIT_DELAY_MS"] ?? 0)
					: 0;
			runFork(
				Effect.sleep(delay).pipe(
					Effect.andThen(Deferred.succeed(stopped, undefined)),
					Effect.asVoid,
				),
			);
		}
		let runner: SessionRunner | undefined;
		let sendJournal: RunnerSendJournal | undefined;
		let initializing = false;
		const spool = new RunnerSpool(`${socketPath}.spool`);
		let backgroundSnapshot:
			| Extract<SessionOutput, { type: "background-task" }>
			| undefined;
		let activeCommands = 0;
		let activeOutputs = 0;
		let revision = 0;
		let reportedQuiescent: boolean | undefined;
		let reportedSnapshot: RunnerUpgradeState["snapshot"];
		let reportedResume: string | undefined;
		let reportedConfiguration: RunnerUpgradeState["liveConfiguration"];
		const quiescent = () =>
			!exiting &&
			retirementInputId === undefined &&
			!retiring &&
			activeCommands === 0 &&
			activeOutputs === 0 &&
			!runner?.hasPendingSubagentFinalizers?.(sessionId) &&
			idle?.quiescent === true;
		const upgradeState = (): RunnerUpgradeState => ({
			quiescent: quiescent(),
			revision,
			...launch.upgradeState(),
		});
		const reportUpgradeState = () => {
			const { snapshot, resumeSessionId, liveConfiguration, frozen } =
				launch.upgradeState();
			const quiet = quiescent();
			if (
				quiet === reportedQuiescent &&
				snapshot === reportedSnapshot &&
				resumeSessionId === reportedResume &&
				liveConfiguration === reportedConfiguration
			)
				return;
			reportedQuiescent = quiet;
			const changedSnapshot = snapshot !== reportedSnapshot;
			reportedSnapshot = snapshot;
			reportedResume = resumeSessionId;
			reportedConfiguration = liveConfiguration;
			revision++;
			if (attached)
				connection?.write({
					type: "upgrade-state",
					state: {
						quiescent: quiet,
						revision,
						...(changedSnapshot && snapshot ? { snapshot } : {}),
						...(resumeSessionId ? { resumeSessionId } : {}),
						...(liveConfiguration ? { liveConfiguration } : {}),
						...(frozen ? { frozen: true } : {}),
					},
				});
		};
		const launch = yield* makeLaunch({
			sessionId,
			runFork,
			stateChanged: reportUpgradeState,
			retireAfterCommand: (inputId) => {
				retirementInputId = inputId;
			},
			isCandidate: () => role === "candidate",
			turnStateChanged: (inFlight) => {
				idle?.setTurnInFlight(inFlight);
				reportUpgradeState();
			},
			readThread: (input) =>
				connection && attached && !connection.closed
					? connection.threadReadEffect(input)
					: Effect.fail(runnerFailure("read thread", "Runner is disconnected")),
		});
		const bindings = new Map<
			string,
			{
				sessionId: string;
				commandId?: string;
				attempt?: number;
				fallback?: boolean;
				providerRunId?: string;
			}
		>();
		const commands = new Map<
			string,
			Deferred.Deferred<TurnResult | undefined, SessionFailure>
		>();
		const completedCommands = new Map<
			string,
			{ commandId: string; result?: TurnResult; failure?: SessionFailure }
		>();
		const server = createServer((socket) => {
			if (connection) {
				socket.destroy();
				return;
			}
			let greeted = false;
			const peer = new RunnerSocket(
				socket,
				(message) => {
					if (message.type === "idle-exit-ack" && exiting) {
						finishExit();
						return;
					}
					if (message.type === "hello") {
						const failure = exiting
							? runnerIdleFailure()
							: (runnerHelloFailure(message, "server", driverKind) ??
								(greeted || initializing || !message.config
									? runnerFailure(
											"runner hello",
											"Runner refused invalid or repeated server hello",
										)
									: undefined));
						if (failure) {
							log.error(failure.message);
							peer.refuse(failure);
							return;
						}
						initializing = true;
						const config = message.config;
						if (!config) return;
						runFork(
							Effect.gen(function* () {
								if (!runner) {
									sendJournal = yield* Effect.try({
										try: () =>
											new RunnerSendJournal(
												dirname(socketPath),
												sessionId,
												driverKind,
											),
										catch: (cause) => runnerFailure("open runner sends", cause),
									});
									runner = yield* launch
										.makeRunner(config, (output) => {
											if (output.type === "background-task") {
												backgroundSnapshot =
													output.transition.kind === "snapshot" &&
													output.transition.tasks.length > 0
														? output
														: undefined;
											}
											idle?.activity(output);
											activeOutputs++;
											reportUpgradeState();
											const binding =
												"sinkId" in output
													? bindings.get(output.sinkId)
													: undefined;
											const runId =
												output.type === "event"
													? output.event.providerRefs.providerTurnId
													: undefined;
											const recordRun =
												runId &&
												binding?.commandId &&
												sendJournal &&
												binding.providerRunId !== runId
													? sendJournal
															.reportProviderRun(
																binding.commandId,
																binding.attempt ?? 0,
																binding.fallback === true,
																runId,
															)
															.pipe(
																Effect.tap(() =>
																	Effect.sync(() => {
																		binding.providerRunId = runId;
																	}),
																),
															)
													: Effect.void;
											return recordRun.pipe(
												Effect.andThen(spool.emit(output)),
												Effect.ensuring(
													Effect.sync(() => {
														activeOutputs--;
														reportUpgradeState();
													}),
												),
											);
										})
										.pipe(Effect.provideService(Scope.Scope, scope));
									const testIdle =
										process.env["NODE_ENV"] === "test"
											? process.env["CONDUIT_TEST_RUNNER_IDLE_MS"]
											: undefined;
									idle = makeRunnerIdleExit(
										beginExit,
										testIdle === "null"
											? null
											: testIdle !== undefined
												? Number(testIdle)
												: undefined,
										process.env["NODE_ENV"] === "test" &&
											process.env["CONDUIT_TEST_RUNNER_IDLE_DAY_MS"]
											? Number(process.env["CONDUIT_TEST_RUNNER_IDLE_DAY_MS"])
											: undefined,
										config.daemonConfigDir,
										() =>
											retiring ||
											activeCommands > 0 ||
											activeOutputs > 0 ||
											runner?.hasPendingSubagentFinalizers?.(sessionId) ===
												true ||
											spool.hasHeldWork,
									);
								}
								if (
									process.env["NODE_ENV"] === "test" &&
									process.env["CONDUIT_TEST_RUNNER_HELLO_DELAY_MS"]
								) {
									process.send?.({
										channel: "conduit-process-test",
										kind: "runner-hello-pending",
										pid: process.pid,
									});
									yield* Effect.sleep(
										Number(process.env["CONDUIT_TEST_RUNNER_HELLO_DELAY_MS"]),
									);
								}
								idle?.activity();
								greeted = true;
								peer.write({
									type: "hello",
									protocolVersion:
										process.env["NODE_ENV"] === "test" &&
										process.env["CONDUIT_TEST_RUNNER_HELLO_VERSION"]
											? Number(process.env["CONDUIT_TEST_RUNNER_HELLO_VERSION"])
											: RUNNER_PROTOCOL_VERSION,
									buildId: runnerBuildId(),
									runnerId,
									driverKind,
									sessionId,
									pid: process.pid,
									bindings: [...bindings].map(([sinkId, binding]) => ({
										sinkId,
										sessionId: binding.sessionId,
										...(binding.commandId
											? { commandId: binding.commandId }
											: {}),
									})),
									pendingOutputs: spool.pendingOutputs,
									completedCommands: [...completedCommands.values()],
									sendCommands: sendJournal?.commands ?? [],
									upgradeState: upgradeState(),
									...launch.capabilities,
								});
								initializing = false;
							}).pipe(
								Effect.catch((failure) =>
									Effect.sync(() => {
										initializing = false;
										peer.refuse(failure);
									}),
								),
							),
						);
					} else if (message.type === "replay") {
						if (
							!greeted ||
							!Number.isSafeInteger(message.acknowledgedSequence) ||
							message.acknowledgedSequence < 0
						) {
							peer.destroy();
							return;
						}
						const firstAttachment = !attached;
						attached = true;
						if (retiring && !message.preserveRole) {
							retiring = false;
							role = undefined;
							register();
						}
						spool.attach(peer, message.acknowledgedSequence);
						// The server lost its in-memory level state, even for acked outputs.
						// Replay the current snapshot after the backlog, with a fresh sequence.
						// Receipt-failure retries on this connection only need the backlog.
						if (firstAttachment)
							runFork(
								Effect.suspend(() =>
									backgroundSnapshot
										? spool.emit(backgroundSnapshot)
										: Effect.void,
								).pipe(Effect.orDie),
							);
						reportedQuiescent = undefined;
						reportUpgradeState();
					} else if (message.type === "output-reply") {
						spool.reply(message);
						reportUpgradeState();
					} else if (
						message.type === "settled-commands" &&
						greeted &&
						sendJournal
					) {
						const journal = sendJournal;
						runFork(
							Effect.try({
								try: () => {
									const records = journal.acknowledge(message.commands);
									const proof =
										process.env["NODE_ENV"] === "test"
											? process.env["CONDUIT_TEST_PROCESS_PROOF"]
											: undefined;
									if (proof && records.length)
										appendFileSync(
											proof,
											`${JSON.stringify({ kind: "runner-send-pruned", sessionId, records })}\n`,
										);
									peer.write({
										type: "settled-commands-ack",
										commands: message.commands,
									});
								},
								catch: (cause) => runnerFailure("prune runner sends", cause),
							}).pipe(
								Effect.catch((failure) => Effect.logWarning(failure.message)),
							),
						);
					} else if (message.type === "upgrade-retire") {
						const ready =
							greeted &&
							attached &&
							message.revision === revision &&
							quiescent();
						if (ready) {
							retiring = true;
							role = "retiring";
							register();
						}
						peer.write({
							type: "upgrade-reply",
							requestId: message.requestId,
							result: ready,
						});
					} else if (message.type === "upgrade-cancel") {
						retiring = false;
						role = undefined;
						register();
						reportUpgradeState();
					} else if (message.type === "upgrade-activate") {
						role = undefined;
						register();
					} else if (message.type === "command" && runner) {
						const command = message.command;
						if (exiting || retirementInputId !== undefined) {
							peer.write({
								type: "command-reply",
								commandId: message.commandId,
								failure: runnerIdleFailure(),
							});
							return;
						}
						// Retirement is a reservation until the server commits its route.
						// A command selected on the old route cancels it without waiting.
						if (retiring && command.type !== "shutdown") {
							retiring = false;
							role = undefined;
							register();
						}
						if (command.type === "send-turn") {
							peer.write({
								type: "command-accepted",
								commandId: message.commandId,
								sinkId: command.sinkId,
							});
							idle?.beginTurn();
						}
						idle?.activity();
						activeCommands++;
						const deduplicationKey = `${message.commandId}:${message.attempt ?? 0}${command.type === "send-turn" && command.input.nativeResumeFallback ? ":native-resume-fallback" : ""}`;
						launch.acceptCommand(command);
						if (command.type === "send-turn") {
							const binding = bindings.get(command.sinkId);
							if (
								binding?.commandId !== message.commandId ||
								binding.attempt !== (message.attempt ?? 0) ||
								binding.fallback !==
									(command.input.nativeResumeFallback === true)
							)
								bindings.set(command.sinkId, {
									sessionId: command.input.sessionId,
									commandId: message.commandId,
									attempt: message.attempt ?? 0,
									fallback: command.input.nativeResumeFallback === true,
								});
						}
						reportUpgradeState();
						if (process.env["NODE_ENV"] === "test" && process.connected)
							process.send?.({
								channel: "conduit-process-test",
								kind: "runner-command",
								commandId: message.commandId,
								type: command.type,
							});
						runFork(
							Effect.gen(function* () {
								const existing = commands.get(deduplicationKey);
								if (existing) return yield* Deferred.await(existing);
								const result = yield* Deferred.make<
									TurnResult | undefined,
									SessionFailure
								>();
								commands.set(deduplicationKey, result);
								if (!runner)
									return yield* Effect.die("Runner is not initialized");
								const execution = launch.executeEffect(runner, command);
								const exit = yield* Effect.exit(
									command.type === "send-turn" && sendJournal
										? sendJournal.execute(
												message.commandId,
												message.attempt ?? 0,
												command.input.nativeResumeFallback === true,
												execution,
											)
										: execution,
								);
								yield* Deferred.done(result, exit);
								return yield* Deferred.await(result);
							}).pipe(
								Effect.ensuring(
									Effect.sync(() => {
										if (command.type === "send-turn") idle?.endTurn();
										activeCommands--;
										reportUpgradeState();
									}),
								),
								Effect.matchCauseEffect({
									onFailure: (cause) =>
										Effect.sync(() => {
											completedCommands.set(message.commandId, {
												commandId: message.commandId,
												failure: runnerFailure(
													command.type,
													Failure.squashCause(cause),
												),
											});
											connection?.write({
												type: "command-reply",
												commandId: message.commandId,
												failure: runnerFailure(
													command.type,
													Failure.squashCause(cause),
												),
											});
											if (
												command.type === "send-turn" &&
												command.input.inputId === retirementInputId
											)
												beginExit();
										}),
									onSuccess: (result) =>
										Effect.gen(function* () {
											if (command.type === "shutdown")
												yield* spool
													.drainEffect()
													.pipe(Effect.timeout("500 millis"), Effect.ignore);
											completedCommands.set(message.commandId, {
												commandId: message.commandId,
												...(result ? { result } : {}),
											});
											reportUpgradeState();
											connection?.write({
												type: "command-reply",
												commandId: message.commandId,
												...(result ? { result } : {}),
											});
											if (
												(command.type === "send-turn" &&
													command.input.inputId === retirementInputId) ||
												launch.shouldExitAfterCommand?.(command, result)
											)
												beginExit();
											if (command.type === "shutdown")
												runFork(
													Deferred.succeed(stopped, undefined).pipe(
														Effect.asVoid,
													),
												);
										}),
								}),
							),
						);
					}
				},
				() => {
					spool.disconnect(peer);
					if (connection === peer) {
						attached = false;
						connection = undefined;
						if (exiting) finishExit();
					}
				},
				undefined,
				launch.wire,
			);
			connection = peer;
		});
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				idle?.close();
				clearTimeout(exitDeadline);
				connection?.destroy();
				server.close();
				removeRunner(socketPath);
			}),
		);
		yield* Effect.tryPromise(
			() =>
				new Promise<void>((done, fail) => {
					server.once("error", fail);
					server.listen(socketPath, () => {
						chmodSync(socketPath, 0o600);
						done();
					});
				}),
		);
		register();
		process.send({
			channel: `conduit-${driverKind}-runner`,
			type: "listening",
		});
		yield* Deferred.await(stopped);
	});
