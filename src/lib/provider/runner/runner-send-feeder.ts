import { Deferred, Effect, Exit, FiberSet, Option } from "effect";
import * as Failure from "../../effect/failure-classification.js";
import { isClaudeResumeRefused } from "../event-sink-errors.js";
import type { TurnResult } from "../types.js";
import {
	runnerCommandReplied,
	runnerDeliveryEvidence,
	runnerFailure,
} from "./runner-protocol.js";
import type { Hold, RunRelease } from "./runner-retirement.js";
import {
	retrySettlementWrite,
	type StoreFault,
	sendRetryBackoff,
} from "./send-settlement.js";
import type { SessionFailure } from "./session-runner.js";

export interface OwnerSend {
	readonly sessionId: string;
	readonly runId: string;
	readonly commandId: string;
	readonly nativeResumeFallback?: boolean;
	readonly requestSequence?: number;
	readonly attempt?: number;
}
export interface SendWritePermission {
	readonly nativeResumeFallback: boolean | undefined;
	readonly current: () => boolean;
	/** Consume immediately before the first byte, without yielding before write. */
	readonly consume: () => boolean;
}
type Held = Extract<Hold, { _tag: "Held" }>;
type Transmit = (
	held: Held,
	permission: SendWritePermission,
) => Effect.Effect<TurnResult | undefined, SessionFailure>;
interface Capability {
	readonly input: OwnerSend;
	readonly ended: Deferred.Deferred<void, SessionFailure>;
	releasedTransmission: number;
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
	readonly failed: (
		input: OwnerSend,
		failure: SessionFailure,
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
	readonly transmitAdopted: (
		input: OwnerSend,
		held: Held,
		permission: SendWritePermission,
	) => Effect.Effect<TurnResult | undefined, SessionFailure>;
}) =>
	Effect.gen(function* () {
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
				releasedTransmission: 0,
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
									yield* options.failed(item.input, start.failure);
									return;
								}
								return { started: true, ordinal: 0 };
							}),
						};
					}
					case "Held": {
						if (hold.transmission <= item.releasedTransmission) return;
						let consumed = false;
						const live = item.live;
						const permission: SendWritePermission = {
							nativeResumeFallback: live?.nativeResumeFallback,
							current: () => hold.transmission > item.releasedTransmission,
							consume: () => {
								if (consumed || hold.transmission <= item.releasedTransmission)
									return false;
								consumed = true;
								return true;
							},
						};
						runFork(
							Effect.gen(function* () {
								const sent = yield* Effect.exit(
									Effect.gen(function* () {
										const reply = yield* Effect.result(
											live
												? live.transmit(hold, permission)
												: options.transmitAdopted(item.input, hold, permission),
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
											} else if (runnerCommandReplied(reply.failure) && live)
												yield* Deferred.fail(live.reply, reply.failure);
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
		return {
			enqueue: (input: OwnerSend) =>
				Effect.sync(() => enqueueCapability(capability(input))),
			released: (input: RunRelease) =>
				Effect.sync(() => {
					const item = capability(input);
					item.releasedTransmission = Math.max(
						item.releasedTransmission,
						input.transmission,
					);
					if (input.reason !== "ResumeRejected") enqueueCapability(item);
				}),
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
