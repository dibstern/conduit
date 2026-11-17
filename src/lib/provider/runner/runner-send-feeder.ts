import {
	type Clock,
	Deferred,
	Effect,
	Exit,
	FiberSet,
	Option,
	PubSub,
	Semaphore,
} from "effect";
import type { SqlClient } from "effect/sql";
import * as Failure from "../../effect/failure-classification.js";
import type { CommitAndSignal } from "../../persistence/effect/commit-and-signal.js";
import { recordClaudeNativeResumeFallback } from "../claude/prepare-turn.js";
import { isClaudeResumeRefused } from "../event-sink-errors.js";
import { runSendCommandIdQuery } from "../session-run-settlement.js";
import type { ProviderNativeSession, TurnResult } from "../types.js";
import type {
	Held,
	Hold,
	OwnerSend,
	ProcessRunnerDeps,
	ProcessRunnerDriver,
	RunRelease,
	WritePermission,
} from "./process-runner-types.js";
import type { makeRunnerDispatch } from "./runner-dispatch.js";
import type { RunnerChild } from "./runner-entry-lifecycle.js";
import {
	runnerCommandReplied,
	runnerDeliveryEvidence,
	runnerFailure,
	runnerSinkId,
} from "./runner-protocol.js";
import {
	currentPendingSendOwner,
	runnerCommandEnded,
	runningRunnerCommands,
} from "./runner-recovery.js";
import type {
	makeRunnerRetirement,
	makeRunnerRunLifecycle,
} from "./runner-retirement.js";
import type { makeRunnerSends } from "./runner-sends.js";
import { CANCELLED_TURN, type makeRunnerStarter } from "./runner-starter.js";
import { replayStoredSend } from "./runner-stored-send.js";
import type { SendScope } from "./send-scope.js";
import {
	classify,
	retrySettlementWrite,
	type SendEvidence,
	type StoreFault,
	sendRetryBackoff,
	terminalFailureResult,
	terminalTurnResult,
} from "./send-settlement.js";
import type { SessionCommand, SessionFailure } from "./session-runner.js";

type Transmit = (
	held: Held,
	permission: WritePermission,
) => Effect.Effect<TurnResult | undefined, SessionFailure>;
interface Capability {
	readonly input: OwnerSend;
	readonly ended: Deferred.Deferred<void, SessionFailure>;
	live?:
		| {
				readonly transmit: Transmit;
				readonly nativeResumeFallback: boolean;
				readonly close: Effect.Effect<void>;
				readonly reply: Deferred.Deferred<
					TurnResult | undefined,
					SessionFailure
				>;
		  }
		| undefined;
}

