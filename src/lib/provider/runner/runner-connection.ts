import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createConnection } from "node:net";
import { Deferred, Effect, Semaphore } from "effect";
import { DEFAULT_AUTO_SETTLE_AFTER_DAYS } from "../../daemon/config-persistence.js";
import { observeTurnTimelineFrame } from "../../domain/daemon/Services/turn-timeline.js";
import * as Failure from "../../effect/failure-classification.js";
import { isRecord } from "../../utils.js";
import type { SendToken } from "../run-ledger/run-ledger-model.js";
import { isLegacyRunner } from "./runner-legacy-classification.js";
import {
	RUNNER_PROTOCOL_VERSION,
	type RunnerMessage,
	RunnerSocket,
	type RunnerWireCodec,
	runnerBuildId,
	runnerFailure,
	runnerHelloFailure,
	type ServerMarkInput,
	type ServerMarkResult,
	type ThreadReadInput,
	type ThreadReadResult,
} from "./runner-protocol.js";
import {
	currentRunnerOutput,
	type makeRunnerReceiptStore,
} from "./runner-receipts.js";
import type { RunnerUpgradeState } from "./runner-upgrade.js";
import type {
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
} from "./session-runner.js";

type ReceiptStore = Effect.Success<ReturnType<typeof makeRunnerReceiptStore>>;

const REPLAY_INACTIVITY_TIMEOUT_MS = 30_000;

