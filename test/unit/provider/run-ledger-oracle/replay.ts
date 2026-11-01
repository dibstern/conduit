/**
 * Replays a trace's wire through main's real stack over `:memory:` SQLite (CONTRACT.md 3592, the
 * 32.2.17 row): the browser RPCs, the inbox, the orchestration engine, its reactor and the turn
 * service run unchanged; only the provider is replaced, at the turn-service seam, by one that
 * records each call main makes and answers it from the trace.
 *
 * How it could fail, written before the code:
 * 1. A call main makes goes unanswered and the replay still passes: every call is recorded, and
 *    one no step binds (no send step for its input and transmission, no stop or answer the
 *    browser asked for) is `unanswered`. The gate requires none.
 * 2. A step waits on a call main never makes and hangs: each wait is capped, and the miss is an
 *    `unmatched` step, data for the comparison (32.2.17.2), never a hang.
 * 3. Frames reach the wrong turn: a token's frames go to the query or session its call arrived
 *    on; frames whose call never arrived are `unmatched`, never sent elsewhere.
 * 4. Steps race main: each step settles first, until the event log, the outbox and the calls
 *    stop moving.
 * 5. Teardown calls (a closing query's interrupt) count as unanswered: calls are judged after the
 *    last step settles, before the stack closes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Data, Effect, Fiber, Layer, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { vi } from "vitest";
import { AccountIdSchema } from "../../../../src/lib/contracts/account.js";
import { WsRpcGroup } from "../../../../src/lib/contracts/ws-rpc.js";
import { AccountDirectory } from "../../../../src/lib/domain/daemon/Services/account-directory.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { OpenCodeInstancesTag } from "../../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import {
	type ProviderAdapterProjectContext,
	ProviderAdapters,
} from "../../../../src/lib/domain/daemon/Services/provider-adapters.js";
import { Usage } from "../../../../src/lib/domain/daemon/Services/usage.js";
import { OpenCodeAPITag } from "../../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { SessionWorkspaceLive } from "../../../../src/lib/domain/relay/Layers/session-workspace-layer.js";
import { ContinuationTag } from "../../../../src/lib/domain/relay/Services/continuation.js";
import { makeEffectOpenCodeRuntimeIngress } from "../../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import { makeProviderRuntimeIngestionLive } from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../../src/lib/domain/relay/Services/services.js";
import { SessionEventBusLive } from "../../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	SessionInboxLive,
	SessionInboxTag,
} from "../../../../src/lib/domain/relay/Services/session-inbox.js";
import { sessionPickEvents } from "../../../../src/lib/domain/relay/Services/session-pick.js";
import { OpenCodeApiError } from "../../../../src/lib/errors.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { __setProbeOverrideForTesting } from "../../../../src/lib/provider/claude/claude-capabilities-probe.js";
import { makeClaudeSessionRunner } from "../../../../src/lib/provider/claude/claude-provider-runtime.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import type { SDKMessage } from "../../../../src/lib/provider/claude/types.js";
import { ClaudeBoundaryError } from "../../../../src/lib/provider/event-sink-errors.js";
import { inputIdFromOpenCodeMessageId } from "../../../../src/lib/provider/opencode/opencode-input-message-id.js";
import { getOrchestrationLayer } from "../../../../src/lib/provider/orchestration-wiring.js";
import type { SSEEvent } from "../../../../src/lib/relay/opencode-events.js";
import { WsRpcServerLayer } from "../../../../src/lib/server/ws-rpc.js";
import {
	MOCK_OPENCODE_GPT4_CATALOG,
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockOpenCodeModelService,
	makeOpenCodeInstancesStub,
	makeTestHandlerLayer,
} from "../../../helpers/mock-factories.js";
import { createMockQuery } from "../../../helpers/mock-sdk.js";
import { makeTestOrchestrationRuntimeLayer } from "../../../helpers/provider-adapters.js";
import type { Trace } from "./traces.js";
import {
	type BrowserCommand,
	type Call,
	type CallReply,
	type ClaudeFrame,
	placeholder,
	type WireProvider,
	type WireStep,
	wireSteps,
} from "./wire-frames.js";

class ReplayStreamFailure extends Data.TaggedError("ReplayStreamFailure")<{
	readonly code: string;
}> {}
class ReplayCallLost extends Data.TaggedError("ReplayCallLost")<{
	readonly call: string;
}> {}
class ReplayCallRefused extends Data.TaggedError("ReplayCallRefused")<{
	readonly code: string;
}> {}

/** One Claude query: its frames, in the order the trace gives them. */
interface ClaudeQuery {
	readonly push: (frame: ClaudeFrame) => void;
}