/** The queue owns wakes; the ledger owns whether any wake may transmit. */
export const makeRunnerSendFeeder = (options: {
	readonly hold: (input: OwnerSend) => Effect.Effect<Hold, StoreFault>;
	readonly start: (
		input: OwnerSend,
	) => Effect.Effect<"Started", SessionFailure>;
	readonly release: (input: RunRelease) => Effect.Effect<void, SessionFailure>;
	/** Settles the send as failed; a held send is released in the same commit. */
	readonly failed: (
		input: OwnerSend,
		failure: SessionFailure,
		held?: Held,
	) => Effect.Effect<void, SessionFailure>;
	readonly awaitRun: (
		input: OwnerSend,
		includeCoverage?: boolean,
	) => Effect.Effect<void, StoreFault>;
	readonly clean: (runner: string) => Effect.Effect<void, StoreFault>;
	readonly park: (predecessor: {
		readonly runner: string;
		readonly until: number;
	}) => Effect.Effect<void, SessionFailure>;
	/** The gate's own stored transmission, for a send with no live caller. */
	readonly transmitAdopted: (
		input: OwnerSend,
		held: Held,
		permission: WritePermission,
	) => Effect.Effect<TurnResult | undefined, SessionFailure>;
	/** The ledger's current hold for a run, set inside the hold's commit. */
	readonly currentHold: (run: OwnerSend) => number | undefined;
	/** The write gate (4.4), read in the write's synchronous step. */
	readonly gate: {
		readonly write: (
			run: OwnerSend,
			transmission: number,
			take: () => boolean,
			refusal: () => RunRelease["refusalReason"],
		) => boolean;
		readonly reopened: (
			run: OwnerSend,
			transmission: number,
		) => Effect.Effect<boolean>;
	};
	readonly releases: PubSub.PubSub<RunRelease>;
}) =>
	Effect.gen(function* () {
		// Subscribed before any hold or recovery can release, and closed after
		// the fibers below, so no release published while they run is missed.
		const released = yield* PubSub.subscribe(options.releases);
		const runFork = yield* FiberSet.makeRuntime<never, void, never>();
		// Entries retain only caller/I/O capabilities, never dispatch or run status.
		const capabilities = new Map<string, Capability>();
		const queues = new Map<string, Set<Capability>>();
		const key = (input: OwnerSend) =>
			JSON.stringify([input.sessionId, input.runId, input.commandId]);
		const release = (input: RunRelease) =>
			retrySettlementWrite(Effect.suspend(() => options.release(input)));
		const capability = (input: OwnerSend) => {
			const id = key(input);
			const current = capabilities.get(id);
			if (current) return current;
			const item: Capability = {
				input,
				ended: Deferred.makeUnsafe<void, SessionFailure>(),
			};
			capabilities.set(id, item);
			runFork(
				Effect.gen(function* () {
					const ended = yield* Effect.exit(
						retrySettlementWrite(options.awaitRun(input)),
					);
					if (Exit.isSuccess(ended)) {
						if (capabilities.get(id) === item) capabilities.delete(id);
						if (item.live) {
							const reply = yield* Deferred.poll(item.live.reply);
							const result = Option.isSome(reply)
								? yield* Effect.exit(reply.value)
								: undefined;
							if (
								!result ||
								Exit.isFailure(result) ||
								result.value?.status !== "completed"
							)
								yield* item.live.close;
						}
						yield* Deferred.succeed(item.ended, undefined);
					} else if (!Failure.isInterruptedOnly(ended.cause)) {
						yield* Deferred.fail(
							item.ended,
							runnerFailure("await owner run", ended.cause),
						);
						yield* Effect.logWarning(
							"Owner run observation failed",
							ended.cause,
						);
					}
				}),
			);
			return item;
		};

		type Wake = {
			readonly ready: Effect.Effect<
				{ readonly started: boolean; readonly ordinal: number } | undefined,
				SessionFailure | StoreFault
			>;
		};
		const step = (
			item: Capability,
			started: boolean,
			ordinal: number,
		): Effect.Effect<Wake | undefined, SessionFailure | StoreFault> =>
			Effect.gen(function* () {
				const result = yield* Effect.result(options.hold(item.input));
				if (result._tag === "Failure") {
					if (result.failure._tag === "StoreRejected")
						return yield* result.failure;
					return {
						ready: Effect.sleep(sendRetryBackoff(ordinal + 1)).pipe(
							Effect.as({ started, ordinal: ordinal + 1 }),
						),
					};
				}
				const hold = result.success;
				switch (hold._tag) {
					case "Busy":
					case "Covered":
					case "Exhausted":
					case "Ended":
						return;
					case "Cleaning":
						// An unavailable cleanup waits one backoff, then steps the gate again.
						// Cleaning is never StartLost, so a later Unserved read starts afresh.
						return {
							ready: Effect.raceFirst(
								options.clean(hold.runner).pipe(
									Effect.as({ started: false, ordinal: 0 }),
									Effect.catchTag("StoreUnavailable", () =>
										Effect.sleep(sendRetryBackoff(ordinal + 1)).pipe(
											Effect.as({ started: false, ordinal: ordinal + 1 }),
										),
									),
								),
								retrySettlementWrite(options.awaitRun(item.input, true)).pipe(
									Effect.as({ started: false, ordinal: 0 }),
								),
							),
						};
					case "Unserved": {
						if (Option.isSome(hold.predecessor))
							return {
								ready: Effect.raceFirst(
									options.park(hold.predecessor.value),
									retrySettlementWrite(options.awaitRun(item.input, true)),
								).pipe(Effect.as({ started: false, ordinal: 0 })),
							};
						if (started) {
							yield* options.failed(item.input, {
								operation: "start runner",
								code: "runner_start_lost",
								message: "Runner exited before accepting the send",
							});
							return;
						}
						return {
							ready: Effect.gen(function* () {
								const start = yield* Effect.raceFirst(
									Effect.result(options.start(item.input)),
									retrySettlementWrite(options.awaitRun(item.input, true)).pipe(
										Effect.as(undefined),
									),
								);
								if (!start) return { started: false, ordinal: 0 };
								if (start._tag === "Failure") {
									const live = item.live;
									// 3.11: a spawn its project's removal cut short is not sent; its
									// caller writes nothing and tries again, meeting the project gate.
									if (start.failure.code === "not_sent" && live) {
										item.live = undefined;
										yield* Deferred.fail(live.reply, start.failure);
									} else yield* options.failed(item.input, start.failure);
									return;
								}
								return { started: true, ordinal: 0 };
							}),
						};
					}
					case "Held": {
						if (options.currentHold(item.input) !== hold.transmission) return;
						const consumed = Deferred.makeUnsafe<void>();
						const live = item.live;
						const permission: WritePermission = {
							write: (refusal) =>
								options.gate.write(
									item.input,
									hold.transmission,
									() => Deferred.doneUnsafe(consumed, Effect.void),
									refusal,
								),
							consume: () =>
								options.currentHold(item.input) === hold.transmission &&
								Deferred.doneUnsafe(consumed, Effect.void),
							// Coverage's take ends the wait: that write never happens.
							reopened: Effect.suspend(() =>
								Deferred.isDoneUnsafe(consumed)
									? Effect.succeed(false)
									: options.gate.reopened(item.input, hold.transmission),
							),
						};
						runFork(
							Effect.gen(function* () {
								const sent = yield* Effect.exit(
									Effect.gen(function* () {
										// A Stop accepted before the first byte takes the write permission,
										// so the hold is released unwritten (4.5 NotSent) and steps to Covered.
										// Once either side takes the permission the coverage read stops. A
										// faulted read takes nothing: the transmission writes normally and a
										// later Stop is answered at the host (4.6 refusal or turn interrupt).
										const reply = yield* Effect.result(
											Effect.raceFirst(
												live
													? live.transmit(hold, permission)
													: options.transmitAdopted(
															item.input,
															hold,
															permission,
														),
												Effect.exit(
													Effect.raceFirst(
														retrySettlementWrite(
															options.awaitRun(item.input, true),
														),
														Deferred.await(consumed),
													),
												).pipe(
													Effect.flatMap((covered) =>
														Exit.isFailure(covered)
															? Effect.logWarning(
																	"Owner send coverage read failed",
																	{ runId: item.input.runId },
																	covered.cause,
																).pipe(Effect.andThen(Effect.never))
															: permission.consume()
																? Effect.fail({
																		...runnerFailure(
																			"send-turn",
																			"Run ended before write",
																		),
																		delivery: { _tag: "NotSent" as const },
																	})
																: Effect.never,
													),
												),
											),
										);
										if (reply._tag === "Failure") {
											const evidence = runnerDeliveryEvidence(reply.failure);
											if (isClaudeResumeRefused(reply.failure)) {
												yield* release({
													...item.input,
													runnerId: hold.runner,
													transmission: hold.transmission,
													reason: "ResumeRejected",
												});
												if (live)
													yield* Deferred.fail(live.reply, reply.failure);
											} else if (evidence) {
												yield* release({
													...item.input,
													runnerId: hold.runner,
													transmission: hold.transmission,
													reason: evidence._tag,
													...(evidence._tag === "Refused"
														? { refusalReason: evidence.reason }
														: {}),
												});
											} else if (
												reply.failure.code === "send_admission_timeout"
											)
												yield* options.failed(item.input, reply.failure, hold);
											else if (runnerCommandReplied(reply.failure) && live)
												yield* Deferred.fail(live.reply, reply.failure);
											else if (
												reply.failure.code === "runner_detached" &&
												live
											) {
												// Detachment is no outcome (4.7). It ends this daemon's
												// live call so the caller hands the send to the next
												// attachment, as on main.
												if (item.live === live) item.live = undefined;
												yield* Deferred.fail(live.reply, reply.failure);
											}
											return;
										}
										if (
											reply.success?.nativeResumeRejected ||
											isClaudeResumeRefused(reply.success?.error)
										)
											yield* release({
												...item.input,
												runnerId: hold.runner,
												transmission: hold.transmission,
												reason: "ResumeRejected",
											});
										if (live)
											yield* Deferred.succeed(live.reply, reply.success);
										// A joined steer's retryable reply leaves its command open, so after the
										// backoff the feeder holds it again from its stored send as its next
										// transmission; any other send's Run ends on it, and with it this
										// capability (CONTRACT 1864-1873, 2021-2025, 2667).
										const result = terminalTurnResult(reply.success);
										if (
											result &&
											classify({ _tag: "replied", result }) === "retryable"
										) {
											yield* Effect.sleep(sendRetryBackoff(hold.transmission));
											if (capabilities.get(key(item.input)) === item) {
												if (item.live === live) item.live = undefined;
												enqueueCapability(item);
											}
										}
									}),
								);
								if (
									Exit.isFailure(sent) &&
									!Failure.isInterruptedOnly(sent.cause)
								) {
									if (live)
										yield* Deferred.done(
											live.reply,
											Exit.failCause(
												Failure.mapFailures(sent.cause, (cause) =>
													runnerFailure("owner send write", cause),
												),
											),
										);
									yield* Effect.logWarning(
										"Owner send write failed",
										sent.cause,
									);
								}
							}),
						);
						return;
					}
				}
			});
		const enqueueCapability = (item: Capability): void => {
			const existing = queues.get(item.input.sessionId);
			if (existing) {
				existing.add(item);
				return;
			}
			const pending = new Set([item]);
			queues.set(item.input.sessionId, pending);
			runFork(
				Effect.gen(function* () {
					let head:
						| {
								readonly item: Capability;
								readonly started: boolean;
								readonly ordinal: number;
						  }
						| undefined;
					while (true) {
						const next = head?.item ?? pending.values().next().value;
						if (!next) {
							if (queues.get(item.input.sessionId) === pending)
								queues.delete(item.input.sessionId);
							return;
						}
						pending.delete(next);
						const result = yield* Effect.exit(
							Effect.gen(function* () {
								const wake = yield* step(
									next,
									head?.started ?? false,
									head?.ordinal ?? 0,
								);
								return wake ? yield* wake.ready : undefined;
							}).pipe(
								Effect.mapError((cause) =>
									runnerFailure("owner send step", cause),
								),
							),
						);
						head = undefined;
						if (Exit.isFailure(result)) {
							if (Failure.isInterruptedOnly(result.cause)) {
								// No loop drains this queue once interrupted (closing only).
								if (queues.get(item.input.sessionId) === pending)
									queues.delete(item.input.sessionId);
								return yield* Effect.interrupt;
							}
							if (next.live)
								yield* Deferred.failCause(next.live.reply, result.cause);
							yield* Effect.logWarning("Owner send step failed", result.cause);
						} else if (result.value) head = { item: next, ...result.value };
					}
				}),
			);
		};
		runFork(
			Effect.forever(
				Effect.gen(function* () {
					const input = yield* PubSub.take(released);
					const item = capability(input);
					if (input.reason !== "ResumeRejected") enqueueCapability(item);
				}),
			),
		);
		return {
			enqueue: (input: OwnerSend) =>
				Effect.sync(() => enqueueCapability(capability(input))),
			send: (
				input: OwnerSend,
				transmit: Transmit,
				nativeResumeFallback = input.nativeResumeFallback === true,
				close: Effect.Effect<void> = Effect.void,
			) =>
				Effect.suspend(() => {
					const item = capability(input);
					if (
						!item.live ||
						item.live.nativeResumeFallback !== nativeResumeFallback
					) {
						item.live = {
							transmit,
							nativeResumeFallback,
							close,
							reply: Deferred.makeUnsafe<
								TurnResult | undefined,
								SessionFailure
							>(),
						};
					}
					enqueueCapability(item);
					const live = item.live;
					return Effect.raceFirst(
						Deferred.await(live.reply),
						Deferred.await(item.ended).pipe(Effect.as(undefined)),
					).pipe(
						Effect.onInterrupt(() =>
							Effect.sync(() => {
								if (item.live === live) item.live = undefined;
							}),
						),
					);
				}),
		};
	});

