// src/lib/provider/claude/claude-provider-runtime.ts
/**
 * ClaudeProviderRuntime adapts provider operations and EventSink to session
 * messages. A per-session runner process owns the live Claude Agent SDK state.
 *
 * Architectural notes:
 * - One SDK query() per conduit session, not per turn.
 * - The first send-turn command creates an EffectPromptQueue (backed by Effect Queue)
 *   + calls query() + starts a background stream consumer. Subsequent
 *   turns enqueue into the existing queue.
 * - Discovery reads the live model list through ClaudeCapabilitiesService. The
 *   service owns the 5-minute TTL/in-flight cache; the probe spawns a throwaway
 *   SDK query, reads initializationResult(), and aborts before any API call.
 *   Nothing persists to disk. Commands and skills are enumerated from ~/.claude/
 *   and <workspace>/.claude/.
 * - Shutdown is graceful: close every session's prompt queue, call the
 *   runtime's close(), then clear the session map.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	type Settings,
	query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { SqlClient } from "@effect/sql";
import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberMap,
	HashMap,
	HashSet,
	Layer,
	Option,
	Ref,
	type Scope,
} from "effect";
import type { ClaudeSDKPermissionMode } from "../../contracts/providers/claude-agent-sdk.js";
import { PendingInteractionServiceTag } from "../../domain/relay/Services/pending-interaction-service.js";
import {
	type ProviderRuntimeIngestionError,
	ProviderRuntimeIngestionTag,
} from "../../domain/relay/Services/provider-runtime-ingestion-service.js";
import { createLogger } from "../../logger.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectTag,
} from "../../persistence/effect/claude-event-persist-effect.js";
import type { BackgroundTaskTransition } from "../../session/background-liveness.js";
import { ProviderInstanceFailure } from "../errors.js";
import {
	type ClaudeAdapterError,
	ClaudeBoundaryError,
	ClaudeRuntimeError,
	EventSinkIngestionError,
	isClaudeResumeFailure,
} from "../event-sink-errors.js";
import type {
	EventSink,
	PermissionDecision,
	PermissionResponse,
	PreWarmSessionInput,
	ProviderCapabilities,
	ProviderNativeSession,
	SendTurnInput,
	TurnResult,
} from "../types.js";
import { claudeApiModelId } from "./claude-api-model-id.js";
import {
	type ClaudeCapabilitiesService,
	makeClaudeCapabilitiesService,
} from "./claude-capabilities-service.js";
import {
	ClaudeGoalTracker,
	type ReadClaudeGoalStatus,
} from "./claude-goal-tracker.js";
import { ClaudePermissionBridge } from "./claude-permission-bridge.js";
import { makeProcessClaudeSessionRunner } from "./claude-process-session-runner.js";
import { buildClaudeQueryOptions } from "./claude-query-options.js";
import { makeRecoveredClaudeEventSink } from "./claude-runner-event-sink.js";
import { claudeRunnerSinkId } from "./claude-runner-protocol.js";
import { settleUnclaimedClaudeRunnerCommands } from "./claude-runner-recovery.js";
import { discoverClaudeRunners } from "./claude-runner-registry.js";
import { failClaudeRunnerTurn } from "./claude-runner-turn-failure.js";
import {
	discoverCapabilitiesEffect,
	expectedApiModelIdEffect,
	setExpectedApiModelId,
} from "./claude-runtime-discovery.js";
import { claudeRuntimeEvent } from "./claude-runtime-event.js";
import {
	getOrUndefined,
	getSession,
	getSetupLock,
	getState,
	isCurrentSession,
	isStreamEnded,
	markStreamEnded,
	markStreamLive,
	removeSession,
	removeSetupLock,
	setSession,
	setSetupLock,
} from "./claude-runtime-state.js";
import {
	buildUserMessage,
	hasPendingTurn,
	pushTurnDeferred,
	rejectTurnIfPendingEffect,
	resolveErrorTurnEffect,
	resolveTurnEffect,
	sdkResultToTurnResult,
	settleQueuedTurnDeferredsEffect,
	shiftTurnDeferred,
} from "./claude-runtime-turn.js";
import {
	asError,
	ClaudeSDKDecodeError,
	decodeProviderMessage,
	validateUserMessage,
} from "./claude-sdk-validation.js";
import type {
	ClaudeSessionCommand,
	ClaudeSessionFailure,
	ClaudeSessionOutput,
	ClaudeSessionOutputReply,
	ClaudeSessionRunner,
} from "./claude-session-runner.js";
import type {
	ClaudeSubagentSdk,
	MaterializeClaudeSubagentsInput,
	MaterializedClaudeSubagent,
} from "./claude-subagent-materializer.js";
import {
	detachSubagentFinalizationContext,
	finalizeSubagentsAfterResultEffect,
	handleSubagentTaskStartedEffect,
	pushForwardedSubagentMessageEffect,
	stopSubagentPollers,
} from "./claude-subagent-runtime.js";
import {
	type ClaudeTranslationService,
	makeClaudeTranslationService,
} from "./claude-translation-service.js";
import {
	emitClaudeUsageLimit,
	interceptClaudeUsageLimit,
} from "./claude-usage-limit.js";
import {
	type ClaudeWarmedQueryOwner,
	makeClaudeWarmedQueryOwner,
} from "./claude-warmed-query.js";
import { makeEffectPromptQueue } from "./effect-prompt-queue.js";
import { captureClaudeSdkMessage } from "./sdk-trace-capture.js";
import type {
	CanUseTool,
	ClaudeSessionContext,
	PromptQueueController,
	Query,
	Options as SDKOptions,
	SDKResultMessage,
	SDKUserMessage,
} from "./types.js";

const log = createLogger("claude-provider-runtime");
type EffortLevel = NonNullable<SDKOptions["effort"]>;
const INTERRUPTED_TURN: TurnResult = {
	status: "interrupted",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
};

export interface ClaudeProviderInstanceDeps {
	readonly readGoalStatus?: ReadClaudeGoalStatus;
	readonly onBackgroundTask?: (
		input: import("../../session/background-liveness.js").BackgroundTaskTransition,
	) => void;
	readonly workspaceRoot: string;
	readonly extraFolders?: readonly string[];
	readonly daemonConfigDir?: string;
	readonly shellEnv?: (
		directory: string,
	) => Readonly<Record<string, string | undefined>>;
	readonly prepareShellEnv?: (directory: string) => Promise<boolean>;
	readonly claudeSettingsOverrides?: () => Settings | undefined;
	/** Injectable factory for the SDK's query() function. Defaults to the real SDK. */
	readonly queryFactory?: (params: {
		prompt: AsyncIterable<SDKUserMessage>;
		options?: SDKOptions;
	}) => Query;
	readonly subagentSdk?: ClaudeSubagentSdk;
	readonly materializeSubagents?: (
		input: MaterializeClaudeSubagentsInput,
	) => Effect.Effect<readonly MaterializedClaudeSubagent[], ClaudeAdapterError>;
	readonly ensureClaudeSubagentSession?: ClaudeEventPersistEffect["ensureClaudeSubagentSession"];
	readonly persistHandoffDelivered?: ClaudeEventPersistEffect["persistHandoffDelivered"];
	readonly subagentPollTimeoutMs?: number;
	readonly capabilitiesService?: ClaudeCapabilitiesService;
	/** Tests can host the session engine locally; production defaults to a process. */
	readonly runnerFactory?: typeof makeClaudeSessionRunner;
}

export type ClaudeSessionRunnerDeps = Pick<
	ClaudeProviderInstanceDeps,
	| "workspaceRoot"
	| "extraFolders"
	| "daemonConfigDir"
	| "shellEnv"
	| "claudeSettingsOverrides"
	| "queryFactory"
	| "subagentSdk"
	| "subagentPollTimeoutMs"
	| "capabilitiesService"
	| "readGoalStatus"
	| "persistHandoffDelivered"
> & {
	readonly materializeSubagents?: boolean;
	readonly onSubagentFinalizationComplete?: () => void;
	readonly onTurnStateChanged?: (sessionId: string, inFlight: boolean) => void;
	readonly prepareQuery?: () => Promise<void>;
};

export interface ClaudeProviderRuntimeState {
	readonly sessions: HashMap.HashMap<string, ClaudeSessionContext>;
	readonly setupLocks: HashMap.HashMap<string, Deferred.Deferred<void, Error>>;
	readonly turnWaiters: HashMap.HashMap<
		string,
		ReadonlyArray<Deferred.Deferred<TurnResult, Error>>
	>;
	readonly endedStreams: HashSet.HashSet<string>;
	readonly shutdownAfterTurn: HashSet.HashSet<string>;
}

interface ClaudeSubagentFinalizationFiberKey {
	readonly id: string;
	readonly sessionId: string;
	readonly turnId: string;
}

const emptyClaudeProviderRuntimeState = (): ClaudeProviderRuntimeState => ({
	sessions: HashMap.empty(),
	setupLocks: HashMap.empty(),
	turnWaiters: HashMap.empty(),
	endedStreams: HashSet.empty(),
	shutdownAfterTurn: HashSet.empty(),
});

export class ClaudeProviderRuntimeTag extends Context.Tag(
	"ClaudeProviderRuntime",
)<ClaudeProviderRuntimeTag, ClaudeProviderRuntime>() {}

export const makeClaudeProviderRuntime = (
	deps: ClaudeProviderInstanceDeps,
): Effect.Effect<ClaudeProviderRuntime, never, Scope.Scope> =>
	Effect.gen(function* () {
		const providerScope = yield* Effect.scope;
		const capabilitiesService =
			deps.capabilitiesService ?? (yield* makeClaudeCapabilitiesService());
		const abortFibers = yield* FiberMap.make<string, void, never>();
		const interactionFibers = yield* FiberMap.make<string, void, never>();
		const preWarmFibers = yield* FiberMap.make<
			string,
			void,
			ProviderInstanceFailure
		>();
		let runtime: ClaudeProviderRuntime | undefined;
		const runner = yield* (
			deps.runnerFactory ?? makeProcessClaudeSessionRunner
		)(
			{
				workspaceRoot: deps.workspaceRoot,
				extraFolders: deps.extraFolders ?? [],
				...(deps.daemonConfigDir !== undefined
					? { daemonConfigDir: deps.daemonConfigDir }
					: {}),
				...(deps.shellEnv ? { shellEnv: deps.shellEnv } : {}),
				...(deps.claudeSettingsOverrides
					? { claudeSettingsOverrides: deps.claudeSettingsOverrides }
					: {}),
				...(deps.queryFactory ? { queryFactory: deps.queryFactory } : {}),
				...(deps.subagentSdk ? { subagentSdk: deps.subagentSdk } : {}),
				...(deps.subagentPollTimeoutMs !== undefined
					? { subagentPollTimeoutMs: deps.subagentPollTimeoutMs }
					: {}),
				materializeSubagents: deps.materializeSubagents !== undefined,
				capabilitiesService,
				...(deps.readGoalStatus ? { readGoalStatus: deps.readGoalStatus } : {}),
				...(deps.persistHandoffDelivered
					? { persistHandoffDelivered: deps.persistHandoffDelivered }
					: {}),
			},
			(output, sessionId?: string) =>
				runtime
					? runtime.handleOutputEffect(output, sessionId)
					: Effect.succeed({}),
		);
		runtime = new ClaudeProviderRuntime(
			{ ...deps, capabilitiesService },
			runner,
			abortFibers,
			interactionFibers,
			preWarmFibers,
			providerScope,
		);
		const providerRuntime = runtime;
		// Direct scope disposal also detaches before the FiberMaps interrupt waiters.
		yield* Effect.addFinalizer(() =>
			providerRuntime
				.shutdownEffect({ detachInteractions: true })
				.pipe(Effect.ignore),
		);
		return runtime;
	});

