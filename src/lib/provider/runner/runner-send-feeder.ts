import { Deferred, Effect, Exit, FiberSet } from "effect";
import * as Failure from "../../effect/failure-classification.js";
import type { Hold } from "../../persistence/effect/commit-and-signal.js";
import { isClaudeResumeRefused } from "../event-sink-errors.js";
import type { TurnResult } from "../types.js";
import {
	runnerCommandReplied,
	runnerDeliveryEvidence,
} from "./runner-protocol.js";
import type { RunRelease } from "./runner-retirement.js";
import { retryRunnerPersistence, runnerRetrySchedule } from "./runner-retry.js";
import type { SessionFailure } from "./session-runner.js";

interface OwnerSend {
	readonly sessionId: string;
	readonly runId: string;
	readonly commandId: string;
	readonly nativeResumeFallback?: boolean;
	readonly requestSequence?: number;
	readonly attempt?: number;
}

type Held = Extract<Hold, { _tag: "Held" }>;
interface WaitingSend {
	readonly input: OwnerSend;
	readonly transmit: (
		hold: Held,
	) => Effect.Effect<TurnResult | undefined, SessionFailure>;
	readonly done: Deferred.Deferred<TurnResult | undefined, SessionFailure>;
	held?: Held | undefined;
	releasedTransmission?: number;
	cancelledBeforeWrite?: boolean;
}