interface RunnerSendGateOptions {
	readonly deps: ProcessRunnerDeps;
	readonly driver: ProcessRunnerDriver;
	readonly clock: Clock.Clock;
	readonly sql: SqlClient.SqlClient | undefined;
	readonly sends: ReturnType<typeof makeRunnerSends>;
	readonly stops: Pick<
		Effect.Success<ReturnType<typeof makeRunnerRetirement>>,
		| "awaitRun"
		| "clean"
		| "closing"
		| "currentHold"
		| "gate"
		| "holdRun"
		| "park"
		| "refuse"
		| "release"
		| "releases"
	>;
	readonly dispatch: ReturnType<typeof makeRunnerDispatch>["dispatch"];
	readonly startStored: Effect.Success<
		ReturnType<typeof makeRunnerStarter>
	>["startStored"];
	readonly sessionCommit: (sessionId: string) => Effect.Effect<
		{
			readonly commit: Pick<CommitAndSignal, "write">;
			readonly lifecycle: Pick<
				ReturnType<typeof makeRunnerRunLifecycle>,
				"releaseRun"
			>;
		},
		unknown
	>;
	readonly settleObservedSend: (
		evidence: SendEvidence,
	) => Effect.Effect<void, StoreFault>;
	readonly pauseSend: (
		point: "before-hold" | "after-hold" | "after-release",
		input: {
			readonly sessionId: string;
			readonly runId: string;
			readonly commandId: string;
			readonly runnerId?: string;
			readonly transmission?: number;
		},
	) => Effect.Effect<void>;
	readonly nativeSession: (
		sessionId: string,
	) => Effect.Effect<ProviderNativeSession | undefined>;
}

