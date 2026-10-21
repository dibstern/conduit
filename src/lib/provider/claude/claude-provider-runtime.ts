// src/lib/provider/claude/claude-provider-runtime.ts
/**
 * Claude launch composition and the SDK payload. The shared runner provider
 * instance routes daemon operations; this payload owns live Claude Agent SDK state.
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
import { join, resolve } from "node:path";
import {
	type Settings,
	query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import {
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
	Semaphore,
} from "effect";
import { accountsStateFromConfig } from "../../account-directory.js";
import type { Account } from "../../contracts/account.js";
import type {
	ClaudeSDKCommandLifecycleMessage,
	ClaudeSDKPermissionMode,
} from "../../contracts/providers/claude-agent-sdk.js";
import {
	defaultDaemonConfig,
	loadDaemonConfigResult,
	resolveClaudeLaunchConfig,
} from "../../daemon/config-persistence.js";
import { makeAccountResourceScopesLive } from "../../domain/daemon/Layers/account-resource-scopes-layer.js";
import { AccountDirectory } from "../../domain/daemon/Services/account-directory.js";
import { AccountResourceScopesTag } from "../../domain/daemon/Services/account-resource-scopes.js";
import type { ClaudeOneShotQueryFactory } from "../../domain/daemon/Services/claude-one-shot.js";
import * as Failure from "../../effect/failure-classification.js";
import { createLogger } from "../../logger.js";
import type { ClaudeEventPersistEffect } from "../../persistence/effect/claude-event-persist-effect.js";
import type { BackgroundTaskTransition } from "../../session/background-liveness.js";
import { ProviderInstanceFailure } from "../errors.js";
import {
	type ClaudeAdapterError,
	ClaudeBoundaryError,
	ClaudeResumeRefused,
	ClaudeRuntimeError,
	isClaudeResumeFailure,
	isClaudeResumeRefused,
} from "../event-sink-errors.js";
import { makeInProcessSessionRunner } from "../runner/in-process-session-runner.js";
import type { LiveSettings, RunnerPayload } from "../runner/runner-payload.js";
import {
	makeRunnerProviderInstance,
	type RunnerProviderInstance,
	type RunnerProviderInstanceDeps,
} from "../runner/runner-provider-instance.js";
import type { RunnerSinkBindings } from "../runner/runner-sink-bindings.js";
import type { SessionTurn } from "../runner/session-runner.js";
import { makeClaudeRunnerDriver } from "./claude-runner-driver.js";

export { RunnerProviderInstance as ClaudeProviderRuntime } from "../runner/runner-provider-instance.js";

import type {
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionRunner,
} from "../runner/session-runner.js";
import type {
	EventSink,
	PermissionDecision,
	ProviderCall,
	ProviderCapabilities,
	ProviderNativeSession,
	SendTurnInput,
	TurnResult,
} from "../types.js";
import {
	ClaudeAccountScopes,
	makeClaudeAccountScopes,
} from "./claude-account-scopes.js";
import { claudeApiModelId } from "./claude-api-model-id.js";
import type { ClaudeCapabilitiesService } from "./claude-capabilities-service.js";
import { isInterruptedResult } from "./claude-event-translator.js";
import { makeClaudeForkQuery } from "./claude-fork-query.js";
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
import {
	normalizeClaudeLaunchInput,
	normalizeClaudeSessionTurn,
} from "./claude-runner-wire.js";
import {
	discoverCapabilitiesEffect,
	expectedApiModelIdEffect,
	setExpectedApiModelId,
} from "./claude-runtime-discovery.js";
import { claudeRuntimeEvent } from "./claude-runtime-event.js";
import {
	claimSetupLock,
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
} from "./claude-runtime-state.js";
import {
	acceptIntakeEffect,
	addPendingIntake,
	buildUserMessage,
	cancelIntakeEffect,
	hasPendingTurn,
	type PendingIntakes,
	pendingIntakes,
	removePendingIntake,
	resolveIntakeErrorEffect,
	sdkResultToTurnResult,
	settlePendingIntakesEffect,
	settleUnacceptedResultEffect,
	unacceptedResultInputIds,
} from "./claude-runtime-turn.js";
import {
	type ClaudeConfigDir,
	captureClaudeLaunchLogin,
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
import { toSdkPermissionMode } from "./permission-mode-map.js";
import { captureClaudeSdkMessage } from "./sdk-trace-capture.js";
import type {
	CanUseTool,
	ClaudeSendTurnInput,
	ClaudeSessionContext,
	ClaudeSessionController,
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

export type { ClaudeOneShotQueryFactory } from "../../domain/daemon/Services/claude-one-shot.js";

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
	/** One-shot text generation runs independently of the long-lived session runner. */
	readonly generateTextQueryFactory?: ClaudeOneShotQueryFactory;
	readonly subagentSdk?: ClaudeSubagentSdk;
	readonly sessionForkSdk?: ClaudeSessionForkSdk;
	readonly ensureClaudeSubagentSession?: ClaudeEventPersistEffect["ensureClaudeSubagentSession"];
	readonly readClaudeSubagentTranscript?: ClaudeEventPersistEffect["readClaudeSubagentTranscript"];
	readonly persistUserMessage?: ClaudeEventPersistEffect["persistUserMessage"];
	readonly subagentPollTimeoutMs?: number;
	readonly subagentPollIntervalMs?: number;
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
	| "subagentPollIntervalMs"
	| "capabilitiesService"
	| "readGoalStatus"
> & {
	readonly accountResources?: RunnerProviderInstanceDeps["accountResources"];
	readonly onSubagentFinalizationComplete?: () => void;
	readonly onTurnStateChanged?: (sessionId: string, inFlight: boolean) => void;
	readonly onAbandonedRun?: (inputId: string) => void;
	readonly onNativeSessionId?: (
		sessionId: string,
		nativeSessionId: string,
	) => void;
	readonly prepareQuery?: () => Promise<void>;
};

export interface ClaudeProviderRuntimeState {
	readonly sessions: HashMap.HashMap<string, ClaudeSessionContext>;
	readonly setupLocks: HashMap.HashMap<string, Deferred.Deferred<void, Error>>;
	readonly pendingIntakes: HashMap.HashMap<string, PendingIntakes>;
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
	pendingIntakes: HashMap.empty(),
	endedStreams: HashSet.empty(),
	shutdownAfterTurn: HashSet.empty(),
});

export class ClaudeProviderRuntimeTag extends Context.Service<
	ClaudeProviderRuntimeTag,
	RunnerProviderInstance
>()("ClaudeProviderRuntime") {}