/** One session queue is the only place an owner send acquires a transmission. */
export const makeRunnerSendFeeder = (options: {
	readonly hold: (input: OwnerSend) => Effect.Effect<Hold, SessionFailure>;
	readonly start: (input: OwnerSend) => Effect.Effect<void, SessionFailure>;
	readonly release: (input: RunRelease) => Effect.Effect<void, SessionFailure>;
	readonly settled: (input: OwnerSend) => Effect.Effect<void, SessionFailure>;
	readonly failed: (
		input: OwnerSend,
		failure: SessionFailure,
	) => Effect.Effect<void, SessionFailure>;
	/** Reconstruct a missing waiter; registration returns to this feeder. */
	readonly restore?: (input: OwnerSend) => Effect.Effect<void, SessionFailure>;
}) =>
	Effect.gen(function* () {
		const runFork = yield* FiberSet.makeRuntime<never, void, never>();
		const waiting = new Map<string, WaitingSend>();
		const abandoned = new Map<string, OwnerSend>();
		const restoring = new Set<string>();
		const queues = new Map<
			string,
			{ readonly pending: Set<WaitingSend>; changed: Deferred.Deferred<void> }
		>();
		const key = (input: OwnerSend) =>
			JSON.stringify([
				input.sessionId,
				input.runId,
				input.commandId,
				input.nativeResumeFallback === true,
			]);
		const ownerKey = (input: OwnerSend) =>
			JSON.stringify([input.sessionId, input.runId, input.commandId]);
		const finish = (item: WaitingSend) => {
			if (waiting.get(key(item.input)) === item)
				waiting.delete(key(item.input));
		};
		const release = (input: RunRelease) =>
			retryRunnerPersistence(Effect.suspend(() => options.release(input)));
		const failed = (input: OwnerSend, failure: SessionFailure) =>
			options.failed(input, failure);
		const schedule = (item: WaitingSend): void => {
			let queue = queues.get(item.input.sessionId);
			if (!queue) {
				queue = { pending: new Set(), changed: Deferred.makeUnsafe<void>() };
				queues.set(item.input.sessionId, queue);
			} else {
				queue.pending.add(item);
				Deferred.doneUnsafe(queue.changed, Effect.void);
				return;
			}
			queue.pending.add(item);
			const session = queue;
			runFork(
				Effect.gen(function* () {
					while (true) {
						const next = session.pending.values().next().value;
						if (!next) {
							const changed = session.changed;
							yield* Deferred.await(changed);
							if (session.changed === changed)
								session.changed = Deferred.makeUnsafe<void>();
							continue;
						}
						session.pending.delete(next);
						if (
							waiting.get(key(next.input)) !== next ||
							next.held ||
							next.cancelledBeforeWrite
						)
							continue;
						const result = yield* Effect.exit(
							Effect.gen(function* () {
								const holdOnce = () =>
									options.hold(next.input).pipe(
										Effect.retry({
											while: (failure) => failure.code === "StoreUnavailable",
											schedule: runnerRetrySchedule,
										}),
									);
								const hold = yield* holdOnce();
								if (hold._tag !== "Unserved") return hold;
								const started = yield* Effect.result(options.start(next.input));
								if (started._tag === "Failure") {
									yield* failed(next.input, started.failure);
									return { _tag: "Covered" as const };
								}
								const afterStart = yield* holdOnce();
								if (afterStart._tag !== "Unserved") return afterStart;
								yield* failed(next.input, {
									operation: "start runner",
									code: "runner_start_lost",
									message: "Runner exited before accepting the send",
								});
								return { _tag: "Covered" as const };
							}),
						);
						if (waiting.get(key(next.input)) !== next) {
							if (result._tag === "Success" && result.value._tag === "Held")
								yield* release({
									...next.input,
									runnerId: result.value.runner,
									transmission: result.value.transmission,
									reason: "NotSent",
								});
							continue;
						}
						if (result._tag === "Failure") {
							if (Failure.isInterruptedOnly(result.cause))
								return yield* Effect.interrupt;
							finish(next);
							yield* Deferred.done(next.done, Exit.failCause(result.cause));
							continue;
						}
						const hold = result.value;
						if (hold._tag !== "Held") {
							// The ledger observer completes the caller after its handle
							// closes. Covered may still belong to a stopping holder.
							continue;
						}
						if (next.cancelledBeforeWrite) {
							yield* release({
								...next.input,
								runnerId: hold.runner,
								transmission: hold.transmission,
								reason: "NotSent",
							});
							continue;
						}
						if (hold.transmission <= (next.releasedTransmission ?? 0)) {
							// Release can commit before the gate's reply reaches this fiber.
							session.pending.add(next);
							continue;
						}
						next.held = hold;
						runFork(
							Effect.gen(function* () {
								if (waiting.get(key(next.input)) !== next) {
									yield* release({
										...next.input,
										runnerId: hold.runner,
										transmission: hold.transmission,
										reason: "NotSent",
									});
									return;
								}
								const sent = yield* Effect.result(next.transmit(hold));
								if (next.held !== hold) return;
								if (sent._tag === "Failure") {
									const evidence = runnerDeliveryEvidence(sent.failure);
									if (isClaudeResumeRefused(sent.failure)) {
										finish(next);
										yield* release({
											...next.input,
											runnerId: hold.runner,
											transmission: hold.transmission,
											reason: "ResumeRejected",
										});
										yield* Deferred.fail(next.done, sent.failure);
									} else if (evidence) {
										yield* release({
											...next.input,
											runnerId: hold.runner,
											transmission: hold.transmission,
											reason: evidence._tag,
											...(evidence._tag === "Refused"
												? { refusalReason: evidence.reason }
												: {}),
										});
									} else if (runnerCommandReplied(sent.failure)) {
										yield* Deferred.fail(next.done, sent.failure);
									}
									// A failed write or a lost reply stays held until ledger settlement.
									return;
								}
								if (
									sent.success?.nativeResumeRejected ||
									isClaudeResumeRefused(sent.success?.error)
								) {
									finish(next);
									yield* release({
										...next.input,
										runnerId: hold.runner,
										transmission: hold.transmission,
										reason: "ResumeRejected",
									});
								}
								yield* Deferred.succeed(next.done, sent.success);
							}).pipe(
								Effect.catchCause((cause) =>
									Failure.isInterruptedOnly(cause)
										? Effect.interrupt
										: Effect.logWarning(
												"Owner send transmission failed",
												cause,
											),
								),
							),
						);
					}
				}).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							if (queues.get(item.input.sessionId) === session)
								queues.delete(item.input.sessionId);
						}),
					),
					Effect.catchCause((cause) =>
						Effect.logWarning("Owner send feeder failed", cause),
					),
				),
			);
		};
		return {
			has: (input: OwnerSend) => waiting.has(key(input)),
			cancel: (input: OwnerSend) =>
				Effect.sync(() => {
					const item = waiting.get(key(input));
					if (item) item.cancelledBeforeWrite = true;
				}),
			cancelledBeforeWrite: (
				input: OwnerSend,
				hold: Held,
				result: TurnResult,
			) =>
				Effect.gen(function* () {
					const item = waiting.get(key(input));
					// Retain the aborted waiter until its ledger outcome arrives, so a
					// release cannot reconstruct a second caller during cancellation.
					if (item) item.cancelledBeforeWrite = true;
					yield* release({
						...input,
						runnerId: hold.runner,
						transmission: hold.transmission,
						reason: "NotSent",
					});
					if (item) yield* Deferred.succeed(item.done, result);
				}),
			send: (
				input: OwnerSend,
				transmit: WaitingSend["transmit"],
				held?: Held,
			) =>
				Effect.suspend(() => {
					let current: WaitingSend | undefined;
					return Effect.gen(function* () {
						let item = waiting.get(key(input));
						if (!item) {
							item = {
								input,
								transmit,
								held,
								done: yield* Deferred.make<
									TurnResult | undefined,
									SessionFailure
								>(),
							};
							current = item;
							waiting.set(key(input), item);
							const registered = item;
							runFork(
								options.settled(input).pipe(
									retryRunnerPersistence,
									Effect.tap(() =>
										Effect.gen(function* () {
											finish(registered);
											abandoned.delete(ownerKey(registered.input));
											yield* Deferred.succeed(registered.done, undefined);
										}),
									),
									Effect.catchCause((cause) =>
										Effect.logWarning(
											"Owner send settlement observation failed",
											cause,
										),
									),
								),
							);
							if (!held) schedule(item);
						}
						current = item;
						return yield* Deferred.await(item.done);
					}).pipe(
						Effect.onInterrupt(() =>
							Effect.sync(() => {
								if (
									current &&
									!current.cancelledBeforeWrite &&
									waiting.get(key(current.input)) === current
								) {
									abandoned.set(ownerKey(current.input), current.input);
									finish(current);
								}
							}),
						),
					);
				}),
			released: (input: RunRelease) =>
				Effect.sync(() => {
					let matched = false;
					for (const item of waiting.values())
						if (
							item.input.sessionId === input.sessionId &&
							item.input.runId === input.runId &&
							item.input.commandId === input.commandId
						) {
							matched = true;
							item.releasedTransmission = Math.max(
								item.releasedTransmission ?? 0,
								input.transmission,
							);
							if (
								!item.held ||
								(item.held.runner === input.runnerId &&
									item.held.transmission === input.transmission)
							) {
								item.held = undefined;
								if (!item.cancelledBeforeWrite) schedule(item);
							}
						}
					const restoreKey = ownerKey(input);
					const missing = abandoned.get(restoreKey) ?? input;
					if (matched) abandoned.delete(restoreKey);
					if (!matched && options.restore) {
						if (restoring.has(restoreKey)) return;
						restoring.add(restoreKey);
						abandoned.delete(restoreKey);
						runFork(
							options.restore(missing).pipe(
								retryRunnerPersistence,
								Effect.ensuring(
									Effect.sync(() => restoring.delete(restoreKey)),
								),
								Effect.catchCause((cause) =>
									Effect.logWarning("Owner send registration failed", cause),
								),
							),
						);
					}
				}),
		};
	});
