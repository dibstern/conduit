import { isDeepStrictEqual } from "node:util";
import { Deferred, Effect, Either, Fiber, Queue, Schema, Stream } from "effect";
import { createEventId } from "../../persistence/events.js";
import { EventSinkIngestionError } from "../event-sink-errors.js";
import { makeInProcessSessionRunner } from "../runner/in-process-session-runner.js";
import type { LiveSettings, RunnerPayload } from "../runner/runner-payload.js";
import { runnerPidAlive } from "../runner/runner-registry.js";
import type { RunnerSinkBindings } from "../runner/runner-sink-bindings.js";
import type {
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionTurn,
} from "../runner/session-runner.js";
import type { EventSink, TurnErrorCode, TurnResult } from "../types.js";
import { resolveCursorCredential } from "./cursor-credential.js";
import { cursorAskUserTool } from "./cursor-questions.js";
import { CursorModelParameters } from "./cursor-runner-driver.js";
import { createCursorSdkPort } from "./cursor-sdk.js";
import { cursorSessionConfig } from "./cursor-session-config.js";
import {
	cursorSessionStorePath,
	readCursorSessionIdentity,
	writeCursorSessionIdentity,
} from "./cursor-session-recovery.js";
import { CursorTurnEvents } from "./cursor-turn-events.js";
import {
	CursorSdkFailure,
	cursorSdkFailure,
	cursorTurnError,
} from "./sdk-error.js";
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
	readonly onAbandonedRun?: (inputId: string) => void;
}

interface CursorSession {
	readonly cwd: string;
	agentId?: string | undefined;
	controllerPid?: number | undefined;
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
	questionAbort?: AbortController | undefined;
	onCancel?: (() => void) | undefined;
	steer?:
		| ((
				input: SessionTurn,
				sink: EventSink,
		  ) => Effect.Effect<TurnResult, SessionFailure>)
		| undefined;
}

const decodeSteeredMessage = Schema.decodeUnknownEither(
	Schema.Struct({
		type: Schema.Literal("user-message-appended"),
		userMessage: Schema.Struct({ text: Schema.String }),
	}),
);

const decodeTerminal = Schema.decodeUnknownEither(
	Schema.Struct({
		status: Schema.Literal("finished", "cancelled", "error"),
		requestId: Schema.optional(Schema.String),
		durationMs: Schema.optional(Schema.Number),
		model: Schema.optional(Schema.Struct({ id: Schema.String })),
		usage: Schema.optional(Schema.Unknown),
		error: Schema.optional(
			Schema.Struct({
				message: Schema.String,
				code: Schema.optional(Schema.String),
			}),
		),
	}),
);

const BillingTokens = Schema.Struct({
	inputTokens: Schema.NonNegative,
	outputTokens: Schema.NonNegative,
	cacheReadTokens: Schema.NonNegative,
	cacheWriteTokens: Schema.NonNegative,
});
const BillingCost = Schema.Struct({ chargedCents: Schema.NonNegative });
const decodeBilling = Schema.decodeUnknownEither(
	Schema.Struct({
		usage: BillingTokens,
		cost: Schema.optional(BillingCost),
		runs: Schema.Array(
			Schema.Struct({
				runId: Schema.String,
				usage: BillingTokens,
				cost: Schema.optional(BillingCost),
			}),
		),
	}),
);

type Update =
	| { readonly channel: "cancel" }
	| { readonly channel: "interrupt-timeout" }
	| { readonly channel: "delta"; readonly value: unknown }
	| { readonly channel: "stream"; readonly value: unknown }
	| { readonly channel: "question"; readonly answer: Effect.Effect<void> }
	| {
			readonly channel: "steer-result";
			readonly inputId: string;
			readonly delivered: boolean;
	  }
	| {
			readonly channel: "wait";
			readonly result: Either.Either<unknown, SessionFailure>;
	  };