export const makeClaudeSessionRunner = (
	deps: ClaudeSessionRunnerDeps,
	emit: (
		output: ClaudeSessionOutput,
	) => Effect.Effect<ClaudeSessionOutputReply, ClaudeSessionFailure>,
): Effect.Effect<ClaudeSessionRunner, never, Scope.Scope> =>
	Effect.gen(function* () {
		const stateRef = yield* Ref.make<ClaudeProviderRuntimeState>(
			emptyClaudeProviderRuntimeState(),
		);
		const streamFibers = yield* FiberMap.make<string, void, unknown>();
		const shutdownFibers = yield* FiberMap.make<string, void, never>();
		const subagentFinalizationFibers = yield* FiberMap.make<
			ClaudeSubagentFinalizationFiberKey,
			void,
			never
		>();
		const capabilitiesService =
			deps.capabilitiesService ?? (yield* makeClaudeCapabilitiesService());
		const warmedQueries = yield* makeClaudeWarmedQueryOwner(
			deps.queryFactory ??
				(sdkQuery as NonNullable<ClaudeProviderInstanceDeps["queryFactory"]>),
			deps.prepareQuery,
		);
		const runner = new InProcessClaudeSessionRunner(
			{ ...deps, capabilitiesService },
			stateRef,
			streamFibers,
			subagentFinalizationFibers,
			shutdownFibers,
			warmedQueries,
			emit,
		);
		yield* Effect.addFinalizer(() =>
			runner.executeEffect({ type: "shutdown" }).pipe(Effect.ignore),
		);
		return runner;
	});

export const ClaudeProviderRuntimeLive = (
	deps: ClaudeProviderInstanceDeps,
): Layer.Layer<ClaudeProviderRuntimeTag, never, Scope.Scope> =>
	Layer.scoped(ClaudeProviderRuntimeTag, makeClaudeProviderRuntime(deps));

function sessionFailure(
	operation: string,
	cause: unknown,
): ClaudeSessionFailure {
	const failure =
		cause instanceof ProviderInstanceFailure ? cause.cause : cause;
	return {
		operation:
			cause instanceof ProviderInstanceFailure ? cause.operation : operation,
		message:
			typeof failure === "object" &&
			failure !== null &&
			"message" in failure &&
			typeof failure.message === "string"
				? failure.message
				: asError(failure).message,
		...(failure instanceof Error ? { name: failure.name } : {}),
		...(typeof failure === "object" &&
		failure !== null &&
		"code" in failure &&
		(typeof failure.code === "string" || typeof failure.code === "number")
			? { code: failure.code }
			: {}),
		...(typeof failure === "object" &&
		failure !== null &&
		"retryable" in failure &&
		typeof failure.retryable === "boolean"
			? { retryable: failure.retryable }
			: {}),
	};
}

/** Provider API compatibility and event-store interaction routing only. */
export class ClaudeProviderRuntime {
	readonly providerId = "claude";
	private readonly sinks = new Map<string, EventSink>();
	private detachingInteractions = false;
	private recoveredSink: ((sessionId: string) => EventSink) | undefined;
	private readonly recoveredSinkIds = new Set<string>();
	private readonly recoveredRequests = new Map<
		string,
		Deferred.Deferred<void>
	>();

	readonly recoverEffect = Effect.gen(this, function* () {
		if (!this.runner.recoverEffect) return;
		const sql = yield* SqlClient.SqlClient;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const pending = yield* PendingInteractionServiceTag;
		this.recoveredSink = (sessionId) =>
			makeRecoveredClaudeEventSink({
				sessionId,
				sql,
				ingestion,
				pending,
				onRegistered: (id) => {
					const ready = this.recoveredRequests.get(id);
					return ready ? Deferred.succeed(ready, undefined) : Effect.void;
				},
			});
		yield* this.runner.recoverEffect;
		const registrations = yield* Effect.try(() =>
			discoverClaudeRunners(this.deps.workspaceRoot, this.deps.daemonConfigDir),
		).pipe(
			Effect.catchAll((error) =>
				Effect.logError("Could not verify Claude runner ownership", error).pipe(
					Effect.as(undefined),
				),
			),
		);
		// Discovery errors are not proof that a running command has no owner.
		if (!registrations) return;
		yield* settleUnclaimedClaudeRunnerCommands(
			sql,
			new Set(registrations.map((runner) => runner.sessionId)),
			(sinkId, turn, failure) =>
				Effect.gen(function* () {
					let persistenceError: ProviderRuntimeIngestionError | undefined;
					yield* failClaudeRunnerTurn(
						(output) =>
							Effect.gen(function* () {
								if (output.type === "event") {
									// Startup has no WebSocket publisher or live sink yet.
									yield* ingestion.ingestBatch([output.event], {
										publishToBus: false,
										publishToRelay: false,
									});
								} else if (output.type === "cancel-interactions") {
									yield* pending.cancelSessionInteractions(
										turn.sessionId,
										output.reason,
										{ recoverQuestions: false },
									);
								}
								return {};
							}).pipe(
								Effect.tapError((error) =>
									Effect.sync(() => {
										persistenceError = error;
									}),
								),
								Effect.mapError((error) =>
									sessionFailure("recover stopped runner", error),
								),
							),
						sinkId,
						turn,
						failure,
					);
					// failClaudeRunnerTurn logs errors; database failures still need a retry.
					if (persistenceError) return yield* Effect.fail(persistenceError);
				}),
			this.deps.daemonConfigDir,
		);
	});

	constructor(
		private readonly deps: ClaudeProviderInstanceDeps,
		private readonly runner: ClaudeSessionRunner,
		private readonly abortFibers: FiberMap.FiberMap<string, void, never>,
		private readonly interactionFibers: FiberMap.FiberMap<string, void, never>,
		private readonly preWarmFibers: FiberMap.FiberMap<
			string,
			void,
			ProviderInstanceFailure
		>,
		private readonly providerScope: Scope.Scope,
	) {}

	private commandEffect(
		command: Extract<ClaudeSessionCommand, { type: "send-turn" }>,
	): Effect.Effect<TurnResult, ProviderInstanceFailure>;
	private commandEffect(
		command: Exclude<ClaudeSessionCommand, { type: "send-turn" }>,
	): Effect.Effect<void, ProviderInstanceFailure>;
	private commandEffect(
		command: ClaudeSessionCommand,
	): Effect.Effect<TurnResult | undefined, ProviderInstanceFailure> {
		return this.runner.executeEffect(command).pipe(
			Effect.mapError(
				(failure) =>
					new ProviderInstanceFailure({
						providerId: this.providerId,
						operation: failure.operation,
						cause: Object.assign(new Error(failure.message), failure),
					}),
			),
		);
	}

	discoverEffect(): Effect.Effect<
		ProviderCapabilities,
		ProviderInstanceFailure
	> {
		return discoverCapabilitiesEffect(
			this.deps.workspaceRoot,
			this.deps.capabilitiesService,
		).pipe(
			Effect.mapError(
				(cause: ClaudeAdapterError) =>
					new ProviderInstanceFailure({
						providerId: this.providerId,
						operation: "discover",
						cause: cause instanceof ClaudeBoundaryError ? cause.cause : cause,
					}),
			),
		);
	}

	getNativeSessionEffect(
		sessionId: string,
	): Effect.Effect<ProviderNativeSession | undefined> {
		return (
			this.runner.getNativeSessionEffect?.(sessionId) ??
			Effect.succeed(undefined)
		);
	}

	sendTurnEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, ProviderInstanceFailure> {
		return Effect.gen(this, function* () {
			const { eventSink, abortSignal, ...turn } = input;
			const claudeSettingsOverrides = yield* Effect.try({
				try: () => this.deps.claudeSettingsOverrides?.(),
				catch: (cause) =>
					new ProviderInstanceFailure({
						providerId: this.providerId,
						operation: "sendTurn",
						cause,
					}),
			});
			const sinkId = claudeRunnerSinkId(
				input.commandId ?? randomUUID(),
				input.commandAttempt,
				input.nativeResumeFallback,
			);
			this.sinks.set(sinkId, eventSink);
			this.reportSinkForTesting("allocated", sinkId, input.sessionId);
			const aborted = Effect.async<void>((resume) => {
				const onAbort = () => resume(Effect.void);
				if (abortSignal.aborted) onAbort();
				else abortSignal.addEventListener("abort", onAbort, { once: true });
				return Effect.sync(() =>
					abortSignal.removeEventListener("abort", onAbort),
				);
			});
			yield* FiberMap.run(
				this.abortFibers,
				sinkId,
				aborted.pipe(
					Effect.andThen(this.runner.executeEffect({ type: "abort", sinkId })),
					Effect.ignore,
				),
			);
			return yield* this.commandEffect({
				type: "send-turn",
				sinkId,
				aborted: abortSignal.aborted,
				claudeSettingsOverrides,
				input: turn,
			});
		});
	}

