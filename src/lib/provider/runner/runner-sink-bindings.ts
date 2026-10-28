import { type Cause, Deferred, Effect, Exit, Schema, Semaphore } from "effect";
import type { ProviderRuntimeEvent } from "../../contracts/providers/provider-runtime-event.js";
import {
	CanonicalEvents,
	type TextDeltaPayload,
} from "../../contracts/stored-event.js";
import { EventSinkIngestionError } from "../event-sink-errors.js";
import type {
	EventSink,
	PermissionDecision,
	PermissionResponse,
	QuestionRequest,
} from "../types.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
} from "./session-runner.js";

// Batch storage writes while keeping streamed text visible within 50 ms.
const DELTA_COALESCE_WINDOW_MS = 50;
const isDeltaPayload = Schema.is(CanonicalEvents["text.delta"].payload);

/** Owns ordered sink output, turn aborts, and retained interaction waits. */
export class RunnerSinkBindings {
	private readonly pendingDeltas = new Map<
		string,
		{
			readonly sinkId: string;
			event: ProviderRuntimeEvent & { readonly data: TextDeltaPayload };
			readonly timer: ReturnType<typeof setTimeout>;
		}
	>();
	private readonly lastDeltaParts = new Map<string, string>();
	/** Later outputs must wait while an earlier flush awaits acknowledgement. */
	private readonly sessionEmits = new Map<string, Semaphore.Semaphore>();
	private readonly deltaFailures = new Map<
		string,
		Cause.Cause<SessionFailure>
	>();
	private readonly sinkBindings = new Map<
		string,
		{
			readonly sessionId: string;
			readonly sink: EventSink;
			readonly abortController: AbortController;
			readonly permissions: Map<
				string,
				Deferred.Deferred<PermissionResponse, SessionFailure>
			>;
			readonly questions: Map<
				string,
				{
					readonly deferred: Deferred.Deferred<
						Record<string, unknown>,
						SessionFailure
					>;
					readonly questions: QuestionRequest["questions"];
				}
			>;
			references: number;
		}
	>();

	constructor(
		private readonly emit: (
			output: SessionOutput,
		) => Effect.Effect<SessionOutputReply, SessionFailure>,
	) {}

	/** A timer flush's failure fails the session's next output once, then clears. */
	private takeDeltaFailure(
		sessionId: string,
	): Cause.Cause<SessionFailure> | undefined {
		const failure = this.deltaFailures.get(sessionId);
		this.deltaFailures.delete(sessionId);
		return failure;
	}

	/** Takes pending text synchronously, before a timer's fork can yield. */
	private flushSession(sessionId: string): Effect.Effect<void, SessionFailure> {
		const pending = this.pendingDeltas.get(sessionId);
		if (pending) {
			this.pendingDeltas.delete(sessionId);
			clearTimeout(pending.timer);
		}
		const failure = this.takeDeltaFailure(sessionId);
		if (failure) return Effect.failCause(failure);
		return pending
			? this.emit({
					type: "event",
					sinkId: pending.sinkId,
					event: pending.event,
				}).pipe(Effect.asVoid)
			: Effect.void;
	}

	flushAllEffect(): Effect.Effect<void, SessionFailure> {
		return Effect.suspend(() =>
			Effect.forEach([...this.pendingDeltas.keys()], (id) =>
				Effect.exit(this.flushSession(id)),
			).pipe(
				Effect.flatMap((exits) => {
					const failure = exits.find(Exit.isFailure);
					return failure ? Effect.failCause(failure.cause) : Effect.void;
				}),
			),
		);
	}

	private emitForSession(
		sessionId: string,
		output: SessionOutput,
	): Effect.Effect<SessionOutputReply, SessionFailure> {
		const permit = this.sessionEmits.get(sessionId) ?? Semaphore.makeUnsafe(1);
		this.sessionEmits.set(sessionId, permit);
		return Effect.gen({ self: this }, function* () {
			const failure = this.takeDeltaFailure(sessionId);
			if (failure) return yield* Effect.failCause(failure);
			const delta =
				output.type === "event" &&
				(output.event.type === "text.delta" ||
					output.event.type === "thinking.delta") &&
				isDeltaPayload(output.event.data)
					? {
							sinkId: output.sinkId,
							event: { ...output.event, data: { ...output.event.data } },
						}
					: undefined;
			const pending = this.pendingDeltas.get(sessionId);
			if (
				delta &&
				pending &&
				pending.sinkId === delta.sinkId &&
				pending.event.type === delta.event.type &&
				pending.event.data.messageId === delta.event.data.messageId &&
				pending.event.data.partId === delta.event.data.partId
			) {
				pending.event = {
					...pending.event,
					data: {
						...pending.event.data,
						text: pending.event.data.text + delta.event.data.text,
					},
				};
				return {};
			}
			yield* this.flushSession(sessionId);
			if (delta) {
				const key = JSON.stringify([
					delta.sinkId,
					delta.event.type,
					delta.event.data.messageId,
					delta.event.data.partId,
				]);
				if (this.lastDeltaParts.get(sessionId) === key) {
					const timer = setTimeout(() => {
						Effect.runFork(
							this.flushSession(sessionId).pipe(
								Effect.catchCause((cause) =>
									Effect.sync(() => {
										this.deltaFailures.set(sessionId, cause);
									}),
								),
							),
						);
					}, DELTA_COALESCE_WINDOW_MS);
					this.pendingDeltas.set(sessionId, { ...delta, timer });
					return {};
				}
				this.lastDeltaParts.set(sessionId, key);
			}
			return yield* this.emit(output);
		}).pipe(permit.withPermits(1));
	}

