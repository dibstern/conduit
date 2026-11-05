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
 * 4. Steps race main: each step runs its action, then advances a fake clock past the stack's
 *    polls, draining ready work between ticks, so a step's work never lands in the next one.
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
import { ReadQueryEffectTag } from "../../../../src/lib/persistence/effect/read-query-effect.js";
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
	/** Main's state once each step settles, raw, for the step-by-step comparison (32.2.17.2). */
	readonly snapshots: readonly StepSnapshot[];
}

/** Main's tables the comparison reads beside the event log (gap P9). */
export const mainTables = [
	"provider_command_outbox",
	"provider_command_interactions",
	"provider_command_turns",
	"provider_command_sessions",
	"pending_inputs",
	"pending_approvals",
	"command_receipts",
] as const;

export interface StepSnapshot {
	readonly fact: number;
	/** The events this step appended. */
	readonly events: readonly Readonly<Record<string, unknown>>[];
	/** Every row of `mainTables`, by table. */
	readonly rows: Readonly<
		Record<
			(typeof mainTables)[number],
			readonly Readonly<Record<string, unknown>>[]
		>
	>;
	readonly inbox: unknown;
	/** The calls main made during this step. */
	readonly calls: readonly Call[];
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
					applyLimitPolicy: () => Effect.void,
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
	const origin = Date.UTC(2026, 0, 1);
	// Timers and Date are faked from before the stack is built until after it is torn down (Effect's
	// scheduler stays on the real setImmediate). Faked only around the steps, the stack's own timers
	// (a 6h sweep, a 30s and two 1s timeouts) ran on the real clock across the steps of this and the
	// next replay, and fired at whichever step the machine's load put them in.
	vi.useFakeTimers({
		toFake: [
			"setTimeout",
			"clearTimeout",
			"setInterval",
			"clearInterval",
			"Date",
		],
		now: origin,
	});
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

			// Failure 4: steps run on the fake clock faked above. A step first
			// moves it to the step's trace time, then 600ms past its action, beyond the reactor's 500ms
			// polls (orchestration-side-effect-reactor.ts 291), in 5ms ticks, draining the stack's ready
			// work before each tick, so whatever a step's timers release lands in that step.
			// Ready work: Effect's scheduler queues setImmediate, and the stack's fs calls (FSReqPromise)
			// finish on libuv's pool, so drained once neither is pending.
			const drain = Effect.promise(async () => {
				do await new Promise<void>((resolve) => setImmediate(resolve));
				while (
					process
						.getActiveResourcesInfo()
						.some((kind) => kind === "Immediate" || kind.startsWith("FSReq"))
				);
			});
			const settle = (until: number) =>
				Effect.gen(function* () {
					while (Date.now() < until) {
						yield* drain;
						vi.advanceTimersByTime(5);
					}
					yield* drain;
				});
			let ingesting: Fiber.Fiber<unknown, unknown> | undefined;

			const read = yield* ReadQueryEffectTag;
			const snapshots: StepSnapshot[] = [];
			let seen = 0;
			let callsSeen = 0;
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
					case "StopTasks":
						return client.StopTasks({
							sessionId,
							tasks: [command.taskId],
						});
				}
			};

			for (const step of steps) {
				current = step.fact;
				// A fact at a later trace time first moves the clock there, so main's own deadlines (a
				// Stop's 30s wait, a send's backoff) fall due where the trace's do.
				yield* settle(origin + step.at);
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
						rpcs.push({ fact: step.fact, rpc: step.command.rpc, fiber });
						break;
					}
					case "call": {
						const { call } = step;
						// The step before settled, so a call main makes for this step has arrived.
						const arrived = calls.find(
							(made) =>
								made.call.kind === "send" &&
								call.kind === "send" &&
								made.call.inputId === call.inputId &&
								made.call.transmission === call.transmission,
						);
						if (arrived !== undefined) tokenCall.set(step.token, arrived);
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
						// Forked: a frame whose handling waits on a timer would otherwise wait on a clock
						// nothing advances until the step settles.
						ingesting = yield* Effect.forkScoped(
							Effect.forEach(step.frames, (frame) => {
								const event: SSEEvent = JSON.parse(
									JSON.stringify(frame)
										.replaceAll(placeholder.session, target.session)
										.replaceAll(
											placeholder.message,
											target.messageId ?? placeholder.message,
										),
								);
								return ingress.onSSEEventEffect(
									event,
									target.session,
									"opencode",
									{
										providerProcessId: api.promptProcessId,
										directory: scratch,
									},
								);
							}),
						);
						break;
					}
					case "start":
					case "replied":
					case "main":
					case "unwired":
						break;
				}
				yield* settle(Date.now() + 600);
				if (ingesting !== undefined) {
					if (ingesting.pollUnsafe() === undefined)
						unmatched.push({
							fact: step.fact,
							why: "frames not ingested by the step's end",
						});
					else yield* Fiber.join(ingesting);
					ingesting = undefined;
				}
				const events = yield* sql<Record<string, unknown>>`
					SELECT sequence, session_id, type, data, metadata, provider FROM events
					WHERE sequence > ${seen} ORDER BY sequence`.pipe(Effect.orDie);
				seen = Number(events.at(-1)?.["sequence"] ?? seen);
				const rows = yield* Effect.forEach(mainTables, (table) =>
					sql<
						Record<string, unknown>
					>`SELECT * FROM ${sql(table)} ORDER BY rowid`.pipe(
						Effect.orDie,
						Effect.map((found) => [table, found] as const),
					),
				);
				snapshots.push({
					fact: step.fact,
					events: events.map(({ sequence: _, ...event }) => event),
					rows: Object.fromEntries(rows) as StepSnapshot["rows"],
					inbox: yield* read.readInboxState(sessionId).pipe(Effect.orDie),
					calls: calls.slice(callsSeen).map(({ call }) => call),
				});
				callsSeen = calls.length;
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
				snapshots,
			};
		}).pipe(
			Effect.scoped,
			Effect.provide(layer),
			Effect.ensuring(
				Effect.sync(() => {
					vi.useRealTimers();
					__setProbeOverrideForTesting(undefined);
					rmSync(scratch, { recursive: true, force: true });
				}),
			),
		),
	);
}
