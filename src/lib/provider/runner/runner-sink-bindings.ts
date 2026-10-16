import { Deferred, Effect } from "effect";
import { EventSinkIngestionError } from "../event-sink-errors.js";
import type {
	EventSink,
	PermissionDecision,
	PermissionResponse,
} from "../types.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
} from "./session-runner.js";

/** Owns every turn abort and the interaction waits retained across attachment loss. */
export class RunnerSinkBindings {
	/** The first send's abort signal stays linked for the query's lifetime. */
	private readonly sessionAbortSources = new Map<string, EventSink>();
	private readonly sinkBindings = new Map<
		string,
		{
			readonly sessionId: string;
			readonly finished: Deferred.Deferred<void>;
			readonly sink: EventSink;
			readonly abortController: AbortController;
			readonly permissions: Map<
				string,
				Deferred.Deferred<PermissionResponse, SessionFailure>
			>;
			readonly questions: Map<
				string,
				Deferred.Deferred<Record<string, unknown>, SessionFailure>
			>;
			references: number;
		}
	>();

	constructor(
		private readonly emit: (
			output: SessionOutput,
		) => Effect.Effect<SessionOutputReply, SessionFailure>,
	) {}
	makeSessionSink(
		sinkId: string,
		sessionId: string,
		finished: Deferred.Deferred<void>,
	): EventSink {
		const permissions = new Map<
			string,
			Deferred.Deferred<PermissionResponse, SessionFailure>
		>();
		const questions = new Map<
			string,
			Deferred.Deferred<Record<string, unknown>, SessionFailure>
		>();
		const sinkFailure = (cause: SessionFailure) =>
			new EventSinkIngestionError({
				cause: Object.assign(new Error(cause.message), cause),
			});
		const emit = (output: SessionOutput) =>
			this.emit(output).pipe(Effect.asVoid, Effect.mapError(sinkFailure));
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
					questions.set(request.requestId, deferred);
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
				emit({ type: "resolve-question", sinkId, requestId, answers }),
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
								Deferred.fail(pending, {
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
			finished,
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
	releaseSinkEffect(sink: EventSink | undefined): Effect.Effect<void> {
		return Effect.gen(this, function* () {
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
				yield* Deferred.fail(pending, {
					operation: "requestQuestion",
					message: binding.abortController.signal.aborted
						? "Turn interrupted"
						: "Runner sink released",
				});
			}
			this.sinkBindings.delete(sink.runnerSinkId);
			yield* this.emit({
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
	awaitSessionSends(sessionId: string): Effect.Effect<void> {
		return Effect.forEach(
			Array.from(this.sinkBindings.values()).filter(
				(binding) => binding.sessionId === sessionId,
			),
			(binding) => Deferred.await(binding.finished),
			{ discard: true },
		);
	}
	sessionSendsFinished(sessionId: string): Effect.Effect<boolean> {
		return Effect.forEach(
			Array.from(this.sinkBindings.values()).filter(
				(binding) => binding.sessionId === sessionId,
			),
			(binding) => Deferred.isDone(binding.finished),
		).pipe(Effect.map((finished) => finished.every(Boolean)));
	}
	retainAbortSource(sessionId: string, sink: EventSink): void {
		this.retainSink(sink);
		this.sessionAbortSources.set(sessionId, sink);
	}
	releaseAbortSource(sessionId: string): Effect.Effect<void> {
		return Effect.suspend(() => {
			const source = this.sessionAbortSources.get(sessionId);
			this.sessionAbortSources.delete(sessionId);
			return this.releaseSinkEffect(source);
		});
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
		return Effect.gen(this, function* () {
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
					if (pending) yield* Deferred.succeed(pending, command.answers);
					return;
				}
				case "interaction-failed": {
					const binding = this.sinkBindings.get(command.sinkId);
					if (command.kind === "permission") {
						const pending = binding?.permissions.get(command.requestId);
						if (pending) yield* Deferred.fail(pending, command.failure);
					} else {
						const pending = binding?.questions.get(command.requestId);
						if (pending) yield* Deferred.fail(pending, command.failure);
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
	): Effect.Effect<boolean, SessionFailure> {
		return Effect.gen(this, function* () {
			const binding = Array.from(this.sinkBindings.values()).find(
				(binding) =>
					binding.sessionId === sessionId && binding.permissions.has(requestId),
			);
			if (!binding) return false;
			yield* binding.sink.resolvePermission(requestId, { decision }).pipe(
				Effect.mapError((cause) => ({
					operation: "resolvePermission",
					message: cause.message,
					name: cause.name,
				})),
			);
			return true;
		});
	}
	resolveQuestion(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<boolean, SessionFailure> {
		return Effect.gen(this, function* () {
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
			return true;
		});
	}
}
