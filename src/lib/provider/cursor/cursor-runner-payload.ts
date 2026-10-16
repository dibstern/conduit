import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
import { CursorModelParameters } from "./cursor-runner-driver.js";
import { createCursorSdkPort } from "./cursor-sdk.js";
import { cursorSessionConfig } from "./cursor-session-config.js";
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
	onCancel?: (() => void) | undefined;
}

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
	| {
			readonly channel: "wait";
			readonly result: Either.Either<unknown, SessionFailure>;
	  };

const sdkCall = <A>(operation: string, run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause): SessionFailure => {
			const failure = cursorSdkFailure(operation, cause);
			return {
				operation,
				message: failure.reason,
				code: failure.code ?? "provider_error",
				retryable: failure.retryable ?? false,
				...(cause instanceof CursorSdkFailure &&
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
			const storePath = join(
				this.deps.daemonConfigDir,
				"cursor",
				"stores",
				input.sessionId,
			);
			const recoveryPath = join(storePath, "interrupted-run.json");
			let abandoned = false;
			let acceptingUpdates = true;
			let settled = false;
			let waitForRun: (() => Promise<unknown>) | undefined;
			let cost: number | undefined;
			const events = new CursorTurnEvents(
				input.sessionId,
				createEventId(),
				sink,
			);
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
							"Cursor requires a credential; set CURSOR_API_KEY or log in with the Cursor SDK",
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
					const recovery = yield* sdkCall("read interrupted run", async () => {
						let text: string;
						try {
							text = await readFile(recoveryPath, "utf8");
						} catch (cause) {
							if (
								cause instanceof Error &&
								"code" in cause &&
								cause.code === "ENOENT"
							)
								return undefined;
							throw cause;
						}
						const decoded = Schema.decodeUnknownEither(
							Schema.Struct({
								controllerPid: Schema.Int.pipe(Schema.positive()),
								agentId: Schema.String,
							}),
						)(JSON.parse(text));
						if (Either.isLeft(decoded))
							throw new CursorSdkFailure({
								operation: "read interrupted run",
								reason: "Invalid Cursor interrupted-run recovery record",
							});
						return decoded.right;
					});
					if (recovery) {
						// force only expires persistence. The old controller must be dead
						// before resuming, otherwise it could still execute the abandoned run.
						yield* Effect.gen(function* () {
							while (true) {
								const alive = yield* Effect.sync(() => {
									try {
										process.kill(recovery.controllerPid, 0);
										return true;
									} catch (cause) {
										return !(
											cause instanceof Error &&
											"code" in cause &&
											cause.code === "ESRCH"
										);
									}
								});
								if (!alive) break;
								yield* Effect.sleep("50 millis");
							}
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
						session.agentId = recovery.agentId;
					}
					const config = cursorSessionConfig({
						cwd: session.cwd,
						storePath,
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
								Effect.tapError(() =>
									Effect.sync(() => {
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
					events.refs.providerSessionId = session.agentId;
					const queue = yield* Queue.unbounded<Update>();
					const agent = session.open.agent;
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
								...(recovery ? { local: { force: true as const } } : {}),
							},
							(value) => {
								if (acceptingUpdates)
									Queue.unsafeOffer(queue, { channel: "delta", value });
							},
						),
					);
					if (recovery)
						yield* sdkCall("clear interrupted run", () => unlink(recoveryPath));
					session.run = run;
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
							// A durable marker precedes terminal publication, so immediate
							// input cannot race provider-state persistence on the daemon.
							yield* sdkCall("record interrupted run", async () => {
								await mkdir(storePath, { recursive: true, mode: 0o700 });
								await writeFile(
									recoveryPath,
									`${JSON.stringify({ controllerPid: process.pid, agentId: agent.id })}\n`,
									{ mode: 0o600 },
								);
							});
							this.deps.onAbandonedRun?.(input.inputId);
							return yield* finish("interrupted");
						}
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
							error.message,
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
				),
			).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						acceptingUpdates = false;
						session.busy = false;
						session.run = undefined;
						session.onCancel = undefined;
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
								userMessageId: input.inputId,
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
			if (session) session.cancelRequested = true;
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