	makeSessionSink(sinkId: string, sessionId: string): EventSink {
		const permissions = new Map<
			string,
			Deferred.Deferred<PermissionResponse, SessionFailure>
		>();
		const questions = new Map<
			string,
			{
				readonly deferred: Deferred.Deferred<
					Record<string, unknown>,
					SessionFailure
				>;
				readonly questions: QuestionRequest["questions"];
			}
		>();
		const sinkFailure = (cause: SessionFailure) =>
			new EventSinkIngestionError({
				cause: Object.assign(new Error(cause.message), cause),
			});
		const emit = (output: SessionOutput) =>
			this.emitForSession(sessionId, output).pipe(
				Effect.asVoid,
				Effect.mapError(sinkFailure),
			);
		const sink: EventSink & { readonly runnerSinkId: string } = {
			runnerSinkId: sinkId,
			push: (event) => emit({ type: "event", sinkId, event }),
			requestPermission: (request) =>
				Effect.gen(function* () {
					const deferred = yield* Deferred.make<
						PermissionResponse,
						SessionFailure
					>();
					permissions.set(request.requestId, deferred);
					return yield* emit({
						type: "permission-request",
						sinkId,
						request,
					}).pipe(
						Effect.andThen(
							Deferred.await(deferred).pipe(Effect.mapError(sinkFailure)),
						),
						Effect.ensuring(
							Effect.sync(() => permissions.delete(request.requestId)).pipe(
								Effect.andThen(
									emit({
										type: "cancel-interaction",
										sinkId,
										requestId: request.requestId,
									}),
								),
								Effect.ignore,
							),
						),
					);
				}),
			requestQuestion: (request) =>
				Effect.gen(function* () {
					const deferred = yield* Deferred.make<
						Record<string, unknown>,
						SessionFailure
					>();
					questions.set(request.requestId, {
						deferred,
						questions: request.questions,
					});
					return yield* emit({
						type: "question-request",
						sinkId,
						request,
					}).pipe(
						Effect.andThen(
							Deferred.await(deferred).pipe(Effect.mapError(sinkFailure)),
						),
						Effect.ensuring(
							Effect.sync(() => questions.delete(request.requestId)).pipe(
								Effect.andThen(
									emit({
										type: "cancel-interaction",
										sinkId,
										requestId: request.requestId,
									}),
								),
								Effect.ignore,
							),
						),
					);
				}),
			resolvePermission: (requestId, response) =>
				emit({ type: "resolve-permission", sinkId, requestId, response }),
			resolveQuestion: (requestId, answers) =>
				emit({
					type: "resolve-question",
					sinkId,
					requestId,
					answers: Object.fromEntries(
						Object.entries(answers).map(([index, answer]) => [
							index,
							questions.get(requestId)?.questions[Number(index)]?.isSecret
								? "[redacted]"
								: answer,
						]),
					),
				}),
			cancelSessionInteractions: (reason, options) =>
				emit({
					type: "cancel-interactions",
					sinkId,
					reason,
					recoverQuestions: options?.recoverQuestions ?? false,
				}).pipe(
					Effect.ignore,
					Effect.andThen(
						Effect.forEach(
							permissions.values(),
							(pending) => Deferred.succeed(pending, { decision: "reject" }),
							{ discard: true },
						),
					),
					Effect.andThen(
						Effect.forEach(
							questions.values(),
							(pending) =>
								Deferred.fail(pending.deferred, {
									operation: "requestQuestion",
									message: reason,
								}),
							{ discard: true },
						),
					),
				),
		};
		this.sinkBindings.set(sinkId, {
			sessionId,
			sink,
			abortController: new AbortController(),
			permissions,
			questions,
			references: 1,
		});
		return sink;
	}

	retainSink(sink: EventSink | undefined): void {
		if (
			sink &&
			"runnerSinkId" in sink &&
			typeof sink.runnerSinkId === "string"
		) {
			const binding = this.sinkBindings.get(sink.runnerSinkId);
			if (binding) binding.references++;
		}
	}