export const makeClaudeProviderRuntime = (
	deps: ClaudeProviderInstanceDeps,
): Effect.Effect<RunnerProviderInstance, never, Scope.Scope> =>
	Effect.gen(function* () {
		const directory = yield* Effect.serviceOption(AccountDirectory);
		const accounts = Option.isSome(directory)
			? directory.value.snapshot
			: Effect.suspend(() =>
					Effect.fromResult(loadDaemonConfigResult(deps.daemonConfigDir)),
				).pipe(
					Effect.catchTag("NotFound", () =>
						Effect.succeed(defaultDaemonConfig()),
					),
					Effect.map((config) =>
						accountsStateFromConfig(
							config,
							captureClaudeLaunchLogin(process.env),
						),
					),
				);
		const shared = yield* Effect.serviceOption(ClaudeAccountScopes);
		const sharedOwner = yield* Effect.serviceOption(AccountResourceScopesTag);
		const owner = Option.isSome(sharedOwner)
			? sharedOwner.value
			: Context.get(
					yield* Layer.build(makeAccountResourceScopesLive()),
					AccountResourceScopesTag,
				);
		const accountScopes = Option.isSome(shared)
			? shared.value
			: yield* makeClaudeAccountScopes({
					accounts,
					...(Option.isNone(directory)
						? { trustAdmission: true as const }
						: {}),
					...(deps.daemonConfigDir !== undefined
						? {
								cacheDir: join(
									deps.daemonConfigDir,
									"cache",
									"claude-capabilities",
								),
							}
						: {}),
					...(deps.capabilitiesService
						? { capabilitiesService: deps.capabilitiesService }
						: {}),
				}).pipe(Effect.provideService(AccountResourceScopesTag, owner));
		const capabilitiesService: ClaudeCapabilitiesService =
			deps.capabilitiesService ?? {
				get: (workspaceRoot, options) => {
					const call = options?.call;
					return call
						? accountScopes.use(call.account, ({ account, capabilities }) =>
								capabilities.get(workspaceRoot, {
									...options,
									call: { ...call, account },
								}),
							)
						: Effect.fail(
								new ClaudeBoundaryError({
									operation: "probeCapabilities",
									cause: new Error(
										"Claude capabilities require an admitted call",
									),
								}),
							);
				},
			};
		const driver = makeClaudeRunnerDriver(deps, accountScopes);
		const accountResources: NonNullable<
			RunnerProviderInstanceDeps["accountResources"]
		> = {
			use: (account, work) =>
				accountScopes
					.use(account, (resource) => work(resource.account))
					.pipe(
						Effect.mapError((cause) =>
							cause instanceof ClaudeBoundaryError
								? new ProviderInstanceFailure({
										providerId: "claude",
										operation: "accountScope",
										cause,
									})
								: cause,
						),
					),
		};
		return yield* makeRunnerProviderInstance(
			{
				...deps,
				accounts,
				accountResources,
				...(deps.ensureClaudeSubagentSession
					? { ensureChildSession: deps.ensureClaudeSubagentSession }
					: {}),
				...(deps.readClaudeSubagentTranscript
					? { readSubagentTranscript: deps.readClaudeSubagentTranscript }
					: {}),
			},
			driver,
			(emit) =>
				(deps.runnerFactory ?? makeProcessClaudeSessionRunner)(
					{ ...deps, capabilitiesService, accountResources },
					emit,
				),
		);
	});

export const makeClaudeSessionRunner = (
	deps: ClaudeSessionRunnerDeps,
	emit: (
		output: SessionOutput,
	) => Effect.Effect<SessionOutputReply, SessionFailure>,
): Effect.Effect<SessionRunner, never, Scope.Scope> =>
	Effect.gen(function* () {
		const stateRef = yield* Ref.make<ClaudeProviderRuntimeState>(
			emptyClaudeProviderRuntimeState(),
		);
		let payload!: ClaudeRunnerPayload;
		const runner = yield* makeInProcessSessionRunner(
			(sinks) =>
				Effect.gen(function* () {
					const scope = yield* Effect.scope;
					const streamFibers = yield* FiberMap.make<string, void, unknown>();
					const shutdownFibers = yield* FiberMap.make<string, void, never>();
					const subagentFinalizationFibers = yield* FiberMap.make<
						ClaudeSubagentFinalizationFiberKey,
						void,
						never
					>();
					const warmedQueries = yield* makeClaudeWarmedQueryOwner(
						deps.queryFactory ??
							(sdkQuery as NonNullable<
								ClaudeProviderInstanceDeps["queryFactory"]
							>),
						deps.prepareQuery,
						deps.readGoalStatus,
						deps.onNativeSessionId,
					);
					payload = new ClaudeRunnerPayload(
						deps,
						stateRef,
						streamFibers,
						subagentFinalizationFibers,
						shutdownFibers,
						warmedQueries,
						emit,
						scope,
						sinks,
					);
					return payload;
				}),
			emit,
		);
		// Preserve existing local state inspection and malformed-message injection.
		Object.defineProperty(runner, "buildUserMessage", {
			get: () => payload.buildUserMessage,
			set: (build: typeof buildUserMessage) => {
				payload.buildUserMessage = build;
			},
		});
		return Object.assign(runner, { stateRef });
	});

export const ClaudeProviderRuntimeLive = (
	deps: ClaudeProviderInstanceDeps,
): Layer.Layer<ClaudeProviderRuntimeTag, never, Scope.Scope> =>
	Layer.effect(ClaudeProviderRuntimeTag, makeClaudeProviderRuntime(deps));

