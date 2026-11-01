import { randomUUID } from "node:crypto";
import { Deferred, Effect, Exit, Fiber } from "effect";
import type { AttachmentRef } from "../../contracts/attachment-ref.js";
import * as Failure from "../../effect/failure-classification.js";
import { isRecord } from "../../utils.js";
import type { RunnerChild } from "./runner-entry-lifecycle.js";
import { type RunnerSocket, runnerFailure } from "./runner-protocol.js";
import type { RunnerSourceDelivery } from "./runner-upgrade.js";
import type { SendScope, SendScopes } from "./send-scope.js";
import type {
	AdmitSend,
	SessionFailure,
	SessionOutput,
} from "./session-runner.js";

/** A send's runner is its assignment in send-scope, never a field here. */
export interface SendBinding {
	readonly sessionId: string;
	readonly sendScope?: SendScope;
	readonly inputId?: string;
	readonly runId?: string | undefined;
	readonly commandId?: string;
	/** What a failed send places when the SDK never started it. */
	readonly placement?: {
		readonly inputId: string;
		readonly text: string;
		readonly images?: readonly AttachmentRef[];
	};
	readonly messageId: string;
	readonly commandPending: boolean;
	readonly outcomeEmitted?: boolean;
}

export interface PendingSend {
	readonly sessionId: string;
	readonly turnId: string;
	readonly cancelled: Deferred.Deferred<void>;
	readonly owner?: boolean;
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** Sinks, pending sends, account demands, admission and per-runner pending commands. */
export const makeRunnerSends = (deps: {
	readonly sendScopes: SendScopes;
	readonly runFork: (effect: Effect.Effect<void>) => Fiber.Fiber<void, never>;
	readonly withAccountScope:
		| ((
				accountId: string,
				work: Effect.Effect<void>,
		  ) => Effect.Effect<void, SessionFailure>)
		| undefined;
	readonly closing: () => boolean;
	readonly currentEntry: (sessionId: string) => RunnerChild | undefined;
}) => {
	const { sendScopes, runFork, closing, currentEntry } = deps;
	const sinks = new Map<string, SendBinding>();
	const pendingSends = new Map<SendScope, PendingSend>();
	const accountDemands = new Map<
		SendScope,
		{
			readonly ready: Deferred.Deferred<void, SessionFailure>;
			readonly finished: Deferred.Deferred<void>;
			readonly dispatched: Deferred.Deferred<RunnerSocket>;
			readonly invalidated: Deferred.Deferred<void>;
			readonly fiber: Fiber.Fiber<void, never>;
		}
	>();
	// Sinks each runner was refused a release for; dropped when its sends close.
	const refusedReleases = new Map<string, Set<string>>();
	// Acknowledgement retention lives as long as its entry.
	const pendingCommands = new WeakMap<RunnerChild, Map<string, number>>();
	let admission: AdmitSend | undefined;
	/** Whether the send was handed to a runner; a requeue clears it. */
	const dispatched = (send: SendScope) =>
		sendScopes.dispatchedTo(send) !== undefined;
	const runnerOf = (binding: SendBinding | undefined) =>
		binding?.sendScope ? sendScopes.dispatchedTo(binding.sendScope) : undefined;
	const admit: AdmitSend = (request, work) =>
		admission
			? admission(request, work)
			: Effect.fail(
					runnerFailure("admit send", "Provider admission is not installed"),
				);
	return {
		route: (sinkId: string) => sinks.get(sinkId),
		pending: (send: SendScope) => pendingSends.get(send),
		demand: (send: SendScope) => accountDemands.get(send),
		runnerOf,
		dispatched,
		bind: (sinkId: string, binding: SendBinding) =>
			Effect.gen(function* () {
				const send = binding.sendScope;
				if (!send) return yield* Effect.die("Missing admitted send handle");
				if (sinks.get(sinkId) === binding) {
					return binding;
				}
				return yield* sendScopes.acquire(
					send,
					sinkId,
					"manager sink",
					Effect.sync(() => {
						sinks.set(sinkId, binding);
						return binding;
					}),
					(binding) =>
						Effect.sync(() => {
							if (sinks.get(sinkId) === binding) sinks.delete(sinkId);
						}),
				);
			}),
		bindPending: (send: SendScope, sinkId: string, pending: PendingSend) =>
			Effect.suspend(() =>
				pendingSends.get(send) === pending
					? Effect.succeed(pending)
					: sendScopes.acquire(
							send,
							sinkId,
							"pending send",
							Effect.sync(() => {
								pendingSends.set(send, pending);
								return pending;
							}),
							(pending) =>
								Effect.sync(() => {
									if (pendingSends.get(send) === pending)
										pendingSends.delete(send);
								}),
						),
			),
		/** Cancels every undispatched non-owner send the interrupt names. */
		cancelUndispatched: (
			sessionId: string,
			turnIds: readonly string[] | undefined,
		) =>
			Effect.forEach(
				[...pendingSends].filter(
					([send, pending]) =>
						!dispatched(send) &&
						!pending.owner &&
						pending.sessionId === sessionId &&
						(turnIds === undefined || turnIds.includes(pending.turnId)),
				),
				([, pending]) => Deferred.succeed(pending.cancelled, undefined),
				{ discard: true },
			),
		/** Scope membership lasts through native cleanup; the assignment routes cancellation. */
		delivers: (
			entry: RunnerChild,
			delivery: RunnerSourceDelivery | undefined,
		) => {
			const binding = delivery ? sinks.get(delivery.sinkId) : undefined;
			return (
				delivery !== undefined &&
				binding?.sessionId === entry.sessionId &&
				runnerOf(binding) === entry.runnerId &&
				binding.commandId === delivery.commandId &&
				binding.inputId === delivery.inputId &&
				binding.runId === delivery.runId
			);
		},
		/** Hands the send to the runner; a transmitted command also becomes pending there. */
		dispatch: (
			send: SendScope,
			entry: RunnerChild,
			command?: {
				readonly sinkId: string;
				readonly commandId: string;
				readonly attempt: number;
			},
		) => {
			sendScopes.dispatch(send, entry.runnerId);
			if (!command) return;
			pendingCommands.get(entry)?.set(command.commandId, command.attempt);
			const binding: Writable<SendBinding> | undefined = sinks.get(
				command.sinkId,
			);
			if (binding) binding.commandId = command.commandId;
		},
		/** Records the run and assistant message a runner event names. */
		observe: (output: SessionOutput, binding: SendBinding | undefined) => {
			const turn: Writable<SendBinding> | undefined = binding;
			if (
				output.type !== "event" ||
				!turn ||
				output.event.sessionId !== turn.sessionId
			)
				return;
			if (output.event.type === "run.started" && output.event.runId)
				turn.runId = output.event.runId;
			if (turn.runId && output.event.runId !== turn.runId) return;
			if (
				output.event.type === "message.created" &&
				isRecord(output.event.data) &&
				output.event.data["role"] === "assistant" &&
				!turn.messageId
			)
				turn.messageId = String(output.event.data["messageId"]);
		},
		/** Claims the send's single outcome; false when one was already emitted. */
		outcome: (binding: SendBinding) => {
			const turn: Writable<SendBinding> = binding;
			if (turn.outcomeEmitted) return false;
			turn.outcomeEmitted = true;
			return true;
		},
		commandSettled: (binding: SendBinding) => {
			const turn: Writable<SendBinding> = binding;
			turn.commandPending = false;
		},
		/** A released run returns its sends on that runner to the queue. */
		released: (input: {
			readonly sessionId: string;
			readonly runId: string;
			readonly runnerId: string;
		}) => {
			for (const binding of sinks.values())
				if (
					binding.sessionId === input.sessionId &&
					binding.runId === input.runId &&
					binding.sendScope &&
					runnerOf(binding) === input.runnerId
				)
					sendScopes.requeue(binding.sendScope, input.runnerId);
		},
		/** True the first time a runner is refused a release for this sink. */
		refused: (runnerId: string, sinkId: string) => {
			const refused = refusedReleases.get(runnerId) ?? new Set<string>();
			if (refused.has(sinkId)) return false;
			refusedReleases.set(runnerId, refused.add(sinkId));
			return true;
		},
		/** The entry scope's send finalizer (6.11): closes the runner's dispatched sends, except those whose run it still holds. */
		closeRunner: (runnerId: string, held?: readonly string[]) =>
			Effect.gen(function* () {
				refusedReleases.delete(runnerId);
				if (!held) return yield* sendScopes.closeRunner(runnerId);
				for (const binding of sinks.values())
					if (
						binding.sendScope &&
						binding.sendScope.assignment._tag === "Dispatched" &&
						binding.sendScope.assignment.runnerId === runnerId &&
						!held.some((runId) => runId === binding.runId)
					)
						yield* binding.sendScope.close;
			}),
		/** The runner's hello replaces what it still retains. */
		recovered: (
			entry: RunnerChild,
			commands: Iterable<{
				readonly commandId: string;
				readonly attempt?: number | undefined;
			}>,
		) => {
			const pending = new Map<string, number>();
			for (const command of commands)
				if (command.attempt !== undefined)
					pending.set(
						command.commandId,
						Math.max(pending.get(command.commandId) ?? -1, command.attempt),
					);
			pendingCommands.set(entry, pending);
		},
		retain: (entry: RunnerChild, commandId: string, attempt: number) => {
			pendingCommands.get(entry)?.set(commandId, attempt);
		},
		pendingAttempt: (entry: RunnerChild, commandId: string) =>
			pendingCommands.get(entry)?.get(commandId),
		pendingOn: (entry: RunnerChild) => [
			...(pendingCommands.get(entry)?.keys() ?? []),
		],
		/** Drops the command unless a newer attempt replaced it. */
		settled: (entry: RunnerChild, commandId: string, attempt: number) => {
			const pending = pendingCommands.get(entry);
			if (pending?.get(commandId) === attempt) pending.delete(commandId);
		},
		admit,
		setAdmission: (admit: AdmitSend) => {
			admission = admit;
		},
		retainAccount: (
			send: SendScope,
			sinkId: string,
			accountId: string | undefined,
			connection?: RunnerSocket,
		) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const pending = pendingSends.get(send);
					if (
						send.assignment._tag === "Closed" ||
						(pending && Deferred.isDoneUnsafe(pending.cancelled))
					)
						return yield* Effect.fail({
							...runnerFailure(
								"retain account",
								"Input cancelled before intake",
							),
							code: "cancelled",
						});
					const withAccountScope = deps.withAccountScope;
					if (!withAccountScope || !accountId) return;
					const existing = accountDemands.get(send);
					if (existing) return yield* restore(Deferred.await(existing.ready));
					const ready = yield* Deferred.make<void, SessionFailure>();
					const finished = yield* Deferred.make<void>();
					const dispatchedTo = yield* Deferred.make<RunnerSocket>();
					const invalidated = yield* Deferred.make<void>();
					if (connection) yield* Deferred.succeed(dispatchedTo, connection);
					const interrupt = Deferred.await(dispatchedTo).pipe(
						Effect.andThen(
							Effect.suspend(() => {
								if (send.assignment._tag === "Closed") return Effect.void;
								const pending = pendingSends.get(send);
								if (pending && !dispatched(send))
									return pending.owner
										? Effect.void
										: Deferred.succeed(pending.cancelled, undefined).pipe(
												Effect.asVoid,
											);
								const assignment = send.assignment;
								const entry = currentEntry(send.sessionId);
								const binding = sinks.get(send.sinkId);
								if (
									assignment._tag !== "Dispatched" ||
									!entry?.connection ||
									entry.runnerId !== assignment.runnerId ||
									binding?.sendScope !== send
								)
									return Effect.void;
								return entry.connection
									.commandEffect(randomUUID(), {
										type: "interrupt",
										sessionId: send.sessionId,
										...(binding.inputId ? { turnIds: [binding.inputId] } : {}),
									})
									.pipe(Effect.asVoid);
							}),
						),
					);
					const fiber = runFork(
						withAccountScope(
							accountId,
							Deferred.succeed(ready, undefined).pipe(
								Effect.andThen(Deferred.await(finished)),
								Effect.onInterrupt(() =>
									Deferred.succeed(invalidated, undefined).pipe(
										Effect.andThen(
											Effect.suspend(() => {
												if (closing()) return Effect.void;
												runFork(
													sendScopes
														.fork(
															send,
															"account invalidation abort",
															interrupt.pipe(Effect.ignore),
														)
														.pipe(Effect.asVoid),
												);
												return Deferred.await(finished).pipe(
													Effect.interruptible,
												);
											}),
										),
									),
								),
							),
						).pipe(
							Effect.onExit((exit) =>
								Effect.gen(function* () {
									yield* Deferred.done(
										ready,
										!closing() &&
											Exit.isFailure(exit) &&
											Failure.isInterruptedOnly(exit.cause)
											? Exit.fail(
													runnerFailure(
														"retain account",
														"Cursor account was invalidated",
													),
												)
											: exit,
									);
								}),
							),
							Effect.catchCause(() => Effect.void),
						),
					);
					yield* sendScopes.acquire(
						send,
						sinkId,
						"account demand",
						Effect.sync(() => {
							const demand = {
								ready,
								finished,
								dispatched: dispatchedTo,
								invalidated,
								fiber,
							};
							accountDemands.set(send, demand);
							return demand;
						}),
						(demand) =>
							Effect.sync(() => {
								if (accountDemands.get(send) === demand)
									accountDemands.delete(send);
								Deferred.doneUnsafe(demand.finished, Effect.void);
							}).pipe(Effect.andThen(Fiber.join(demand.fiber))),
					);
					yield* restore(Deferred.await(ready));
				}),
			),
	};
};

export type RunnerSends = ReturnType<typeof makeRunnerSends>;
