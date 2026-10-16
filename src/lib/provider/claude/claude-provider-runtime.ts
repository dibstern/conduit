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
 *   Nothing persists to disk. Commands and skills are enumerated from the
 *   resolved account folder and <workspace>/.claude/.
 * - Shutdown is graceful: close every session's prompt queue, call the
 *   runtime's close(), then clear the session map.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
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
	Either,
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
import type { Account } from "../../contracts/account.js";
import { PROVIDER_DRIVERS } from "../../contracts/provider-instance.js";
import type {
	ClaudeSDKCommandLifecycleMessage,
	ClaudeSDKPermissionMode,
} from "../../contracts/providers/claude-agent-sdk.js";
import {
	loadDaemonConfigResult,
	resolveClaudeLaunchConfig,
} from "../../daemon/config-persistence.js";
import {
	bindTurnTimelineSink,
	observeTurnTimelineFrame,
} from "../../domain/daemon/Services/turn-timeline.js";
import { PendingInteractionServiceTag } from "../../domain/relay/Services/pending-interaction-service.js";
import {
	type ProviderRuntimeIngestionError,
	ProviderRuntimeIngestionTag,
} from "../../domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	makeProcessingTimeoutHooks,
	type OverridesStateTag,
} from "../../domain/relay/Services/session-overrides-state.js";
import { formatErrorDetail } from "../../errors-utils.js";
import { createLogger } from "../../logger.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectTag,
	type ClaudeEventPersistFailure,
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
import { isInterruptedResult } from "./claude-event-translator.js";
import {
	ClaudeGoalTracker,
	type ReadClaudeGoalStatus,
} from "./claude-goal-tracker.js";
import {
	type ClaudeOwnershipDecision,
	createClaudeMessageOwnership,
} from "./claude-message-ownership.js";
import {
	applyClaudeOwnershipDecisionEffect,
	decideClaudeMessageOwnershipEffect,
	endClaudeMessageOwnershipEffect,
	finalReadClaudeSubagentFeedEffect,
	startClaudeSubagentFeedEffect,
} from "./claude-message-ownership-runtime.js";
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
	addTurnWaiter,
	buildUserMessage,
	cancelTurnWaiterEffect,
	hasPendingTurn,
	pendingTurnWaiters,
	rejectTurnIfPendingEffect,
	removeTurnWaiter,
	resolveErrorTurnEffect,
	resolveTurnEffect,
	sdkResultToTurnResult,
	settleQueuedTurnDeferredsEffect,
	startTurnWaiter,
	type TurnWaiters,
} from "./claude-runtime-turn.js";
import {
	type ClaudeConfigDir,
	configuredClaudeConfigDir,
	sameClaudeLogin,
	sdkDefaultClaudeConfigDir,
} from "./claude-sdk-env.js";
import {
	asError,
	ClaudeSDKDecodeError,
	decodeProviderMessage,
	validateUserMessage,
} from "./claude-sdk-validation.js";
import {
	type ClaudeSessionForkSdk,
	defaultClaudeSessionForkSdk,
	resolveRewindUpToUuid,
} from "./claude-session-fork.js";
import type {
	ClaudeSessionCommand,
	ClaudeSessionFailure,
	ClaudeSessionOutput,
	ClaudeSessionOutputReply,
	ClaudeSessionRunner,
} from "./claude-session-runner.js";
import type { ClaudeSubagentSdk } from "./claude-subagent-materializer.js";
import { claudeSubagentSessionId } from "./claude-subagent-materializer.js";
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
	ClaudeSendTurnInput,
	ClaudeSessionContext,
	PromptQueueController,
	Query,
	Options as SDKOptions,
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
		configDir: ClaudeConfigDir;
		prompt: AsyncIterable<SDKUserMessage>;
		options?: SDKOptions;
	}) => Query;
	readonly subagentSdk?: ClaudeSubagentSdk;
	readonly sessionForkSdk?: ClaudeSessionForkSdk;
	readonly ensureClaudeSubagentSession?: ClaudeEventPersistEffect["ensureClaudeSubagentSession"];
	readonly persistUserMessage?: ClaudeEventPersistEffect["persistUserMessage"];
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
	| "prepareShellEnv"
	| "claudeSettingsOverrides"
	| "queryFactory"
	| "subagentSdk"
	| "sessionForkSdk"
	| "subagentPollTimeoutMs"
	| "capabilitiesService"
	| "readGoalStatus"
	| "persistHandoffDelivered"
> & {
	readonly onSubagentFinalizationComplete?: () => void;
	readonly onTurnStateChanged?: (sessionId: string, inFlight: boolean) => void;
	readonly prepareQuery?: () => Promise<void>;
};