	preWarmSessionEffect(
		input: PreWarmSessionInput,
	): Effect.Effect<void, ProviderInstanceFailure> {
		const preWarm = Effect.gen(this, function* () {
			let model = input.model;
			if (!model) {
				// Discovery is shared with sends; cancellation only stops this waiter.
				const discovery = yield* Effect.forkIn(
					this.discoverEffect(),
					this.providerScope,
				);
				const { models } = yield* Fiber.join(discovery);
				const inferred =
					models.find((item) => item.id === "default") ?? models[0];
				if (!inferred) return;
				model = { providerId: inferred.providerId, modelId: inferred.id };
			}
			const prepareShellEnv = this.deps.prepareShellEnv;
			if (prepareShellEnv) {
				// Keep capture owned by the resolver when this request times out.
				const ready = yield* Effect.tryPromise({
					try: () => prepareShellEnv(input.workspaceRoot),
					catch: (cause) =>
						new ProviderInstanceFailure({
							providerId: this.providerId,
							operation: "preWarmSession",
							cause,
						}),
				}).pipe(Effect.timeoutOption("10 seconds"));
				if (Option.isNone(ready) || !ready.value) return;
			}
			const claudeSettingsOverrides = yield* Effect.try({
				try: () => this.deps.claudeSettingsOverrides?.(),
				catch: (cause) =>
					new ProviderInstanceFailure({
						providerId: this.providerId,
						operation: "preWarmSession",
						cause,
					}),
			});
			yield* this.commandEffect({
				type: "pre-warm",
				sessionId: input.sessionId,
				input: { ...input, model },
				claudeSettingsOverrides,
			});
		});
		return Effect.uninterruptibleMask((restore) =>
			Effect.gen(this, function* () {
				const runPreWarm = yield* FiberMap.runtime(this.preWarmFibers)();
				const fiber = yield* Effect.sync(() => {
					const existing = FiberMap.unsafeGet(
						this.preWarmFibers,
						input.sessionId,
					);
					return Option.isSome(existing)
						? existing.value
						: runPreWarm(input.sessionId, Effect.interruptible(preWarm), {
								onlyIfMissing: true,
							});
				});
				const exit = yield* restore(Fiber.await(fiber)).pipe(
					Effect.onInterrupt(() => Fiber.interrupt(fiber)),
				);
				if (Exit.isSuccess(exit)) return;
				return yield* Cause.isInterruptedOnly(exit.cause)
					? Effect.fail(
							new ProviderInstanceFailure({
								providerId: this.providerId,
								operation: "preWarmSession",
								cause: new Error("Session pre-warm was cancelled"),
							}),
						)
					: Effect.failCause(exit.cause);
			}),
		);
	}

	interruptTurnEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return FiberMap.remove(this.preWarmFibers, sessionId).pipe(
			Effect.andThen(this.commandEffect({ type: "interrupt", sessionId })),
		);
	}
	resolvePermissionEffect(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({
			type: "resolve-permission",
			sessionId,
			requestId,
			decision,
		});
	}
	resolveQuestionEffect(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({
			type: "resolve-question",
			sessionId,
			requestId,
			answers,
		});
	}
	applyLiveSettingsEffect(
		sessionId: string,
		settings: {
			readonly modelId?: string | undefined;
			readonly contextWindow?: string | undefined;
			readonly variant?: string | undefined;
		},
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({
			type: "apply-live-settings",
			sessionId,
			settings,
		});
	}
	setPermissionModeEffect(
		sessionId: string,
		mode: ClaudeSDKPermissionMode,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({ type: "set-permission-mode", sessionId, mode });
	}
	endSessionEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return FiberMap.remove(this.preWarmFibers, sessionId).pipe(
			Effect.andThen(this.commandEffect({ type: "end-session", sessionId })),
		);
	}
	shutdownEffect(options?: {
		readonly detachInteractions?: true;
	}): Effect.Effect<void, ProviderInstanceFailure> {
		return Effect.gen(this, function* () {
			if (options?.detachInteractions) {
				this.detachingInteractions = true;
				for (const sink of this.sinks.values()) {
					yield* sink.detachInteractions?.() ?? Effect.void;
				}
			}
			yield* FiberMap.clear(this.preWarmFibers);
			yield* this.commandEffect({ type: "shutdown" });
		}).pipe(
			Effect.ensuring(
				Effect.gen(this, function* () {
					this.sinks.clear();
					yield* FiberMap.clear(this.abortFibers);
					yield* FiberMap.clear(this.interactionFibers);
				}),
			),
		);
	}

	private reportSinkForTesting(
		phase: "allocated" | "released",
		sinkId: string,
		sessionId: string | undefined,
	): void {
		if (
			process.env["NODE_ENV"] === "test" &&
			process.env["CONDUIT_TEST_UPGRADE_SINK_PROOF"] === "1" &&
			process.connected
		)
			process.send?.({
				channel: "conduit-process-test",
				kind: "runtime-sink",
				phase,
				sinkId,
				sessionId,
				activeSinks: this.sinks.size,
			});
	}

	handleOutputEffect(
		output: ClaudeSessionOutput,
		recoveredSessionId?: string,
	): Effect.Effect<ClaudeSessionOutputReply, ClaudeSessionFailure> {
		return Effect.gen(this, function* () {
			if (output.type === "background-task") {
				this.deps.onBackgroundTask?.(output.transition);
				return;
			}
			let sink = this.sinks.get(output.sinkId);
			if (!sink && recoveredSessionId && this.recoveredSink) {
				sink = this.recoveredSink(recoveredSessionId);
				this.sinks.set(output.sinkId, sink);
				this.recoveredSinkIds.add(output.sinkId);
				this.reportSinkForTesting(
					"allocated",
					output.sinkId,
					recoveredSessionId,
				);
			}
			if (!sink) return;
			if (this.detachingInteractions)
				yield* sink.detachInteractions?.() ?? Effect.void;
			switch (output.type) {
				case "event":
					return yield* sink
						.push(output.event)
						.pipe(Effect.mapError((cause) => sessionFailure("push", cause)));
				case "permission-request":
				case "question-request": {
					const registered = this.recoveredSinkIds.has(output.sinkId)
						? yield* Deferred.make<void>()
						: undefined;
					if (registered)
						this.recoveredRequests.set(output.request.requestId, registered);
					const request = Effect.suspend(() =>
						output.type === "permission-request"
							? sink.requestPermission(output.request).pipe(
									Effect.flatMap((response) =>
										this.runner.executeEffect({
											type: "answer-permission",
											sinkId: output.sinkId,
											requestId: output.request.requestId,
											response,
										}),
									),
								)
							: sink.requestQuestion(output.request).pipe(
									Effect.flatMap((answers) =>
										this.runner.executeEffect({
											type: "answer-question",
											sinkId: output.sinkId,
											requestId: output.request.requestId,
											answers,
										}),
									),
								),
					);
					yield* FiberMap.run(
						this.interactionFibers,
						`${output.sinkId}:${output.request.requestId}`,
						request.pipe(
							Effect.onExit((exit) =>
								Effect.gen(this, function* () {
									if (
										Exit.isFailure(exit) &&
										!Cause.isInterruptedOnly(exit.cause)
									) {
										yield* this.runner
											.executeEffect({
												type: "interaction-failed",
												sinkId: output.sinkId,
												requestId: output.request.requestId,
												kind:
													output.type === "permission-request"
														? "permission"
														: "question",
												failure: sessionFailure(
													"request interaction",
													Cause.squash(exit.cause),
												),
											})
											.pipe(Effect.ignore);
									}
								}),
							),
							Effect.catchAllCause(() => Effect.void),
						),
					);
					if (registered) {
						yield* Deferred.await(registered);
						this.recoveredRequests.delete(output.request.requestId);
					}
					return;
				}
				case "resolve-permission":
					return yield* sink
						.resolvePermission(output.requestId, output.response)
						.pipe(
							Effect.mapError((cause) =>
								sessionFailure("resolvePermission", cause),
							),
						);
				case "resolve-question":
					return yield* sink
						.resolveQuestion(output.requestId, output.answers)
						.pipe(
							Effect.mapError((cause) =>
								sessionFailure("resolveQuestion", cause),
							),
						);
				case "cancel-interactions":
					return yield* Effect.suspend(
						() =>
							sink.cancelSessionInteractions?.(output.reason, {
								recoverQuestions: output.recoverQuestions,
							}) ?? Effect.void,
					).pipe(Effect.catchAllCause(() => Effect.void));
				case "cancel-interaction":
					return yield* FiberMap.remove(
						this.interactionFibers,
						`${output.sinkId}:${output.requestId}`,
					);
				case "release-sink":
					for (const [key] of Array.from(this.interactionFibers)) {
						if (key.startsWith(`${output.sinkId}:`)) {
							yield* FiberMap.remove(this.interactionFibers, key);
						}
					}
					this.sinks.delete(output.sinkId);
					this.recoveredSinkIds.delete(output.sinkId);
					yield* FiberMap.remove(this.abortFibers, output.sinkId);
					this.reportSinkForTesting(
						"released",
						output.sinkId,
						recoveredSessionId,
					);
					return;
				case "materialize-subagents":
					return yield* this.deps
						.materializeSubagents?.({
							...output.input,
							knownTasks: new Map(output.input.knownTasks),
						})
						.pipe(
							Effect.mapError((cause) => sessionFailure(output.type, cause)),
						) ?? Effect.succeed([]);
				case "ensure-subagent-session": {
					const persist = yield* Effect.serviceOption(
						ClaudeEventPersistEffectTag,
					);
					const ensureSession =
						this.deps.ensureClaudeSubagentSession ??
						(persist._tag === "Some"
							? persist.value.ensureClaudeSubagentSession
							: undefined);
					return yield* ensureSession?.(output.input).pipe(
						Effect.mapError((cause) => sessionFailure(output.type, cause)),
					) ?? Effect.void;
				}
			}
		}).pipe(
			Effect.map((children) => (children ? { children } : {})),
			Effect.catchAllDefect((cause) =>
				Effect.fail(sessionFailure(output.type, cause)),
			),
		);
	}
}

class InProcessClaudeSessionRunner implements ClaudeSessionRunner {
	readonly providerId = "claude";
	/** The first send's abort signal stays linked for the query's lifetime. */
	private readonly sessionAbortSources = new Map<string, EventSink>();
	private readonly sinkBindings = new Map<
		string,
		{
			readonly sessionId: string;
			readonly finished: Deferred.Deferred<void>;
			readonly claudeSettingsOverrides: Settings | undefined;
			readonly sink: EventSink;
			readonly abortController: AbortController;
			readonly permissions: Map<
				string,
				Deferred.Deferred<PermissionResponse, ClaudeSessionFailure>
			>;
			readonly questions: Map<
				string,
				Deferred.Deferred<Record<string, unknown>, ClaudeSessionFailure>
			>;
			references: number;
		}
	>();

	/** Permission bridge is stateless; the live sink comes from the session context. */
	private permissionBridge: ClaudePermissionBridge =
		new ClaudePermissionBridge();

	/** Injectable query factory (defaults to real SDK). */
	private readonly queryFactory: NonNullable<
		ClaudeProviderInstanceDeps["queryFactory"]
	>;