export interface RecordedCall {
	readonly call: Call;
	/** A step answers it (failure 1). */
	readonly bound: boolean;
	/** The step the replay was on when main made it. */
	readonly fact: number;
	readonly session: string;
	readonly messageId?: string;
	readonly query?: ClaudeQuery;
}

export interface ReplayResult {
	readonly steps: readonly WireStep[];
	readonly calls: readonly RecordedCall[];
	/** Calls main made that no step answers: the gate requires none. */
	readonly unanswered: readonly Call[];
	/** Steps that found no call to answer or carry (failure 2, 3). */
	readonly unmatched: readonly {
		readonly fact: number;
		readonly why: string;
	}[];
	/** Browser RPCs main refused, by fact. */
	readonly refusals: readonly {
		readonly fact: number;
		readonly rpc: string;
		readonly why: string;
	}[];
}

const sessionId = "replay-session";
const project = "test-project";

const callKey = (inputId: string, transmission: number) =>
	`${inputId}#${transmission}`;

const stopping = (command: BrowserCommand) =>
	command.rpc === "CancelSession" ||
	command.rpc === "input.sendNow" ||
	command.rpc === "ReloadProviderSession";

/** Replays `trace` as `provider`'s wire; `drop` removes steps, for the gate's red check. */
export function replayTrace(
	trace: Trace,
	provider: WireProvider,
	drop: (step: WireStep) => boolean = () => false,
): Promise<ReplayResult> {
	const steps = wireSteps(trace, provider).filter((step) => !drop(step));
	// Sends bind from the whole trace: main may send before the replay reaches the step.
	const sendReplies = new Map(
		steps.flatMap((step) =>
			step.kind === "call" && step.call.kind === "send"
				? [[callKey(step.call.inputId, step.call.transmission), step.reply]]
				: [],
		),
	);
	// Stops and answers bind only once the browser asked for them.
	const stopReplies: CallReply[] = [];
	const answerReplies = new Map<string, CallReply>();
	const calls: RecordedCall[] = [];
	const unmatched: { fact: number; why: string }[] = [];
	const refusals: { fact: number; rpc: string; why: string }[] = [];
	let stopCalls = 0;
	let current = -1;
	const record = (
		call: Call,
		reply: CallReply | undefined,
		rest: Pick<RecordedCall, "session" | "messageId" | "query">,
	): Promise<void> => {
		calls.push({ call, bound: reply !== undefined, fact: current, ...rest });
		if (reply === undefined || reply.tag === "ok") return Promise.resolve();
		return Promise.reject(
			reply.tag === "lost"
				? new ReplayCallLost({ call: call.kind })
				: provider === "opencode"
					? new OpenCodeApiError({
							message: reply.code,
							endpoint: `/session/${call.kind}`,
							responseStatus: reply.status,
							responseBody: { name: reply.code },
						})
					: new ReplayCallRefused({ code: reply.code }),
		);
	};
	const transmission = (inputId: string) =>
		calls.filter(({ call }) => call.kind === "send" && call.inputId === inputId)
			.length + 1;
	const recordSend = (
		inputId: string,
		rest: Pick<RecordedCall, "session" | "messageId" | "query">,
	) => {
		const n = transmission(inputId);
		return record(
			{ kind: "send", inputId, transmission: n },
			sendReplies.get(callKey(inputId, n)),
			rest,
		);
	};
	/**
	 * The nth stop call answers the nth stop the browser asked for. Main re-sends an abort the
	 * native turn outlives; the trace records no outcome past a control's first transmission
	 * (gap P7), so a re-send is bound to the stops already asked for and returns.
	 */
	const recordStop = (rest: Pick<RecordedCall, "session" | "query">) => {
		const reply =
			stopReplies[stopCalls] ??
			(stopReplies.length > 0 ? { tag: "ok" as const } : undefined);
		stopCalls += 1;
		return record({ kind: "stop" }, reply, rest);
	};
	const recordAnswer = (interactionId: string, session: string) =>
		record(
			{ kind: "answer", interactionId },
			answerReplies.get(interactionId),
			{ session },
		);

	const scratch = mkdtempSync(join(tmpdir(), "conduit-replay-"));
	const api = Object.assign(makeMockOpenCodeAPI(), {
		promptProcessId: `opencode:replay:${trace.id}`,
		controlReplaySafe: true,
	});
	api.session.prompt = vi.fn((session, options) =>
		recordSend(
			inputIdFromOpenCodeMessageId(options.messageId ?? "") ??
				options.text.split(" ")[0] ??
				"",
			{
				session,
				...(options.messageId === undefined
					? {}
					: { messageId: options.messageId }),
			},
		),
	);
	api.session.abort = vi.fn((session) => recordStop({ session }));
	// Main reads the session's directory before it answers a prompt.
	api.session.get = vi.fn(async (session: string) => ({
		id: session,
		directory: scratch,
		projectID: project,
		title: trace.id,
		version: "replay",
		time: { created: 1, updated: 1 },
	}));
	api.question.reply = vi.fn((id) => recordAnswer(id, sessionId));
	api.question.reject = vi.fn((id) => recordAnswer(id, sessionId));
	api.permission.reply = vi.fn((session, id) => recordAnswer(id, session));

	const persistence = makePersistenceEffectLayer(
		":memory:",
		project,
		undefined,
		SessionEventBusLive,
	);
	const accounts = makeMockAccountDirectory([
		{
			driver: "claude",
			id: AccountIdSchema.make("claude"),
			name: "Claude",
			folder: configuredClaudeConfigDir(scratch),
			usageEligible: true,
		},
		{
			driver: "opencode",
			id: AccountIdSchema.make("opencode"),
			name: "OpenCode",
			usageEligible: false,
		},
	]);
	const config = makeMockConfig({ projectDir: scratch, configDir: scratch });
	const orchestration = makeTestOrchestrationRuntimeLayer({
		configDir: scratch,
		workspaceRoot: scratch,
		shellEnv: () => ({ env: {}, declared: {} }),
		claudeRunnerFactory: (deps, emit) => {
			if (deps.capabilitiesService)
				vi.spyOn(deps.capabilitiesService, "get").mockImplementation(() =>
					Effect.fail(
						new ClaudeBoundaryError({
							operation: "probeCapabilities",
							cause: "no capability probe in a replay",
						}),
					),
				);
			return makeClaudeSessionRunner(deps, emit);
		},
		claudeQueryFactory: ({ prompt, options }) => {
			const frames: ClaudeFrame[] = [];
			const asks = new Map<string, AbortController>();
			let closed = false;
			let wake = () => {};
			const query: ClaudeQuery = {
				push: (frame) => {
					frames.push(frame);
					wake();
				},
			};
			void (async () => {
				for await (const user of prompt) {
					await recordSend(user.uuid ?? "", {
						session: sessionId,
						query,
					}).catch(() => undefined);
				}
			})().catch(() => undefined);
			const stream = (async function* (): AsyncGenerator<SDKMessage> {
				for (;;) {
					const frame = frames.shift();
					if (frame === undefined) {
						if (closed) return;
						await new Promise<void>((resume) => {
							wake = resume;
						});
						continue;
					}
					if ("type" in frame) {
						yield frame;
						continue;
					}
					switch (frame.tag) {
						case "end":
							return;
						case "fail":
							throw new ReplayStreamFailure({ code: frame.code });
						case "withdraw":
							asks.get(frame.toolUseID)?.abort();
							break;
						case "ask": {
							const controller = new AbortController();
							asks.set(frame.toolUseID, controller);
							void options
								?.canUseTool?.(frame.toolName, frame.input, {
									signal: controller.signal,
									toolUseID: frame.toolUseID,
									requestId: frame.toolUseID,
								})
								.then(() =>
									controller.signal.aborted
										? undefined
										: recordAnswer(frame.toolUseID, sessionId),
								)
								.catch(() => undefined);
						}
					}
				}
			})();
			return Object.assign(createMockQuery([]), {
				interrupt: vi.fn(() => recordStop({ session: sessionId, query })),
				close: () => {
					closed = true;
					wake();
				},
				next: stream.next.bind(stream),
				return: stream.return.bind(stream),
				throw: stream.throw.bind(stream),
				[Symbol.asyncIterator]: () => stream,
			});
		},
	}).pipe(
		Layer.provideMerge(SessionWorkspaceLive),
		Layer.provideMerge(
			Layer.mergeAll(
				persistence,
				SessionEventBusLive,
				DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
				makeProviderRuntimeIngestionLive().pipe(
					Layer.provide(Layer.merge(persistence, SessionEventBusLive)),
				),
				Layer.succeed(AccountDirectory, accounts),
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(ConfigTag, config),
				Layer.succeed(LoggerTag, makeMockLogger()),
				Layer.succeed(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
			),
		),
	);
	const layer = Layer.unwrap(
		Effect.gen(function* () {
			const wired = yield* getOrchestrationLayer;
			const deps = Layer.mergeAll(
				makeTestHandlerLayer({
					api,
					accountDirectory: accounts,
					config,
					orchestrationEngine: wired.engine,
					providerRegistry: wired.registry,
					persistenceLayer: persistence,
					openCodeModelService: makeMockOpenCodeModelService(
						MOCK_OPENCODE_GPT4_CATALOG,
					),
					seedEvents: [
						canonicalEvent("session.created", sessionId, {
							sessionId,
							title: trace.id,
							provider,
						}),
						...sessionPickEvents(sessionId, {
							harness: provider,
							model:
								provider === "claude"
									? { providerId: "claude", modelId: "sonnet" }
									: { providerId: "openai", modelId: "gpt-4" },
							effort: "",
							contextWindow: "",
						}),
					],
				}),
				SessionEventBusLive,
				Layer.succeed(Usage, {
					readings: Stream.empty,
					latest: () => Effect.succeed(undefined),
					refresh: (_options) => Effect.succeed([]),
					turnEnded: () => Effect.void,
					pickFailover: () => Effect.succeed(undefined),
				}),
				Layer.succeed(ContinuationTag, {
					requestContinuation: () => Effect.void,
					intakeLimit: () => Effect.succeed(false),
					dismissCutOff: () => Effect.void,
					cancelContinuation: () => Effect.void,
					sweepDueContinuations: () => Effect.void,
					queueLimitPolicy: () => Effect.void,
					runLimitPolicies: Effect.never,
				}),
			);
			return WsRpcServerLayer.pipe(
				Layer.provideMerge(SessionInboxLive.pipe(Layer.provideMerge(deps))),
			);
		}),
	).pipe(Layer.provideMerge(orchestration));

	// The capability probe would open a query of its own; main's tests stub it the same way.
	__setProbeOverrideForTesting(async () => ({
		models: [],
		commands: [],
		agents: [],
	}));
	return Effect.runPromise(
		Effect.gen(function* () {
			const adapters = yield* ProviderAdapters;
			yield* adapters.registerProject(
				project,
				yield* Effect.context<ProviderAdapterProjectContext>(),
			);
			yield* adapters.recover;
			yield* (yield* OrchestrationEngineTag).drainSideEffects();
			const wired = yield* getOrchestrationLayer;
			const ingress = yield* makeEffectOpenCodeRuntimeIngress(
				makeMockLogger(),
				undefined,
				(sid, mid) => wired.openCodeInstance.inputIdForUserEcho(sid, mid),
			);
			yield* Effect.addFinalizer(() => Effect.sync(() => ingress.shutdown()));
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			yield* (yield* SessionInboxTag).start;
			const sql = yield* SqlClient.SqlClient;

			// Failure 4: settled once the log, the outbox and the calls hold still for 20ms.
			const fingerprint = sql<{
				readonly n: number;
				readonly outbox: string | null;
			}>`
				SELECT (SELECT count(*) FROM events) AS n,
					(SELECT group_concat(command_id || ':' || status) FROM provider_command_outbox) AS outbox`.pipe(
				Effect.map(([row]) => `${row?.n}|${row?.outbox}|${calls.length}`),
				Effect.orDie,
			);
			const settle = Effect.gen(function* () {
				let last = yield* fingerprint;
				let still = 0;
				while (still < 4) {
					yield* Effect.sleep("5 millis");
					const next = yield* fingerprint;
					still = next === last ? still + 1 : 0;
					last = next;
				}
			}).pipe(Effect.timeoutOption("1 second"));

			const tokenCall = new Map<string, RecordedCall>();
			const rpcs: {
				readonly fact: number;
				readonly rpc: string;
				readonly fiber: Fiber.Fiber<unknown, unknown>;
			}[] = [];
			const lastSend = () =>
				calls.filter(({ call }) => call.kind === "send").at(-1);
			// The browser answers main's own prompt id, minted for the provider's request id.
			const promptId = (interactionId: string) =>
				sql<{ readonly id: string }>`SELECT id FROM pending_approvals
					WHERE provider_request_id = ${interactionId} ORDER BY rowid DESC LIMIT 1`.pipe(
					Effect.map(([row]) => row?.id ?? interactionId),
					Effect.orDie,
				);
			const browser = (
				command: BrowserCommand,
			): Effect.Effect<unknown, unknown> => {
				switch (command.rpc) {
					case "input.submit":
						return client["input.submit"]({
							sessionId,
							inputId: command.inputId,
							text: command.text,
							delivery: command.delivery,
							originId: "replay-browser",
						});
					case "input.sendNow":
						return client["input.sendNow"]({
							sessionId,
							inputId: command.inputId,
							interrupt: true,
						});
					case "CancelSession":
						return client.CancelSession({
							sessionId,
							commandId: command.commandId,
						});
					case "ReloadProviderSession":
						return client.ReloadProviderSession({
							sessionId,
							commandId: command.commandId,
						});
					case "AnswerQuestion":
						return promptId(command.interactionId).pipe(
							Effect.flatMap((toolId) =>
								client.AnswerQuestion({
									projectSlug: project,
									originId: "replay-browser",
									commandId: command.commandId,
									toolId,
									answers: { "Continue?": "yes" },
								}),
							),
						);
					case "RespondPermission":
						return promptId(command.interactionId).pipe(
							Effect.flatMap((requestId) =>
								client.RespondPermission({
									projectSlug: project,
									originId: "replay-browser",
									commandId: command.commandId,
									requestId,
									decision: "allow",
								}),
							),
						);
					case "StopBackgroundTask":
						return client.StopBackgroundTask({
							sessionId,
							taskId: command.taskId,
						});
				}
			};

			for (const step of steps) {
				current = step.fact;
				switch (step.kind) {
					case "browser": {
						if (stopping(step.command)) stopReplies.push(step.reply);
						if (
							step.command.rpc === "AnswerQuestion" ||
							step.command.rpc === "RespondPermission"
						)
							answerReplies.set(step.command.interactionId, step.reply);
						// A stop's reply waits for the native turn to end, which a later step may bring, so
						// the RPC runs on and its reply is read when the trace ends.
						const fiber = yield* Effect.forkScoped(browser(step.command));
						yield* Fiber.await(fiber).pipe(Effect.timeoutOption("500 millis"));
						rpcs.push({ fact: step.fact, rpc: step.command.rpc, fiber });
						break;
					}
					case "call": {
						const { call } = step;
						const arrived = yield* Effect.sleep("5 millis").pipe(
							Effect.map(() =>
								calls.find(
									(made) =>
										made.call.kind === "send" &&
										call.kind === "send" &&
										made.call.inputId === call.inputId &&
										made.call.transmission === call.transmission,
								),
							),
							Effect.repeat({ until: (made) => made !== undefined }),
							Effect.timeoutOption("500 millis"),
						);
						if (arrived._tag === "Some" && arrived.value !== undefined)
							tokenCall.set(step.token, arrived.value);
						else
							unmatched.push({
								fact: step.fact,
								why: `main never made ${JSON.stringify(call)}`,
							});
						break;
					}
					case "frames": {
						const target =
							step.token === null ? lastSend() : tokenCall.get(step.token);
						if (target === undefined) {
							unmatched.push({
								fact: step.fact,
								why: `no call carries ${step.token ?? "the session"}'s frames`,
							});
							break;
						}
						if (step.provider === "claude") {
							if (target.query === undefined)
								unmatched.push({ fact: step.fact, why: "no Claude query" });
							else for (const frame of step.frames) target.query.push(frame);
							break;
						}
						for (const frame of step.frames) {
							const event: SSEEvent = JSON.parse(
								JSON.stringify(frame)
									.replaceAll(placeholder.session, target.session)
									.replaceAll(
										placeholder.message,
										target.messageId ?? placeholder.message,
									),
							);
							const ingested = yield* ingress
								.onSSEEventEffect(event, target.session, "opencode", {
									providerProcessId: api.promptProcessId,
									directory: scratch,
								})
								.pipe(Effect.timeoutOption("3 seconds"));
							if (ingested._tag === "None")
								unmatched.push({
									fact: step.fact,
									why: `${event.type} not ingested in 3s`,
								});
						}
						break;
					}
					case "start":
					case "replied":
					case "main":
					case "unwired":
						break;
				}
				yield* settle;
			}
			for (const { fact, rpc, fiber } of rpcs) {
				const exit = fiber.pollUnsafe();
				if (exit === undefined)
					refusals.push({ fact, rpc, why: "no reply by the trace's end" });
				else if (exit._tag === "Failure")
					refusals.push({
						fact,
						rpc,
						why: `refused: ${String(exit.cause).slice(0, 300)}`,
					});
			}
			return {
				steps,
				calls: [...calls],
				unanswered: calls.filter((made) => !made.bound).map(({ call }) => call),
				unmatched,
				refusals,
			};
		}).pipe(
			Effect.scoped,
			Effect.provide(layer),
			Effect.ensuring(
				Effect.sync(() => {
					__setProbeOverrideForTesting(undefined);
					rmSync(scratch, { recursive: true, force: true });
				}),
			),
		),
	);
}