	sinkId(sink: EventSink | undefined): string | undefined {
		return sink &&
			"runnerSinkId" in sink &&
			typeof sink.runnerSinkId === "string"
			? sink.runnerSinkId
			: undefined;
	}
	withdrawInteraction(
		sink: EventSink,
		requestId: string,
		kind: "permission" | "question",
	): Effect.Effect<void, SessionFailure> {
		const sinkId = this.sinkId(sink);
		const binding = sinkId ? this.sinkBindings.get(sinkId) : undefined;
		return binding && sinkId
			? this.emitForSession(binding.sessionId, {
					type: "cancel-interaction",
					sinkId,
					requestId,
					kind,
				}).pipe(Effect.asVoid)
			: Effect.void;
	}
	releaseSinkEffect(sink: EventSink | undefined): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			if (
				!sink ||
				!("runnerSinkId" in sink) ||
				typeof sink.runnerSinkId !== "string"
			)
				return;
			const binding = this.sinkBindings.get(sink.runnerSinkId);
			if (!binding || --binding.references > 0) return;
			for (const pending of binding.permissions.values()) {
				yield* Deferred.succeed(pending, { decision: "reject" });
			}
			for (const pending of binding.questions.values()) {
				yield* Deferred.fail(pending.deferred, {
					operation: "requestQuestion",
					message: binding.abortController.signal.aborted
						? "Turn interrupted"
						: "Runner sink released",
				});
			}
			this.sinkBindings.delete(sink.runnerSinkId);
			yield* this.emitForSession(binding.sessionId, {
				type: "release-sink",
				sinkId: sink.runnerSinkId,
			}).pipe(Effect.ignore);
		});
	}

	controller(sinkId: string): AbortController | undefined {
		return this.sinkBindings.get(sinkId)?.abortController;
	}
	hasSessionSinks(sessionId: string): boolean {
		return Array.from(this.sinkBindings.values()).some(
			(binding) => binding.sessionId === sessionId,
		);
	}
	settle(
		command: Extract<
			SessionCommand,
			{
				type:
					| "answer-permission"
					| "answer-question"
					| "interaction-failed"
					| "abort";
			}
		>,
	): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			switch (command.type) {
				case "answer-permission": {
					const pending = this.sinkBindings
						.get(command.sinkId)
						?.permissions.get(command.requestId);
					if (pending) yield* Deferred.succeed(pending, command.response);
					return;
				}
				case "answer-question": {
					const pending = this.sinkBindings
						.get(command.sinkId)
						?.questions.get(command.requestId);
					if (pending)
						yield* Deferred.succeed(pending.deferred, command.answers);
					return;
				}
				case "interaction-failed": {
					const binding = this.sinkBindings.get(command.sinkId);
					if (command.kind === "permission") {
						const pending = binding?.permissions.get(command.requestId);
						if (pending) yield* Deferred.fail(pending, command.failure);
					} else {
						const pending = binding?.questions.get(command.requestId);
						if (pending)
							yield* Deferred.fail(pending.deferred, command.failure);
					}
					return;
				}
				case "abort":
					this.sinkBindings.get(command.sinkId)?.abortController.abort();
			}
		});
	}
	resolvePermission(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
		response?: PermissionResponse,
	): Effect.Effect<boolean, SessionFailure> {
		return Effect.gen({ self: this }, function* () {
			const binding = Array.from(this.sinkBindings.values()).find(
				(binding) =>
					binding.sessionId === sessionId && binding.permissions.has(requestId),
			);
			if (!binding) return false;
			yield* binding.sink
				.resolvePermission(requestId, response ?? { decision })
				.pipe(
					Effect.mapError((cause) => ({
						operation: "resolvePermission",
						message: cause.message,
						name: cause.name,
					})),
				);
			const waiter = binding.permissions.get(requestId);
			if (waiter) yield* Deferred.succeed(waiter, response ?? { decision });
			return true;
		});
	}
	resolveQuestion(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
		operation?: "reply" | "reject",
	): Effect.Effect<boolean, SessionFailure> {
		return Effect.gen({ self: this }, function* () {
			const binding = Array.from(this.sinkBindings.values()).find(
				(binding) =>
					binding.sessionId === sessionId && binding.questions.has(requestId),
			);
			if (!binding) return false;
			yield* binding.sink.resolveQuestion(requestId, answers).pipe(
				Effect.mapError((cause) => ({
					operation: "resolveQuestion",
					message: cause.message,
					name: cause.name,
				})),
			);
			const waiter = binding.questions.get(requestId);
			if (waiter) {
				if (operation === "reject")
					yield* Deferred.fail(waiter.deferred, {
						operation: "requestQuestion",
						code: "question_rejected",
						message: "Question rejected",
					});
				else yield* Deferred.succeed(waiter.deferred, answers);
			}
			return true;
		});
	}
}
