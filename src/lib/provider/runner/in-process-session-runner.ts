import { Deferred, Effect, type Scope } from "effect";
import type { TurnResult } from "../types.js";
import type { RunnerPayload } from "./runner-payload.js";
import { RunnerSinkBindings } from "./runner-sink-bindings.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionRunner,
} from "./session-runner.js";

export const makeInProcessSessionRunner = (
	makePayload: (
		sinks: RunnerSinkBindings,
	) => Effect.Effect<RunnerPayload, never, Scope.Scope>,
	emit: (
		output: SessionOutput,
	) => Effect.Effect<SessionOutputReply, SessionFailure>,
): Effect.Effect<SessionRunner, never, Scope.Scope> =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const sinks = new RunnerSinkBindings(emit);
		const payload = yield* makePayload(sinks);
		const runner = new InProcessSessionRunner(payload, sinks, scope);
		yield* Effect.addFinalizer(() =>
			runner.executeEffect({ type: "shutdown" }).pipe(Effect.ignore),
		);
		return runner;
	});

/** Executes sends concurrently: only the payload decides how a steer is admitted. */
export class InProcessSessionRunner implements SessionRunner {
	private readonly sessions = new Set<string>();
	constructor(
		private readonly payload: RunnerPayload,
		private readonly sinks: RunnerSinkBindings,
		private readonly scope: Scope.Scope,
	) {}
	hasPendingSubagentFinalizers(sessionId: string): boolean {
		return this.payload.hasPendingSubagentFinalizers?.(sessionId) ?? false;
	}
	getResumeSessionIdEffect(sessionId: string) {
		return (
			this.payload.getResumeSessionIdEffect?.(sessionId) ??
			Effect.succeed(undefined)
		);
	}
	getNativeSessionEffect(sessionId: string) {
		return (
			this.payload.getNativeSessionEffect?.(sessionId) ??
			Effect.succeed(undefined)
		);
	}

	executeEffect(
		command: Extract<SessionCommand, { type: "send-turn" }>,
	): Effect.Effect<TurnResult, SessionFailure>;
	executeEffect(
		command: Exclude<SessionCommand, { type: "send-turn" }>,
	): Effect.Effect<void, SessionFailure>;
	executeEffect(
		command: SessionCommand,
	): Effect.Effect<TurnResult | undefined, SessionFailure>;
	executeEffect(
		command: SessionCommand,
	): Effect.Effect<TurnResult | undefined, SessionFailure> {
		return Effect.gen({ self: this }, function* () {
			switch (command.type) {
				case "send-turn": {
					this.sessions.add(command.input.sessionId);
					const finished = yield* Deferred.make<void>();
					const sink = this.sinks.makeSessionSink(
						command.sinkId,
						command.input.sessionId,
						finished,
					);
					const controller = this.sinks.controller(command.sinkId);
					if (!controller)
						return yield* Effect.die("Missing runner sink binding");
					if (command.aborted) controller.abort();
					return yield* Effect.gen({ self: this }, function* () {
						yield* this.payload.prepareTurn?.(command, sink) ?? Effect.void;
						return yield* this.payload.sendTurn(
							command.input,
							sink,
							controller.signal,
						);
					}).pipe(
						Effect.map((result) =>
							result.status === "completed" && command.input.handoff
								? { ...result, handoff: command.input.handoff }
								: result,
						),
						Effect.ensuring(Deferred.succeed(finished, undefined)),
						Effect.ensuring(this.sinks.releaseSinkEffect(sink)),
					);
				}
				case "answer-permission":
				case "answer-question":
				case "interaction-failed":
				case "abort":
					return yield* this.sinks.settle(command);
				case "resolve-permission":
					if (
						!(yield* this.sinks.resolvePermission(
							command.sessionId,
							command.requestId,
							command.decision,
						))
					)
						yield* this.payload.resolvePermission?.(
							command.sessionId,
							command.requestId,
							command.decision,
						) ?? Effect.void;
					return;
				case "resolve-question":
					if (
						!(yield* this.sinks.resolveQuestion(
							command.sessionId,
							command.requestId,
							command.answers,
						))
					)
						yield* this.payload.resolveQuestion?.(
							command.sessionId,
							command.requestId,
							command.answers,
						) ?? Effect.void;
					return;
				case "interrupt":
					return yield* this.payload.interrupt(command.sessionId);
				case "apply-live-settings":
					return yield* this.payload.applySettings(
						command.sessionId,
						command.settings,
					);
				case "end-session":
					yield* this.payload.endSession(command.sessionId);
					this.sessions.delete(command.sessionId);
					return;
				case "pre-warm":
					this.sessions.add(command.sessionId);
					return yield* this.payload.preWarm?.(command) ?? Effect.void;
				case "shutdown":
					if (this.payload.shutdown) return yield* this.payload.shutdown();
					yield* Effect.forEach(
						this.sessions,
						(id) => this.payload.endSession(id),
						{ discard: true },
					);
					this.sessions.clear();
					return;
				case "shutdown-after-turn":
					if (this.payload.shutdownAfterTurn)
						return yield* this.payload.shutdownAfterTurn(command.sessionId);
					yield* this.sinks
						.awaitSessionSends(command.sessionId)
						.pipe(
							Effect.andThen(this.payload.endSession(command.sessionId)),
							Effect.forkIn(this.scope),
						);
					return;
				case "stop-task":
					if (this.payload.stopTask)
						return yield* this.payload.stopTask(
							command.sessionId,
							command.taskId,
						);
					break;
				case "set-permission-mode":
					if (this.payload.setPermissionMode)
						return yield* this.payload.setPermissionMode(
							command.sessionId,
							command.mode,
						);
					break;
			}
			return yield* Effect.fail({
				operation: "executeCommand",
				message: `Unsupported runner command: ${command.type}`,
			});
		}).pipe(Effect.map((result) => result ?? undefined));
	}
}