export interface ClaudeProviderRuntimeState {
	readonly sessions: HashMap.HashMap<string, ClaudeSessionContext>;
	readonly setupLocks: HashMap.HashMap<string, Deferred.Deferred<void, Error>>;
	readonly turnWaiters: HashMap.HashMap<string, TurnWaiters>;
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
			deps.capabilitiesService ??
			(yield* makeClaudeCapabilitiesService({
				launchConfig: () =>
					resolveClaudeLaunchConfig(
						Either.getOrElse(
							loadDaemonConfigResult(deps.daemonConfigDir),
							(error) => {
								if (error._tag === "NotFound") return null;
								throw error;
							},
						),
					),
			}));
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
				...(deps.prepareShellEnv
					? { prepareShellEnv: deps.prepareShellEnv }
					: {}),
				...(deps.claudeSettingsOverrides
					? { claudeSettingsOverrides: deps.claudeSettingsOverrides }
					: {}),
				...(deps.queryFactory ? { queryFactory: deps.queryFactory } : {}),
				...(deps.subagentSdk ? { subagentSdk: deps.subagentSdk } : {}),
				...(deps.sessionForkSdk ? { sessionForkSdk: deps.sessionForkSdk } : {}),
				...(deps.subagentPollTimeoutMs !== undefined
					? { subagentPollTimeoutMs: deps.subagentPollTimeoutMs }
					: {}),
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
		const scope = yield* Effect.scope;
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
			deps.capabilitiesService ??
			(yield* makeClaudeCapabilitiesService({
				launchConfig: () =>
					resolveClaudeLaunchConfig(
						Either.getOrElse(
							loadDaemonConfigResult(deps.daemonConfigDir),
							(error) => {
								if (error._tag === "NotFound") return null;
								throw error;
							},
						),
					),
			}));
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
			scope,
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
	/** Sends handed to the runner and not yet finished, per session. */
	private readonly sendsInFlight = new Map<string, number>();
	private detachingInteractions = false;
	private recoveredSink: ((sessionId: string) => EventSink) | undefined;
	private readonly recoveredSinkIds = new Set<string>();
	private readonly recoveredRequests = new Map<
		string,
		Deferred.Deferred<void>
	>();