/** Verify a discovered runner's identity and protocol before attaching. */
export const connectRunner = (options: {
	readonly socketPath: string;
	readonly sessionId: string;
	readonly runnerId: string;
	readonly pid?: number;
	readonly helloTimeoutMs?: number;
	/** Orphan retirement verifies identity without replaying absent history. */
	readonly identityOnly?: true;
	readonly driverKind?: string;
	readonly cursorBackendUrl?: import("../cursor/cursor-credential.js").CursorBackendUrl;
	readonly wire?: RunnerWireCodec;
	readonly readThread?: (
		sessionId: string,
		input: ThreadReadInput,
	) => Effect.Effect<ThreadReadResult>;
	/** 8.7 Declared from an agent's tool call: this runner's session is the caller. */
	readonly markServer?: (
		sessionId: string,
		input: ServerMarkInput,
	) => Effect.Effect<ServerMarkResult, unknown>;
	readonly deps: {
		readonly workspaceRoot: string;
		readonly daemonConfigDir?: string;
		readonly accounts?: Effect.Effect<
			import("../../account-directory.js").AccountsState
		>;
		readonly claudeLaunchConfig?:
			| import("../claude/claude-sdk-env.js").ClaudeLaunchConfig
			| null;
		readonly autoSettleAfterDays?:
			| Effect.Effect<number | null | undefined>
			| undefined;
		readonly extraFolders?: readonly string[];
		readonly subagentPollTimeoutMs?: number;
	};
	readonly receipts?: ReceiptStore;
	readonly checkpoint?: (
		op: Effect.Effect<void, SessionFailure>,
	) => Effect.Effect<boolean, SessionFailure>;
	readonly runFork: (effect: Effect.Effect<void>) => unknown;
	readonly emit: (
		output: SessionOutput,
		sessionId: string,
	) => Effect.Effect<SessionOutputReply, SessionFailure>;
	readonly onHello: (
		hello: Extract<RunnerMessage, { readonly type: "hello" }>,
		connection: RunnerSocket,
		replay?: Effect.Effect<void, SessionFailure>,
	) => Effect.Effect<void, SessionFailure>;
	readonly onClose: (failure: SessionFailure) => void;
	readonly onIdleExit?: () => void;
	readonly onCommandAccepted?: (sinkId: string) => void;
	readonly onCommandReply?: (
		reply: Extract<RunnerMessage, { readonly type: "command-reply" }>,
	) => Effect.Effect<void, SessionFailure>;
	readonly onCommandsSettled?: (tokens: readonly SendToken[]) => void;
	readonly onUpgradeState?: (state: RunnerUpgradeState) => void;
	readonly onOutputCommitted?: (output: SessionOutput) => void;
}) =>
	Effect.gen(function* () {
		const autoSettleAfterDays = options.deps.autoSettleAfterDays
			? yield* options.deps.autoSettleAfterDays.pipe(
					Effect.map((days) =>
						days === undefined ? DEFAULT_AUTO_SETTLE_AFTER_DAYS : days,
					),
				)
			: undefined;
		const outputLock = yield* Semaphore.make(1);
		const helloRestored = yield* Deferred.make<void, SessionFailure>();
		const attachmentId = randomUUID();
		let acknowledged = 0;
		let lastReply: SessionOutputReply = {};
		let heldAck = false;
		return yield* Effect.callback<RunnerSocket, SessionFailure>((resume) => {
			let settled = false;
			let active = true;
			let receivedSequence = 0;
			const outputWaiters = new Set<{
				sequence: number;
				complete: () => void;
			}>();
			const releaseOutputWaiters = () => {
				for (const waiter of outputWaiters) {
					if (!active || acknowledged >= waiter.sequence) {
						outputWaiters.delete(waiter);
						waiter.complete();
					}
				}
			};
			const beforeCommandFailure = () => {
				const sequence = receivedSequence;
				return Effect.callback<void>((resume) => {
					if (!active || acknowledged >= sequence) {
						resume(Effect.void);
						return;
					}
					const waiter = { sequence, complete: () => resume(Effect.void) };
					outputWaiters.add(waiter);
					return Effect.sync(() => {
						outputWaiters.delete(waiter);
					});
				});
			};
			let greeted = false;
			let replayRequested = false;
			let replayed:
				| ((effect: Effect.Effect<void, SessionFailure>) => void)
				| undefined;
			let replayTimer: ReturnType<typeof setTimeout> | undefined;
			let replayCommittedSequence = 0;
			let resyncScheduled = false;
			let resyncFailures = 0;
			const socket = createConnection(options.socketPath);
			const finish = (effect: Effect.Effect<RunnerSocket, SessionFailure>) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				clearTimeout(replayTimer);
				replayTimer = undefined;
				resume(effect);
			};
			const resetReplayTimeout = () => {
				clearTimeout(replayTimer);
				replayTimer = setTimeout(() => {
					finish(
						Effect.fail(
							runnerFailure("runner replay", "Runner replay made no progress"),
						),
					);
					connection.destroy();
				}, REPLAY_INACTIVITY_TIMEOUT_MS);
			};
			const replayOutputCommitted = (sequence: number) => {
				if (replayTimer === undefined || sequence <= replayCommittedSequence)
					return;
				replayCommittedSequence = sequence;
				resetReplayTimeout();
			};
			const timer = setTimeout(() => {
				finish(
					Effect.fail(
						runnerFailure("runner hello", "Runner handshake timed out"),
					),
				);
				connection.destroy();
			}, options.helloTimeoutMs ?? 2000);
			const connection = new RunnerSocket(
				socket,
				(message) => {
					if (message.type === "upgrade-state") {
						// The runner writes this state after its retained replay frames.
						// Wait for their durable boundary, including receipt-failure retries.
						const completeReplay = replayed;
						replayed = undefined;
						completeReplay?.(beforeCommandFailure());
						options.onUpgradeState?.(message.state);
						return;
					}
					if (message.type === "idle-exit") {
						options.onIdleExit?.();
						connection.write({ type: "idle-exit-ack" });
						return;
					}
					if (message.type === "command-accepted") {
						options.onCommandAccepted?.(message.sinkId);
						return;
					}
					if (message.type === "settled-commands-ack") {
						options.onCommandsSettled?.(message.tokens);
						return;
					}
					if (message.type === "refused") {
						finish(Effect.fail(message.failure));
						options.onClose(message.failure);
						connection.destroy();
						return;
					}
					if (message.type === "hello") {
						if (greeted) return;
						const helloFailure = runnerHelloFailure(
							message,
							"runner",
							options.driverKind ?? "claude",
							options.cursorBackendUrl,
						);
						if (
							helloFailure ||
							message.runnerId !== options.runnerId ||
							message.sessionId !== options.sessionId ||
							(options.pid !== undefined && message.pid !== options.pid)
						) {
							finish(
								Effect.fail(
									helloFailure ??
										runnerFailure(
											"runner hello",
											"Runner identity/protocol/build mismatch",
										),
								),
							);
							connection.destroy();
							return;
						}
						greeted = true;
						clearTimeout(timer);
						options.runFork(
							Effect.gen(function* () {
								const cursor = options.receipts
									? yield* options.receipts
											.attach(options.runnerId, attachmentId, {
												sessionId: options.sessionId,
												pid: message.pid ?? options.pid,
												driverKind:
													message.driverKind ?? options.driverKind ?? "claude",
												journalsBeforeExecution: !isLegacyRunner(message),
											})
											.pipe(
												Effect.mapError((cause) =>
													runnerFailure("attach runner", cause),
												),
											)
									: { sequence: 0, result: {} };
								acknowledged = cursor.sequence;
								lastReply = cursor.result;
								const restored = options.receipts
									? {
											runnerId: options.runnerId,
											sequence: acknowledged,
											attachmentId,
											committed: yield* Deferred.make<void>(),
											consumed: true,
										}
									: undefined;
								if (restored)
									yield* Deferred.succeed(restored.committed, undefined);
								// Restored interaction fibers inherit the new attachment's fence,
								// without advancing an output sequence already acknowledged.
								yield* options
									.onHello(
										{ ...message, acknowledgedSequence: acknowledged },
										connection,
										Effect.callback<void, SessionFailure>((resume) => {
											replayRequested = true;
											replayed = resume;
											replayCommittedSequence = acknowledged;
											resetReplayTimeout();
											connection.write({
												type: "replay",
												acknowledgedSequence: acknowledged,
											});
										}).pipe(
											Effect.ensuring(
												Effect.sync(() => {
													clearTimeout(replayTimer);
													replayTimer = undefined;
													replayed = undefined;
												}),
											),
										),
									)
									.pipe(Effect.provideService(currentRunnerOutput, restored));
							}).pipe(
								Effect.matchCauseEffect({
									onFailure: (cause) =>
										Effect.gen(function* () {
											const failure = runnerFailure(
												"restore runner",
												Failure.squashCause(cause),
											);
											yield* Deferred.fail(helloRestored, failure);
											finish(Effect.fail(failure));
											connection.destroy();
										}),
									onSuccess: () =>
										Effect.gen(function* () {
											yield* Deferred.succeed(helloRestored, undefined);
											releaseOutputWaiters();
											if (!replayRequested && !options.identityOnly)
												connection.write({
													type: "replay",
													acknowledgedSequence: acknowledged,
												});
											finish(Effect.succeed(connection));
										}),
								}),
							),
						);
					} else if (message.type === "command-reply" && greeted) {
						// Ordinary requests consume their own replies in RunnerSocket. A
						// retained send has no waiter after reconnect, but still owns a row.
						const precedingOutput = beforeCommandFailure();
						options.runFork(
							Effect.gen(function* () {
								yield* Deferred.await(helloRestored);
								yield* precedingOutput;
								if (active)
									yield* options.onCommandReply?.(message) ?? Effect.void;
							}).pipe(
								Effect.catchCause((cause) =>
									Effect.sync(() => {
										if (!active) return;
										const failure = runnerFailure(
											"settle runner reply",
											Failure.squashCause(cause),
										);
										finish(Effect.fail(failure));
										options.onClose(failure);
										connection.destroy();
									}),
								),
							),
						);
					} else if (message.type === "thread-read" && greeted) {
						options.runFork(
							(options.readThread
								? options.readThread(options.sessionId, message.input)
								: Effect.succeed({
										code: "ServerUnavailable",
										message: "Conduit history is unavailable.",
									})
							).pipe(
								Effect.matchCause({
									onFailure: () =>
										connection.write({
											type: "thread-read-reply",
											requestId: message.requestId,
											result: {
												code: "ServerUnavailable",
												message:
													"Conduit could not read this session's history.",
											},
										}),
									onSuccess: (result) =>
										connection.write({
											type: "thread-read-reply",
											requestId: message.requestId,
											result,
										}),
								}),
							),
						);
					} else if (message.type === "server-mark" && greeted) {
						const unavailable: ServerMarkResult = {
							ok: false,
							reason: "Conduit could not mark the server",
						};
						options.runFork(
							(
								options.markServer?.(options.sessionId, message.input) ??
								Effect.succeed(unavailable)
							).pipe(
								Effect.tapCause((cause) =>
									Effect.logWarning(
										`Server mark failed: ${Failure.renderCause(cause)}`,
									),
								),
								Effect.matchCause({
									onFailure: () => unavailable,
									onSuccess: (result) => result,
								}),
								Effect.map((result) =>
									connection.write({
										type: "server-mark-reply",
										requestId: message.requestId,
										result,
									}),
								),
							),
						);
					} else if (message.type === "output") {
						observeTurnTimelineFrame(message.output);
						if (
							message.sequence !== undefined &&
							Number.isSafeInteger(message.sequence) &&
							message.sequence >= 1
						)
							receivedSequence = Math.max(receivedSequence, message.sequence);
						let replied = false;
						const reply = (result: SessionOutputReply) => {
							if (replied || !active) return;
							replied = true;
							if (
								!heldAck &&
								process.env["NODE_ENV"] === "test" &&
								(message.output.type ===
									process.env["CONDUIT_TEST_HOLD_RUNNER_ACK"] ||
									(message.output.type === "event" &&
										message.output.event.type ===
											process.env["CONDUIT_TEST_HOLD_RUNNER_ACK"]))
							) {
								heldAck = true;
								return;
							}
							connection.write({
								type: "output-reply",
								outputId: message.outputId,
								sequence: message.sequence,
								result,
							});
						};
						options.runFork(
							outputLock
								.withPermits(1)(
									Effect.gen(function* () {
										if (!active) return {};
										const sequence = message.sequence;
										if (
											sequence === undefined ||
											!Number.isSafeInteger(sequence) ||
											sequence < 1
										)
											return yield* Effect.fail(
												runnerFailure(
													"runner output",
													"Missing runner sequence",
												),
											);
										if (sequence <= acknowledged) {
											return sequence === acknowledged ? lastReply : {};
										}
										if (sequence !== acknowledged + 1)
											return yield* Effect.fail(
												runnerFailure(
													"runner output",
													"Non-contiguous runner output",
												),
											);
										const committed = yield* Deferred.make<void>();
										if (
											process.env["NODE_ENV"] === "test" &&
											process.env["CONDUIT_TEST_HOLD_RUNNER_OUTPUT"] ===
												message.output.type
										) {
											const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
											if (proof)
												appendFileSync(
													proof,
													`${JSON.stringify({ kind: "held-output", type: message.output.type, sequence })}\n`,
												);
											yield* Effect.never;
										}
										const receipt = {
											runnerId: options.runnerId,
											sequence,
											attachmentId,
											committed,
											ownedRunId:
												message.output.type === "event" &&
												message.output.event.type === "run.started"
													? message.output.event.runId
													: undefined,
											consumed: false,
											onCommitted: () => {
												// Durable terminal state must survive publication failure.
												replayOutputCommitted(sequence);
												options.onOutputCommitted?.(message.output);
												if (
													message.output.type === "event" &&
													message.output.event.type === "turn.completed"
												) {
													// The SDK may settle the completed turn once its event and
													// cursor are durable; publication still holds outputLock.
													acknowledged = sequence;
													lastReply = {};
													releaseOutputWaiters();
													reply({});
												}
											},
										};
										// 2.1 row 215: a wake's evidence is labelled by its runner and the
										// querySeq the host stamped on its frame (6.1).
										const output =
											message.output.type === "event" &&
											(message.output.event.type === "evidence.turn_started" ||
												message.output.event.type === "evidence.turn_ended")
												? {
														...message.output,
														event: {
															...message.output.event,
															data: {
																...(isRecord(message.output.event.data)
																	? message.output.event.data
																	: {}),
																label: `${options.runnerId}:${message.querySeq ?? 0}`,
															},
														},
													}
												: message.output;
										const result = yield* options
											.emit(output, options.sessionId)
											.pipe(
												Effect.provideService(
													currentRunnerOutput,
													options.receipts ? receipt : undefined,
												),
											);
										if (options.receipts) {
											// Interaction routing forks its waiter. Wait for the ask's actual
											// durable commit before acknowledging that output.
											if (
												message.output.type === "permission-request" ||
												message.output.type === "question-request"
											)
												yield* Deferred.await(committed);
											if (!receipt.consumed) {
												const checkpoint = options.receipts
													.acknowledge(
														options.runnerId,
														sequence,
														result,
														attachmentId,
													)
													.pipe(
														Effect.mapError((cause) =>
															runnerFailure("acknowledge runner", cause),
														),
													);
												const checkpointed = yield* options.checkpoint?.(
													checkpoint,
												) ?? checkpoint.pipe(Effect.as(true));
												if (!checkpointed)
													return yield* Effect.fail(
														runnerFailure(
															"acknowledge runner",
															"Runner checkpoint refused",
														),
													);
											}
										}
										replayOutputCommitted(sequence);
										acknowledged = sequence;
										lastReply = result;
										return result;
									}),
								)
								.pipe(
									Effect.matchCauseEffect({
										onFailure: (cause) =>
											Effect.suspend(() => {
												if (
													!active ||
													resyncScheduled ||
													Failure.isInterruptedOnly(cause)
												)
													return Effect.void;
												// Keep the runner's waiter pending and replay from the durable
												// boundary. Coalesce failures and back off persistent write errors.
												resyncScheduled = true;
												const delay = Math.min(
													1000,
													25 * 2 ** Math.min(resyncFailures++, 6),
												);
												return Effect.sleep(delay).pipe(
													Effect.andThen(
														Effect.sync(() => {
															resyncScheduled = false;
															if (active)
																connection.write({
																	type: "replay",
																	acknowledgedSequence: acknowledged,
																});
														}),
													),
												);
											}),
										onSuccess: (result) =>
											Effect.sync(() => {
												resyncFailures = 0;
												releaseOutputWaiters();
												reply(result);
											}),
									}),
								),
						);
					}
				},
				(failure) => {
					active = false;
					options.runFork(
						Deferred.fail(helloRestored, failure).pipe(Effect.asVoid),
					);
					replayed?.(Effect.fail(failure));
					replayed = undefined;
					releaseOutputWaiters();
					finish(Effect.fail(failure));
					options.onClose(failure);
				},
				beforeCommandFailure,
				options.wire,
			);
			socket.once("connect", () =>
				connection.write({
					type: "hello",
					// Runner builds predating driverKind were all Claude.
					driverKind: options.driverKind ?? "claude",
					protocolVersion:
						process.env["NODE_ENV"] === "test" &&
						process.env["CONDUIT_TEST_SERVER_PROTOCOL_VERSION"]
							? Number(process.env["CONDUIT_TEST_SERVER_PROTOCOL_VERSION"])
							: RUNNER_PROTOCOL_VERSION,
					buildId: runnerBuildId(),
					taggedConfigDir: true,
					attachmentRefs: true,
					acknowledgedSequence: acknowledged,
					config: {
						workspaceRoot: options.deps.workspaceRoot,
						extraFolders: options.deps.extraFolders ?? [],
						autoSettleAfterDays,
						...(options.deps.claudeLaunchConfig !== undefined
							? { claudeLaunchConfig: options.deps.claudeLaunchConfig }
							: {}),
						...(options.deps.daemonConfigDir !== undefined
							? { daemonConfigDir: options.deps.daemonConfigDir }
							: {}),
						...(options.deps.subagentPollTimeoutMs !== undefined
							? { subagentPollTimeoutMs: options.deps.subagentPollTimeoutMs }
							: {}),
					},
				}),
			);
			return Effect.sync(() => {
				clearTimeout(timer);
				clearTimeout(replayTimer);
				connection.destroy();
			});
		});
	});
