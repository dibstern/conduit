import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Effect, Either, Fiber, Queue, Schema, Stream } from "effect";
import { createEventId } from "../../persistence/events.js";
import { makeInProcessSessionRunner } from "../runner/in-process-session-runner.js";
import type { LiveSettings, RunnerPayload } from "../runner/runner-payload.js";
import type { RunnerSinkBindings } from "../runner/runner-sink-bindings.js";
import type {
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionTurn,
} from "../runner/session-runner.js";
import type { EventSink, TurnErrorCode, TurnResult } from "../types.js";
import { resolveCursorCredential } from "./cursor-credential.js";
import { createCursorSdkPort } from "./cursor-sdk.js";
import { cursorSessionConfig } from "./cursor-session-config.js";
import { CursorTurnEvents } from "./cursor-turn-events.js";
import { CursorSdkFailure } from "./sdk-error.js";
import type {
	CursorAgent,
	CursorAgentOptions,
	CursorRun,
	CursorSdkPort,
	CursorStore,
} from "./sdk-port.js";

export interface CursorRunnerDeps {
	readonly workspaceRoot: string;
	readonly daemonConfigDir: string;
	readonly port?: CursorSdkPort;
	readonly environment?: () => Readonly<Record<string, string | undefined>>;
}

interface CursorSession {
	readonly cwd: string;
	agentId?: string | undefined;
	open?:
		| {
				readonly agent: CursorAgent;
				readonly store: CursorStore;
				readonly options: CursorAgentOptions;
		  }
		| undefined;
	run?: CursorRun | undefined;
	busy: boolean;
	cancelRequested: boolean;
}

const decodeTerminal = Schema.decodeUnknownEither(
	Schema.Struct({
		status: Schema.Literal("finished", "cancelled", "error"),
		requestId: Schema.optional(Schema.String),
		durationMs: Schema.optional(Schema.Number),
		error: Schema.optional(
			Schema.Struct({
				message: Schema.String,
				code: Schema.optional(Schema.String),
			}),
		),
	}),
);

type Update =
	| { readonly channel: "delta"; readonly value: unknown }
	| { readonly channel: "stream"; readonly value: unknown }
	| {
			readonly channel: "wait";
			readonly result: Either.Either<unknown, SessionFailure>;
	  };

const sdkCall = <A>(operation: string, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause): SessionFailure => ({
			operation,
			message:
				cause instanceof CursorSdkFailure && cause.authRequired
					? "Cursor authentication failed. Log in to Cursor in Settings."
					: cause instanceof CursorSdkFailure
						? cause.reason
						: `Cursor ${operation} failed`,
			...(cause instanceof CursorSdkFailure && cause.authRequired
				? { code: "auth_required", retryable: false }
				: cause instanceof CursorSdkFailure &&
						cause.operation === "sandbox.prime"
					? { code: "sandbox_unavailable", retryable: false }
					: {}),
		}),
	});

export class CursorRunnerPayload implements RunnerPayload {
	private readonly sessions = new Map<string, CursorSession>();
	private primed = false;
	private sandboxFailed = false;
	private readonly sdk: CursorSdkPort;

	constructor(
		private readonly deps: CursorRunnerDeps,
		private readonly sinks: RunnerSinkBindings,
		private readonly emit: (
			output: SessionOutput,
		) => Effect.Effect<SessionOutputReply, SessionFailure>,
	) {
		this.sdk = deps.port ?? createCursorSdkPort();
	}