/** The send gate: admits each owner send to the feeder and owns its stored transmission. */
export const makeRunnerSendGate = (options: RunnerSendGateOptions) =>
	Effect.gen(function* () {
		const {
			deps,
			driver,
			clock,
			sql,
			sends,
			stops,
			dispatch,
			startStored,
			sessionCommit,
			settleObservedSend,
			pauseSend,
			nativeSession,
		} = options;
		function submit(
			command: Extract<SessionCommand, { type: "send-turn" }>,
			send: SendScope,
			recovered?: RunnerChild,
		): Effect.Effect<TurnResult, SessionFailure>;
		function submit(
			command: Exclude<SessionCommand, { type: "send-turn" }>,
			send?: SendScope,
			recovered?: RunnerChild,
		): Effect.Effect<void, SessionFailure>;
		function submit(
			command: SessionCommand,
			send: SendScope,
			recovered?: RunnerChild,
		): Effect.Effect<TurnResult | undefined, SessionFailure>;
		function submit(
			command: SessionCommand,
			send?: SendScope,
			recovered?: RunnerChild,
		): Effect.Effect<TurnResult | undefined, SessionFailure> {
			if (command.type !== "send-turn")
				return dispatch(command, send, recovered).pipe(Effect.as(undefined));
			if (!send) return Effect.die("Send command requires its admitted handle");
			if (!sql || !command.input.runId)
				return dispatch(command, send, recovered);
			const runId = command.input.runId;
			return Effect.gen(function* () {
				// From 32.5 a joined steer goes through the feeder and the hold (CONTRACT 1555-1556).
				const commandId =
					(yield* runSendCommandIdQuery(
						sql,
						command.input.sessionId,
						runId,
					).pipe(
						retrySettlementWrite,
						Effect.mapError((cause) => runnerFailure("send-turn", cause)),
					)) ?? command.input.inputId;
				const pending = sends.pending(send) ?? {
					sessionId: command.input.sessionId,
					runId: command.runId ?? command.input.runId,
					cancelled: yield* Deferred.make<void>(),
				};
				yield* sends.bindPending(send, command.sinkId, {
					...pending,
					owner: true,
				});
				const [claim] = yield* sql<{
					request_sequence: number;
					attempt_count: number;
				}>`SELECT request_sequence, attempt_count
					FROM provider_command_outbox WHERE session_id = ${command.input.sessionId}
					AND run_id = ${runId} AND command_id = ${commandId} AND effect_type = 'send_turn'
					AND (${command.input.commandAttempt ?? null} IS NULL OR attempt_count = ${command.input.commandAttempt ?? null})
					ORDER BY request_sequence DESC LIMIT 1`.pipe(
					retrySettlementWrite,
					Effect.mapError((cause) => runnerFailure("read send claim", cause)),
				);
				const feederInput: OwnerSend = {
					...(claim
						? {
								requestSequence: claim.request_sequence,
								attempt: claim.attempt_count,
							}
						: {}),
					sessionId: command.input.sessionId,
					runId,
					commandId,
				};
				const result = yield* feeder
					.send(
						feederInput,
						(hold, permission) =>
							Effect.gen(function* () {
								yield* pauseSend("after-hold", {
									...feederInput,
									runnerId: hold.runner,
									transmission: hold.transmission,
								});
								const [payload] = yield* retrySettlementWrite(sql<{
									fallback: number;
								}>`SELECT COALESCE(json_extract(payload_json, '$.nativeResumeFallback'), 0) AS fallback
							FROM provider_command_outbox WHERE session_id = ${feederInput.sessionId} AND run_id = ${runId} AND command_id = ${commandId}
							ORDER BY request_sequence DESC LIMIT 1`).pipe(
									Effect.mapError((cause) =>
										runnerFailure("read send mode", cause),
									),
								);
								// The live capability carries this command's own mode.
								if (
									(payload?.fallback === 1) !==
									(command.input.nativeResumeFallback === true)
								)
									return yield* transmitStoredOwner(
										feederInput,
										hold,
										permission,
									);
								return yield* dispatch(
									command,
									send,
									recovered,
									hold,
									permission,
								).pipe(
									Effect.catchIf(
										(failure) =>
											runnerCommandReplied(failure) &&
											!runnerDeliveryEvidence(failure) &&
											!isClaudeResumeRefused(failure),
										(failure) => Effect.succeed(terminalFailureResult(failure)),
									),
									Effect.map((reply) =>
										reply
											? {
													...reply,
													runnerSend: {
														runnerId: hold.runner,
														transmission: hold.transmission,
													},
												}
											: reply,
									),
								);
							}),
						command.input.nativeResumeFallback === true,
						send.close,
					)
					.pipe(Effect.mapError((cause) => runnerFailure("send-turn", cause)));
				const [open] = yield* retrySettlementWrite(
					sql`SELECT 1 FROM provider_runs WHERE id = ${runId} AND session_id = ${command.input.sessionId} AND status IN ('pending', 'running')`,
				).pipe(
					Effect.mapError((cause) =>
						runnerFailure("read send lifetime", cause),
					),
				);
				if (result?.status !== "completed" && (!result || !open))
					yield* send.close;
				return result ?? CANCELLED_TURN;
			});
		}
		const transmitStoredOwner = (
			input: OwnerSend,
			held: Held,
			permission: WritePermission,
		): Effect.Effect<TurnResult | undefined, SessionFailure> =>
			Effect.gen(function* () {
				if (!sql || stops.closing) return yield* Effect.interrupt;
				const accounts = yield* deps.accounts ?? Effect.succeed(undefined);
				const [row] = yield* runningRunnerCommands(
					sql,
					driver.driverKind,
					(accountId) =>
						accounts?.accounts.find(({ id }) => id === accountId)?.driver ??
						accounts?.deleted.find(({ id }) => id === accountId)?.driver ??
						(accountId === driver.driverKind ? driver.driverKind : undefined),
					input.sessionId,
					input,
				);
				if (!row) return;
				const replayLock = yield* Semaphore.make(1);
				let admitted: SendScope | undefined;
				let first = true;
				const sendPrepared = (
					_id: string,
					command: Extract<SessionCommand, { type: "send-turn" }>,
				) =>
					Effect.gen(function* () {
						if (!admitted)
							return yield* Effect.fail(
								runnerFailure("transmit owner send", "Missing admitted send"),
							);
						if (!first) return yield* submit(command, admitted);
						first = false;
						const attempt = yield* Effect.result(
							dispatch(command, admitted, undefined, held, permission).pipe(
								Effect.catchIf(
									(failure) =>
										runnerCommandReplied(failure) &&
										!runnerDeliveryEvidence(failure) &&
										!isClaudeResumeRefused(failure),
									(failure) => Effect.succeed(terminalFailureResult(failure)),
								),
							),
						);
						const resumeRejected =
							attempt._tag === "Failure"
								? isClaudeResumeRefused(attempt.failure)
								: attempt.success?.nativeResumeRejected ||
									isClaudeResumeRefused(attempt.success?.error);
						if (driver.driverKind === "claude" && resumeRejected)
							yield* retrySettlementWrite(
								stops.release({
									...input,
									runnerId: held.runner,
									transmission: held.transmission,
									reason: "ResumeRejected",
								}),
							).pipe(
								Effect.mapError((cause) =>
									runnerFailure("release resume refusal", cause),
								),
							);
						if (attempt._tag === "Failure")
							return yield* Effect.fail(attempt.failure);
						return attempt.success
							? {
									...attempt.success,
									runnerSend: {
										runnerId: held.runner,
										transmission: held.transmission,
									},
								}
							: attempt.success;
					});
				const outcome = yield* replayStoredSend({
					sql,
					row,
					driverKind: driver.driverKind,
					replayLock,
					...(driver.prepareStoredTurnEffect
						? { prepareTurnEffect: driver.prepareStoredTurnEffect }
						: {}),
					deps: {
						...(deps.accounts ? { accounts: deps.accounts } : {}),
						autoSettleAfterDays: deps.autoSettleAfterDays,
						recoveryForSession: deps.recoveryForSession,
						sessionForkSdk: deps.sessionForkSdk,
						claudeSettingsOverrides: deps.claudeSettingsOverrides,
					},
					admitReplay: (turn, sinkId, replay) =>
						sends
							.admit(
								{
									origin: { _tag: "Adopted" },
									input: turn,
									sinkId,
									isEnded: runnerCommandEnded(
										sql,
										row.session_id,
										row.command_id,
										row.attempt_count,
									),
								},
								(send) =>
									Effect.gen(function* () {
										admitted = send;
										const pending = sends.pending(send) ?? {
											sessionId: turn.sessionId,
											runId: turn.runId,
											cancelled: yield* Deferred.make<void>(),
										};
										yield* sends.bindPending(send, sinkId, {
											...pending,
											owner: true,
										});
										return yield* replay;
									}),
							)
							.pipe(
								Effect.map(
									Option.getOrElse(() => ({
										result: undefined,
										nativeResumeFallback: false,
									})),
								),
							),
					liveSession: nativeSession(row.session_id),
					resolveSinkId: (id, _inputId, attempt, fallback) =>
						runnerSinkId(id, attempt, fallback),
					send: sendPrepared,
					closing: () => stops.closing,
				}).pipe(
					Effect.catch((failure) =>
						Effect.gen(function* () {
							if (stops.closing) return yield* Effect.interrupt;
							if (!first) return yield* Effect.fail(failure);
							const evidence: Extract<
								SendEvidence,
								{ readonly _tag: "failed" }
							> = {
								_tag: "failed",
								observedAt: clock.currentTimeMillisUnsafe(),
								failure,
								send: {
									sessionId: row.session_id,
									runId: input.runId,
									commandId: row.command_id,
									requestSequence: row.request_sequence,
									attempt: row.attempt_count,
								},
							};
							yield* retrySettlementWrite(
								Effect.gen(function* () {
									const { lifecycle } = yield* sessionCommit(row.session_id);
									yield* lifecycle.releaseRun(
										{
											sessionId: row.session_id,
											runId: input.runId,
											commandId: row.command_id,
											runnerId: held.runner,
											transmission: held.transmission,
											reason: "NotSent",
										},
										evidence,
									);
								}),
							);
							yield* admitted?.close ?? Effect.void;
							return { result: undefined, nativeResumeFallback: false };
						}),
					),
				);
				const result = terminalTurnResult(outcome.result);
				if (result && outcome.result?.runnerSend)
					yield* settleObservedSend({
						_tag: "replied",
						observedAt: clock.currentTimeMillisUnsafe(),
						result,
						send: {
							sessionId: row.session_id,
							runId: input.runId,
							commandId: row.command_id,
							requestSequence: row.request_sequence,
							attempt: row.attempt_count,
							...outcome.result.runnerSend,
						},
					});
				return outcome.result;
			}).pipe(
				Effect.mapError((cause) => runnerFailure("transmit owner send", cause)),
			);

		const feeder = yield* makeRunnerSendFeeder({
			hold: (input) =>
				Effect.suspend(() =>
					stops.closing
						? Effect.interrupt
						: pauseSend("before-hold", input).pipe(
								Effect.andThen(
									stops.holdRun(input.sessionId, input.runId, input.commandId),
								),
							),
				),
			start: startStored,
			release: (input) => stops.release(input),
			failed: stops.refuse,
			awaitRun: stops.awaitRun,
			clean: stops.clean,
			park: stops.park,
			transmitAdopted: transmitStoredOwner,
			currentHold: stops.currentHold,
			gate: stops.gate,
			releases: stops.releases,
		});

		const recoverOwnerSends = (sessionIds?: ReadonlySet<string>) =>
			Effect.gen(function* () {
				if (!sql || stops.closing) return;
				const accounts = yield* deps.accounts ?? Effect.succeed(undefined);
				const ownsPending = yield* currentPendingSendOwner;
				const rows = yield* runningRunnerCommands(
					sql,
					driver.driverKind,
					(accountId) =>
						accounts?.accounts.find(({ id }) => id === accountId)?.driver ??
						accounts?.deleted.find(({ id }) => id === accountId)?.driver ??
						(accountId === driver.driverKind ? driver.driverKind : undefined),
				);
				for (const row of rows) {
					if (
						!row.run_id ||
						(sessionIds && !sessionIds.has(row.session_id)) ||
						ownsPending?.(
							row.session_id,
							row.command_id,
							row.request_sequence,
							row.attempt_count,
						)
					)
						continue;
					// As for recovered registrations, a send whose project is not
					// served stays with the reactor's project gate; the project's
					// attachment recovers it once it is served.
					if (!(yield* deps.projectRootForSession(row.session_id))) continue;
					// row.run_id names a joined steer's owner; from 32.5 the steer is re-held under
					// its own run id while its owner's Run is open (CONTRACT 1868-1869, 2021-2025).
					const [unheld] = yield* sql<{
						id: string;
					}>`SELECT run.id FROM provider_command_outbox command
					JOIN provider_runs run ON run.id = command.run_id AND run.session_id = command.session_id
					JOIN provider_runs owner ON owner.id = COALESCE(run.joined_into, run.id) AND owner.session_id = run.session_id
					WHERE command.request_sequence = ${row.request_sequence} AND command.project_key = ${row.project_key}
						AND run.runner_id IS NULL AND owner.status IN ('pending','running')`;
					if (!unheld) continue;
					const [rejected] = yield* sql<{
						instance_id: string;
						fork_refused: number;
					}>`SELECT COALESCE(json_extract(command.payload_json, '$.account.id'), json_extract(command.payload_json, '$.instanceId'), command.provider_id) AS instance_id,
					(COALESCE(json_extract(command.payload_json, '$.clearInheritedGoal'), 0) OR COALESCE(json_extract(command.payload_json, '$.forkSession'), 0) OR session.forked_from IS NOT NULL) AS fork_refused
					FROM provider_command_outbox command JOIN sessions session ON session.id = command.session_id WHERE command.request_sequence = ${row.request_sequence}
					AND COALESCE(json_extract(command.payload_json, '$.nativeResumeFallback'), 0) = 0
					AND EXISTS (SELECT 1 FROM events WHERE session_id = command.session_id AND type = 'run.released'
						AND json_extract(data, '$.runId') = command.run_id AND json_extract(data, '$.commandId') = command.command_id AND json_extract(data, '$.reason') = 'ResumeRejected')`;
					if (rejected) {
						const { commit } = yield* sessionCommit(row.session_id);
						yield* commit.write(() =>
							Effect.gen(function* () {
								const [eligible] =
									yield* sql`SELECT 1 FROM provider_command_outbox command JOIN provider_runs run ON run.id = command.run_id AND run.session_id = command.session_id
								WHERE command.request_sequence = ${row.request_sequence} AND command.attempt_count = ${row.attempt_count} AND command.status = 'running'
								AND run.runner_id IS NULL AND run.status IN ('pending', 'running')`;
								if (!eligible) return;
								yield* recordClaudeNativeResumeFallback(sql, {
									sessionId: row.session_id,
									instanceId: rejected.instance_id,
									commandId: row.command_id,
									requestSequence: row.request_sequence,
									attempt: row.attempt_count,
									forkRefused: rejected.fork_refused !== 0,
								});
							}),
						);
					}
					yield* feeder.enqueue({
						sessionId: row.session_id,
						runId: unheld.id,
						commandId: row.command_id,
						requestSequence: row.request_sequence,
						attempt: row.attempt_count,
					});
				}
			}).pipe(
				Effect.mapError((cause) => runnerFailure("recover owner sends", cause)),
			);
		return { submit, recover: recoverOwnerSends };
	});