	readonly recoverEffect = Effect.gen(this, function* () {
		const sql = yield* SqlClient.SqlClient;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const pending = yield* PendingInteractionServiceTag;
		const timeoutRuntime = yield* Effect.runtime<OverridesStateTag>();
		// An in-process runner's turns ended with the relay that ran them, so
		// every running command is unclaimed. Runner processes may outlive it.
		let claimed = new Set<string>();
		if (this.runner.recoverEffect) {
			this.recoveredSink = (sessionId) =>
				makeRecoveredClaudeEventSink({
					sessionId,
					sql,
					ingestion,
					pending,
					timeoutHooks: makeProcessingTimeoutHooks(timeoutRuntime, sessionId),
					onRegistered: (id) => {
						const ready = this.recoveredRequests.get(id);
						return ready ? Deferred.succeed(ready, undefined) : Effect.void;
					},
				});
			yield* this.runner.recoverEffect;
			const registrations = yield* Effect.try(() =>
				discoverClaudeRunners(
					this.deps.workspaceRoot,
					this.deps.daemonConfigDir,
				),
			).pipe(
				Effect.catchAll((error) =>
					Effect.logError(
						"Could not verify Claude runner ownership",
						error,
					).pipe(Effect.as(undefined)),
				),
			);
			// Discovery errors are not proof that a running command has no owner.
			if (!registrations) return;
			claimed = new Set(registrations.map((runner) => runner.sessionId));
		}
		yield* settleUnclaimedClaudeRunnerCommands(
			sql,
			claimed,
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

	discoverEffect(
		workspaceRoot?: string,
		account?: Account,
	): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure> {
		return Effect.gen(this, function* () {
			const configDir =
				account?.driver === "claude"
					? account.folder
					: resolveClaudeLaunchConfig(
							yield* Effect.suspend(() =>
								loadDaemonConfigResult(this.deps.daemonConfigDir),
							).pipe(Effect.catchTag("NotFound", () => Effect.succeed(null))),
						).configDir;
			return yield* discoverCapabilitiesEffect(
				workspaceRoot ?? this.deps.workspaceRoot,
				this.deps.capabilitiesService,
				configDir,
			);
		}).pipe(
			Effect.mapError(
				(cause) =>
					new ProviderInstanceFailure({
						providerId: this.providerId,
						operation: "discover",
						cause,
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
			const { eventSink, abortSignal, ...payload } = input;
			const account = input.account;
			if (
				account &&
				PROVIDER_DRIVERS[account.driver].accountKind !== "config-directory"
			)
				return yield* Effect.fail(
					new ProviderInstanceFailure({
						providerId: this.providerId,
						operation: "sendTurn",
						cause: new Error("Claude turn requires a Claude account"),
					}),
				);
			const folder =
				(account?.driver === "claude" ? account.folder : undefined) ??
				input.configDir;
			if (folder === undefined)
				return yield* Effect.fail(
					new ProviderInstanceFailure({
						providerId: this.providerId,
						operation: "sendTurn",
						cause: new Error(
							"Claude turn requires a resolved account or explicit config directory",
						),
					}),
				);
			const turn = {
				...payload,
				configDir: folder,
				folderSource: input.folderSource ?? "account",
				...(account ? { instanceId: account.id } : {}),
			};
			const claudeSettingsOverrides = yield* Effect.try({
				try: () => this.deps.claudeSettingsOverrides?.(),
				catch: (cause) =>
					new ProviderInstanceFailure({
						providerId: this.providerId,
						operation: "sendTurn",
						cause,
					}),
			});
			const { sessionId } = input;
			return yield* Effect.acquireUseRelease(
				Effect.sync(() => {
					const inFlight = this.sendsInFlight.get(sessionId) ?? 0;
					this.sendsInFlight.set(sessionId, inFlight + 1);
					return inFlight;
				}),
				(inFlight) =>
					Effect.gen(this, function* () {
						// An idle send is placed before the runner hop, as fast as a
						// local write; the runner places a held send when the SDK
						// starts it (command_lifecycle: started). A continuation places
						// nothing: it resumes the cut-off message's turn.
						if (inFlight === 0 && !input.continuation)
							yield* this.placeUserMessageEffect({
								sessionId,
								inputId: input.inputId,
								text: input.text ?? input.prompt,
							}).pipe(
								Effect.mapError(
									(cause) =>
										new ProviderInstanceFailure({
											providerId: this.providerId,
											operation: "sendTurn",
											cause,
										}),
								),
							);
						// The SDK reports busy only once the model streams, so SDK-local
						// work (a manual /compact, a slash command) ran with the session
						// idle until its result. A send to an idle session starts its
						// turn now; the turn's end reports idle as before.
						if (inFlight === 0)
							yield* eventSink
								.push(
									claudeRuntimeEvent("session.status", sessionId, {
										sessionId,
										status: "busy",
									}),
								)
								.pipe(Effect.ignore);
						const sinkId = claudeRunnerSinkId(
							input.inputId,
							input.commandAttempt,
							input.nativeResumeFallback,
						);
						this.sinks.set(sinkId, eventSink);
						bindTurnTimelineSink(sinkId, {
							sessionId,
							inputId: input.inputId,
						});
						this.reportSinkForTesting("allocated", sinkId, sessionId);
						const aborted = Effect.async<void>((resume) => {
							const onAbort = () => resume(Effect.void);
							if (abortSignal.aborted) onAbort();
							else
								abortSignal.addEventListener("abort", onAbort, { once: true });
							return Effect.sync(() =>
								abortSignal.removeEventListener("abort", onAbort),
							);
						});
						yield* FiberMap.run(
							this.abortFibers,
							sinkId,
							aborted.pipe(
								Effect.andThen(
									this.runner.executeEffect({ type: "abort", sinkId }),
								),
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
					}),
				() =>
					Effect.sync(() => {
						const remaining = (this.sendsInFlight.get(sessionId) ?? 1) - 1;
						if (remaining > 0) this.sendsInFlight.set(sessionId, remaining);
						else this.sendsInFlight.delete(sessionId);
					}),
			);
		});
	}

	/** Places a send's user message once; only a missing session fails it. */
	private placeUserMessageEffect(input: {
		readonly sessionId: string;
		readonly inputId: string;
		readonly text: string;
	}): Effect.Effect<void, ClaudeEventPersistFailure> {
		return Effect.gen(this, function* () {
			const persist = yield* Effect.serviceOption(ClaudeEventPersistEffectTag);
			const persistUserMessage =
				this.deps.persistUserMessage ??
				(persist._tag === "Some"
					? persist.value.persistUserMessage
					: undefined);
			if (!persistUserMessage) return;
			yield* persistUserMessage(input.sessionId, input.text, {
				messageId: input.inputId,
				inputId: input.inputId,
			}).pipe(
				Effect.catchIf(
					(error) => error._tag !== "ClaudeSessionLifecycleError",
					(error) =>
						Effect.sync(() =>
							log.warn(
								`Non-fatal persistence error for Claude user message: ${formatErrorDetail(error)}`,
							),
						),
				),
			);
		});
	}

	preWarmSessionEffect(
		input: PreWarmSessionInput,
	): Effect.Effect<void, ProviderInstanceFailure> {
		const preWarm = Effect.gen(this, function* () {
			const account = input.account;
			if (
				account &&
				PROVIDER_DRIVERS[account.driver].accountKind !== "config-directory"
			)
				return yield* Effect.fail(
					new ProviderInstanceFailure({
						providerId: this.providerId,
						operation: "preWarmSession",
						cause: new Error("Claude warm-up requires a Claude account"),
					}),
				);
			const folder =
				(account?.driver === "claude" ? account.folder : undefined) ??
				input.configDir;
			if (folder === undefined)
				return yield* Effect.fail(
					new ProviderInstanceFailure({
						providerId: this.providerId,
						operation: "preWarmSession",
						cause: new Error(
							"Claude warm-up requires a resolved account or explicit config directory",
						),
					}),
				);
			let model = input.model;
			if (!model) {
				// Discovery is shared with sends; cancellation only stops this waiter.
				const discovery = yield* Effect.forkIn(
					this.discoverEffect(input.workspaceRoot, account),
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
				input: {
					...input,
					model,
					configDir: folder,
					folderSource: input.folderSource ?? "account",
					...(account ? { instanceId: account.id } : {}),
				},
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
	stopTaskEffect(
		sessionId: string,
		taskId: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.commandEffect({ type: "stop-task", sessionId, taskId });
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
			observeTurnTimelineFrame(output);
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
				case "place-user-message":
					return yield* this.placeUserMessageEffect(output.input).pipe(
						Effect.mapError((cause) => sessionFailure(output.type, cause)),
					);
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
			Effect.as({}),
			Effect.catchAllDefect((cause) =>
				Effect.fail(sessionFailure(output.type, cause)),
			),
		);
	}
}

class InProcessClaudeSessionRunner implements ClaudeSessionRunner {
	readonly providerId = "claude";
	private readonly endingOwnership = new WeakSet<ClaudeSessionContext>();
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
		private readonly scope: Scope.Scope,
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
				case "stop-task": {
					const ctx = yield* getSession(this.stateRef, command.sessionId);
					if (!ctx || ctx.stopped)
						return yield* Effect.fail(
							new ClaudeBoundaryError({
								operation: "stopTask",
								cause: "Claude session is not running in this runner",
							}),
						);
					yield* Effect.tryPromise({
						try: () => ctx.query.stopTask(command.taskId),
						catch: (cause) =>
							new ClaudeBoundaryError({ operation: "stopTask", cause }),
					});
					return;
				}
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
				default: {
					// A newer daemon can send a command this build lacks; acknowledging
					// it would report work that never happened.
					const unknown: { readonly type: string } = command;
					return yield* Effect.fail(
						new ClaudeBoundaryError({
							operation: "executeCommand",
							cause: `Unsupported Claude runner command: ${unknown.type}`,
						}),
					);
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
		return Effect.gen(this, function* () {
			const ctx = yield* getSession(this.stateRef, transition.sessionId);
			if (ctx)
				ctx.liveBackgroundTaskCount =
					transition.kind === "snapshot" ? transition.tasks.length : 0;
			yield* this.emit({ type: "background-task", transition }).pipe(
				Effect.orDie,
			);
		});
	}

	/**
	 * The server places the message before this turn may produce output. A
	 * continuation places nothing: it resumes the cut-off message's turn.
	 */
	private placeUserMessageEffect(
		input: SendTurnInput,
	): Effect.Effect<void, ClaudeAdapterError> {
		const sinkId = this.sinkId(input.eventSink);
		if (!sinkId || input.continuation) return Effect.void;
		return this.emit({
			type: "place-user-message",
			sinkId,
			input: {
				sessionId: input.sessionId,
				inputId: input.inputId,
				text: input.text ?? input.prompt,
			},
		}).pipe(
			Effect.asVoid,
			Effect.mapError(
				(cause) =>
					new ClaudeBoundaryError({
						operation: "placeUserMessage",
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

	private mapProviderFailure<A, E>(
		operation: string,
		effect: Effect.Effect<A, E>,
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

	discoverEffect(
		workspaceRoot?: string,
		account?: Account,
	): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure> {
		return this.mapProviderFailure(
			"discover",
			Effect.gen(this, function* () {
				const configDir =
					account?.driver === "claude"
						? account.folder
						: resolveClaudeLaunchConfig(
								yield* Effect.suspend(() =>
									loadDaemonConfigResult(this.deps.daemonConfigDir),
								).pipe(Effect.catchTag("NotFound", () => Effect.succeed(null))),
							).configDir;
				return yield* discoverCapabilitiesEffect(
					workspaceRoot ?? this.deps.workspaceRoot,
					this.deps.capabilitiesService,
					configDir,
				);
			}),
		);
	}

	/**
	 * `undefined` means "no expectation" -- under exactOptionalPropertyTypes that
	 * has to clear the field rather than store an undefined in it, or the drift
	 * check would compare against a value nobody stands behind.
	 */

	sendTurnEffect(
		input: ClaudeSendTurnInput,
	): Effect.Effect<TurnResult, ProviderInstanceFailure> {
		const attributes = {
			providerId: this.providerId,
			sessionId: input.sessionId,
			turnId: input.inputId,
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
		input: ClaudeSendTurnInput,
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
			if (
				input.rewind !== undefined &&
				(yield* hasPendingTurn(this.stateRef, sessionId))
			)
				return yield* Effect.fail(
					new ClaudeRuntimeError({
						message: "Cannot commit a Claude rewind while a turn is active",
					}),
				);
			if (existingCtx?.stopped) {
				// Safety net: any path that stopped this context (interruptTurn,
				// endSession, shutdown) leaves it in sessions with a closed prompt
				// queue; enqueueing would throw. Evict silently and create fresh.
				log.info(`Evicting stopped session on sendTurn: ${sessionId}`);
				yield* this.removeSessionEffect(sessionId);
				return yield* this.createSessionAndSendTurnEffect(input);
			} else if (
				existingCtx &&
				!sameClaudeLogin(
					{ configDir: existingCtx.configDir, root: existingCtx.workspaceRoot },
					{ configDir: input.configDir, root: input.workspaceRoot },
				) &&
				!(yield* hasPendingTurn(this.stateRef, sessionId))
			) {
				return yield* this.restartSessionEffect(
					existingCtx,
					input,
					"Claude account folder changed",
				);
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
				(input.startFreshNativeSession || input.rewind !== undefined) &&
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
		input: ClaudeSendTurnInput,
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
			yield* addTurnWaiter(this.stateRef, sessionId, input.inputId, {
				deferred,
				started: false,
			});

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
				yield* this.placeUserMessageEffect(input);
				let resumeSessionAt = input.resumeSessionAt;
				const rewindPoint = input.rewind?.resumeSessionAt;
				if (
					rewindPoint !== undefined &&
					rewindPoint !== null &&
					input.resumeSessionId === undefined &&
					input.handoff === undefined
				)
					return yield* Effect.fail(
						new ClaudeRuntimeError({
							message:
								"Claude rewind has no native session or kept-history handoff",
						}),
					);
				if (
					rewindPoint !== undefined &&
					rewindPoint !== null &&
					input.resumeSessionId !== undefined
				) {
					const resumeSessionId = input.resumeSessionId;
					const configDir = input.configDir;
					const transcript = yield* Effect.tryPromise({
						try: () =>
							(
								this.deps.sessionForkSdk ?? defaultClaudeSessionForkSdk
							).readTranscript(resumeSessionId, {
								dir: input.workspaceRoot,
								configDir,
							}),
						catch: (cause) =>
							new ClaudeBoundaryError({
								operation: "resolveClaudeRewind",
								cause,
							}),
					});
					// Conduit uses API message ids; SDK resume needs the transcript's
					// chain uuid. Keep tool-result tails belonging to the kept turn.
					const resolvedPoint = resolveRewindUpToUuid(
						transcript,
						rewindPoint,
						input.rewind?.targetMessageId,
					);
					resumeSessionAt = resolvedPoint ?? undefined;
					if (resolvedPoint === undefined)
						return yield* Effect.fail(
							new ClaudeRuntimeError({
								message: `Rewind point ${rewindPoint} before ${input.rewind?.targetMessageId ?? "the discarded turns"} was not found in the Claude transcript`,
							}),
						);
				}
				const launchInput =
					rewindPoint === null ||
					(input.rewind !== undefined && resumeSessionAt === undefined)
						? {
								...input,
								resumeSessionId: undefined,
								resumeSessionAt: undefined,
								nativeThread: undefined,
							}
						: { ...input, resumeSessionAt };
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
							launchInput,
							abortController,
							canUseTool,
							this.sinkBindings.get(this.sinkId(input.eventSink) ?? "")
								?.claudeSettingsOverrides,
							this.deps.shellEnv?.(input.workspaceRoot),
						),
					catch: (cause) =>
						new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
				});
				if (input.rewind !== undefined)
					yield* this.warmedQueries.discardEffect(sessionId);
				const warmed = yield* this.warmedQueries.takeEffect(
					sessionId,
					launchOptions,
					input.configDir,
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
					nativeThread: launchInput.nativeThread,
					workspaceRoot: input.workspaceRoot,
					configDir: input.configDir,
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
					subagentTranscripts: new Map(),
					failedSubagentSessions: new Set<string>(),
					eventSink: input.eventSink,
					currentTurnId: input.inputId,
					currentUserMessageId:
						input.continuation?.cutOffMessageId ?? input.inputId,
					resumeFallbackAllowed:
						input.rewind === undefined &&
						!!launchInput.resumeSessionId &&
						!!launchInput.handoff,
					queryInitialized: false,
					turnInFlight: true,
					currentModel: input.model?.modelId,
					currentApiModelId: apiModelId,
					...(expectedApiModelId ? { expectedApiModelId } : {}),
					...(input.agent ? { currentAgent: input.agent } : {}),
					...(input.variant === undefined
						? {}
						: { currentVariant: input.variant }),
					settingsOutOfSync: false,
					resumeSessionId,
					lastAssistantUuid: undefined,
					turnCount: 0,
					stopped: false,
				};

				// A warmed query's queue may already be closed under us.
				const admitPrompt = queue
					.enqueue(userMessage)
					.pipe(
						Effect.mapError(
							(cause) => new ClaudeRuntimeError({ message: cause.message }),
						),
					);
				// Cold creation retains the SDK's original first-prompt admission.
				if (!warmed) yield* admitPrompt;
				const query =
					warmed?.query ??
					(yield* Effect.try({
						try: () =>
							this.queryFactory({
								configDir: launchInput.configDir,
								prompt: queue,
								options,
							}),
						catch: (cause) =>
							new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
					}));
				activeQuery = query;
				ctx = {
					...context,
					query,
					configDir:
						input.configDir._tag === "SdkDefault"
							? sdkDefaultClaudeConfigDir(
									resolve(input.workspaceRoot, input.configDir.path),
								)
							: configuredClaudeConfigDir(
									resolve(input.workspaceRoot, input.configDir.path),
								),
				};
				const ownershipContext = ctx;
				ctx.messageOwnership = createClaudeMessageOwnership({
					childSessionIdFor: (taskId, message) =>
						claudeSubagentSessionId({
							parentConduitSessionId: ownershipContext.sessionId,
							parentClaudeSessionId:
								ownershipContext.resumeSessionId ?? message.session_id ?? "",
							sdkSubagentId: taskId,
						}),
				});
				warmed?.bindContext(ctx);
				if (warmed) yield* admitPrompt;

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
				if (settings.variant !== undefined) {
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
		input: ClaudeSendTurnInput,
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
					// A send that needs no settings change joins the live query at
					// once: mid-turn it is a steer, which the SDK reads at its next
					// tool boundary. One that changes the model or effort waits for
					// the turns ahead to finish, so it never retunes them mid-flight,
					// and never inherits their failure: the liveness checks below
					// decide whether it may still proceed.
					const priorTurns = yield* pendingTurnWaiters(
						this.stateRef,
						ctx.sessionId,
					);
					const apiModelId = claudeApiModelId(
						input.model?.modelId ?? ctx.currentModel,
						input.contextWindow,
					);
					const retunes =
						ctx.settingsOutOfSync ||
						(apiModelId !== undefined &&
							apiModelId !== ctx.currentApiModelId) ||
						input.variant !== ctx.currentVariant;
					if (priorTurns.size > 0 && retunes)
						yield* Effect.forEach(
							priorTurns.values(),
							(prior) => Deferred.await(prior.deferred).pipe(Effect.ignore),
							{ discard: true },
						);
					const joinsRunningTurn =
						(yield* pendingTurnWaiters(this.stateRef, ctx.sessionId)).size > 0;

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
					yield* (ctx.messageOwnershipPermit ??=
						Effect.unsafeMakeSemaphore(1)).withPermits(1)(
						Effect.uninterruptible(
							Effect.gen(this, function* () {
								// A held send is placed when the SDK starts it.
								yield* addTurnWaiter(
									this.stateRef,
									ctx.sessionId,
									input.inputId,
									{
										deferred: turnDeferred,
										started: false,
										unplaced: input,
									},
								);
								// A steer becomes current when the SDK starts it.
								if (!joinsRunningTurn) {
									ctx.currentTurnId = input.inputId;
									ctx.currentUserMessageId =
										input.continuation?.cutOffMessageId ?? input.inputId;
									ctx.resumeFallbackAllowed =
										!!input.resumeSessionId && !!input.handoff;
									ctx.usageLimit = undefined;
									ctx.usageLimitReported = undefined;
									ctx.pendingSyntheticMessages = undefined;
									const priorSink = ctx.eventSink;
									this.retainSink(input.eventSink);
									ctx.eventSink = input.eventSink;
									ctx.cumulativeTokens =
										input.cumulativeTokens ?? ctx.cumulativeTokens ?? 0;
									yield* this.releaseSinkEffect(priorSink);
								}
								// Marks the turn as started so a system/init arriving before
								// the first assistant chunk cannot report the session idle.
								ctx.turnInFlight = true;
								// The queue closes when a Stop or stream end overtakes this
								// send during the settings sync above. The SDK will never
								// read the prompt, so end the turn here rather than wait.
								yield* ctx.promptQueue.enqueue(userMessage).pipe(
									Effect.catchTag("EffectPromptQueueClosed", () =>
										Effect.gen(this, function* () {
											yield* removeTurnWaiter(
												this.stateRef,
												ctx.sessionId,
												input.inputId,
											);
											ctx.turnInFlight = false;
											// As above: a Stop already sent done for this turn.
											if (ctx.stopped)
												return yield* Deferred.succeed(
													turnDeferred,
													INTERRUPTED_TURN,
												);
											return yield* Effect.fail(
												new ClaudeRuntimeError({
													message: `Claude session is no longer active: ${ctx.sessionId}`,
												}),
											);
										}),
									),
								);
								ctx.settingsOutOfSync = false;
							}),
						),
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
		input: ClaudeSendTurnInput,
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
			yield* this.consumeStreamLoopEffect(ctx, translator).pipe(
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
					this.finalizeStreamConsumerEffect(ctx).pipe(Effect.ignore),
				),
			);
		});
	}

	private consumeStreamLoopEffect(
		ctx: ClaudeSessionContext,
		translator: ClaudeTranslationService,
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
				if (decodedMessage.type === "command_lifecycle") {
					yield* this.handleCommandLifecycleEffect(ctx, decodedMessage);
				}
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
				if (
					decodedMessage.type === "system" &&
					decodedMessage.subtype === "background_tasks_changed"
				) {
					yield* decideClaudeMessageOwnershipEffect(
						ctx,
						{
							kind: "live-tasks",
							taskIds: decodedMessage.tasks.map((task) => task.task_id),
						},
						(decisions) =>
							this.applyClaudeOwnershipDecisionsEffect(
								ctx,
								translator,
								decisions,
							),
					);
				}
				yield* decideClaudeMessageOwnershipEffect(
					ctx,
					{
						kind: "sdk",
						message: decodedMessage,
					},
					(decisions) =>
						this.applyClaudeOwnershipDecisionsEffect(
							ctx,
							translator,
							decisions,
							ctx.resumeSessionId ?? decodedMessage.session_id,
						),
				);
			}
			yield* this.finishStreamOutputEffect(ctx, translator);
		});
	}

	private applyClaudeOwnershipDecisionsEffect(
		ctx: ClaudeSessionContext,
		translator: ClaudeTranslationService,
		decisions: readonly ClaudeOwnershipDecision[],
		parentClaudeSessionId = ctx.resumeSessionId,
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
			let parentChildLink: Effect.Effect<void> | undefined;
			for (const decision of decisions) {
				if (decision.kind === "start-feed") {
					yield* startClaudeSubagentFeedEffect(
						this.deps,
						this.scope,
						ctx,
						decision,
						(decisions) =>
							this.applyClaudeOwnershipDecisionsEffect(
								ctx,
								translator,
								decisions,
							),
						parentClaudeSessionId,
					);
					continue;
				}
				if (decision.kind === "final-read") {
					yield* this.runSubagentFinalizationEffect(
						ctx,
						finalReadClaudeSubagentFeedEffect(
							this.deps,
							ctx,
							decision,
							(decisions) =>
								this.applyClaudeOwnershipDecisionsEffect(
									ctx,
									translator,
									decisions,
								),
						),
					);
					continue;
				}
				if (decision.kind !== "route" || decision.owner.kind !== "parent") {
					const childLink = yield* applyClaudeOwnershipDecisionEffect(
						(input) => this.ensureSubagentSessionEffect(ctx, input),
						ctx,
						decision,
						parentClaudeSessionId,
					);
					if (childLink) parentChildLink = childLink;
					continue;
				}
				const message = decision.message;
				if (
					(message.type === "system" &&
						message.subtype === "task_notification" &&
						message.status !== "stopped") ||
					((message.type === "assistant" ||
						(message.type === "stream_event" &&
							message.event.type === "message_start")) &&
						message.parent_tool_use_id == null)
				) {
					ctx.turnInFlight = true;
					this.deps.onTurnStateChanged?.(ctx.sessionId, true);
				}
				if (message.type === "result") {
					const inputIds = message.user_message_uuids ?? [
						message.user_message_uuid ?? ctx.currentTurnId,
					];
					ctx.interruptRequested =
						ctx.interruptInputId !== undefined &&
						inputIds.includes(ctx.interruptInputId);
					if (isInterruptedResult(message, ctx.interruptRequested)) {
						yield* this.completeTurnToolsEffect(ctx, false);
						yield* this.cancelInteractionsEffect(
							ctx,
							"Turn interrupted",
							false,
						);
					}
					ctx.turnInFlight = false;
				}
				const translatedMessages = yield* interceptClaudeUsageLimit(
					ctx,
					message,
				);
				for (const translatedMessage of translatedMessages)
					yield* translator.translate(
						ctx,
						translatedMessage,
						decision.receivedAt,
					);
				if (parentChildLink) {
					yield* parentChildLink;
					parentChildLink = undefined;
				}
				if (message.type === "result") {
					const translatedResult = translatedMessages.find(
						(message) => message.type === "result",
					);
					this.deps.onTurnStateChanged?.(ctx.sessionId, false);
					yield* resolveTurnEffect(
						this.stateRef,
						ctx,
						translatedResult ?? message,
					);
					if (ctx.interruptRequested) ctx.interruptInputId = undefined;
					ctx.interruptRequested = false;
				}
			}
			// Ownership or launcher input can arrive after the live snapshot,
			// including through an agent's transcript feed. Final reads still
			// persist history above, but cannot revive an ended or replaced stream.
			if (
				ctx.subagentTasks?.size &&
				!ctx.stopped &&
				(yield* isCurrentSession(this.stateRef, ctx)) &&
				!(yield* isStreamEnded(this.stateRef, ctx.sessionId)) &&
				decisions.some(
					(decision) =>
						decision.kind === "route-transcript" ||
						(decision.kind === "route" &&
							(decision.message.type === "assistant" ||
								(decision.message.type === "stream_event" &&
									decision.message.event.type === "content_block_stop") ||
								(decision.message.type === "system" &&
									decision.message.subtype === "task_started"))),
				)
			)
				yield* translator.publishBackgroundTasks(ctx);
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

	/**
	 * `started` places a held input's message before any of its output;
	 * `cancelled` before `started` resolves the input cancelled. `queued` and
	 * `completed` carry nothing a result does not.
	 */
	private handleCommandLifecycleEffect(
		ctx: ClaudeSessionContext,
		message: ClaudeSDKCommandLifecycleMessage,
	): Effect.Effect<void> {
		return Effect.gen(this, function* () {
			if (message.state === "cancelled") {
				yield* cancelTurnWaiterEffect(
					this.stateRef,
					ctx.sessionId,
					message.command_uuid,
				);
				return;
			}
			if (message.state !== "started") return;
			const unplaced = yield* startTurnWaiter(
				this.stateRef,
				ctx.sessionId,
				message.command_uuid,
			);
			if (!unplaced) return;
			// A steer becomes the current turn when it starts, on its own sink,
			// and is in flight even when the turn before it already ended.
			ctx.currentTurnId = message.command_uuid;
			ctx.currentUserMessageId =
				unplaced.continuation?.cutOffMessageId ?? message.command_uuid;
			ctx.turnInFlight = true;
			if (unplaced.eventSink !== ctx.eventSink) {
				const priorSink = ctx.eventSink;
				this.retainSink(unplaced.eventSink);
				ctx.eventSink = unplaced.eventSink;
				yield* this.releaseSinkEffect(priorSink);
			}
			// The stream outlives one input: a failed placement must not end it.
			yield* this.placeUserMessageEffect(unplaced).pipe(
				Effect.catchAll((error) =>
					Effect.sync(() =>
						log.warn(
							`Session ${ctx.sessionId}: placing input ${message.command_uuid} failed: ${formatErrorDetail(error)}`,
						),
					),
				),
			);
		}).pipe(
			Effect.uninterruptible,
			(ctx.messageOwnershipPermit ??=
				Effect.unsafeMakeSemaphore(1)).withPermits(1),
		);
	}

	private runSubagentFinalizationEffect(
		ctx: ClaudeSessionContext,
		finalization: Effect.Effect<void, ClaudeAdapterError>,
	): Effect.Effect<void> {
		const key: ClaudeSubagentFinalizationFiberKey = {
			id: randomUUID(),
			sessionId: ctx.sessionId,
			turnId: ctx.currentTurnId ?? "unknown",
		};
		const sink = ctx.eventSink;
		this.retainSink(sink);
		return FiberMap.run(
			this.subagentFinalizationFibers,
			key,
			finalization.pipe(
				Effect.interruptible,
				Effect.catchAll((err) =>
					Effect.sync(() =>
						log.warn(
							`Claude subagent finalization failed for ${ctx.sessionId}: ${err instanceof Error ? err.message : err}`,
						),
					),
				),
				Effect.ensuring(this.releaseSinkEffect(sink)),
			),
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

	private endMessageOwnershipEffect(
		ctx: ClaudeSessionContext,
	): Effect.Effect<void> {
		return Effect.suspend(() => {
			// Stop and the stream finalizer can both end the same query.
			if (this.endingOwnership.has(ctx)) return Effect.void;
			this.endingOwnership.add(ctx);
			return this.runSubagentFinalizationEffect(
				ctx,
				endClaudeMessageOwnershipEffect(this.deps, ctx),
			);
		});
	}

	private handleStreamFailureEffect(
		ctx: ClaudeSessionContext,
		translator: ClaudeTranslationService,
		err: unknown,
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
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
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen(this, function* () {
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
					yield* this.endMessageOwnershipEffect(ctx);
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

			// Live tasks and pending steering inputs need the same query and prompt
			// queue. Interrupt only the running turn; its SDK result settles it by id.
			const waiters = yield* pendingTurnWaiters(this.stateRef, sessionId);
			if (
				!ctx.stopped &&
				((ctx.liveBackgroundTaskCount ?? 0) > 0 ||
					[...waiters].some(
						([inputId, waiter]) =>
							!waiter.started &&
							waiter.unplaced !== undefined &&
							inputId !== ctx.currentTurnId,
					))
			) {
				// A delayed Cancel can arrive after the result while tasks or a steer
				// keep the query alive. It must not interrupt an idle query or the next input.
				const inputId = ctx.currentTurnId;
				if (!ctx.turnInFlight || !inputId || ctx.interruptInputId === inputId)
					return;
				log.info(`Interrupting running turn for session ${sessionId}`);
				ctx.interruptInputId = inputId;
				yield* Effect.tryPromise({
					try: () => ctx.query.interrupt(),
					catch: (cause) =>
						new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
				}).pipe(
					Effect.tapError(() =>
						Effect.sync(() => {
							if (ctx.interruptInputId === inputId)
								ctx.interruptInputId = undefined;
						}),
					),
				);
				// Only an accepted interrupt may reject interactions. Keep this on
				// the stream's ownership permit so a pending steer cannot lose its approvals.
				yield* (ctx.messageOwnershipPermit ??=
					Effect.unsafeMakeSemaphore(1)).withPermits(1)(
					Effect.gen(this, function* () {
						if (ctx.currentTurnId === inputId && ctx.turnInFlight)
							yield* this.cancelInteractionsEffect(
								ctx,
								"Turn interrupted",
								false,
							);
					}),
				);
				return;
			}

			log.info(`Interrupting turn for session ${sessionId}`);
			yield* this.cleanupSessionEffect(ctx, "Turn interrupted", false);
			// With no live tasks or pending steer, retain the existing close path.
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

	/** Complete turn-scoped tools without changing query or background-task ownership. */
	private completeTurnToolsEffect(
		ctx: ClaudeSessionContext,
		recoverQuestions: boolean,
	): Effect.Effect<void> {
		return Effect.gen(function* () {
			for (const [, tool] of ctx.inFlightTools) {
				if (recoverQuestions && tool.toolName === "AskUserQuestion") continue;
				const event = claudeRuntimeEvent("tool.completed", ctx.sessionId, {
					messageId:
						ctx.activeAssistantMessageId ?? ctx.lastAssistantUuid ?? "",
					partId: tool.itemId,
					result: null,
					duration: 0,
				});
				if (ctx.eventSink) yield* ctx.eventSink.push(event).pipe(Effect.ignore);
			}
			ctx.inFlightTools.clear();
		});
	}

	/** Denies open approvals and rejects open questions. */
	private cancelInteractionsEffect(
		ctx: ClaudeSessionContext,
		reason: string,
		recoverQuestions: boolean,
	): Effect.Effect<void> {
		return Effect.gen(function* () {
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

			yield* this.completeTurnToolsEffect(ctx, recoverQuestions);

			yield* this.cancelInteractionsEffect(ctx, reason, recoverQuestions);

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
			yield* this.endMessageOwnershipEffect(ctx);
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