	sendTurn(
		input: SessionTurn,
		sink: EventSink,
		signal: AbortSignal,
	): Effect.Effect<TurnResult, SessionFailure> {
		return Effect.suspend(() => {
			let state = this.sessions.get(input.sessionId);
			if (!state) {
				const storedCwd = input.providerState["cursor.cwd"];
				const storedId = input.providerState["cursor.agentId"];
				state = {
					cwd: typeof storedCwd === "string" ? storedCwd : input.workspaceRoot,
					busy: false,
					cancelRequested: false,
					...(typeof storedId === "string" ? { agentId: storedId } : {}),
				};
				this.sessions.set(input.sessionId, state);
			}
			const session = state;
			if (session.busy)
				return Effect.succeed(this.result(session, "steer-declined", 0));
			session.busy = true;
			session.cancelRequested = false;
			const started = Date.now();
			const events = new CursorTurnEvents(
				input.sessionId,
				createEventId(),
				sink,
			);
			const finish = (
				status: "completed" | "interrupted" | "error",
				code?: TurnErrorCode,
				message?: string,
			) =>
				Effect.succeed(
					this.result(session, status, Date.now() - started, code, message),
				);

			return Effect.scoped(
				Effect.gen(this, function* () {
					// The daemon places only sends that reach an idle session, so a send
					// that starts here just after a turn ends places its own message
					// (placement is idempotent). A continuation places nothing: it
					// resumes the cut-off message's turn.
					const sinkId = this.sinks.sinkId(sink);
					if (sinkId && !input.continuation)
						yield* this.emit({
							type: "place-user-message",
							sinkId,
							input: {
								sessionId: input.sessionId,
								inputId: input.inputId,
								text: input.text ?? input.prompt,
							},
						});
					yield* events.push("session.status", {
						sessionId: input.sessionId,
						status: "busy",
					});
					yield* events.push("message.created", {
						messageId: events.messageId,
						sessionId: input.sessionId,
						role: "assistant",
					});
					const credential = yield* sdkCall("credential lookup", () =>
						resolveCursorCredential(
							this.sdk,
							this.deps.environment?.() ?? process.env,
						),
					);
					if (!credential)
						return yield* finish(
							"error",
							"auth_required",
							"Cursor authentication required. Log in to Cursor in Settings.",
						);
					if (!input.model)
						return yield* finish(
							"error",
							"send_failed",
							"Select a Cursor model before sending",
						);
					if (this.sandboxFailed)
						return yield* finish(
							"error",
							"sandbox_unavailable",
							"Cursor sandbox initialization failed; restart the runner before retrying",
						);
					const config = cursorSessionConfig({
						cwd: session.cwd,
						storePath: join(
							this.deps.daemonConfigDir,
							"cursor",
							"stores",
							input.sessionId,
						),
						workspaceRoot: input.workspaceRoot,
						extraFolders: input.extraFolders,
						permissionMode: input.permissionMode,
						modelId: input.model.modelId,
						credential,
					});
					if (
						session.open &&
						!isDeepStrictEqual(session.open.options, config.agent)
					)
						yield* this.close(session);
					if (!session.open) {
						const store = yield* Effect.acquireRelease(
							sdkCall("store open", () =>
								this.sdk.openStore(config.agent.storePath, config.agent.cwd),
							),
							(store) =>
								sdkCall("store dispose", () => store.dispose()).pipe(
									Effect.catchAll((failure) =>
										Effect.logError(failure.message),
									),
								),
						);
						if (!this.primed) {
							yield* Effect.uninterruptible(
								sdkCall("sandbox prime", () =>
									this.sdk.primeSandbox(config.agent, credential, store),
								),
							).pipe(
								Effect.tapError((failure) =>
									Effect.sync(() => {
										if (failure.code !== "auth_required")
											this.sandboxFailed = true;
									}),
								),
							);
							this.primed = true;
						}
						const customTools = {};
						const agent = yield* Effect.acquireRelease(
							sdkCall("agent open", () =>
								session.agentId
									? this.sdk.resumeAgent(
											session.agentId,
											config.agent,
											credential,
											store,
											customTools,
										)
									: this.sdk.createAgent(
											config.agent,
											credential,
											store,
											customTools,
										),
							),
							(agent) =>
								sdkCall("agent close", () => agent.close()).pipe(
									Effect.catchAll((failure) =>
										Effect.logError(failure.message),
									),
									Effect.ensuring(
										Effect.sync(() => {
											if (session.open?.agent === agent)
												session.open = undefined;
										}),
									),
								),
						);
						session.agentId = agent.id;
						session.open = { agent, store, options: config.agent };
					}
					events.refs.providerSessionId = session.agentId;
					const queue = yield* Queue.unbounded<Update>();
					const agent = session.open.agent;
					const run = yield* sdkCall("send", () =>
						agent.send(input.prompt, config.send, (value) => {
							Queue.unsafeOffer(queue, { channel: "delta", value });
						}),
					);
					session.run = run;
					if (session.cancelRequested) yield* this.interrupt(input.sessionId);
					events.refs.providerTurnId = run.id;
					const abort = Effect.async<void>((resume) => {
						const onAbort = () => resume(Effect.void);
						if (signal.aborted) onAbort();
						else signal.addEventListener("abort", onAbort, { once: true });
						return Effect.sync(() =>
							signal.removeEventListener("abort", onAbort),
						);
					});
					yield* Effect.forkScoped(
						abort.pipe(
							Effect.andThen(this.interrupt(input.sessionId)),
							Effect.catchAll((failure) => Effect.logError(failure.message)),
						),
					);
					const stream = yield* Effect.forkScoped(
						Stream.fromAsyncIterable(
							run.stream,
							(): SessionFailure => ({
								operation: "stream",
								message: "Cursor stream failed",
							}),
						).pipe(
							Stream.runForEach((value) =>
								Queue.offer(queue, { channel: "stream", value }),
							),
							Effect.catchAll((failure) => Effect.logWarning(failure.message)),
						),
					);
					yield* Effect.forkScoped(
						sdkCall("wait", () => run.wait()).pipe(
							Effect.either,
							Effect.flatMap((result) =>
								Queue.offer(queue, { channel: "wait", result }),
							),
						),
					);
					while (true) {
						const update = yield* Queue.take(queue);
						if (update.channel === "delta") {
							yield* events.delta(update.value);
							continue;
						}
						if (update.channel === "stream") {
							yield* events.stream(update.value);
							continue;
						}
						// Stream closure and turn-ended deltas never settle a turn. Only wait does.
						yield* Fiber.interrupt(stream);
						for (const pending of yield* Queue.takeAll(queue)) {
							if (pending.channel === "delta")
								yield* events.delta(pending.value);
							else if (pending.channel === "stream")
								yield* events.stream(pending.value);
						}
						if (Either.isLeft(update.result))
							return yield* finish(
								"error",
								update.result.left.code === "auth_required"
									? "auth_required"
									: "provider_error",
								update.result.left.message,
							);
						const terminal = decodeTerminal(update.result.right);
						if (Either.isLeft(terminal))
							return yield* finish(
								"error",
								"provider_error",
								"Cursor wait ended without a terminal status",
							);
						if (terminal.right.requestId)
							events.refs.providerRequestId = terminal.right.requestId;
						if (terminal.right.status === "finished")
							return yield* finish("completed");
						if (terminal.right.status === "cancelled")
							return yield* finish("interrupted");
						// SDK 1.0.37 toRunError preserves Connect's authentication code.
						const authRequired =
							terminal.right.error?.code === "unauthenticated";
						return yield* finish(
							"error",
							authRequired ? "auth_required" : "provider_error",
							authRequired
								? "Cursor authentication failed. Log in to Cursor in Settings."
								: (terminal.right.error?.message ?? "Cursor run failed"),
						);
					}
				}).pipe(
					Effect.catchAll((failure) =>
						finish(
							"error",
							"code" in failure && failure.code === "sandbox_unavailable"
								? "sandbox_unavailable"
								: "code" in failure && failure.code === "auth_required"
									? "auth_required"
									: "provider_error",
							"message" in failure
								? String(failure.message)
								: "Cursor turn failed",
						),
					),
				),
			).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						session.busy = false;
						session.run = undefined;
					}),
				),
				Effect.flatMap((result) =>
					Effect.gen(function* () {
						// Cleanup and admission readiness precede the terminal publication.
						// Otherwise an inbox input can be removed while this payload is busy.
						const durationMs = Date.now() - started;
						yield* events.endThinking();
						if (result.status === "completed")
							yield* events.push("turn.completed", {
								messageId: events.messageId,
								...(session.agentId
									? { providerSessionId: session.agentId }
									: {}),
								duration: durationMs,
							});
						else if (result.status === "interrupted")
							yield* events.push("turn.interrupted", {
								messageId: events.messageId,
							});
						else
							yield* events.push("turn.error", {
								messageId: events.messageId,
								userMessageId: input.inputId,
								error: result.error?.message ?? "Cursor turn failed",
								code: result.error?.code ?? "provider_error",
							});
						yield* events.push("session.status", {
							sessionId: input.sessionId,
							status: "idle",
						});
						return { ...result, durationMs };
					}).pipe(
						Effect.mapError(
							(): SessionFailure => ({
								operation: "persist Cursor turn",
								message: "Could not persist Cursor turn outcome",
							}),
						),
					),
				),
			);
		});
	}

	interrupt(sessionId: string) {
		return Effect.suspend(() => {
			const session = this.sessions.get(sessionId);
			if (session) session.cancelRequested = true;
			const run = session?.run;
			return run ? sdkCall("cancel", () => run.cancel()) : Effect.void;
		});
	}

	applySettings(_sessionId: string, _settings: LiveSettings) {
		return Effect.void;
	}

	endSession(sessionId: string) {
		return Effect.gen(this, function* () {
			const session = this.sessions.get(sessionId);
			if (!session) return;
			yield* this.interrupt(sessionId);
			yield* this.close(session);
			this.sessions.delete(sessionId);
		});
	}

	shutdown() {
		return Effect.forEach(this.sessions.keys(), (id) => this.endSession(id), {
			discard: true,
		});
	}
	getResumeSessionIdEffect(sessionId: string) {
		return Effect.sync(() => this.sessions.get(sessionId)?.agentId);
	}

	private close(session: CursorSession) {
		return Effect.gen(function* () {
			const open = session.open;
			if (!open) return;
			yield* sdkCall("agent close", () => open.agent.close());
			session.open = undefined;
		});
	}

	private result(
		session: CursorSession,
		status: TurnResult["status"],
		durationMs: number,
		code?: TurnErrorCode,
		message?: string,
	): TurnResult {
		return {
			status,
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs,
			...(code
				? {
						error: {
							code,
							message: message ?? "Cursor turn failed",
							retryable: false,
						},
					}
				: {}),
			providerStateUpdates: session.agentId
				? [
						{ key: "cursor.agentId", value: session.agentId },
						{ key: "cursor.cwd", value: session.cwd },
					]
				: [],
		};
	}
}

export const makeCursorSessionRunner = (
	deps: CursorRunnerDeps,
	emit: (
		output: SessionOutput,
	) => Effect.Effect<SessionOutputReply, SessionFailure>,
) =>
	makeInProcessSessionRunner(
		(sinks) => Effect.sync(() => new CursorRunnerPayload(deps, sinks, emit)),
		emit,
	);