const sdkCall = <A>(operation: string, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause): SessionFailure => {
			const failure = cursorSdkFailure(operation, cause);
			const error = cursorTurnError(failure);
			return {
				operation,
				message: error.message,
				code: error.code,
				retryable: error.retryable ?? false,
				...(error.code !== "auth_required" &&
				cause instanceof CursorSdkFailure &&
				cause.operation === "sandbox.prime"
					? { code: "sandbox_unavailable", retryable: false }
					: {}),
			};
		},
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
		return Effect.gen(this, function* () {
			let state = this.sessions.get(input.sessionId);
			if (!state) {
				const identity = yield* Effect.try({
					try: () =>
						readCursorSessionIdentity(
							this.deps.daemonConfigDir,
							input.sessionId,
						),
					catch: (): SessionFailure => ({
						operation: "session identity",
						message: "Could not read Cursor session identity",
					}),
				});
				const storedCwd = input.providerState["cursor.cwd"];
				const storedId = input.providerState["cursor.agentId"];
				state = {
					cwd:
						identity?.cwd ??
						(typeof storedCwd === "string" ? storedCwd : input.workspaceRoot),
					busy: false,
					cancelRequested: false,
					...(identity
						? {
								agentId: identity.agentId,
								controllerPid: identity.controllerPid,
							}
						: typeof storedId === "string"
							? { agentId: storedId }
							: {}),
				};
				this.sessions.set(input.sessionId, state);
			}
			const session = state;
			if (session.busy)
				return session.steer
					? yield* session.steer(input, sink)
					: this.result(session, "steer-declined", 0);
			session.busy = true;
			session.cancelRequested = false;
			const questionAbort = new AbortController();
			session.questionAbort = questionAbort;
			const started = Date.now();
			let abandoned = false;
			let acceptingUpdates = true;
			let settled = false;
			let waitForRun: (() => Promise<unknown>) | undefined;
			let cost: number | undefined;
			let currentInputId = input.inputId;
			const events = new CursorTurnEvents(
				input.sessionId,
				createEventId(),
				sink,
				session.cwd,
				{
					instanceId: input.instanceId,
					ensure: (child) => {
						const sinkId = this.sinks.sinkId(sink);
						return sinkId
							? this.emit({
									type: "ensure-subagent-session",
									sinkId,
									input: child,
								}).pipe(
									Effect.asVoid,
									Effect.mapError(
										(cause) => new EventSinkIngestionError({ cause }),
									),
								)
							: Effect.void;
					},
				},
			);
			const steers = new Map<
				string,
				{
					input: SessionTurn;
					sinkId: string;
					shellCalls: readonly string[];
					finished: Deferred.Deferred<TurnResult, SessionFailure>;
					landed: boolean;
					outcome?: boolean;
				}
			>();
			let acceptingSteers = true;
			// All receipts, turn end and cancellation use this one settle point.
			// Retain settled receipts until turn end so an ack plus its user delta
			// cannot consume a second steer with identical text.
			const settleSteer = (inputId: string, delivered: boolean) =>
				Effect.suspend(() => {
					const pending = steers.get(inputId);
					if (!pending || pending.outcome !== undefined) return Effect.void;
					pending.outcome = delivered;
					return Effect.gen(this, function* () {
						if (delivered) {
							yield* events.steerDelivered(pending.shellCalls);
							yield* this.emit({
								type: "place-user-message",
								sinkId: pending.sinkId,
								input: {
									sessionId: input.sessionId,
									inputId,
									text: pending.input.text ?? pending.input.prompt,
								},
							});
							currentInputId = inputId;
						}
						return this.result(
							session,
							delivered ? "joined" : "steer-declined",
							0,
						);
					}).pipe(
						Effect.mapError(
							(): SessionFailure => ({
								operation: "persist Cursor steer",
								message: "Could not persist Cursor steer outcome",
							}),
						),
						Effect.exit,
						Effect.flatMap((exit) => Deferred.done(pending.finished, exit)),
						Effect.asVoid,
					);
				});
			const declinePending = () =>
				Effect.gen(function* () {
					acceptingSteers = false;
					for (const inputId of steers.keys())
						yield* settleSteer(inputId, false);
				});
			const applyUpdate = (update: Update) =>
				Effect.gen(function* () {
					if (update.channel === "steer-result") {
						yield* settleSteer(update.inputId, update.delivered);
					} else if (update.channel === "delta") {
						const message = decodeSteeredMessage(update.value);
						if (Either.isRight(message)) {
							const pending = [...steers.values()].find(
								(steer) =>
									!steer.landed &&
									steer.outcome !== false &&
									steer.input.prompt === message.right.userMessage.text,
							);
							if (pending) {
								pending.landed = true;
								yield* settleSteer(pending.input.inputId, true);
							}
						}
						yield* events.delta(update.value);
					} else if (update.channel === "stream") {
						yield* events.stream(update.value);
					}
				});
			const finish = (
				status: "completed" | "interrupted" | "error",
				code?: TurnErrorCode,
				message?: string,
				retryable = false,
			) =>
				Effect.succeed({
					...this.result(
						session,
						status,
						Date.now() - started,
						code,
						message,
						retryable,
					),
					tokens: events.tokens,
					cost: cost ?? 0,
				});

			return yield* Effect.scoped(
				Effect.gen(this, function* () {
					const queue = yield* Queue.unbounded<Update>();
					const customTools = {
						ask_user: cursorAskUserTool(
							sink,
							events,
							questionAbort.signal,
							(answer) => {
								Queue.unsafeOffer(queue, { channel: "question", answer });
							},
						),
					};
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
					const modelParams =
						input.providerState["cursor.modelParams"] === undefined
							? undefined
							: yield* Schema.decodeUnknown(CursorModelParameters)(
									input.providerState["cursor.modelParams"],
								).pipe(
									Effect.mapError(
										(): SessionFailure => ({
											operation: "model parameters",
											message: "Invalid Cursor model parameters",
										}),
									),
								);
					const config = cursorSessionConfig({
						cwd: session.cwd,
						storePath: cursorSessionStorePath(
							this.deps.daemonConfigDir,
							input.sessionId,
						),
						workspaceRoot: input.workspaceRoot,
						extraFolders: input.extraFolders,
						permissionMode: input.permissionMode,
						modelId: input.model.modelId,
						modelParams,
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
								Effect.suspend(() =>
									abandoned
										? Effect.void
										: sdkCall("store dispose", () => store.dispose()).pipe(
												Effect.catchAll((failure) =>
													Effect.logError(failure.message),
												),
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
								Effect.suspend(() =>
									(abandoned
										? Effect.void
										: sdkCall("agent close", () => agent.close()).pipe(
												Effect.catchAll((failure) =>
													Effect.logError(failure.message),
												),
											)
									).pipe(
										Effect.ensuring(
											Effect.sync(() => {
												if (session.open?.agent === agent)
													session.open = undefined;
											}),
										),
									),
								),
						);
						session.agentId = agent.id;
						session.open = { agent, store, options: config.agent };
					}
					const open = session.open;
					events.refs.providerSessionId = session.agentId;
					const activeRun = yield* sdkCall("active run lookup", () =>
						this.sdk.getActiveRun(open.agent.id, open.store),
					);
					// Public listRuns calls a never-sent queued run "running". Only the
					// persisted document distinguishes it from an orphaned controller.
					const force = activeRun?.status === "running";
					if (
						force &&
						(session.controllerPid === undefined ||
							session.controllerPid === process.pid)
					)
						return yield* finish(
							"error",
							"provider_error",
							"Cursor's previous controller is not confirmed dead; refusing to force its active run",
						);
					if (force && session.controllerPid !== undefined) {
						const controllerPid = session.controllerPid;
						yield* Effect.gen(function* () {
							while (yield* Effect.sync(() => runnerPidAlive(controllerPid)))
								yield* Effect.sleep("50 millis");
						}).pipe(
							Effect.timeoutFail({
								duration: "5 seconds",
								onTimeout: (): SessionFailure => ({
									operation: "recover interrupted run",
									message:
										"Cursor's previous controller has not exited; retry after it stops",
									code: "timeout",
									retryable: true,
								}),
							}),
						);
					}
					yield* Effect.try({
						try: () =>
							writeCursorSessionIdentity(
								this.deps.daemonConfigDir,
								input.sessionId,
								{
									agentId: open.agent.id,
									cwd: session.cwd,
									controllerPid: process.pid,
								},
							),
						catch: (): SessionFailure => ({
							operation: "session identity",
							message: "Could not persist Cursor session identity before send",
						}),
					});
					session.controllerPid = process.pid;
					const agent = open.agent;
					const readUsage = sdkCall("usage", () => agent.getUsage()).pipe(
						Effect.timeout("2 seconds"),
						Effect.map((value) => {
							const decoded = decodeBilling(value);
							return Either.isRight(decoded) ? decoded.right : undefined;
						}),
						Effect.catchAll(() => Effect.succeed(undefined)),
					);
					const beforeUsage = yield* readUsage;
					const run = yield* sdkCall("send", () =>
						agent.send(
							input.prompt,
							{
								...config.send,
								...(force ? { local: { force: true as const } } : {}),
							},
							(value) => {
								if (acceptingUpdates)
									Queue.unsafeOffer(queue, { channel: "delta", value });
							},
						),
					);
					session.run = run;
					const steer = run.steer?.bind(run);
					session.steer = (steeredInput, steerSink) =>
						Effect.scoped(
							Effect.gen(this, function* () {
								const sinkId = this.sinks.sinkId(steerSink);
								const finished = yield* Deferred.make<
									TurnResult,
									SessionFailure
								>();
								if (
									!acceptingSteers ||
									session.cancelRequested ||
									!steer ||
									steeredInput.images?.length ||
									!sinkId
								)
									return this.result(session, "steer-declined", 0);
								steers.set(steeredInput.inputId, {
									input: steeredInput,
									sinkId,
									shellCalls: events.activeShellCalls(),
									finished,
									landed: false,
								});
								yield* Effect.forkScoped(
									sdkCall("steer", () => steer(steeredInput.prompt)).pipe(
										Effect.match({
											onFailure: () => false,
											onSuccess: (outcome) => outcome === "complete_delivered",
										}),
										Effect.flatMap((delivered) =>
											Queue.offer(queue, {
												channel: "steer-result",
												inputId: steeredInput.inputId,
												delivered,
											}),
										),
									),
								);
								return yield* Deferred.await(finished);
							}),
						);
					session.onCancel = () => {
						if (acceptingUpdates)
							Queue.unsafeOffer(queue, { channel: "cancel" });
					};
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
						abort.pipe(Effect.andThen(this.interrupt(input.sessionId))),
					);
					// An async iterator's return can wait behind its stalled next().
					// Await ordinary cleanup, but let controller retirement end a stuck one.
					const stream = yield* Effect.forkDaemon(
						Stream.fromAsyncIterable(run.stream, (cause): SessionFailure => {
							const failure = cursorSdkFailure("stream", cause);
							return {
								operation: "stream",
								message: failure.reason,
								code: failure.code ?? "provider_error",
								retryable: failure.retryable ?? false,
							};
						}).pipe(
							Stream.runForEach((value) =>
								acceptingUpdates
									? Queue.offer(queue, { channel: "stream", value })
									: Effect.void,
							),
							Effect.catchAll((failure) => Effect.logWarning(failure.message)),
						),
					);
					yield* Effect.addFinalizer(() =>
						Effect.suspend(() =>
							abandoned
								? Fiber.interruptFork(stream)
								: Fiber.interrupt(stream).pipe(Effect.asVoid),
						),
					);
					let waiting: Promise<unknown> | undefined;
					waitForRun = () =>
						(waiting ??= run.wait().finally(() => {
							settled = true;
						}));
					const wait = waitForRun;
					yield* Effect.forkScoped(
						sdkCall("wait", wait).pipe(
							Effect.either,
							Effect.flatMap((result) =>
								Queue.offer(queue, { channel: "wait", result }),
							),
						),
					);
					let cancelling = false;
					while (true) {
						const update = yield* Queue.take(queue);
						if (update.channel === "cancel") {
							yield* declinePending();
							if (!cancelling) {
								cancelling = true;
								// Start the deadline when cancel is invoked, even if cancel itself hangs.
								yield* Effect.forkScoped(
									sdkCall("cancel", () => run.cancel()).pipe(
										Effect.catchAll((failure) =>
											Effect.logWarning(failure.message),
										),
									),
								);
								yield* Effect.forkScoped(
									Effect.sleep("10 seconds").pipe(
										Effect.andThen(
											Queue.offer(queue, { channel: "interrupt-timeout" }),
										),
									),
								);
							}
							continue;
						}
						if (update.channel === "interrupt-timeout") {
							if (settled) continue;
							acceptingUpdates = false;
							abandoned = true;
							// The identity persisted before send is the next controller's durable recovery record.
							this.deps.onAbandonedRun?.(input.inputId);
							return yield* finish("interrupted");
						}
						if (
							update.channel === "delta" ||
							update.channel === "stream" ||
							update.channel === "steer-result"
						) {
							yield* applyUpdate(update);
							continue;
						}
						if (update.channel === "question") {
							yield* Effect.forkScoped(update.answer);
							continue;
						}
						// Stream closure and turn-ended deltas never settle a turn. Only wait does.
						yield* Fiber.interrupt(stream);
						for (const pending of yield* Queue.takeAll(queue)) {
							yield* applyUpdate(pending);
						}
						yield* declinePending();
						acceptingUpdates = false;
						if (Either.isLeft(update.result))
							return yield* finish(
								"error",
								cursorTurnError(update.result.left).code,
								update.result.left.message,
								update.result.left.retryable,
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
						if (terminal.right.model?.id)
							yield* events.push("turn.model_resolved", {
								messageId: events.messageId,
								requestedModel: input.model.modelId,
								expectedModel:
									input.model.modelId === "default"
										? terminal.right.model.id
										: input.model.modelId,
								actualModel: terminal.right.model.id,
							});
						events.reconcileUsage(terminal.right.usage);
						const afterUsage = yield* readUsage;
						if (beforeUsage?.cost && afterUsage?.cost) {
							const previous = new Map(
								beforeUsage.runs.map((entry) => [entry.runId, entry]),
							);
							const added = afterUsage.runs.filter(
								(entry) => !previous.has(entry.runId),
							);
							const usage = added.reduce(
								(sum, entry) => ({
									inputTokens: sum.inputTokens + entry.usage.inputTokens,
									outputTokens: sum.outputTokens + entry.usage.outputTokens,
									cacheReadTokens:
										sum.cacheReadTokens + entry.usage.cacheReadTokens,
									cacheWriteTokens:
										sum.cacheWriteTokens + entry.usage.cacheWriteTokens,
								}),
								{
									inputTokens: 0,
									outputTokens: 0,
									cacheReadTokens: 0,
									cacheWriteTokens: 0,
								},
							);
							const expected = {
								inputTokens: events.tokens.input,
								outputTokens: events.tokens.output,
								cacheReadTokens: events.tokens.cacheRead ?? 0,
								cacheWriteTokens: events.tokens.cacheWrite ?? 0,
							};
							const delta = {
								inputTokens:
									afterUsage.usage.inputTokens - beforeUsage.usage.inputTokens,
								outputTokens:
									afterUsage.usage.outputTokens -
									beforeUsage.usage.outputTokens,
								cacheReadTokens:
									afterUsage.usage.cacheReadTokens -
									beforeUsage.usage.cacheReadTokens,
								cacheWriteTokens:
									afterUsage.usage.cacheWriteTokens -
									beforeUsage.usage.cacheWriteTokens,
							};
							const chargedCents = added.reduce(
								(sum, entry) => sum + (entry.cost?.chargedCents ?? 0),
								0,
							);
							// Local billing IDs are usage UUIDs, not Run.id. Require new,
							// matching entries; aggregate-only or late prior bills are ambiguous.
							if (
								added.length > 0 &&
								added.every((entry) => entry.cost !== undefined) &&
								beforeUsage.runs.every((entry) =>
									isDeepStrictEqual(
										entry,
										afterUsage.runs.find((next) => next.runId === entry.runId),
									),
								) &&
								isDeepStrictEqual(usage, expected) &&
								isDeepStrictEqual(delta, expected) &&
								Math.abs(
									chargedCents -
										(afterUsage.cost.chargedCents -
											beforeUsage.cost.chargedCents),
								) < 1e-9
							)
								cost = chargedCents / 100;
						}
						if (terminal.right.status === "finished")
							return yield* finish("completed");
						if (terminal.right.status === "cancelled")
							return yield* finish("interrupted");
						const error = cursorTurnError(
							terminal.right.error ?? { message: "Cursor run failed" },
						);
						return yield* finish(
							"error",
							error.code,
							error.code === "auth_required"
								? `${error.message}\n\nLog in to Cursor in Settings.`
								: error.message,
							error.retryable,
						);
					}
				}).pipe(
					Effect.catchAll((failure) =>
						finish(
							"error",
							cursorTurnError(failure).code,
							"message" in failure
								? String(failure.message)
								: "Cursor turn failed",
							"retryable" in failure && failure.retryable === true,
						),
					),
					Effect.ensuring(Effect.sync(() => questionAbort.abort())),
				),
			).pipe(
				Effect.ensuring(
					declinePending().pipe(
						Effect.andThen(
							Effect.sync(() => {
								acceptingUpdates = false;
								session.busy = false;
								session.run = undefined;
								session.questionAbort = undefined;
								session.onCancel = undefined;
								session.steer = undefined;
							}),
						),
					),
				),
				Effect.flatMap((result) =>
					Effect.gen(function* () {
						// Cleanup and admission readiness precede the terminal publication.
						// Otherwise an inbox input can be removed while this payload is busy.
						const durationMs = Date.now() - started;
						yield* events.finishChildren(
							result.status === "completed"
								? "completed"
								: result.status === "interrupted"
									? "interrupted"
									: "error",
						);
						yield* events.endThinking();
						if (result.status === "completed")
							yield* events.push("turn.completed", {
								messageId: events.messageId,
								...(session.agentId
									? { providerSessionId: session.agentId }
									: {}),
								duration: durationMs,
								// Cursor reports occupancy but no capacity. Zero explicitly
								// distinguishes that absence from legacy omitted metadata.
								tokens: { ...result.tokens, contextWindow: 0 },
								...(events.contextTokens !== undefined
									? { contextTokens: events.contextTokens }
									: {}),
								...(cost !== undefined ? { cost } : {}),
							});
						else if (result.status === "interrupted")
							yield* events.push("turn.interrupted", {
								messageId: events.messageId,
							});
						else
							yield* events.push("turn.error", {
								messageId: events.messageId,
								userMessageId: currentInputId,
								error: result.error?.message ?? "Cursor turn failed",
								code: result.error?.code ?? "provider_error",
								retryable: result.error?.retryable ?? false,
							});
						yield* events.push("session.status", {
							sessionId: input.sessionId,
							status: "idle",
						});
						if (abandoned && waitForRun) {
							// Give late settlement a bounded grace; its updates are already
							// fenced. The owning process is retired even if it never settles.
							yield* sdkCall("await abandoned run", waitForRun).pipe(
								Effect.timeout("1 second"),
								Effect.ignore,
							);
						}
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
			if (session) {
				session.cancelRequested = true;
				session.questionAbort?.abort();
			}
			session?.onCancel?.();
			return Effect.void;
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
		retryable = false,
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
							message: `${message ?? "Cursor turn failed"}\n\n${retryable ? "You can retry this turn." : "Resolve this error before retrying."}`,
							retryable,
							retryHandled: true,
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