function sessionFailure(operation: string, cause: unknown): SessionFailure {
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

class ClaudeRunnerPayload implements RunnerPayload {
	readonly providerId = "claude";
	private readonly endingOwnership = new WeakSet<ClaudeSessionContext>();
	private readonly controllers = new Map<string, ClaudeSessionController>();
	private readonly turnSettings = new WeakMap<
		EventSink,
		Settings | undefined
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
			output: SessionOutput,
		) => Effect.Effect<SessionOutputReply, SessionFailure>,
		private readonly scope: Scope.Scope,
		private readonly sinks: RunnerSinkBindings,
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

	hasActiveTurnsEffect(sessionId: string): Effect.Effect<boolean> {
		return Effect.gen({ self: this }, function* () {
			return (
				(yield* getSetupLock(this.stateRef, sessionId)) !== undefined ||
				(yield* hasPendingTurn(this.stateRef, sessionId))
			);
		});
	}
	hasDemandEffect(sessionId: string): Effect.Effect<boolean> {
		return Effect.gen({ self: this }, function* () {
			const ctx = yield* getSession(this.stateRef, sessionId);
			return (
				(yield* this.hasActiveTurnsEffect(sessionId)) ||
				(ctx?.liveBackgroundTaskCount ?? 0) > 0 ||
				(ctx?.pendingApprovals.size ?? 0) > 0 ||
				(ctx?.pendingQuestions.size ?? 0) > 0 ||
				this.hasPendingSubagentFinalizers(sessionId)
			);
		});
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

	resolvePermission(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Effect.Effect<void, SessionFailure> {
		return this.resolvePermissionEffect(sessionId, requestId, decision).pipe(
			Effect.mapError((cause) => sessionFailure("resolve-permission", cause)),
		);
	}
	resolveQuestion(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<void, SessionFailure> {
		return this.resolveQuestionEffect(sessionId, requestId, answers).pipe(
			Effect.mapError((cause) => sessionFailure("resolve-question", cause)),
		);
	}

	prepareTurn(
		command: Extract<SessionCommand, { type: "send-turn" }>,
		sink: EventSink,
	): Effect.Effect<void> {
		return Effect.sync(() =>
			this.turnSettings.set(sink, command.claudeSettingsOverrides),
		);
	}
	sendTurn(
		input: SessionTurn,
		sink: EventSink,
		signal: AbortSignal,
	): Effect.Effect<TurnResult, SessionFailure> {
		return Effect.suspend(() =>
			this.sendTurnEffect({
				...normalizeClaudeSessionTurn(input),
				eventSink: sink,
				abortSignal: signal,
			}),
		).pipe(Effect.mapError((cause) => sessionFailure("send-turn", cause)));
	}
	interrupt(
		sessionId: string,
		turnIds?: readonly string[],
	): Effect.Effect<void, SessionFailure> {
		return this.interruptTurnEffect(sessionId, turnIds).pipe(
			Effect.mapError((cause) => sessionFailure("interrupt", cause)),
		);
	}
	applySettings(
		sessionId: string,
		settings: LiveSettings,
	): Effect.Effect<void, SessionFailure> {
		const permissionOnly =
			settings.permissionMode !== undefined &&
			!("modelId" in settings) &&
			!("contextWindow" in settings) &&
			!("variant" in settings);
		return (
			permissionOnly
				? Effect.void
				: this.applyLiveSettingsEffect(sessionId, settings)
		).pipe(
			Effect.andThen(
				settings.permissionMode === undefined
					? Effect.void
					: this.setPermissionModeEffect(
							sessionId,
							toSdkPermissionMode(settings.permissionMode),
						),
			),
			Effect.mapError((cause) => sessionFailure("apply-live-settings", cause)),
		);
	}
	endSession(sessionId: string): Effect.Effect<void, SessionFailure> {
		return this.endSessionEffect(sessionId).pipe(
			Effect.mapError((cause) => sessionFailure("end-session", cause)),
		);
	}
	preWarm(
		command: Extract<SessionCommand, { type: "pre-warm" }>,
	): Effect.Effect<void, SessionFailure> {
		return Effect.gen({ self: this }, function* () {
			if (
				(yield* getSession(this.stateRef, command.sessionId)) ||
				(yield* getSetupLock(this.stateRef, command.sessionId))
			)
				return;
			yield* this.warmedQueries.preWarmEffect(
				normalizeClaudeLaunchInput(command.input),
				command.claudeSettingsOverrides,
				command.input.shellEnv ??
					command.shellEnv ??
					this.deps.shellEnv?.(command.input.workspaceRoot),
				this.getPermissionBridge(),
				command.settingsSnapshot !== undefined,
			);
		}).pipe(Effect.mapError((cause) => sessionFailure("pre-warm", cause)));
	}
	stopTask(
		sessionId: string,
		taskId: string,
	): Effect.Effect<void, SessionFailure> {
		return Effect.gen({ self: this }, function* () {
			const ctx = yield* getSession(this.stateRef, sessionId);
			if (!ctx || ctx.stopped)
				return yield* Effect.fail(
					new ClaudeBoundaryError({
						operation: "stopTask",
						cause: "Claude session is not running in this runner",
					}),
				);
			yield* Effect.tryPromise({
				try: () => ctx.query.stopTask(taskId),
				catch: (cause) =>
					new ClaudeBoundaryError({ operation: "stopTask", cause }),
			});
		}).pipe(Effect.mapError((cause) => sessionFailure("stop-task", cause)));
	}
	setPermissionMode(
		sessionId: string,
		mode: ClaudeSDKPermissionMode,
	): Effect.Effect<void, SessionFailure> {
		return this.setPermissionModeEffect(sessionId, mode).pipe(
			Effect.mapError((cause) => sessionFailure("set-permission-mode", cause)),
		);
	}
	shutdown(): Effect.Effect<void, SessionFailure> {
		return this.shutdownEffect().pipe(
			Effect.mapError((cause) => sessionFailure("shutdown", cause)),
		);
	}
	shutdownAfterTurn(sessionId: string): Effect.Effect<void, SessionFailure> {
		return Effect.gen({ self: this }, function* () {
			const ctx = yield* getSession(this.stateRef, sessionId);
			if (!ctx && !this.sinks.hasSessionSinks(sessionId)) {
				yield* this.warmedQueries.discardEffect(sessionId);
				return;
			}
			yield* Ref.update(this.stateRef, (state) => ({
				...state,
				shutdownAfterTurn: HashSet.add(state.shutdownAfterTurn, sessionId),
			}));
			yield* this.scheduleShutdownAfterTurnEffect(sessionId);
		}).pipe(
			Effect.mapError((cause) => sessionFailure("shutdown-after-turn", cause)),
		);
	}

	private scheduleShutdownAfterTurnEffect(
		sessionId: string,
	): Effect.Effect<void> {
		return FiberMap.run(
			this.shutdownFibers,
			sessionId,
			Effect.gen({ self: this }, function* () {
				while (
					HashSet.has(
						(yield* getState(this.stateRef)).shutdownAfterTurn,
						sessionId,
					)
				) {
					while (yield* this.hasActiveTurnsEffect(sessionId))
						yield* Effect.sleep("10 millis");
					const finalizers = Array.from(this.subagentFinalizationFibers).filter(
						([key]) => key.sessionId === sessionId,
					);
					yield* Effect.forEach(finalizers, ([, fiber]) => Fiber.await(fiber), {
						discard: true,
					});
					// Sends admitted while finalization ran still use the warm query.
					if (
						(yield* this.hasActiveTurnsEffect(sessionId)) ||
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

	private recordBackgroundTaskEffect(
		transition: BackgroundTaskTransition,
	): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
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
		const sinkId = this.sinks.sinkId(input.eventSink);
		if (!sinkId || input.continuation) return Effect.void;
		return this.emit({
			type: "place-user-message",
			sinkId,
			input: {
				sessionId: input.sessionId,
				inputId: input.inputId,
				...(input.runId ? { runId: input.runId } : {}),
				text: input.text ?? input.prompt,
				...(input.images ? { images: input.images } : {}),
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
		const sinkId = this.sinks.sinkId(ctx.eventSink);
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

	private readSubagentTranscriptEffect(
		ctx: ClaudeSessionContext,
		childSessionId: string,
	) {
		const sinkId = this.sinks.sinkId(ctx.eventSink);
		return Effect.gen({ self: this }, function* () {
			if (!sinkId)
				return yield* Effect.fail({
					operation: "read-subagent-transcript",
					message: "Missing Claude transcript sink",
				});
			const output = {
				type: "read-subagent-transcript" as const,
				sinkId,
				childSessionId,
			};
			let reply = yield* this.emit(output);
			// A reconnect can replay a read older than the last acknowledged output.
			// Its reply is no longer retained, so ask again with a new sequence.
			if (!reply.subagentTranscript) reply = yield* this.emit(output);
			if (!reply.subagentTranscript)
				return yield* Effect.fail({
					operation: output.type,
					message: "Missing persisted Claude subagent transcript reply",
				});
			return reply.subagentTranscript;
		}).pipe(
			Effect.mapError(
				(cause) =>
					new ClaudeBoundaryError({
						operation: "readClaudeSubagentTranscript",
						cause: new Error(cause.message),
					}),
			),
		);
	}

	private removeSessionEffect(sessionId: string): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			yield* this.warmedQueries.discardEffect(sessionId);
			const ctx = yield* getSession(this.stateRef, sessionId);
			yield* removeSession(this.stateRef, sessionId);
			yield* this.recordBackgroundTaskEffect({
				sessionId,
				kind: "session-ended",
			});
			yield* this.sinks.releaseSinkEffect(ctx?.eventSink);
		});
	}

	buildUserMessage = buildUserMessage;

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
		options?: { readonly refresh?: boolean },
		call?: ProviderCall,
	): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure> {
		return this.mapProviderFailure(
			"discover",
			Effect.gen({ self: this }, function* () {
				const selectedAccount = call?.account ?? account;
				const configDir =
					selectedAccount?.driver === "claude"
						? selectedAccount.folder
						: resolveClaudeLaunchConfig(
								yield* Effect.suspend(() =>
									Effect.fromResult(
										loadDaemonConfigResult(this.deps.daemonConfigDir),
									),
								).pipe(Effect.catchTag("NotFound", () => Effect.succeed(null))),
							).configDir;
				return yield* discoverCapabilitiesEffect(
					call?.workspaceRoot ?? workspaceRoot ?? this.deps.workspaceRoot,
					this.deps.capabilitiesService,
					configDir,
					options,
					call,
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
				Effect.catch((err) =>
					Effect.gen({ self: this }, function* () {
						const ctx = yield* getSession(this.stateRef, input.sessionId);
						const tracker = ctx
							? (ctx.goalTracker ??= new ClaudeGoalTracker(
									input.sessionId,
									input.goalState,
								))
							: (this.controllers.get(input.sessionId)?.goalTracker ??
								new ClaudeGoalTracker(input.sessionId, input.goalState));
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
		return Effect.gen({ self: this }, function* () {
			const { sessionId } = input;
			if (input.abortSignal.aborted)
				return { ...INTERRUPTED_TURN, status: "cancelled" as const };

			// Per-session mutex: prevent duplicate session creation.
			const pending = yield* getSetupLock(this.stateRef, sessionId);
			if (pending) {
				const existingCtx = yield* getSession(this.stateRef, sessionId);
				if (existingCtx && this.hasAgentChanged(existingCtx, input)) {
					return yield* Effect.fail(
						this.agentSwitchDuringActiveTurnError(existingCtx, input),
					);
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
				return yield* this.createSessionAndSendTurnEffect(
					input,
					existingCtx.workspaceStartReported,
				);
			} else if (
				existingCtx?.rebinding &&
				!(yield* hasPendingTurn(this.stateRef, sessionId))
			) {
				// The server's fresh-native retry replaces the rejected query while
				// retaining this session's facts, just like an account rebind.
				return yield* this.rebindSessionEffect(existingCtx, input);
			} else if (
				existingCtx &&
				!sameClaudeLogin(
					existingCtx.login ?? {
						configDir: existingCtx.configDir,
						root: existingCtx.workspaceRoot,
						instanceId: existingCtx.instanceId,
					},
					{
						...input,
						root: input.workspaceRoot,
						shellEnv:
							input.shellEnv ?? this.deps.shellEnv?.(input.workspaceRoot),
					},
				) &&
				!(yield* hasPendingTurn(this.stateRef, sessionId))
			) {
				return yield* this.rebindSessionEffect(existingCtx, input);
			} else if (existingCtx && this.hasAgentChanged(existingCtx, input)) {
				if (yield* hasPendingTurn(this.stateRef, sessionId)) {
					return yield* Effect.fail(
						this.agentSwitchDuringActiveTurnError(existingCtx, input),
					);
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

			return yield* this.createSessionAndSendTurnEffect(
				input,
				existingCtx?.workspaceStartReported,
			);
		});
	}

	private createSessionAndSendTurnEffect(
		input: ClaudeSendTurnInput,
		workspaceStartReported = false,
		previous?: ClaudeSessionContext,
	): Effect.Effect<TurnResult, ClaudeAdapterError> {
		return Effect.gen({ self: this }, function* () {
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
			const intake = yield* Deferred.make<TurnResult, Error>();
			const setupLock = yield* Deferred.make<void, Error>();
			const pending = yield* claimSetupLock(
				this.stateRef,
				sessionId,
				setupLock,
			);
			if (pending) {
				yield* Deferred.await(pending).pipe(
					Effect.mapError(
						(cause) =>
							new ClaudeBoundaryError({ operation: "awaitSetup", cause }),
					),
				);
				return yield* this.sendTurnLocalEffect(input);
			}
			let promptQueue: PromptQueueController | undefined;
			let activeQuery: Query | undefined;
			const setup = Effect.gen({ self: this }, function* () {
				yield* markStreamLive(this.stateRef, sessionId);
				this.sinks.retainSink(input.eventSink);
				yield* addPendingIntake(this.stateRef, sessionId, input.inputId, {
					deferred: intake,
					unplaced: input,
					releaseSink: this.sinks.releaseSinkEffect(input.eventSink),
				});
				const expectedApiModelId = yield* expectedApiModelIdEffect(
					this.deps.capabilitiesService,
					input.model?.modelId,
					input.contextWindow,
					input.workspaceRoot,
					input.agent,
					input,
				);
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
				const abortController = new AbortController();
				const launchOptions = yield* Effect.try({
					try: () =>
						buildClaudeQueryOptions(
							launchInput,
							abortController,
							canUseTool,
							this.turnSettings.get(input.eventSink),
							input.shellEnv ?? this.deps.shellEnv?.(input.workspaceRoot),
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
				const turnAdmissionSemaphore = yield* Semaphore.make(1);

				const options = warmed?.options ?? launchOptions;
				const resumeSessionId = options.forkSession
					? options.sessionId
					: options.resume;
				const controller: ClaudeSessionController = this.controllers.get(
					sessionId,
				) ?? {
					goalTracker: new ClaudeGoalTracker(sessionId, input.goalState),
					pendingApprovals: new Map(),
					pendingQuestions: new Map(),
					messageOwnership: createClaudeMessageOwnership({
						childSessionIdFor: (taskId, message) =>
							claudeSubagentSessionId({
								parentConduitSessionId: sessionId,
								parentClaudeSessionId: message.session_id ?? "",
								sdkSubagentId: taskId,
							}),
					}),
					messageOwnershipPermit: yield* Semaphore.make(1),
					messageRunIds: new Map(),
					toolRunIds: new Map(),
					toolMessageIds: new Map(),
					subagentTasks: new Map(),
					subagentPollers: new Map(),
					subagentTranscripts: new Map(),
					failedSubagentSessions: new Set(),
				};
				this.controllers.set(sessionId, controller);
				const context = {
					...controller,
					controller,
					sessionId,
					login: {
						...input,
						root: input.workspaceRoot,
						shellEnv:
							input.shellEnv ?? this.deps.shellEnv?.(input.workspaceRoot),
					},
					instanceId: input.instanceId ?? "claude",
					nativeThread: launchInput.nativeThread,
					workspaceRoot: input.workspaceRoot,
					workspaceStartReported,
					configDir: input.configDir,
					cumulativeTokens:
						input.cumulativeTokens ?? previous?.cumulativeTokens ?? 0,
					startedAt: previous?.startedAt ?? new Date().toISOString(),
					promptQueue: queue,
					turnAdmissionSemaphore,
					inFlightTools: new Map(),
					eventSink: input.eventSink,
					currentTurnId: input.inputId,
					currentUserMessageId:
						input.continuation?.cutOffMessageId ?? input.inputId,
					resumeFallbackAllowed:
						input.rewind === undefined &&
						!!launchInput.resumeSessionId &&
						(!!launchInput.handoff || !!input.clearInheritedGoal),
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
					turnCount: previous?.turnCount ?? 0,
					stopped: false,
				};

				// A warmed query's queue may already be closed under us.
				const admitPrompt = queue
					.enqueue(userMessage, input.abortSignal)
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
						try: () => {
							const createQuery = (prompt: AsyncIterable<SDKUserMessage>) =>
								this.queryFactory({
									configDir: launchInput.configDir,
									prompt,
									options,
								});
							return launchInput.clearInheritedGoal
								? makeClaudeForkQuery(
										createQuery,
										queue,
										launchInput,
										this.deps.readGoalStatus,
										(nativeId) =>
											this.deps.onNativeSessionId?.(sessionId, nativeId),
									)
								: createQuery(queue);
						},
						catch: (cause) =>
							new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
					}));
				activeQuery = query;
				if (launchInput.clearInheritedGoal)
					yield* Effect.tryPromise({
						try: () => query.initializationResult(),
						catch: (cause) =>
							cause instanceof ClaudeResumeRefused
								? cause
								: new ClaudeBoundaryError({
										operation: "Claude fork initialization",
										cause,
									}),
					});
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
				warmed?.bindContext(ctx);
				if (warmed) yield* admitPrompt;

				this.sinks.retainSink(ctx.eventSink);
				yield* setSession(this.stateRef, sessionId, ctx);

				yield* input.eventSink
					.push(
						claudeRuntimeEvent("session.status", sessionId, {
							sessionId,
							status: "busy",
						}),
					)
					.pipe(Effect.ignore);

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
				Effect.raceFirst(
					Deferred.await(setupLock).pipe(
						Effect.mapError(
							(cause) =>
								new ClaudeBoundaryError({ operation: "awaitSetup", cause }),
						),
					),
				),
				Effect.tap(() =>
					Deferred.succeed(setupLock, undefined).pipe(Effect.ignore),
				),
				Effect.onExit((exit) =>
					Exit.isFailure(exit)
						? Effect.gen({ self: this }, function* () {
								const failure = asError(Failure.squashCause(exit.cause));
								yield* settlePendingIntakesEffect(
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
					Effect.gen({ self: this }, function* () {
						// The stream owns the intake acknowledgement after setup.
						yield* removeSetupLock(this.stateRef, sessionId);
					}),
				),
			);

			return yield* this.awaitIntakeEffect(input, intake);
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
		return Effect.gen({ self: this }, function* () {
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
			Effect.gen({ self: this }, function* () {
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
			Effect.gen({ self: this }, function* () {
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
		return Effect.gen({ self: this }, function* () {
			if (this.hasAgentChanged(ctx, input)) {
				if (yield* hasPendingTurn(this.stateRef, ctx.sessionId)) {
					return yield* Effect.fail(
						this.agentSwitchDuringActiveTurnError(ctx, input),
					);
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
			const intake = yield* turnAdmissionSemaphore.withPermits(1)(
				Effect.gen({ self: this }, function* () {
					// A send that needs no settings change joins the live query at
					// once: mid-turn it is a steer, which the SDK reads at its next
					// tool boundary. One that changes the model or effort waits for
					// the turns ahead to finish, so it never retunes them mid-flight,
					// and never inherits their failure: the liveness checks below
					// decide whether it may still proceed.
					const apiModelId = claudeApiModelId(
						input.model?.modelId ?? ctx.currentModel,
						input.contextWindow,
					);
					const retunes =
						ctx.settingsOutOfSync ||
						(apiModelId !== undefined &&
							apiModelId !== ctx.currentApiModelId) ||
						input.variant !== ctx.currentVariant;
					if (retunes)
						while (
							!ctx.stopped &&
							!input.abortSignal.aborted &&
							(yield* hasPendingTurn(this.stateRef, ctx.sessionId))
						)
							yield* Effect.sleep("10 millis");
					// A Stop that landed while this turn waited dropped it with the
					// rest of the queue and already sent done. Failing it instead
					// would send a second done that ends the user's next prompt.
					if (ctx.stopped || input.abortSignal.aborted) {
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
						input,
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

					const intakeReceipt = yield* Deferred.make<TurnResult, Error>();
					yield* (ctx.messageOwnershipPermit ??=
						Semaphore.makeUnsafe(1)).withPermits(1)(
						Effect.uninterruptible(
							Effect.gen({ self: this }, function* () {
								// A result can finish while admission waits for this permit.
								const joinsRunningTurn = yield* hasPendingTurn(
									this.stateRef,
									ctx.sessionId,
								);
								// The server can still count the prior send while it publishes
								// its result. Establish this input's own turn and busy status here.
								if (!joinsRunningTurn) {
									yield* this.placeUserMessageEffect(input);
									yield* input.eventSink
										.push(
											claudeRuntimeEvent("session.status", ctx.sessionId, {
												sessionId: ctx.sessionId,
												status: "busy",
											}),
										)
										.pipe(Effect.ignore);
								}
								// A held send is placed when the SDK starts it.
								this.sinks.retainSink(input.eventSink);
								yield* addPendingIntake(
									this.stateRef,
									ctx.sessionId,
									input.inputId,
									{
										deferred: intakeReceipt,
										unplaced: input,
										releaseSink: this.sinks.releaseSinkEffect(input.eventSink),
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
									this.sinks.retainSink(input.eventSink);
									ctx.eventSink = input.eventSink;
									ctx.cumulativeTokens =
										input.cumulativeTokens ?? ctx.cumulativeTokens ?? 0;
									yield* this.sinks.releaseSinkEffect(priorSink);
								}
								// Marks the turn as started so a system/init arriving before
								// the first assistant chunk cannot report the session idle.
								ctx.turnInFlight = true;
								// The queue closes when a Stop or stream end overtakes this
								// send during the settings sync above. The SDK will never
								// read the prompt, so end the turn here rather than wait.
								yield* ctx.promptQueue
									.enqueue(userMessage, input.abortSignal)
									.pipe(
										Effect.catchTag("EffectPromptQueueClosed", () =>
											Effect.gen({ self: this }, function* () {
												yield* removePendingIntake(
													this.stateRef,
													ctx.sessionId,
													input.inputId,
												);
												ctx.turnInFlight = false;
												// As above: a Stop already sent done for this turn.
												if (ctx.stopped)
													return yield* Deferred.succeed(
														intakeReceipt,
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

					return intakeReceipt;
				}),
			);

			return yield* this.awaitIntakeEffect(input, intake);
		});
	}

	private awaitIntakeEffect(
		input: ClaudeSendTurnInput,
		intake: Deferred.Deferred<TurnResult, Error>,
	): Effect.Effect<TurnResult, ClaudeAdapterError> {
		const aborted = Effect.callback<void>((resume) => {
			const onAbort = () => resume(Effect.void);
			if (input.abortSignal.aborted) onAbort();
			else input.abortSignal.addEventListener("abort", onAbort, { once: true });
			return Effect.sync(() =>
				input.abortSignal.removeEventListener("abort", onAbort),
			);
		});
		return Effect.raceFirst(
			Deferred.await(intake),
			aborted.pipe(
				Effect.andThen(
					Effect.gen({ self: this }, function* () {
						const ctx = yield* getSession(this.stateRef, input.sessionId);
						if (!ctx) return INTERRUPTED_TURN;
						return yield* (ctx.messageOwnershipPermit ??=
							Semaphore.makeUnsafe(1)).withPermits(1)(
							Effect.gen({ self: this }, function* () {
								if (
									!(yield* pendingIntakes(this.stateRef, input.sessionId)).has(
										input.inputId,
									)
								)
									return yield* Deferred.await(intake);
								// SDK handoff is not acceptance: retain this intake until
								// the real lifecycle frame names the input's native run.
								if (!(yield* ctx.promptQueue.recall(input.inputId)))
									return {
										...INTERRUPTED_TURN,
										status: "indeterminate" as const,
									};
								if (ctx.currentTurnId === input.inputId) {
									ctx.turnInFlight = false;
									this.deps.onTurnStateChanged?.(ctx.sessionId, false);
								}
								yield* cancelIntakeEffect(
									this.stateRef,
									input.sessionId,
									input.inputId,
								);
								return yield* Deferred.await(intake);
							}),
						);
					}),
				),
			),
		).pipe(
			Effect.mapError(
				(cause) => new ClaudeBoundaryError({ operation: "awaitIntake", cause }),
			),
		);
	}

	private hasAgentChanged(
		ctx: ClaudeSessionContext,
		input: SendTurnInput,
	): boolean {
		return input.agent !== ctx.currentAgent;
	}

	private agentSwitchDuringActiveTurnError(
		ctx: ClaudeSessionContext,
		input: SendTurnInput,
	): ClaudeRuntimeError {
		return new ClaudeRuntimeError({
			code: "provider_error",
			message: `Cannot switch Claude agent while a turn is active (current=${ctx.currentAgent ?? "default"}, requested=${input.agent ?? "default"}).`,
		});
	}

	private rebindSessionEffect(
		ctx: ClaudeSessionContext,
		input: ClaudeSendTurnInput,
	): Effect.Effect<TurnResult, ClaudeAdapterError> {
		return Effect.gen({ self: this }, function* () {
			if (
				ctx.turnInFlight ||
				(ctx.liveBackgroundTaskCount ?? 0) > 0 ||
				ctx.pendingApprovals.size > 0 ||
				ctx.pendingQuestions.size > 0 ||
				this.hasPendingSubagentFinalizers(ctx.sessionId)
			)
				return yield* Effect.fail(
					new ClaudeRuntimeError({
						message: "Cannot rebind a busy Claude query",
					}),
				);
			yield* FiberMap.remove(this.shutdownFibers, ctx.sessionId);
			ctx.rebinding = true;
			ctx.stopped = true;
			yield* ctx.promptQueue.close().pipe(Effect.ignore);
			yield* Effect.try(() => ctx.query.close()).pipe(Effect.ignore);
			// Join the old consumer before opening the new query. Old SDK callbacks
			// keep their stopped context and can never borrow the next query's run.
			yield* FiberMap.remove(this.streamFibers, ctx.sessionId);
			yield* this.removeSessionEffect(ctx.sessionId);
			return yield* this.createSessionAndSendTurnEffect(
				input,
				ctx.workspaceStartReported,
				ctx,
			);
		});
	}

	private restartSessionEffect(
		ctx: ClaudeSessionContext,
		input: ClaudeSendTurnInput,
		reason: string,
	): Effect.Effect<TurnResult, ClaudeAdapterError> {
		return Effect.gen({ self: this }, function* () {
			yield* FiberMap.remove(this.shutdownFibers, ctx.sessionId);
			yield* this.disposeSessionEffect(ctx, reason);
			return yield* this.createSessionAndSendTurnEffect(
				input,
				ctx.workspaceStartReported,
			);
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
		return Effect.gen({ self: this }, function* () {
			yield* this.consumeStreamLoopEffect(ctx, translator).pipe(
				Effect.catch((err) =>
					isClaudeResumeRefused(err) ||
					(ctx.resumeFallbackAllowed &&
						!ctx.queryInitialized &&
						isClaudeResumeFailure(err))
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
		return Effect.gen({ self: this }, function* () {
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
					Effect.catch((cause) =>
						cause instanceof ClaudeSDKDecodeError
							? Effect.succeed(undefined)
							: Effect.fail(cause),
					),
				);
				if (decodedMessage === undefined) continue;
				if (
					"session_id" in decodedMessage &&
					typeof decodedMessage.session_id === "string"
				) {
					ctx.resumeSessionId = decodedMessage.session_id;
					this.deps.onNativeSessionId?.(
						ctx.sessionId,
						decodedMessage.session_id,
					);
				}
				if (
					decodedMessage.type === "result" &&
					decodedMessage.subtype !== "success" &&
					decodedMessage.errors.some((error) =>
						error.includes("Resume rejected by --resume-drops-turn:"),
					)
				)
					return yield* Effect.fail(
						new ClaudeResumeRefused({
							reason: "resume_drops_turn",
							message: decodedMessage.errors.join("\n"),
						}),
					);
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
					ctx.rebinding = true;
					ctx.turnInFlight = false;
					this.deps.onTurnStateChanged?.(ctx.sessionId, false);
					yield* settleUnacceptedResultEffect(
						this.stateRef,
						ctx,
						decodedMessage,
					);
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
			if (!ctx.stopped && ctx.turnInFlight && ctx.currentRunId)
				yield* this.handleStreamFailureEffect(
					ctx,
					translator,
					new Error("SDK stream ended without result"),
				);
		});
	}

	private applyClaudeOwnershipDecisionsEffect(
		ctx: ClaudeSessionContext,
		translator: ClaudeTranslationService,
		decisions: readonly ClaudeOwnershipDecision[],
		parentClaudeSessionId = ctx.resumeSessionId,
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen({ self: this }, function* () {
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
						{
							readTranscript: (childSessionId) =>
								this.readSubagentTranscriptEffect(ctx, childSessionId),
						},
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
				let unacceptedResultInputs: SendTurnInput[] = [];
				let terminalRunIds: string[] = [];
				let resultInput:
					| (Pick<SendTurnInput, "inputId" | "runId" | "continuation"> & {
							readonly eventSink: ClaudeSessionContext["eventSink"];
					  })
					| undefined;
				let endsCurrentRun = true;
				if (message.type === "result") {
					const pending = yield* pendingIntakes(this.stateRef, ctx.sessionId);
					unacceptedResultInputs = unacceptedResultInputIds(
						ctx,
						message,
						pending,
					)
						.map((id) => pending.get(id)?.unplaced)
						.filter(
							(input): input is SendTurnInput => input?.runId !== undefined,
						);
					ctx.turnCount++;
					const inputIds = message.user_message_uuids ?? [
						message.user_message_uuid ??
							(ctx.currentRunId
								? ctx.currentTurnId
								: (ctx.acceptedOutputOwner?.inputId ?? ctx.currentTurnId)),
					];
					const acceptedOwner = inputIds.flatMap((inputId) => {
						const runId = inputId && ctx.messageRunIds?.get(inputId);
						return runId ? [{ inputId, runId, eventSink: ctx.eventSink }] : [];
					});
					terminalRunIds = [
						...new Set([
							...unacceptedResultInputs.flatMap((input) =>
								input.runId ? [input.runId] : [],
							),
							...acceptedOwner.map(({ runId }) => runId),
						]),
					];
					endsCurrentRun =
						!ctx.currentRunId ||
						(unacceptedResultInputs.length === 0 &&
							acceptedOwner.length === 0) ||
						inputIds.includes(ctx.currentTurnId) ||
						acceptedOwner.some(({ runId }) => runId === ctx.currentRunId);
					if (!ctx.currentRunId || !endsCurrentRun)
						resultInput = unacceptedResultInputs[0] ?? acceptedOwner[0];
					ctx.interruptRequested =
						ctx.interruptInputId !== undefined &&
						inputIds.includes(ctx.interruptInputId);
					if (
						endsCurrentRun &&
						isInterruptedResult(message, ctx.interruptRequested)
					) {
						yield* this.completeTurnToolsEffect(ctx, false);
						yield* this.cancelInteractionsEffect(
							ctx,
							"Turn interrupted",
							false,
						);
					}
					if (endsCurrentRun) ctx.turnInFlight = false;
				}
				const detachedResult =
					resultInput !== undefined &&
					(unacceptedResultInputs.length > 0 ||
						resultInput.inputId !==
							(ctx.acceptedOutputOwner?.inputId ?? ctx.currentTurnId));
				const translationContext: ClaudeSessionContext = resultInput
					? {
							...ctx,
							currentRunId: resultInput.runId,
							currentTurnId: resultInput.inputId,
							currentUserMessageId:
								resultInput.continuation?.cutOffMessageId ??
								(ctx.acceptedOutputOwner?.inputId === resultInput.inputId
									? ctx.acceptedOutputOwner.userMessageId
									: undefined) ??
								resultInput.inputId,
							eventSink: resultInput.eventSink,
							...(detachedResult
								? {
										lastAssistantUuid: undefined,
										activeAssistantMessageId: "",
										goalTracker: new ClaudeGoalTracker(ctx.sessionId),
										usageLimit: undefined,
										usageLimitReported: undefined,
										pendingSyntheticMessages: undefined,
									}
								: {}),
						}
					: ctx;
				const translatedMessages = yield* interceptClaudeUsageLimit(
					translationContext,
					message,
				);
				for (const translatedMessage of translatedMessages)
					yield* translatedMessage.type === "result" && detachedResult
						? translator.translateDetachedResult(
								translationContext,
								translatedMessage,
								terminalRunIds,
							)
						: translator.translate(
								translationContext,
								translatedMessage,
								decision.receivedAt,
								terminalRunIds,
							);
				if (parentChildLink) {
					yield* parentChildLink;
					parentChildLink = undefined;
				}
				if (message.type === "result") {
					const translatedResult = translatedMessages.find(
						(message) => message.type === "result",
					);
					if (endsCurrentRun)
						this.deps.onTurnStateChanged?.(ctx.sessionId, false);
					yield* settleUnacceptedResultEffect(
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
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen({ self: this }, function* () {
			const pending = (yield* pendingIntakes(this.stateRef, ctx.sessionId)).get(
				message.command_uuid,
			);
			if (message.state === "cancelled") {
				yield* ctx.promptQueue.recall(message.command_uuid);
				if (pending?.unplaced?.runId)
					yield* pending.unplaced.eventSink
						.push(
							claudeRuntimeEvent(
								"turn.interrupted",
								ctx.sessionId,
								{ messageId: "" },
								pending.unplaced.runId,
							),
						)
						.pipe(
							Effect.mapError(
								(cause) =>
									new ClaudeBoundaryError({ operation: "cancelIntake", cause }),
							),
						);
				if (pending && ctx.currentTurnId === message.command_uuid) {
					ctx.turnInFlight = false;
					this.deps.onTurnStateChanged?.(ctx.sessionId, false);
				}
				yield* cancelIntakeEffect(
					this.stateRef,
					ctx.sessionId,
					message.command_uuid,
				);
				return;
			}
			if (message.state !== "started") return;
			const unplaced = pending?.unplaced;
			if (!unplaced || ctx.stopped) return;
			yield* ctx.promptQueue.recall(message.command_uuid);
			// A steer becomes the current turn when it starts, on its own sink,
			// and is in flight even when the turn before it already ended.
			// Stop keeps this query alive for tasks/steers, but closes its run to
			// new members, including when the daemon has retired it at the bound.
			if (ctx.currentRunId && ctx.closedRunIds?.has(ctx.currentRunId))
				ctx.currentRunId = undefined;
			ctx.currentTurnId = message.command_uuid;
			ctx.currentUserMessageId =
				unplaced.continuation?.cutOffMessageId ?? message.command_uuid;
			ctx.currentRunId ??= unplaced.runId;
			if (ctx.currentRunId) {
				(ctx.messageRunIds ??= new Map()).set(
					message.command_uuid,
					ctx.currentRunId,
				);
				ctx.acceptedOutputOwner = {
					inputId: message.command_uuid,
					runId: ctx.currentRunId,
					userMessageId: ctx.currentUserMessageId,
				};
			}
			ctx.turnInFlight = true;
			this.deps.onTurnStateChanged?.(ctx.sessionId, true);
			if (unplaced.eventSink !== ctx.eventSink) {
				const priorSink = ctx.eventSink;
				this.sinks.retainSink(unplaced.eventSink);
				ctx.eventSink = unplaced.eventSink;
				yield* this.sinks.releaseSinkEffect(priorSink);
			}
			yield* this.placeUserMessageEffect(unplaced);
			if (ctx.stopped) return;
			if (ctx.currentRunId && unplaced.runId) {
				yield* ctx.eventSink
					.push(
						claudeRuntimeEvent(
							"run.started",
							ctx.sessionId,
							{
								inputId: message.command_uuid,
								requestedRunId: unplaced.runId,
								...(unplaced.continuation
									? { userMessageId: unplaced.continuation.cutOffMessageId }
									: {}),
							},
							ctx.currentRunId,
						),
					)
					.pipe(
						Effect.mapError(
							(cause) =>
								new ClaudeBoundaryError({ operation: "startRun", cause }),
						),
					);
				if (ctx.pendingRunModel?.inputId === message.command_uuid) {
					yield* ctx.eventSink
						.push(
							claudeRuntimeEvent(
								"turn.model_resolved",
								ctx.sessionId,
								ctx.pendingRunModel.model,
								ctx.currentRunId,
							),
						)
						.pipe(
							Effect.mapError(
								(cause) =>
									new ClaudeBoundaryError({
										operation: "reportRunModel",
										cause,
									}),
							),
						);
				}
				ctx.pendingRunModel = undefined;
			}
			// Admission may have joined the prior turn before its result wrote idle.
			// The SDK start places this input and makes its local work busy too.
			yield* ctx.eventSink
				.push(
					claudeRuntimeEvent(
						"session.status",
						ctx.sessionId,
						{
							sessionId: ctx.sessionId,
							status: "busy",
						},
						ctx.currentRunId,
					),
				)
				.pipe(
					Effect.mapError(
						(cause) =>
							new ClaudeBoundaryError({ operation: "startTurn", cause }),
					),
				);
			yield* acceptIntakeEffect(
				this.stateRef,
				ctx.sessionId,
				message.command_uuid,
			);
		}).pipe(
			Effect.uninterruptible,
			(ctx.messageOwnershipPermit ??= Semaphore.makeUnsafe(1)).withPermits(1),
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
		this.sinks.retainSink(sink);
		return FiberMap.run(
			this.subagentFinalizationFibers,
			key,
			finalization.pipe(
				Effect.interruptible,
				Effect.catch((err) =>
					Effect.sync(() =>
						log.warn(
							`Claude subagent finalization failed for ${ctx.sessionId}: ${err instanceof Error ? err.message : err}`,
						),
					),
				),
				Effect.ensuring(this.sinks.releaseSinkEffect(sink)),
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
			if (ctx.rebinding || this.endingOwnership.has(ctx)) return Effect.void;
			this.endingOwnership.add(ctx);
			if (this.controllers.get(ctx.sessionId) === ctx.controller)
				this.controllers.delete(ctx.sessionId);
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
		return Effect.gen({ self: this }, function* () {
			if (ctx.stopped || !(yield* isCurrentSession(this.stateRef, ctx))) return;
			// Clear stale resume cursor so next turn starts a fresh SDK session
			const errMsg = err instanceof Error ? err.message : String(err);
			if (
				ctx.resumeSessionId &&
				(!ctx.queryInitialized || isClaudeResumeRefused(err)) &&
				isClaudeResumeFailure(err)
			) {
				ctx.resumeSessionId = undefined;
				log.warn(
					`Session ${ctx.sessionId}: stale resume cursor cleared after: ${errMsg}`,
				);
				if (ctx.resumeFallbackAllowed || isClaudeResumeRefused(err)) {
					// Native resume fallback replaces an unopened query, not its
					// session controller or already observed goal/message facts.
					ctx.rebinding = true;
					ctx.turnInFlight = false;
					this.deps.onTurnStateChanged?.(ctx.sessionId, false);
					return yield* resolveIntakeErrorEffect(this.stateRef, ctx, err);
				}
			}

			const pending = (yield* pendingIntakes(this.stateRef, ctx.sessionId)).get(
				ctx.currentTurnId ?? "",
			);
			yield* translator
				.translateError(ctx, err, ctx.currentRunId ?? pending?.unplaced?.runId)
				.pipe(
					Effect.catch((translateErr) =>
						Effect.sync(() => {
							if (ctx.currentTurnId)
								this.deps.onAbandonedRun?.(ctx.currentTurnId);
							log.warn(
								`translateError failed for session ${ctx.sessionId}: ${translateErr instanceof Error ? translateErr.message : translateErr}`,
							);
						}),
					),
				);
			yield* resolveIntakeErrorEffect(this.stateRef, ctx, err);
			yield* settlePendingIntakesEffect(this.stateRef, ctx.sessionId, errMsg);
		});
	}

	private finalizeStreamConsumerEffect(
		ctx: ClaudeSessionContext,
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen({ self: this }, function* () {
			if (!ctx.stopped && (yield* isCurrentSession(this.stateRef, ctx))) {
				const current = yield* getSession(this.stateRef, ctx.sessionId);
				if (current === ctx) {
					yield* markStreamEnded(this.stateRef, ctx.sessionId);
					yield* settlePendingIntakesEffect(
						this.stateRef,
						ctx.sessionId,
						"SDK stream ended without result",
					);
				}
			}
		}).pipe(
			// Once this stream ends, its background tasks can never report
			// completion, even after an interrupt: the next turn starts a new
			// query. A newer query that already replaced this one went through
			// removeSession, which cleared it; don't wipe the newer query's tasks.
			Effect.ensuring(
				Effect.gen({ self: this }, function* () {
					const current = yield* getSession(this.stateRef, ctx.sessionId);
					if (current === undefined || current === ctx) {
						ctx.turnInFlight = false;
						yield* this.recordBackgroundTaskEffect({
							sessionId: ctx.sessionId,
							kind: "session-ended",
						});
					}
					yield* this.endMessageOwnershipEffect(ctx);
					const active = yield* getSession(this.stateRef, ctx.sessionId);
					if (active === undefined || active === ctx)
						this.deps.onTurnStateChanged?.(ctx.sessionId, false);
				}),
			),
		);
	}

	interruptTurnEffect(
		sessionId: string,
		turnIds?: readonly string[],
	): Effect.Effect<void, ProviderInstanceFailure> {
		const attributes = { providerId: this.providerId, sessionId };
		return this.mapProviderFailure(
			"interruptTurn",
			this.interruptSessionEffect(sessionId, turnIds).pipe(
				Effect.annotateLogs(attributes),
				Effect.withSpan("claude.interrupt", { attributes }),
			),
		);
	}

	private interruptSessionEffect(
		sessionId: string,
		turnIds?: readonly string[],
	): Effect.Effect<void, ClaudeAdapterError> {
		const bound = turnIds !== undefined;
		return Effect.gen({ self: this }, function* () {
			if (!bound) {
				yield* FiberMap.remove(this.shutdownFibers, sessionId);
				yield* this.warmedQueries.discardEffect(sessionId);
				const setup = yield* getSetupLock(this.stateRef, sessionId);
				if (setup) yield* Deferred.await(setup).pipe(Effect.ignore);
			}
			const ctx = yield* getSession(this.stateRef, sessionId);
			const interrupt = Effect.gen({ self: this }, function* () {
				// A queued lifecycle start can change the active admission while Stop
				// waits for message ownership. Select its candidate under that permit.
				const boundTurnId = bound ? ctx?.currentTurnId : undefined;
				if (bound && !ctx) {
					// Stop setup too: it may still be placing the user message and
					// otherwise create a cold query after the warm query is discarded.
					const waiters = yield* pendingIntakes(this.stateRef, sessionId);
					if (!turnIds.some((turnId) => waiters.has(turnId)))
						return Effect.void;
					const setupLock = yield* getSetupLock(this.stateRef, sessionId);
					if (setupLock)
						yield* Deferred.fail(setupLock, new Error("Turn interrupted"));
				} else if (
					ctx &&
					bound &&
					(!boundTurnId ||
						!turnIds.includes(boundTurnId) ||
						!(yield* isCurrentSession(this.stateRef, ctx)))
				)
					return Effect.void;
				if (bound) {
					yield* FiberMap.remove(this.shutdownFibers, sessionId);
					yield* this.warmedQueries.discardEffect(sessionId);
				}
				if (!ctx) return Effect.void;
				// Revalidate the captured input after asynchronous owner cleanup. Never
				// resolve a replacement query from the session id for a delayed Stop.
				if (
					bound &&
					(!(yield* isCurrentSession(this.stateRef, ctx)) ||
						ctx.currentTurnId !== boundTurnId)
				)
					return Effect.void;

				// Live tasks and pending steering inputs need the same query and prompt
				// queue. Interrupt only the running turn; its SDK result settles it by id.
				const waiters = yield* pendingIntakes(this.stateRef, sessionId);
				if (
					!ctx.stopped &&
					((ctx.liveBackgroundTaskCount ?? 0) > 0 ||
						[...waiters].some(
							([inputId, waiter]) =>
								waiter.unplaced !== undefined && inputId !== ctx.currentTurnId,
						))
				) {
					// A delayed Cancel can arrive after the result while tasks or a steer
					// keep the query alive. It must not interrupt an idle query or the next input.
					const inputId = ctx.currentTurnId;
					if (!ctx.turnInFlight || !inputId || ctx.interruptInputId === inputId)
						return Effect.void;
					log.info(`Interrupting running turn for session ${sessionId}`);
					ctx.interruptInputId = inputId;
					const closed = (ctx.closedRunIds ??= new Set());
					// A late rejection can follow durable bound retirement. Membership
					// stays closed; rejection still leaves the durable run untouched.
					for (const id of [
						ctx.currentRunId,
						...(turnIds ?? [inputId]).map(
							(id) =>
								ctx.messageRunIds?.get(id) ?? waiters.get(id)?.unplaced?.runId,
						),
					])
						if (id) closed.add(id);
					const acknowledged = yield* this.interruptQueryEffect(ctx).pipe(
						Effect.tapError(() =>
							Effect.sync(() => {
								if (ctx.interruptInputId === inputId)
									ctx.interruptInputId = undefined;
							}),
						),
					);
					// Only an accepted interrupt may reject interactions. Keep this on
					// the stream's ownership permit so a pending steer cannot lose its approvals.
					// A bound Stop awaits acceptance after releasing that permit, so the
					// acknowledgement holds no admission and a rejection still fails the Stop.
					return acknowledged.pipe(
						Effect.andThen(
							(ctx.messageOwnershipPermit ??=
								Semaphore.makeUnsafe(1)).withPermits(1)(
								Effect.gen({ self: this }, function* () {
									if (ctx.currentTurnId === inputId && ctx.turnInFlight)
										yield* this.cancelInteractionsEffect(
											ctx,
											"Turn interrupted",
											false,
										);
								}),
							),
						),
					);
				}

				log.info(`Interrupting turn for session ${sessionId}`);
				yield* this.cleanupSessionEffect(
					ctx,
					"Turn interrupted",
					false,
					!bound,
				);
				// With no live tasks or pending steer, retain the existing close path.
				yield* Effect.try({
					try: () => ctx.query.close(),
					catch: (cause) =>
						new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
				}).pipe(Effect.ignore);
				yield* settlePendingIntakesEffect(
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
				return Effect.void;
			});
			// Lifecycle starts and send admission change currentTurnId on this permit.
			// Keep a bound Stop's identity check and query command in the same turn.
			const acknowledged = yield* ctx && bound
				? (ctx.messageOwnershipPermit ??= Semaphore.makeUnsafe(1)).withPermits(
						1,
					)(interrupt)
				: interrupt;
			yield* acknowledged;
		});
	}

	/** Issues the interrupt to this query; the result awaits its acknowledgement. */
	private interruptQueryEffect(
		ctx: ClaudeSessionContext,
	): Effect.Effect<
		Effect.Effect<void, ClaudeAdapterError>,
		ClaudeAdapterError
	> {
		return Effect.gen({ self: this }, function* () {
			const inputId = ctx.currentTurnId;
			const acknowledgement = yield* Effect.try({
				try: () => {
					const pending = ctx.query.interrupt();
					// close() rejects an unanswered interrupt, and callers may fork or drop
					// the acknowledgement. Unobserved, that rejection kills the runner.
					pending.catch(() => {});
					return pending;
				},
				catch: (cause) =>
					new ClaudeBoundaryError({ operation: "Claude SDK", cause }),
			});
			return Effect.tryPromise({
				try: () => acknowledgement,
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
				const event = claudeRuntimeEvent(
					"tool.completed",
					ctx.sessionId,
					{
						messageId:
							ctx.activeAssistantMessageId ?? ctx.lastAssistantUuid ?? "",
						partId: tool.itemId,
						result: null,
						duration: 0,
					},
					ctx.toolRunIds?.get(tool.itemId),
				);
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
		waitForInterrupt = true,
	): Effect.Effect<void, ClaudeAdapterError> {
		return Effect.gen({ self: this }, function* () {
			if (ctx.stopped) return;
			ctx.stopped = true;
			const turnInFlight = ctx.turnInFlight === true;
			const messageId = ctx.activeAssistantMessageId ?? "";
			const unaccepted = (yield* pendingIntakes(
				this.stateRef,
				ctx.sessionId,
			)).get(ctx.currentTurnId ?? "")?.unplaced;
			const runId = ctx.currentRunId ?? unaccepted?.runId;

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
								runId,
							),
						)
						.pipe(Effect.ignore);
				}
				yield* ctx.eventSink
					.push(
						claudeRuntimeEvent(
							"turn.interrupted",
							ctx.sessionId,
							{
								messageId,
							},
							runId,
						),
					)
					.pipe(Effect.ignore);
				yield* ctx.eventSink
					.push(
						claudeRuntimeEvent(
							"session.status",
							ctx.sessionId,
							{
								sessionId: ctx.sessionId,
								status: "idle",
							},
							runId,
						),
					)
					.pipe(Effect.ignore);
			}

			ctx.turnInFlight = false;
			ctx.currentRunId = undefined;
			this.deps.onTurnStateChanged?.(ctx.sessionId, false);

			yield* ctx.promptQueue.close().pipe(Effect.ignore);

			const acknowledged = yield* this.interruptQueryEffect(ctx).pipe(
				Effect.orElseSucceed(() => Effect.void),
			);
			// A late acknowledgement must neither hold admission nor perform cleanup
			// against a replacement.
			yield* waitForInterrupt
				? Effect.ignore(acknowledged)
				: Effect.forkIn(
						acknowledged.pipe(Effect.interruptible, Effect.ignore),
						this.scope,
					);
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
			Effect.gen({ self: this }, function* () {
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
			Effect.gen({ self: this }, function* () {
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
		return Effect.gen({ self: this }, function* () {
			// Explicit disposal ends the controller even after a resumable query
			// failure left its context waiting for the next send.
			ctx.rebinding = false;
			yield* this.cleanupSessionEffect(ctx, reason, true);

			yield* settlePendingIntakesEffect(this.stateRef, ctx.sessionId, reason);

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
		return Effect.gen({ self: this }, function* () {
			yield* FiberMap.remove(this.shutdownFibers, sessionId);
			yield* this.warmedQueries.discardEffect(sessionId);
			const ctx = yield* getSession(this.stateRef, sessionId);
			if (!ctx) {
				// Query creation can fail after a rebind has detached the old one.
				this.controllers.delete(sessionId);
				return;
			}
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
		return Effect.gen({ self: this }, function* () {
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
			this.controllers.clear();
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