	constructor(
		private readonly deps: ClaudeSessionRunnerDeps,
		private readonly stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
		private readonly streamFibers: FiberMap.FiberMap<string, void, unknown>,
		private readonly subagentFinalizationFibers: FiberMap.FiberMap<
			ClaudeSubagentFinalizationFiberKey,
			void,
			never
		>,
		private readonly shutdownFibers: FiberMap.FiberMap<string, void, never>,
		private readonly warmedQueries: ClaudeWarmedQueryOwner,
		private readonly emit: (
			output: ClaudeSessionOutput,
		) => Effect.Effect<ClaudeSessionOutputReply, ClaudeSessionFailure>,
	) {
		this.queryFactory =
			deps.queryFactory ??
			(sdkQuery as NonNullable<ClaudeProviderInstanceDeps["queryFactory"]>);
	}

	hasPendingSubagentFinalizers(sessionId: string): boolean {
		return Array.from(this.subagentFinalizationFibers).some(
			([key]) => key.sessionId === sessionId,
		);
	}

	getResumeSessionIdEffect(
		sessionId: string,
	): Effect.Effect<string | null | undefined> {
		return getSession(this.stateRef, sessionId).pipe(
			Effect.map((ctx) => (ctx ? (ctx.resumeSessionId ?? null) : undefined)),
		);
	}

	getNativeSessionEffect(
		sessionId: string,
	): Effect.Effect<ProviderNativeSession | undefined> {
		return getSession(this.stateRef, sessionId).pipe(
			Effect.map((ctx) =>
				ctx
					? {
							instanceId: ctx.instanceId ?? "claude",
							configDir: ctx.configDir,
							agent: ctx.currentAgent,
							resumeSessionId: ctx.resumeSessionId,
						}
					: undefined,
			),
		);
	}

	executeEffect(
		command: Extract<ClaudeSessionCommand, { type: "send-turn" }>,
	): Effect.Effect<TurnResult, ClaudeSessionFailure>;
	executeEffect(
		command: Exclude<ClaudeSessionCommand, { type: "send-turn" }>,
	): Effect.Effect<void, ClaudeSessionFailure>;
	executeEffect(
		command: ClaudeSessionCommand,
	): Effect.Effect<TurnResult | undefined, ClaudeSessionFailure>;
	executeEffect(
		command: ClaudeSessionCommand,
	): Effect.Effect<TurnResult | undefined, ClaudeSessionFailure> {
		const execute = Effect.gen(this, function* () {
			switch (command.type) {
				case "pre-warm":
					if (
						(yield* getSession(this.stateRef, command.sessionId)) ||
						(yield* getSetupLock(this.stateRef, command.sessionId))
					)
						return;
					yield* this.warmedQueries.preWarmEffect(
						command.input,
						command.claudeSettingsOverrides,
						this.deps.shellEnv?.(command.input.workspaceRoot),
						this.getPermissionBridge(),
						command.settingsSnapshot !== undefined,
					);
					return;
				case "send-turn": {
					const finished = yield* Deferred.make<void>();
					const eventSink = this.makeSessionSink(
						command.sinkId,
						command.input.sessionId,
						finished,
						command.claudeSettingsOverrides,
					);
					const controller = this.sinkBindings.get(
						command.sinkId,
					)?.abortController;
					if (!controller)
						return yield* Effect.die("Missing Claude runner sink binding");
					if (command.aborted) controller.abort();
					return yield* this.sendTurnEffect({
						...command.input,
						eventSink,
						abortSignal: controller.signal,
					}).pipe(
						Effect.map((result) =>
							result.status === "completed" && command.input.handoff
								? { ...result, handoff: command.input.handoff }
								: result,
						),
						Effect.ensuring(Deferred.succeed(finished, undefined)),
						Effect.ensuring(this.releaseSinkEffect(eventSink)),
					);
				}
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
				case "resolve-permission":
					yield* this.resolvePermissionEffect(
						command.sessionId,
						command.requestId,
						command.decision,
					);
					return;
				case "resolve-question":
					yield* this.resolveQuestionEffect(
						command.sessionId,
						command.requestId,
						command.answers,
					);
					return;
				case "interrupt":
					yield* this.interruptTurnEffect(command.sessionId);
					return;
				case "abort":
					this.sinkBindings.get(command.sinkId)?.abortController.abort();
					return;
				case "end-session":
					yield* this.endSessionEffect(command.sessionId);
					return;
				case "apply-live-settings":
					yield* this.applyLiveSettingsEffect(
						command.sessionId,
						command.settings,
					);
					return;
				case "set-permission-mode":
					yield* this.setPermissionModeEffect(command.sessionId, command.mode);
					return;
				case "shutdown":
					yield* this.shutdownEffect();
					return;
				case "shutdown-after-turn": {
					const ctx = yield* getSession(this.stateRef, command.sessionId);
					if (
						!ctx &&
						!Array.from(this.sinkBindings.values()).some(
							(binding) => binding.sessionId === command.sessionId,
						)
					) {
						yield* this.warmedQueries.discardEffect(command.sessionId);
						return;
					}
					yield* Ref.update(this.stateRef, (state) => ({
						...state,
						shutdownAfterTurn: HashSet.add(
							state.shutdownAfterTurn,
							command.sessionId,
						),
					}));
					yield* this.scheduleShutdownAfterTurnEffect(command.sessionId);
					return;
				}
			}
		});
		return execute.pipe(
			Effect.mapError((cause) => sessionFailure(command.type, cause)),
		);
	}

	private scheduleShutdownAfterTurnEffect(
		sessionId: string,
	): Effect.Effect<void> {
		return FiberMap.run(
			this.shutdownFibers,
			sessionId,
			Effect.gen(this, function* () {
				while (
					HashSet.has(
						(yield* getState(this.stateRef)).shutdownAfterTurn,
						sessionId,
					)
				) {
					const sends = Array.from(this.sinkBindings.values()).filter(
						(binding) => binding.sessionId === sessionId,
					);
					yield* Effect.forEach(
						sends,
						(binding) => Deferred.await(binding.finished),
						{ discard: true },
					);
					const finalizers = Array.from(this.subagentFinalizationFibers).filter(
						([key]) => key.sessionId === sessionId,
					);
					yield* Effect.forEach(finalizers, ([, fiber]) => Fiber.await(fiber), {
						discard: true,
					});
					// Sends admitted while finalization ran still use the warm query.
					const finished = yield* Effect.forEach(
						Array.from(this.sinkBindings.values()).filter(
							(binding) => binding.sessionId === sessionId,
						),
						(binding) => Deferred.isDone(binding.finished),
					);
					if (
						finished.some((done) => !done) ||
						Array.from(this.subagentFinalizationFibers).some(
							([key]) => key.sessionId === sessionId,
						)
					)
						continue;
					const state = yield* getState(this.stateRef);
					// Eviction cancels the request for the old query generation.
					if (!HashSet.has(state.shutdownAfterTurn, sessionId)) return;
					const ctx = getOrUndefined(HashMap.get(state.sessions, sessionId));
					if (ctx)
						yield* this.disposeSessionEffect(
							ctx,
							"Runner shutting down after turn",
						);
					else
						yield* Ref.update(this.stateRef, (state) => ({
							...state,
							shutdownAfterTurn: HashSet.remove(
								state.shutdownAfterTurn,
								sessionId,
							),
						}));
					return;
				}
			}).pipe(Effect.ignore),
			{ onlyIfMissing: true },
		).pipe(Effect.asVoid);
	}

	private makeSessionSink(
		sinkId: string,
		sessionId: string,
		finished: Deferred.Deferred<void>,
		claudeSettingsOverrides: Settings | undefined,
	): EventSink {
		const permissions = new Map<
			string,
			Deferred.Deferred<PermissionResponse, ClaudeSessionFailure>
		>();
		const questions = new Map<
			string,
			Deferred.Deferred<Record<string, unknown>, ClaudeSessionFailure>
		>();
		const sinkFailure = (cause: ClaudeSessionFailure) =>
			new EventSinkIngestionError({
				cause: Object.assign(new Error(cause.message), cause),
			});
		const emit = (output: ClaudeSessionOutput) =>
			this.emit(output).pipe(Effect.asVoid, Effect.mapError(sinkFailure));
		const sink: EventSink & { readonly runnerSinkId: string } = {
			runnerSinkId: sinkId,
			push: (event) => emit({ type: "event", sinkId, event }),
			requestPermission: (request) =>
				Effect.gen(function* () {
					const deferred = yield* Deferred.make<
						PermissionResponse,
						ClaudeSessionFailure
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
						ClaudeSessionFailure
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
			claudeSettingsOverrides,
			sink,
			abortController: new AbortController(),
			permissions,
			questions,
			references: 1,
		});
		return sink;
	}

	private retainSink(sink: EventSink | undefined): void {
		if (
			sink &&
			"runnerSinkId" in sink &&
			typeof sink.runnerSinkId === "string"
		) {
			const binding = this.sinkBindings.get(sink.runnerSinkId);
			if (binding) binding.references++;
		}
	}

	private sinkId(sink: EventSink | undefined): string | undefined {
		return sink &&
			"runnerSinkId" in sink &&
			typeof sink.runnerSinkId === "string"
			? sink.runnerSinkId
			: undefined;
	}

	private recordBackgroundTaskEffect(
		transition: BackgroundTaskTransition,
	): Effect.Effect<void> {
		return this.emit({ type: "background-task", transition }).pipe(
			Effect.orDie,
			Effect.asVoid,
		);
	}

	private materializeSubagentsEffect(
		ctx: ClaudeSessionContext,
		input: MaterializeClaudeSubagentsInput,
	): Effect.Effect<readonly MaterializedClaudeSubagent[], ClaudeAdapterError> {
		const sinkId = this.sinkId(ctx.eventSink);
		if (!sinkId) return Effect.succeed([]);
		return this.emit({
			type: "materialize-subagents",
			sinkId,
			input: { ...input, knownTasks: Array.from(input.knownTasks) },
		}).pipe(
			Effect.map((reply) => reply.children ?? []),
			Effect.mapError(
				(cause) =>
					new ClaudeBoundaryError({
						operation: "materializeSubagents",
						cause: new Error(cause.message),
					}),
			),
		);
	}

	private ensureSubagentSessionEffect(
		ctx: ClaudeSessionContext,
		input: Parameters<
			NonNullable<ClaudeProviderInstanceDeps["ensureClaudeSubagentSession"]>
		>[0],
	): Effect.Effect<void, ClaudeAdapterError> {
		const sinkId = this.sinkId(ctx.eventSink);
		if (!sinkId) return Effect.void;
		return this.emit({ type: "ensure-subagent-session", sinkId, input }).pipe(
			Effect.asVoid,
			Effect.mapError(
				(cause) =>
					new ClaudeBoundaryError({
						operation: "ensureClaudeSubagentSession",
						cause: new Error(cause.message),
					}),
			),
		);
	}

	private releaseSinkEffect(sink: EventSink | undefined): Effect.Effect<void> {
		return Effect.gen(this, function* () {
			if (
				!sink ||
				!("runnerSinkId" in sink) ||
				typeof sink.runnerSinkId !== "string"
			)
				return;
			const binding = this.sinkBindings.get(sink.runnerSinkId);
			if (!binding || --binding.references > 0) return;
			this.sinkBindings.delete(sink.runnerSinkId);
			yield* this.emit({
				type: "release-sink",
				sinkId: sink.runnerSinkId,
			}).pipe(Effect.ignore);
		});
	}

	private removeSessionEffect(sessionId: string): Effect.Effect<void> {
		return Effect.gen(this, function* () {
			yield* this.warmedQueries.discardEffect(sessionId);
			const ctx = yield* getSession(this.stateRef, sessionId);
			yield* removeSession(this.stateRef, sessionId);
			yield* this.recordBackgroundTaskEffect({
				sessionId,
				kind: "session-ended",
			});
			yield* this.releaseSinkEffect(ctx?.eventSink);
			const abortSource = this.sessionAbortSources.get(sessionId);
			this.sessionAbortSources.delete(sessionId);
			yield* this.releaseSinkEffect(abortSource);
		});
	}

	private buildUserMessage(input: SendTurnInput): SDKUserMessage {
		return buildUserMessage(input);
	}

	private mapProviderFailure<A>(
		operation: string,
		effect: Effect.Effect<A, ClaudeAdapterError>,
	): Effect.Effect<A, ProviderInstanceFailure> {
		return effect.pipe(
			Effect.mapError(
				(cause) =>
					new ProviderInstanceFailure({
						providerId: this.providerId,
						operation,
						// Unwrap so the side-effect reactor still sees the SDK error's code and retryable fields.
						cause: cause instanceof ClaudeBoundaryError ? cause.cause : cause,
					}),
			),
		);
	}

	discoverEffect(): Effect.Effect<
		ProviderCapabilities,
		ProviderInstanceFailure
	> {
		return this.mapProviderFailure(
			"discover",
			discoverCapabilitiesEffect(
				this.deps.workspaceRoot,
				this.deps.capabilitiesService,
			),
		);
	}

	/**
	 * `undefined` means "no expectation" -- under exactOptionalPropertyTypes that
	 * has to clear the field rather than store an undefined in it, or the drift
	 * check would compare against a value nobody stands behind.
	 */

	sendTurnEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, ProviderInstanceFailure> {
		const attributes = {
			providerId: this.providerId,
			sessionId: input.sessionId,
			turnId: input.turnId,
		};
		return this.mapProviderFailure(
			"sendTurn",
			this.sendTurnLocalEffect(input).pipe(
				Effect.catchAll((err) =>
					Effect.gen(this, function* () {
						const ctx = yield* getSession(this.stateRef, input.sessionId);
						const tracker = ctx
							? (ctx.goalTracker ??= new ClaudeGoalTracker(
									input.sessionId,
									input.goalState,
								))
							: new ClaudeGoalTracker(input.sessionId, input.goalState);
						const goalChange = tracker.pause(asError(err).message);
						if (goalChange) {
							// The pause write must never replace the send's original failure.
							yield* Effect.suspend(() =>
								input.eventSink.push(
									claudeRuntimeEvent(
										"session.goal_changed",
										input.sessionId,
										goalChange,
									),
								),
							).pipe(Effect.exit);
						}
						return yield* Effect.fail(err);
					}),
				),
				Effect.annotateLogs(attributes),
				Effect.withSpan("claude.sendTurn", { attributes }),
			),
		);
	}

	private sendTurnLocalEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
			const { sessionId } = input;

			// Per-session mutex: prevent duplicate session creation.
			const pending = yield* getSetupLock(this.stateRef, sessionId);
			if (pending) {
				const existingCtx = yield* getSession(this.stateRef, sessionId);
				if (existingCtx && this.hasAgentChanged(existingCtx, input)) {
					return this.agentSwitchDuringActiveTurnResult(existingCtx, input);
				}
				yield* Deferred.await(pending).pipe(
					Effect.mapError(
						(cause) =>
							new ClaudeBoundaryError({ operation: "awaitSetup", cause }),
					),
				);
				return yield* this.sendTurnLocalEffect(input);
			}

			const existingCtx = yield* getSession(this.stateRef, sessionId);
			if (existingCtx?.stopped) {
				// Safety net: any path that stopped this context (interruptTurn,
				// endSession, shutdown) leaves it in sessions with a closed prompt
				// queue; enqueueing would throw. Evict silently and create fresh.
				log.info(`Evicting stopped session on sendTurn: ${sessionId}`);
				yield* this.removeSessionEffect(sessionId);
				return yield* this.createSessionAndSendTurnEffect(input);
			} else if (existingCtx && this.hasAgentChanged(existingCtx, input)) {
				if (yield* hasPendingTurn(this.stateRef, sessionId)) {
					return this.agentSwitchDuringActiveTurnResult(existingCtx, input);
				}
				return yield* this.restartSessionEffect(
					existingCtx,
					input,
					"Claude agent changed",
				);
			} else if (
				existingCtx &&
				input.startFreshNativeSession &&
				!(yield* hasPendingTurn(this.stateRef, sessionId))
			) {
				return yield* this.restartSessionEffect(
					existingCtx,
					input,
					"Server requested a fresh Claude session",
				);
			} else if (
				existingCtx &&
				(yield* isStreamEnded(this.stateRef, sessionId))
			) {
				log.info(`Evicting ended session stream on sendTurn: ${sessionId}`);
				yield* this.removeSessionEffect(sessionId);
			} else if (existingCtx) {
				return yield* this.enqueueTurnEffect(existingCtx, input);
			}

			return yield* this.createSessionAndSendTurnEffect(input);
		});
	}

	private createSessionAndSendTurnEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
			const { sessionId } = input;
			const apiModelId = claudeApiModelId(
				input.model?.modelId,
				input.contextWindow,
			);
			if (apiModelId === undefined) {
				return yield* Effect.fail(
					new ClaudeRuntimeError({
						message:
							"Claude runtime invariant violated: model is required before query creation",
					}),
				);
			}
			const expectedApiModelId = yield* expectedApiModelIdEffect(
				this.deps.capabilitiesService,
				input.model?.modelId,
				input.contextWindow,
				input.workspaceRoot,
				input.agent,
			);
			yield* markStreamLive(this.stateRef, sessionId);

			const deferred = yield* Deferred.make<TurnResult, Error>();
			yield* pushTurnDeferred(this.stateRef, sessionId, deferred);

			// Set session lock synchronously before any effectful boundary.
			const setupLock = yield* Deferred.make<void, Error>();
			yield* setSetupLock(this.stateRef, sessionId, setupLock);

			let promptQueue: PromptQueueController | undefined;
			let activeQuery: Query | undefined;
			const setup = Effect.gen(this, function* () {
				const userMessage = yield* Effect.try({
					try: () => validateUserMessage(this.buildUserMessage(input)),
					catch: (cause) =>
						new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
				});
				const bridge = this.getPermissionBridge();
				let ctx: ClaudeSessionContext | undefined;
				const canUseTool: CanUseTool = async (
					toolName,
					toolInput,
					permissionOptions,
				) => {
					if (!ctx)
						return { behavior: "deny", message: "Claude session is not ready" };
					return bridge.canUseTool(ctx, toolName, toolInput, permissionOptions);
				};
				let abortController = new AbortController();
				const launchOptions = yield* Effect.try({
					try: () =>
						buildClaudeQueryOptions(
							input,
							abortController,
							canUseTool,
							this.sinkBindings.get(this.sinkId(input.eventSink) ?? "")
								?.claudeSettingsOverrides,
							this.deps.shellEnv?.(input.workspaceRoot),
						),
					catch: (cause) =>
						new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
				});
				const warmed = yield* this.warmedQueries.takeEffect(
					sessionId,
					launchOptions,
				);
				if (!warmed && this.deps.prepareQuery)
					yield* Effect.tryPromise({
						try: this.deps.prepareQuery,
						catch: (cause) =>
							new ClaudeBoundaryError({ operation: "prepareQuery", cause }),
					});
				activeQuery = warmed?.query;
				const queue = warmed?.promptQueue ?? (yield* makeEffectPromptQueue());
				promptQueue = queue;
				const turnAdmissionSemaphore = yield* Effect.makeSemaphore(1);
				abortController = warmed?.abortController ?? abortController;
				if (input.abortSignal) {
					if (input.abortSignal.aborted) {
						abortController.abort();
					} else {
						input.abortSignal.addEventListener(
							"abort",
							() => abortController.abort(),
							{ once: true },
						);
					}
				}
				const options = warmed?.options ?? launchOptions;
				const resumeSessionId = options.resume;
				const context = {
					sessionId,
					instanceId: input.instanceId ?? "claude",
					nativeThread: input.nativeThread,
					workspaceRoot: input.workspaceRoot,
					...(input.configDir !== undefined
						? { configDir: input.configDir }
						: {}),
					goalTracker: new ClaudeGoalTracker(sessionId, input.goalState),
					cumulativeTokens: input.cumulativeTokens ?? 0,
					startedAt: new Date().toISOString(),
					promptQueue: queue,
					turnAdmissionSemaphore,
					pendingApprovals: new Map(),
					pendingQuestions: new Map(),
					inFlightTools: new Map(),
					subagentTasks: new Map(),
					subagentPollers: new Map(),
					pendingSubagentMessages: new Map(),
					eventSink: input.eventSink,
					currentTurnId: input.turnId,
					currentUserMessageId: input.userMessageId,
					resumeFallbackAllowed: !!input.resumeSessionId && !!input.handoff,
					queryInitialized: false,
					turnInFlight: input.turnId !== undefined,
					currentModel: input.model?.modelId,
					currentApiModelId: apiModelId,
					...(expectedApiModelId ? { expectedApiModelId } : {}),
					...(input.agent ? { currentAgent: input.agent } : {}),
					...(input.variant ? { currentVariant: input.variant } : {}),
					settingsOutOfSync: false,
					resumeSessionId,
					lastAssistantUuid: undefined,
					turnCount: 0,
					stopped: false,
				};

				// Cold creation retains the SDK's original first-prompt admission.
				if (!warmed) yield* queue.enqueue(userMessage);
				const query =
					warmed?.query ??
					(yield* Effect.try({
						try: () => this.queryFactory({ prompt: queue, options }),
						catch: (cause) =>
							new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
					}));
				activeQuery = query;
				ctx = {
					...context,
					query,
					configDir: resolve(
						input.workspaceRoot,
						options.env?.["CLAUDE_CONFIG_DIR"] ??
							join(options.env?.["HOME"] ?? homedir(), ".claude"),
					),
				};
				warmed?.bindContext(ctx);
				if (warmed) yield* queue.enqueue(userMessage);

				this.retainSink(ctx.eventSink);
				this.retainSink(input.eventSink);
				this.sessionAbortSources.set(sessionId, input.eventSink);
				yield* setSession(this.stateRef, sessionId, ctx);

				const translator = makeClaudeTranslationService({
					getSink: (ctx) => ctx.eventSink,
					...(this.deps.readGoalStatus
						? { readGoalStatus: this.deps.readGoalStatus }
						: {}),
					onBackgroundTask: (transition) =>
						this.recordBackgroundTaskEffect(transition),
				});
				yield* FiberMap.run(
					this.streamFibers,
					sessionId,
					this.runStreamConsumerEffect(ctx, translator),
				);
			});

			yield* setup.pipe(
				Effect.tap(() =>
					Deferred.succeed(setupLock, undefined).pipe(Effect.ignore),
				),
				Effect.onExit((exit) =>
					Exit.isFailure(exit)
						? Effect.gen(this, function* () {
								const failure = asError(Cause.squash(exit.cause));
								yield* settleQueuedTurnDeferredsEffect(
									this.stateRef,
									sessionId,
									failure.message,
								);
								yield* Deferred.fail(setupLock, failure);
								if (promptQueue) yield* Effect.exit(promptQueue.close());
								if (activeQuery)
									yield* Effect.try(() => activeQuery?.close()).pipe(
										Effect.ignore,
									);
								const current = yield* getSession(this.stateRef, sessionId);
								if (activeQuery && current?.query === activeQuery)
									yield* this.removeSessionEffect(sessionId);
							})
						: Effect.void,
				),
				Effect.ensuring(
					Effect.gen(this, function* () {
						// Clear the lock (but keep the deferred -- it resolves via the stream).
						yield* removeSetupLock(this.stateRef, sessionId);
					}),
				),
			);

			return yield* Deferred.await(deferred).pipe(
				Effect.mapError(
					(cause) => new ClaudeBoundaryError({ operation: "awaitTurn", cause }),
				),
			);
		});
	}

	/**
	 * Push the settings the user picked onto the live query. `setModel` and the
	 * flag layer are the only mid-session channels: `model` (with the context
	 * window folded into the API model id) goes through the former, `effort`
	 * through the latter because it is fixed at query creation.
	 *
	 * Leaves `ctx.settingsOutOfSync` latched on failure so the next turn
	 * re-issues whatever did not land; the caller clears it once the settings
	 * are known to have reached the query.
	 */
	private syncQuerySettingsEffect(
		ctx: ClaudeSessionContext,
		settings: {
			readonly modelId?: string | undefined;
			readonly contextWindow?: string | undefined;
			readonly variant?: string | undefined;
		},
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
			const baseModelId = settings.modelId ?? ctx.currentModel;
			const apiModelId = claudeApiModelId(baseModelId, settings.contextWindow);
			const forceSettingsSync = ctx.settingsOutOfSync;
			const shouldSetModel =
				apiModelId !== undefined &&
				(forceSettingsSync || apiModelId !== ctx.currentApiModelId);
			const shouldApplyFlagSettings =
				forceSettingsSync || settings.variant !== ctx.currentVariant;

			if (shouldSetModel || shouldApplyFlagSettings) {
				ctx.settingsOutOfSync = true;
			}
			if (shouldSetModel) {
				yield* Effect.tryPromise({
					try: () => ctx.query.setModel(apiModelId),
					catch: (cause) =>
						new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
				});
				ctx.currentApiModelId = apiModelId;
			}
			if (settings.modelId) {
				ctx.currentModel = settings.modelId;
			}
			// `effort` is fixed at query creation, so a mid-session change only
			// lands via the flag-settings layer. Empty/absent clears it back to
			// the settings-file default.
			if (shouldApplyFlagSettings) {
				const effortLevel = (settings.variant || null) as EffortLevel | null;
				yield* Effect.tryPromise({
					try: () => ctx.query.applyFlagSettings({ effortLevel }),
					catch: (cause) =>
						new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
				});
				if (settings.variant) {
					ctx.currentVariant = settings.variant;
				} else {
					delete ctx.currentVariant;
				}
			}
		});
	}

	/**
	 * Apply a picker change to the live query immediately, rather than letting
	 * it wait for the next turn's admission path. A session with no live query
	 * yet is a no-op: query creation reads these from its options.
	 */
	applyLiveSettingsEffect(
		sessionId: string,
		settings: {
			readonly modelId?: string | undefined;
			readonly contextWindow?: string | undefined;
			readonly variant?: string | undefined;
		},
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.mapProviderFailure(
			"apply live settings",
			Effect.gen(this, function* () {
				const pending = yield* getSetupLock(this.stateRef, sessionId);
				if (pending) {
					yield* Deferred.await(pending).pipe(
						Effect.mapError(
							(cause) =>
								new ClaudeBoundaryError({ operation: "awaitSetup", cause }),
						),
					);
				}
				const ctx = yield* getSession(this.stateRef, sessionId);
				if (!ctx) return;
				yield* this.syncQuerySettingsEffect(ctx, settings);
				// `init` arrives only at query creation, so for the rest of the
				// session the drift check reads this. Left at the pre-switch model,
				// a switch the user just made reads back as the SDK ignoring them
				// the moment an assistant message reports what actually served it.
				// The live query's own workspace and agent are the right frame: an
				// agent change restarts the session instead of reaching this path.
				setExpectedApiModelId(
					ctx,
					yield* expectedApiModelIdEffect(
						this.deps.capabilitiesService,
						settings.modelId ?? ctx.currentModel,
						settings.contextWindow,
						ctx.workspaceRoot,
						ctx.currentAgent,
					),
				);
				// Both calls landed, so the next turn has nothing to re-issue.
				ctx.settingsOutOfSync = false;
			}),
		);
	}

	setPermissionModeEffect(
		sessionId: string,
		mode: ClaudeSDKPermissionMode,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.mapProviderFailure(
			"set permission mode",
			Effect.gen(this, function* () {
				const pending = yield* getSetupLock(this.stateRef, sessionId);
				if (pending) {
					yield* Deferred.await(pending).pipe(
						Effect.mapError(
							(cause) =>
								new ClaudeBoundaryError({ operation: "awaitSetup", cause }),
						),
					);
				}
				const ctx = yield* getSession(this.stateRef, sessionId);
				if (!ctx) return;
				yield* Effect.tryPromise({
					try: () => ctx.query.setPermissionMode(mode),
					catch: (cause) =>
						new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
				});
			}),
		);
	}

	private enqueueTurnEffect(
		ctx: ClaudeSessionContext,
		input: SendTurnInput,
	): Effect.Effect<TurnResult, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
			if (this.hasAgentChanged(ctx, input)) {
				if (yield* hasPendingTurn(this.stateRef, ctx.sessionId)) {
					return this.agentSwitchDuringActiveTurnResult(ctx, input);
				}
				return yield* this.restartSessionEffect(
					ctx,
					input,
					"Claude agent changed",
				);
			}

			const turnAdmissionSemaphore = ctx.turnAdmissionSemaphore;
			if (!turnAdmissionSemaphore) {
				return yield* Effect.fail(
					new ClaudeRuntimeError({
						message: `Claude runtime invariant violated: missing turn admission semaphore for ${ctx.sessionId}`,
					}),
				);
			}
			const deferred = yield* turnAdmissionSemaphore.withPermits(1)(
				Effect.gen(this, function* () {
					const state = yield* getState(this.stateRef);
					const pendingTurns = getOrUndefined(
						HashMap.get(state.turnWaiters, ctx.sessionId),
					);
					const priorTurn = pendingTurns?.[0];
					if (priorTurn) {
						// Wait for the prior turn to finish, but never inherit its
						// failure: a rejected turn A must not reject turn B. The
						// liveness checks below decide whether B may still proceed.
						yield* Deferred.await(priorTurn).pipe(Effect.ignore);
					}

					// A Stop that landed while this turn waited dropped it with the
					// rest of the queue and already sent done. Failing it instead
					// would send a second done that ends the user's next prompt.
					if (ctx.stopped) {
						const dropped = yield* Deferred.make<TurnResult, Error>();
						yield* Deferred.succeed(dropped, INTERRUPTED_TURN);
						return dropped;
					}
					if (
						!(yield* isCurrentSession(this.stateRef, ctx)) ||
						(yield* isStreamEnded(this.stateRef, ctx.sessionId))
					) {
						return yield* Effect.fail(
							new ClaudeRuntimeError({
								message: `Claude session is no longer active: ${ctx.sessionId}`,
							}),
						);
					}

					const baseModelId = input.model?.modelId ?? ctx.currentModel;
					const expectedApiModelId = yield* expectedApiModelIdEffect(
						this.deps.capabilitiesService,
						baseModelId,
						input.contextWindow,
						input.workspaceRoot,
						input.agent,
					);
					const userMessage = yield* Effect.try({
						try: () => validateUserMessage(this.buildUserMessage(input)),
						catch: (cause) =>
							new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
					});
					yield* this.syncQuerySettingsEffect(ctx, {
						modelId: input.model?.modelId,
						contextWindow: input.contextWindow,
						variant: input.variant,
					});
					setExpectedApiModelId(ctx, expectedApiModelId);

					const turnDeferred = yield* Deferred.make<TurnResult, Error>();
					yield* Effect.uninterruptible(
						Effect.gen(this, function* () {
							yield* pushTurnDeferred(
								this.stateRef,
								ctx.sessionId,
								turnDeferred,
							);
							ctx.currentTurnId = input.turnId;
							ctx.currentUserMessageId = input.userMessageId;
							ctx.resumeFallbackAllowed =
								!!input.resumeSessionId && !!input.handoff;
							ctx.usageLimit = undefined;
							ctx.usageLimitReported = undefined;
							ctx.pendingSyntheticMessages = undefined;
							// Marks the turn as started so a system/init arriving before
							// the first assistant chunk cannot report the session idle.
							ctx.turnInFlight = true;
							const priorSink = ctx.eventSink;
							this.retainSink(input.eventSink);
							ctx.eventSink = input.eventSink;
							ctx.cumulativeTokens =
								input.cumulativeTokens ?? ctx.cumulativeTokens ?? 0;
							yield* this.releaseSinkEffect(priorSink);
							// Marks the assistant-message boundary: if the SDK's streaming
							// turn is still open, no `result` resets the translator, and
							// this reply would otherwise merge into the previous message.
							ctx.pendingAssistantBoundary = true;
							yield* ctx.promptQueue.enqueue(userMessage).pipe(
								Effect.catchAll((cause) =>
									Effect.gen(this, function* () {
										yield* shiftTurnDeferred(this.stateRef, ctx.sessionId);
										ctx.turnInFlight = false;
										return yield* Effect.fail(cause);
									}),
								),
							);
							ctx.settingsOutOfSync = false;
						}),
					);

					return turnDeferred;
				}),
			);

			return yield* Deferred.await(deferred).pipe(
				Effect.mapError(
					(cause) => new ClaudeBoundaryError({ operation: "awaitTurn", cause }),
				),
			);
		});
	}

	private hasAgentChanged(
		ctx: ClaudeSessionContext,
		input: SendTurnInput,
	): boolean {
		return input.agent !== ctx.currentAgent;
	}

	private agentSwitchDuringActiveTurnResult(
		ctx: ClaudeSessionContext,
		input: SendTurnInput,
	): TurnResult {
		return {
			status: "error",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			error: {
				code: "provider_error",
				message: `Cannot switch Claude agent while a turn is active (current=${ctx.currentAgent ?? "default"}, requested=${input.agent ?? "default"}).`,
			},
			providerStateUpdates: [],
		};
	}

	private restartSessionEffect(
		ctx: ClaudeSessionContext,
		input: SendTurnInput,
		reason: string,
	): Effect.Effect<TurnResult, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
			yield* FiberMap.remove(this.shutdownFibers, ctx.sessionId);
			yield* this.disposeSessionEffect(ctx, reason);
			return yield* this.createSessionAndSendTurnEffect(input);
		});
	}

	private runStreamConsumerEffect(
		ctx: ClaudeSessionContext,
		translator: ClaudeTranslationService,
	): Effect.Effect<void, ClaudeAdapterError> {
		const attributes = {
			providerId: this.providerId,
			sessionId: ctx.sessionId,
			turnId: ctx.currentTurnId ?? "unknown",
		};
		return this.consumeStreamEffect(ctx, translator).pipe(
			Effect.annotateLogs(attributes),
			Effect.withSpan("claude.stream.consume", { attributes }),
		);
	}

	private consumeStreamEffect(
		ctx: ClaudeSessionContext,
		translator: ClaudeTranslationService,
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
			let resultFinalizationStarted = false;
			yield* this.consumeStreamLoopEffect(ctx, translator, () => {
				resultFinalizationStarted = true;
			}).pipe(
				Effect.catchAll((err) =>
					ctx.resumeFallbackAllowed &&
					!ctx.queryInitialized &&
					isClaudeResumeFailure(err)
						? this.handleStreamFailureEffect(ctx, translator, err)
						: this.finishStreamOutputEffect(ctx, translator).pipe(
								Effect.matchEffect({
									onFailure: (limitError) =>
										this.handleStreamFailureEffect(ctx, translator, limitError),
									onSuccess: () =>
										this.handleStreamFailureEffect(ctx, translator, err),
								}),
							),
				),
				Effect.ensuring(
					this.finalizeStreamConsumerEffect(
						ctx,
						() => resultFinalizationStarted,
					).pipe(Effect.ignore),
				),
			);
		});
	}

	private consumeStreamLoopEffect(
		ctx: ClaudeSessionContext,
		translator: ClaudeTranslationService,
		markResultFinalizationStarted: () => void,
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
			const iterator = (ctx.query as AsyncIterable<unknown>)[
				Symbol.asyncIterator
			]();
			while (true) {
				if (ctx.stopped || !(yield* isCurrentSession(this.stateRef, ctx)))
					break;
				const next = yield* Effect.tryPromise({
					try: () => iterator.next(),
					catch: (cause) =>
						new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
				});
				if (next.done) break;
				if (ctx.stopped || !(yield* isCurrentSession(this.stateRef, ctx)))
					break;
				captureClaudeSdkMessage(ctx.sessionId, next.value);

				// A single message failing decode (SDK vocabulary drift) must not
				// kill the long-lived stream consumer — that turned one unknown
				// keepalive into "SDK stream ended without result" for the whole
				// session. Skip it; decodeProviderMessage already logged payload.
				const decodedMessage = yield* Effect.try({
					try: () => decodeProviderMessage(next.value),
					catch: (cause) =>
						cause instanceof ClaudeSDKDecodeError
							? cause
							: new ClaudeBoundaryError({
									operation: "decodeProviderMessage",
									cause,
								}),
				}).pipe(
					Effect.catchAll((cause) =>
						cause instanceof ClaudeSDKDecodeError
							? Effect.succeed(undefined)
							: Effect.fail(cause),
					),
				);
				if (decodedMessage === undefined) continue;
				if (
					decodedMessage.type === "system" &&
					decodedMessage.subtype === "init"
				)
					ctx.queryInitialized = true;
				if (
					decodedMessage.type === "result" &&
					ctx.resumeFallbackAllowed &&
					!ctx.queryInitialized &&
					isClaudeResumeFailure(
						sdkResultToTurnResult(ctx, decodedMessage).error,
					)
				) {
					ctx.resumeSessionId = undefined;
					ctx.pendingSyntheticMessages = undefined;
					ctx.turnInFlight = false;
					this.deps.onTurnStateChanged?.(ctx.sessionId, false);
					yield* resolveTurnEffect(this.stateRef, ctx, decodedMessage);
					break;
				}
				if (yield* pushForwardedSubagentMessageEffect(ctx, decodedMessage)) {
					continue;
				}
				if (
					(decodedMessage.type === "system" &&
						decodedMessage.subtype === "task_notification") ||
					((decodedMessage.type === "assistant" ||
						(decodedMessage.type === "stream_event" &&
							decodedMessage.event.type === "message_start")) &&
						decodedMessage.parent_tool_use_id == null)
				) {
					ctx.turnInFlight = true;
					this.deps.onTurnStateChanged?.(ctx.sessionId, true);
				}
				if (decodedMessage.type === "result") ctx.turnInFlight = false;
				const translatedMessages = yield* interceptClaudeUsageLimit(
					ctx,
					decodedMessage,
				);
				for (const message of translatedMessages)
					yield* translator.translate(ctx, message);
				yield* handleSubagentTaskStartedEffect(
					(input) => this.ensureSubagentSessionEffect(ctx, input),
					ctx,
					decodedMessage,
				);
				if (decodedMessage.type === "result") {
					const translatedResult = translatedMessages.find(
						(message) => message.type === "result",
					);
					this.deps.onTurnStateChanged?.(ctx.sessionId, false);
					const finalizationCtx = detachSubagentFinalizationContext(ctx);
					markResultFinalizationStarted();
					yield* this.runSubagentFinalizationEffect(
						finalizationCtx,
						decodedMessage,
					);
					yield* resolveTurnEffect(
						this.stateRef,
						ctx,
						translatedResult ?? decodedMessage,
					);
				}
			}
			yield* this.finishStreamOutputEffect(ctx, translator);
		});
	}

	private finishStreamOutputEffect(
		ctx: ClaudeSessionContext,
		translator: ClaudeTranslationService,
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen(function* () {
			yield* emitClaudeUsageLimit(ctx);
			const pending = ctx.pendingSyntheticMessages;
			ctx.pendingSyntheticMessages = undefined;
			// Ordinary SDK command output is still history if its stream ends
			// without a result; only classified limit replies are discarded.
			if (pending && !ctx.usageLimit)
				for (const message of pending)
					yield* translator.translate(ctx, message);
		});
	}

	private runSubagentFinalizationEffect(
		ctx: ClaudeSessionContext,
		result: SDKResultMessage,
	): Effect.Effect<void> {
		const key: ClaudeSubagentFinalizationFiberKey = {
			id: randomUUID(),
			sessionId: ctx.sessionId,
			turnId: ctx.currentTurnId ?? "unknown",
		};
		this.retainSink(ctx.eventSink);
		return FiberMap.run(
			this.subagentFinalizationFibers,
			key,
			finalizeSubagentsAfterResultEffect(
				{
					...(this.deps.subagentSdk
						? { subagentSdk: this.deps.subagentSdk }
						: {}),
					...(this.deps.subagentPollTimeoutMs !== undefined
						? { subagentPollTimeoutMs: this.deps.subagentPollTimeoutMs }
						: {}),
					...(this.deps.materializeSubagents
						? {
								materializeSubagents: (
									input: MaterializeClaudeSubagentsInput,
								) => this.materializeSubagentsEffect(ctx, input),
							}
						: {}),
				},
				ctx,
				result,
			).pipe(Effect.ensuring(this.releaseSinkEffect(ctx.eventSink))),
		).pipe(
			Effect.tap((fiber) =>
				Effect.sync(() => {
					// Effect observers run in reverse registration order. Report after
					// FiberMap's observer has removed the completed finalizer.
					const complete = this.deps.onSubagentFinalizationComplete;
					if (complete) fiber.addObserver(() => queueMicrotask(complete));
				}),
			),
			Effect.asVoid,
		);
	}

	private interruptSubagentFinalizersForSession(
		sessionId: string,
	): Effect.Effect<void> {
		return Effect.gen(this, function* () {
			const keys = Array.from(
				this.subagentFinalizationFibers,
				([key]) => key,
			).filter((key) => key.sessionId === sessionId);
			yield* Effect.forEach(
				keys,
				(key) => FiberMap.remove(this.subagentFinalizationFibers, key),
				{ discard: true },
			);
		});
	}

	private handleStreamFailureEffect(
		ctx: ClaudeSessionContext,
		translator: ClaudeTranslationService,
		err: unknown,
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
			stopSubagentPollers(ctx);
			if (ctx.stopped || !(yield* isCurrentSession(this.stateRef, ctx))) return;
			// Clear stale resume cursor so next turn starts a fresh SDK session
			const errMsg = err instanceof Error ? err.message : String(err);
			if (
				ctx.resumeSessionId &&
				!ctx.queryInitialized &&
				isClaudeResumeFailure(err)
			) {
				ctx.resumeSessionId = undefined;
				log.warn(
					`Session ${ctx.sessionId}: stale resume cursor cleared after: ${errMsg}`,
				);
				if (ctx.resumeFallbackAllowed) {
					ctx.turnInFlight = false;
					this.deps.onTurnStateChanged?.(ctx.sessionId, false);
					return yield* resolveErrorTurnEffect(this.stateRef, ctx, err);
				}
			}

			yield* translator.translateError(ctx, err).pipe(
				Effect.catchAll((translateErr) =>
					Effect.sync(() => {
						log.warn(
							`translateError failed for session ${ctx.sessionId}: ${translateErr instanceof Error ? translateErr.message : translateErr}`,
						);
					}),
				),
			);
			yield* resolveErrorTurnEffect(this.stateRef, ctx, err);
		});
	}

	private finalizeStreamConsumerEffect(
		ctx: ClaudeSessionContext,
		resultFinalizationStarted: () => boolean,
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
			if (!resultFinalizationStarted()) {
				stopSubagentPollers(ctx);
			}
			if (!ctx.stopped && (yield* isCurrentSession(this.stateRef, ctx))) {
				const current = yield* getSession(this.stateRef, ctx.sessionId);
				if (current === ctx) {
					yield* markStreamEnded(this.stateRef, ctx.sessionId);
					yield* rejectTurnIfPendingEffect(
						this.stateRef,
						ctx,
						new Error("SDK stream ended without result"),
					);
				}
			}
		}).pipe(
			// Once this stream ends, its background tasks can never report
			// completion, even after an interrupt: the next turn starts a new
			// query. A newer query that already replaced this one went through
			// removeSession, which cleared it; don't wipe the newer query's tasks.
			Effect.ensuring(
				Effect.gen(this, function* () {
					const current = yield* getSession(this.stateRef, ctx.sessionId);
					if (current === undefined || current === ctx) {
						this.deps.onTurnStateChanged?.(ctx.sessionId, false);
						yield* this.recordBackgroundTaskEffect({
							sessionId: ctx.sessionId,
							kind: "session-ended",
						});
					}
				}),
			),
		);
	}

	interruptTurnEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		const attributes = { providerId: this.providerId, sessionId };
		return this.mapProviderFailure(
			"interruptTurn",
			this.interruptSessionEffect(sessionId).pipe(
				Effect.annotateLogs(attributes),
				Effect.withSpan("claude.interrupt", { attributes }),
			),
		);
	}

	private interruptSessionEffect(
		sessionId: string,
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
			yield* FiberMap.remove(this.shutdownFibers, sessionId);
			yield* this.warmedQueries.discardEffect(sessionId);
			const ctx = yield* getSession(this.stateRef, sessionId);
			if (!ctx) return;

			log.info(`Interrupting turn for session ${sessionId}`);
			yield* this.cleanupSessionEffect(ctx, "Turn interrupted", false);
			// Stop means the whole session. interrupt() alone leaves the CLI alive
			// for up to 10 minutes while Monitor tasks and agents are armed, and the
			// next turn starts a new process anyway, so their results could never
			// arrive. Closing kills them now; the stream end then clears liveness.
			yield* Effect.try({
				try: () => ctx.query.close(),
				catch: (cause) =>
					new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
			}).pipe(Effect.ignore);
			yield* settleQueuedTurnDeferredsEffect(
				this.stateRef,
				ctx.sessionId,
				INTERRUPTED_TURN,
			);
			if (
				HashSet.has(
					(yield* getState(this.stateRef)).shutdownAfterTurn,
					sessionId,
				)
			)
				yield* this.scheduleShutdownAfterTurnEffect(sessionId);
		});
	}

	/**
	 * Shared cleanup for a single session — used by both interruptTurn()
	 * and shutdown(). Completes in-flight tools except questions on disposal,
	 * resolves pending approvals with deny, rejects provider question waiters, persists
	 * turn.interrupted + session.status idle for any in-flight turn, closes
	 * the prompt queue, and interrupts the SDK query.
	 */
	private cleanupSessionEffect(
		ctx: ClaudeSessionContext,
		reason: string,
		recoverQuestions: boolean,
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
			if (ctx.stopped) return;
			ctx.stopped = true;
			const turnInFlight = ctx.turnInFlight === true;
			const messageId = ctx.activeAssistantMessageId ?? "";

			stopSubagentPollers(ctx);
			yield* this.interruptSubagentFinalizersForSession(ctx.sessionId);

			for (const [, tool] of ctx.inFlightTools) {
				if (recoverQuestions && tool.toolName === "AskUserQuestion") continue;
				const event = claudeRuntimeEvent("tool.completed", ctx.sessionId, {
					messageId: ctx.lastAssistantUuid ?? "",
					partId: tool.itemId,
					result: null,
					duration: 0,
				});
				if (ctx.eventSink) {
					yield* ctx.eventSink.push(event).pipe(Effect.ignore);
				}
			}
			ctx.inFlightTools.clear();

			for (const pending of ctx.pendingApprovals.values()) {
				yield* pending.resolve("reject").pipe(Effect.ignore);
			}
			ctx.pendingApprovals.clear();

			for (const pending of ctx.pendingQuestions.values()) {
				yield* pending.reject(new Error(reason)).pipe(Effect.ignore);
			}
			ctx.pendingQuestions.clear();

			if (ctx.eventSink?.cancelSessionInteractions) {
				yield* Effect.try({
					try: () =>
						ctx.eventSink?.cancelSessionInteractions?.(reason, {
							recoverQuestions,
						}),
					catch: (cause) =>
						new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
				}).pipe(
					Effect.flatMap((cancelEffect) => cancelEffect ?? Effect.void),
					Effect.ignore,
				);
			}

			// Persist terminal turn state. The SDK's post-interrupt `result`
			// message is never translated (stream finalizers bail once
			// `stopped` is set), so without this the turn row stays 'running'
			// and the session stays 'busy' forever — the UI keeps showing the
			// session as processing until the next turn accidentally resets it.
			if (ctx.eventSink && turnInFlight) {
				const goalChange = ctx.goalTracker?.pause("Interrupted");
				if (goalChange) {
					yield* ctx.eventSink
						.push(
							claudeRuntimeEvent(
								"session.goal_changed",
								ctx.sessionId,
								goalChange,
							),
						)
						.pipe(Effect.ignore);
				}
				yield* ctx.eventSink
					.push(
						claudeRuntimeEvent("turn.interrupted", ctx.sessionId, {
							messageId,
						}),
					)
					.pipe(Effect.ignore);
				yield* ctx.eventSink
					.push(
						claudeRuntimeEvent("session.status", ctx.sessionId, {
							sessionId: ctx.sessionId,
							status: "idle",
						}),
					)
					.pipe(Effect.ignore);
			}

			ctx.turnInFlight = false;
			this.deps.onTurnStateChanged?.(ctx.sessionId, false);

			yield* ctx.promptQueue.close().pipe(Effect.ignore);

			yield* Effect.tryPromise({
				try: () => ctx.query.interrupt(),
				catch: (cause) =>
					new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
			}).pipe(Effect.ignore);
		});
	}

	resolvePermissionEffect(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.mapProviderFailure(
			"resolvePermission",
			Effect.gen(this, function* () {
				const ctx = yield* getSession(this.stateRef, sessionId);
				if (!ctx) return;

				yield* this.permissionBridge.resolvePermission(
					ctx,
					requestId,
					decision,
				);
			}),
		);
	}

	resolveQuestionEffect(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.mapProviderFailure(
			"resolveQuestion",
			Effect.gen(this, function* () {
				const ctx = yield* getSession(this.stateRef, sessionId);
				if (!ctx) return;

				const pending = ctx.pendingQuestions.get(requestId);
				if (pending) {
					yield* pending.resolve(answers);
					ctx.pendingQuestions.delete(requestId);
				}
			}),
		);
	}

	/**
	 * Terminal disposal of a single session: cleanup + reject pending turn
	 * deferreds + close the SDK query + remove from the session map. Shared
	 * by endSessionEffect() and shutdown(); interruptTurnEffect() still uses cleanupSession
	 * alone because interrupt is resumable.
	 */
	private disposeSessionEffect(
		ctx: ClaudeSessionContext,
		reason: string,
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
			yield* this.cleanupSessionEffect(ctx, reason, true);

			yield* settleQueuedTurnDeferredsEffect(
				this.stateRef,
				ctx.sessionId,
				reason,
			);

			// Terminal close of the SDK query (vs interrupt(), which is resumable).
			yield* Effect.try({
				try: () => ctx.query.close(),
				catch: (cause) =>
					new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
			}).pipe(Effect.ignore);

			yield* FiberMap.remove(this.streamFibers, ctx.sessionId);
			yield* this.removeSessionEffect(ctx.sessionId);
		});
	}

	endSessionEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.mapProviderFailure(
			"endSession",
			this.endSessionLocalEffect(sessionId),
		);
	}

	private endSessionLocalEffect(
		sessionId: string,
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
			yield* FiberMap.remove(this.shutdownFibers, sessionId);
			yield* this.warmedQueries.discardEffect(sessionId);
			const ctx = yield* getSession(this.stateRef, sessionId);
			if (!ctx) return; // idempotent
			log.info(`Ending Claude session: ${sessionId}`);
			yield* this.disposeSessionEffect(ctx, "Session ended (reload)");
		});
	}

	shutdownEffect(): Effect.Effect<void, ProviderInstanceFailure> {
		const attributes = { providerId: this.providerId };
		return this.mapProviderFailure(
			"shutdown",
			this.shutdownLocalEffect().pipe(
				Effect.annotateLogs(attributes),
				Effect.withSpan("claude.shutdown", { attributes }),
			),
		);
	}

	shutdownLocalEffect(): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
			yield* this.warmedQueries.clearEffect();
			yield* FiberMap.clear(this.shutdownFibers);
			log.info("ClaudeProviderRuntime shutting down");
			const state = yield* getState(this.stateRef);
			for (const ctx of HashMap.values(state.sessions)) {
				yield* this.disposeSessionEffect(
					ctx,
					"Provider instance shutting down",
				);
			}
			yield* Ref.set(this.stateRef, emptyClaudeProviderRuntimeState());
			yield* FiberMap.clear(this.streamFibers);
			yield* FiberMap.clear(this.subagentFinalizationFibers);
		});
	}

	/**
	 * Set the permission bridge. Called during session setup (sendTurn).
	 * Exposed for testing.
	 */
	protected setPermissionBridge(bridge: ClaudePermissionBridge): void {
		this.permissionBridge = bridge;
	}

	/**
	 * Get the permission bridge, creating one if needed.
	 */
	protected getPermissionBridge(): ClaudePermissionBridge {
		return this.permissionBridge;
	}
}
