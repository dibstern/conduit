// Scoped layers for daemon process lifecycle: signal handling, error handling,
// and leaf drainable services (KeepAwake, VersionChecker, StorageMonitor, PortScanner).
// Finalizers remove process listeners / drain services to prevent leaks in tests.

import * as NodeCommandExecutor from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import {
	Context,
	Data,
	Deferred,
	Effect,
	HashMap,
	Layer,
	Option,
	PubSub,
	Ref,
	Stream,
} from "effect";
import { accountsStateFromConfig } from "../../../account-directory.js";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../contracts/provider-instance.js";
import {
	type DaemonConfig,
	defaultDaemonConfig,
	migrateDaemonConfig,
} from "../../../daemon/config-persistence.js";
import {
	closeHttpServer,
	closeOnboardingServer,
	type DaemonLifecycleContext,
	type HttpServerStartConfig,
	type OnboardingServerDeps,
	type OnboardingServerStartConfig,
	startHttpServer,
	startOnboardingServer,
} from "../../../daemon/daemon-lifecycle.js";
import { makeDaemonRpcSocketLayer } from "../../../daemon/daemon-rpc-server.js";
import * as Failure from "../../../effect/failure-classification.js";
import { ENV, resolveTraceConfig } from "../../../env.js";
import { startContentionMetrics } from "../../../persistence/contention-metrics.js";
import {
	makePersistenceDaemonLayer,
	PersistenceStore,
} from "../../../persistence/effect/live.js";
import { ClaudeAccountScopesLive } from "../../../provider/claude/claude-account-scopes.js";
import { makeClaudeSessionRunner } from "../../../provider/claude/claude-provider-runtime.js";
import {
	type ClaudeConfigDir,
	captureClaudeLaunchLogin,
} from "../../../provider/claude/claude-sdk-env.js";
import { CodexAccountResourcesLive } from "../../../provider/codex/codex-account-resources.js";
import { readCodexSessionIdentity } from "../../../provider/codex/codex-session-store.js";
import { CursorAccountResourcesLive } from "../../../provider/cursor/cursor-account-resources.js";
import type { ProjectShellEnvResolver } from "../../../provider/project-shell-env.js";
import { loadRelaySettings } from "../../../relay/relay-settings.js";
import {
	ServerBuildUpdateLive,
	serverExitCode,
} from "../../../server/build-update.js";
import {
	BrowserRpcConnectionsLive,
	makeRoutedWsRpcServerLayer,
} from "../../../server/ws-rpc.js";
import { archiveIdleSessions } from "../../../session/auto-archive-sweep.js";
import { settleIdleSessions } from "../../../session/auto-settle-sweep.js";
import type { ClaudeSdkSeam } from "../../../types.js";
import {
	EventRetentionSchedulerTag,
	makeEventRetentionSchedulerLive,
} from "../../persistence/Services/event-retention-scheduler.js";
import { makePortWatcherLive } from "../../persistence/Services/port-watcher.js";
import { makeRunLedgerSchedulerLive } from "../../persistence/Services/run-ledger-scheduler.js";
import { RateLimiterLive } from "../../relay/Layers/rate-limiter-layer.js";
import { SessionWorkspaceLive } from "../../relay/Layers/session-workspace-layer.js";
import { makeStatusPollerCoreLive } from "../../relay/Layers/status-poller-layer.js";
import { AlertsLive } from "../../relay/Services/alerts.js";
import { GoalStuckStopReactorLive } from "../../relay/Services/goal-stuck-stop.js";
import {
	InputDraftsLive,
	releaseInputDraftClaims,
} from "../../relay/Services/input-drafts.js";
import {
	ProjectSettingsTag,
	refreshGlobalDefaults,
	syncGlobalSetting,
} from "../../relay/Services/project-settings.js";
import { ProviderTurnsLive } from "../../relay/Services/provider-turn-service.js";
import { RelayStatusSnapshotTag } from "../../relay/Services/relay-status-snapshot.js";
import { ConfigTag } from "../../relay/Services/services.js";
import { SessionEventBusLive } from "../../relay/Services/session-event-bus.js";
import { SessionManagerServiceTag } from "../../relay/Services/session-manager-service.js";
import {
	makeOverridesStateLive,
	setDefaultAgent,
} from "../../relay/Services/session-overrides-state.js";
import { DaemonSessionSetupLive } from "../../relay/Services/session-setup.js";
import { SessionWorkspaceHintReactorLive } from "../../relay/Services/session-workspace-hint.js";
import { SSEStreamTag } from "../../relay/Services/sse-stream-service.js";
import { AuthManagerFromConfigLive } from "../../server/Layers/auth-middleware.js";
import {
	DaemonHttpRequestHandlerTag,
	makeDaemonHttpRouterLive,
} from "../../server/Layers/http-router-layer.js";
import {
	ProjectRpcContextsLive,
	ProjectRpcContextsTag,
	WebSocketRelayRouterLive,
	WebSocketRoutingLive,
} from "../../server/Layers/ws-routing-layer.js";
import {
	HttpServerRefLive,
	HttpServerRefTag,
} from "../../server/Services/http-server-ref.js";
import { PushNotificationManagerLive } from "../../server/Services/push-service.js";
import {
	commitDaemonRuntimeConfig,
	type DaemonConfigMirror,
	DaemonConfigMirrorLive,
	DaemonConfigRefLive,
	DaemonConfigRefTag,
	type DaemonRuntimeConfig,
} from "../Services/daemon-config-ref.js";
import { DaemonHandleLive } from "../Services/daemon-handle.js";
import {
	DaemonLifecycleContextLive,
	DaemonLifecycleContextTag,
} from "../Services/daemon-lifecycle-context.js";
import {
	DaemonEvent,
	DaemonEventBusLive,
	DaemonEventBusTag,
} from "../Services/daemon-pubsub.js";
import {
	DaemonStateTag,
	makeDaemonStateLive,
} from "../Services/daemon-state.js";
import { DaemonTurnsLive } from "../Services/daemon-turns.js";
import { EventLoopBlockMonitorLive } from "../Services/event-loop-delay.js";
import { InstanceHealthCheckLive } from "../Services/instance-health-service.js";
import {
	ManagedOpenCodeLifecycleLive,
	makeInstanceManagerStateFromDaemonStateLive,
	makeInstanceManagerStateLive,
} from "../Services/instance-manager-service.js";
import {
	type OpenCodeInstances,
	OpenCodeInstancesTag,
} from "../Services/opencode-instances-service.js";
import {
	makeOpenCodeProjectStreamsLive,
	OpenCodeProjectStreams,
} from "../Services/opencode-project-streams.js";
import { OpenCodeSessionIdsLive } from "../Services/opencode-session-ids.js";
import {
	allProjects,
	makeProjectRegistryFromDaemonStateLive,
	makeProjectRegistryLive,
	ProjectRegistryTag,
} from "../Services/project-registry-service.js";
import {
	type PollerTimings,
	type ProjectParts,
	ProjectServices,
} from "../Services/project-services.js";
import { ProviderAdapters } from "../Services/provider-adapters.js";
import {
	type Relay,
	type RelayCache,
	RelayCacheTag,
} from "../Services/relay-cache.js";
import {
	SessionActivityDaemonLive,
	SessionActivityTag,
} from "../Services/session-activity.js";
import { SessionDiffLive } from "../Services/session-diff.js";
import {
	makeSharedSessionDirectoryLive,
	SessionDirectory,
} from "../Services/session-directory.js";
import { SessionGit, SessionGitLive } from "../Services/session-git.js";
import { SessionManagerOwnerLive } from "../Services/session-manager-owner.js";
import { WorkingTreeEditsLive } from "../Services/working-tree-edits.js";
import { WorktreeCleanupQueueLive } from "../Services/worktree-cleanup-service.js";
import { AccountPictureLive } from "./account-picture-layer.js";
import { makeAccountResourceScopesLive } from "./account-resource-scopes-layer.js";
import { AskAlertsLive } from "./ask-alerts-layer.js";
import { AutoSettleLive } from "./auto-settle-layer.js";
import { CategorySetLive } from "./category-set-layer.js";
import {
	ConfigPersistenceLive,
	ConfigPersistenceTag,
	ConfigSnapshotFromEffectStateLive,
	makeConfigWriterLive,
} from "./config-persistence-layer.js";
import { DaemonOrchestrationLive } from "./daemon-orchestration-layer.js";
import { makeDaemonSharedStoreLayer } from "./daemon-shared-store-layer.js";
import {
	DaemonWsRpcHandlersLive,
	DaemonWsRpcHandlersTag,
} from "./daemon-ws-rpc-layer.js";
import { FolderTimelineEvictionLive } from "./folder-timeline-eviction-layer.js";
import { makeHostedTerminalsLive } from "./hosted-terminals-layer.js";
import { KeepAwakeLive } from "./keep-awake-layer.js";
import { MessageSurfacingSettingsLive } from "./message-surfacing-settings-layer.js";
import { OpenCodeInstancesLive } from "./opencode-instances-layer.js";
import { OwnerScopesLive } from "./owner-scopes-layer.js";
import { PermissionTimeoutLive } from "./permission-timeout-layer.js";
import { PinoLoggerLive } from "./pino-logger-layer.js";
import { PortScannerLive, PortScannerTag } from "./port-scanner-layer.js";
import { makePreviewGateLive } from "./preview-gate-layer.js";
import { ProjectContextLive } from "./project-context-layer.js";
import { makeProjectServicesLive } from "./project-services-layer.js";
import {
	makeProjectShellEnvLive,
	ProjectShellEnvTag,
	ProjectShellEnvWiringLive,
} from "./project-shell-env-layer.js";
import { makeProviderAdaptersLive } from "./provider-adapters-layer.js";
import { SessionPrefetchLive } from "./session-prefetch-layer.js";
import {
	StorageMonitorLive,
	StorageMonitorTag,
} from "./storage-monitor-layer.js";
import { SubprocessLive } from "./subprocess-layer.js";
import {
	TailscaleCliLive,
	TailscaleServeLive,
} from "./tailscale-serve-layer.js";
import { EnsureCertsLive, TlsCertLive, TlsCertTag } from "./tls-cert-layer.js";
import { makeDaemonTracingLive } from "./tracing.js";
import { UsageLive } from "./usage-layer.js";
import { UserAvatarLive } from "./user-avatar-layer.js";
import {
	VersionCheckerLive,
	VersionCheckerTag,
} from "./version-checker-layer.js";
import { WorktreeCleanupLive } from "./worktree-cleanup-layer.js";
import { makeWorktreeLive } from "./worktree-layer.js";

/** Shutdown signal — Deferred that completes when SIGTERM/SIGINT received. */
export class ShutdownSignalTag extends Context.Service<
	ShutdownSignalTag,
	Deferred.Deferred<"restart" | "stop">
>()("ShutdownSignal") {}

export class DaemonLifecycleLayerError extends Data.TaggedError(
	"DaemonLifecycleLayerError",
)<{
	operation: string;
	cause: unknown;
}> {
	get message(): string {
		let inner: string;
		if (this.cause instanceof Error) inner = this.cause.message;
		else if (Failure.isCause(this.cause))
			inner = Failure.renderCause(this.cause);
		else {
			try {
				inner = String(this.cause);
			} catch {
				inner = "unknown error";
			}
		}
		return `${this.operation} failed: ${inner}`;
	}
}

const loggedFinalizerPromise = (operation: string, run: () => Promise<void>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) => new DaemonLifecycleLayerError({ operation, cause }),
	}).pipe(
		Effect.catch((error) =>
			Effect.logError(`${operation} failed during shutdown`, error),
		),
	);

const closeLifecycleServer = (operation: string, close: () => Promise<void>) =>
	loggedFinalizerPromise(operation, close);

/**
 * Installs SIGTERM/SIGINT handlers. Completes a Deferred on signal.
 * Finalizer removes handlers to prevent leaks in tests.
 */
export const SignalHandlerLayer = Layer.effect(
	ShutdownSignalTag,
	Effect.gen(function* () {
		const deferred = yield* Deferred.make<"restart" | "stop">();
		let shutdownMode: "restart" | "stop" | undefined;
		yield* Deferred.await(deferred).pipe(
			Effect.tap((mode) =>
				Effect.sync(() => {
					shutdownMode = mode;
				}),
			),
			Effect.forkScoped,
		);

		const onShutdown = () => {
			shutdownMode ??= "restart";
			Deferred.doneUnsafe(deferred, Effect.succeed("restart"));
		};
		const onInterrupt = () => {
			// A second interrupt during shutdown exits now, keeping the stop/restart exit policy.
			if (shutdownMode) process.exit(serverExitCode(shutdownMode));
			onShutdown();
		};
		const onReload = () => {
			// SIGHUP — config reload placeholder
		};

		process.on("SIGTERM", onShutdown);
		process.on("SIGINT", onInterrupt);
		process.on("SIGHUP", onReload);

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				process.removeListener("SIGTERM", onShutdown);
				process.removeListener("SIGINT", onInterrupt);
				process.removeListener("SIGHUP", onReload);
			}),
		);

		return deferred;
	}),
);

/**
 * Attaches unhandledRejection/uncaughtException handlers.
 * Finalizer removes them to prevent listener leaks.
 */
export const ProcessErrorHandlerLayer = Layer.effectDiscard(
	Effect.gen(function* () {
		const onUnhandled = (reason: unknown) => {
			console.error("[daemon] Unhandled rejection:", reason);
		};
		const onUncaught = (err: Error) => {
			console.error("[daemon] Uncaught exception:", err);
		};

		process.on("unhandledRejection", onUnhandled);
		process.on("uncaughtException", onUncaught);

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				process.removeListener("unhandledRejection", onUnhandled);
				process.removeListener("uncaughtException", onUncaught);
			}),
		);
	}),
);

// Leaf Service Layers (Effect-native)
// These delegate to the pure Effect Layer factories defined in the *-layer.ts
// modules. The old imperative-class bridge layers have been removed.

/**
 * KeepAwake layer — uses the pure Effect KeepAwakeLive layer.
 * Background fiber is fork-scoped; interrupted automatically on scope close.
 */
export const makeKeepAwakeLive = (options?: {
	command?: string;
	args?: string[];
}) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const state = yield* Ref.get(yield* DaemonStateTag);
			const command = options?.command ?? state.keepAwakeCommand;
			const args = options?.args ?? state.keepAwakeArgs;
			return KeepAwakeLive({
				enabled: state.keepAwake,
				...(command !== undefined && { command }),
				...(args !== undefined && { args }),
			});
		}),
	).pipe(
		Layer.provide(NodeCommandExecutor.layer),
		Layer.provide(NodeFileSystem.layer),
	);

/**
 * VersionChecker layer — uses the pure Effect VersionCheckerLive layer.
 * Background fiber checks periodically and broadcasts updates.
 */
export const makeVersionCheckerLive = (
	config: Parameters<typeof VersionCheckerLive>[0],
) => VersionCheckerLive(config);

/**
 * StorageMonitor layer — uses the pure Effect StorageMonitorLive layer.
 * Background fiber checks disk usage and evicts when above high-water mark.
 */
export const makeStorageMonitorLive = (
	config: Parameters<typeof StorageMonitorLive>[0],
) => StorageMonitorLive(config);

/**
 * PortScanner layer — uses the pure Effect PortScannerLive layer.
 * Background fiber scans ports with hysteresis-based removal.
 */
export const makePortScannerLive = (
	config: Parameters<typeof PortScannerLive>[0],
) => PortScannerLive(config);

/**
 * Central daemon event subscriptions. Business services expose direct methods;
 * this layer owns transitional bus bridges so subscriptions do not hide inside
 * unrelated service layers.
 */
export const DaemonWiringLive: Layer.Layer<
	never,
	never,
	DaemonEventBusTag | ConfigPersistenceTag | ProviderAdapters
> = Layer.effectDiscard(
	Effect.gen(function* () {
		const bus = yield* DaemonEventBusTag;
		const persistence = yield* ConfigPersistenceTag;
		const adapters = yield* ProviderAdapters;
		// Drain native terminals while project borrows and their sinks remain live.
		yield* Effect.addFinalizer(() => adapters.shutdown);
		const sub = yield* PubSub.subscribe(bus);

		yield* Effect.forkScoped(
			Stream.fromSubscription(sub).pipe(
				Stream.filter((event) => event._tag === "ConfigChanged"),
				Stream.runForEach(() => persistence.requestSave),
			),
		);
	}),
);

/** A project's daemon-side controls, read from its generation (lane 16q). */
const projectHandle = (
	slug: string,
	context: Context.Context<ProjectParts | SessionManagerServiceTag>,
): Relay => {
	const run = <A, E>(effect: Effect.Effect<A, E, ProjectParts>) =>
		effect.pipe(Effect.provideContext(context));
	const manager = Context.get(context, SessionManagerServiceTag).forProject(
		slug,
	);
	const activity = Context.get(context, SessionActivityTag);
	return {
		slug,
		syncGlobalSetting: (tag) => run(syncGlobalSetting(tag)),
		refreshGlobalDefaults: () => run(refreshGlobalDefaults.pipe(Effect.asVoid)),
		settleIdleSessions: (idleWindowMs, now) =>
			run(
				settleIdleSessions(
					{
						projectDir: Context.get(context, ConfigTag).projectDir,
						hasViewer: activity.hasViewers,
						hasLiveBackgroundWork: (id) => activity.background.hasLiveWork(id),
						setSettled: (id) =>
							manager.setSessionSettled(id, { settled: true, automatic: true }),
					},
					idleWindowMs,
					now,
				),
			),
		archiveIdleSessions: (idleWindowMs, now) =>
			run(
				archiveIdleSessions(
					{
						hasLiveBackgroundWork: activity.background.hasLiveWork,
						setArchived: (id) =>
							manager.setSessionArchived(id, {
								archived: true,
								automatic: true,
								idleWindowMs,
								now,
							}),
					},
					idleWindowMs,
					now,
				),
			),
		deleteArchivedSessions: (windowMs, now) =>
			manager.deleteArchivedSessions(windowMs, now),
		getStatusSnapshot: () => ({
			...Context.get(context, RelayStatusSnapshotTag).getSnapshot(),
			clients: Context.get(context, ProjectSettingsTag).browsers.count(),
			sse: Context.get(context, SSEStreamTag).getHealth(),
		}),
		setDefaultAgent: (agent) => run(setDefaultAgent(agent)),
	};
};

/**
 * The daemon's view of its open projects. A project opens in its generation
 * (ProjectServices.open) and closes with its owner scope; no relay starts, as
 * t3code starts its reactors in the server scope (apps/server/src/server.ts:540-627).
 */
export const makeRelayCacheLayer = (): Layer.Layer<
	RelayCacheTag,
	never,
	ProjectServices | SessionManagerServiceTag
> =>
	Layer.effect(
		RelayCacheTag,
		Effect.gen(function* () {
			const projects = yield* ProjectServices;
			const managers = yield* SessionManagerServiceTag;
			const withManagers = Context.add(SessionManagerServiceTag, managers);
			const cache: RelayCache = {
				get: (slug) =>
					projects
						.open(slug)
						.pipe(
							Effect.map((context) =>
								projectHandle(slug, withManagers(context)),
							),
						),
				peek: (slug) =>
					projects
						.opened(slug)
						.pipe(
							Effect.map(
								Option.map((context) =>
									projectHandle(slug, withManagers(context)),
								),
							),
						),
				// A folder change or a missing folder ends the start; removal also
				// closes the owner scope.
				invalidate: projects.close,
			};
			// A project holding OpenCode events with no tab open starts in its generation (82tn.16).
			const projectStreams = yield* Effect.serviceOption(
				OpenCodeProjectStreams,
			);
			if (Option.isSome(projectStreams))
				yield* Stream.fromQueue(projectStreams.value.wakes).pipe(
					Stream.runForEach((slug) =>
						projects
							.open(slug)
							.pipe(
								Effect.catchCause((cause) =>
									Effect.logError(`Failed to start project "${slug}"`, cause),
								),
							),
					),
					Effect.forkScoped,
				);
			return cache;
		}),
	);

/**
 * HTTP(S) server layer — starts the HTTP (or TLS protocol-detection) server
 * and tears it down gracefully on scope close.
 */
export const HttpServerLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const ctx = yield* DaemonLifecycleContextTag;
		const configRef = yield* DaemonConfigRefTag;
		const httpServerRef = yield* HttpServerRefTag;
		const requestHandler = yield* DaemonHttpRequestHandlerTag;
		const tls = yield* TlsCertTag;
		const config = yield* Ref.get(configRef);

		const startConfig: HttpServerStartConfig = {
			port: config.port,
			host: config.host,
		};
		if (tls.certs) {
			startConfig.tls = {
				key: tls.certs.key,
				cert: tls.certs.caCertPem
					? Buffer.concat([
							tls.certs.cert,
							Buffer.from("\n"),
							tls.certs.caCertPem,
						])
					: tls.certs.cert,
			};
		}

		ctx.router = requestHandler;
		const actualPort = yield* Effect.tryPromise({
			try: () => startHttpServer(ctx, startConfig),
			catch: (cause) =>
				new DaemonLifecycleLayerError({
					operation: "startHttpServer",
					cause,
				}),
		}).pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					ctx.router = null;
				}).pipe(Effect.andThen(Effect.fail(error))),
			),
		);
		yield* Ref.set(httpServerRef, ctx.upgradeServer ?? ctx.httpServer);
		yield* commitDaemonRuntimeConfig((c) => ({ ...c, port: actualPort }));
		yield* Effect.addFinalizer(() =>
			closeLifecycleServer("closeHttpServer", () => closeHttpServer(ctx)).pipe(
				Effect.andThen(Ref.set(httpServerRef, null)),
				Effect.andThen(
					Effect.sync(() => {
						ctx.router = null;
					}),
				),
			),
		);
	}),
);

export const makeHttpServerLive = (ctx: DaemonLifecycleContext) =>
	HttpServerLive.pipe(
		Layer.provide(Layer.succeed(DaemonLifecycleContextTag, ctx)),
	);

/** Local clients use the browser RPC contract and handler layer. */
export const DaemonRpcServerLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const ctx = yield* DaemonLifecycleContextTag;
		const handlers = yield* DaemonWsRpcHandlersTag;
		const directory = yield* SessionDirectory;
		const resolveRpcContext = yield* ProjectRpcContextsTag;
		const shutdownSignal = yield* ShutdownSignalTag;
		const server = makeDaemonRpcSocketLayer(
			ctx.socketPath,
			makeRoutedWsRpcServerLayer(resolveRpcContext, handlers).pipe(
				Layer.provide(Layer.succeed(SessionDirectory, directory)),
			),
			{
				onSuccessfulShutdownResponse: (tag) =>
					Deferred.succeed(
						shutdownSignal,
						tag === "Shutdown" ? "stop" : "restart",
					).pipe(Effect.asVoid),
				onClientCountChange: (count) => {
					ctx.clientCount = count;
				},
			},
		);
		yield* Layer.build(server).pipe(
			Effect.mapError(
				(cause) =>
					new DaemonLifecycleLayerError({ operation: "startRpcServer", cause }),
			),
		);
	}),
);

/**
 * Onboarding server layer — starts an HTTP-only onboarding server when TLS is
 * active and tears it down gracefully on scope close.
 */
export const OnboardingServerLive = (staticDir: string) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const ctx = yield* DaemonLifecycleContextTag;
			const configRef = yield* DaemonConfigRefTag;
			const tls = yield* TlsCertTag;
			const config = yield* Ref.get(configRef);

			if (!tls.certs) return;

			const startConfig: OnboardingServerStartConfig = {
				httpsPort: config.port,
				listenPort: config.port === 0 ? 0 : config.port + 1,
				host: config.host,
			};
			const effectiveDeps: OnboardingServerDeps = {
				staticDir,
				caRootPath: tls.caRootPath,
				caCertDer: tls.caCertDer,
			};

			yield* Effect.tryPromise({
				try: () => startOnboardingServer(ctx, effectiveDeps, startConfig),
				catch: (cause) =>
					new DaemonLifecycleLayerError({
						operation: "startOnboardingServer",
						cause,
					}),
			});
			yield* Effect.addFinalizer(() =>
				closeLifecycleServer("closeOnboardingServer", () =>
					closeOnboardingServer(ctx),
				),
			);
		}),
	);

export const makeOnboardingServerLive = (
	ctx: DaemonLifecycleContext,
	staticDir: string,
) =>
	OnboardingServerLive(staticDir).pipe(
		Layer.provide(Layer.succeed(DaemonLifecycleContextTag, ctx)),
	);

/**
 * Options for composing the full DaemonLive layer.
 *
 * Simplified from the original DaemonLiveOptions — fields that are now
 * provided by Layers (keepAwake config, versionCheck config, storageMon
 * config, configPath) have been moved to DaemonOptions or
 * are derived internally. Only server lifecycle context (still imperative)
 * and optional background service configs remain.
 */
export interface DaemonLiveOptions {
	/** Launch login captured before the legacy startup environment mutation. */
	launchLogin?: ClaudeConfigDir;
	// Server lifecycle (still partially imperative — AP-38 deferred)
	staticDir: string;

	/** Full runtime config snapshot used to seed DaemonConfigRef. */
	initialConfig: DaemonRuntimeConfig;
	/** Optional mirror for sync legacy DaemonHandle reads during migration. */
	configMirror?: DaemonConfigMirror;

	// Background services — Effect-native config types (all optional for phased migration)
	keepAwake?: Parameters<typeof KeepAwakeLive>[0];
	versionCheck?: Parameters<typeof VersionCheckerLive>[0];
	storageMon?: Parameters<typeof StorageMonitorLive>[0];
	portScanner?: Parameters<typeof PortScannerLive>[0];
	defaultOpencodeUrl?: string;
	smartDefault?: boolean;
	smartDefaultUrl?: string;

	// DaemonOptions-derived values (computed by caller from DaemonOptions)
	configDir: string;
	socketPath: string;

	/** Already decoded startup snapshot; seeds the project and instance registries. */
	persistedConfig?: DaemonConfig;
	/** Computed while loading that snapshot, before normalization discards the old values. */
	persistedConfigNeedsMigration?: boolean;
	/** Test seam: an in-process Claude SDK for the provider adapters and every project. */
	claudeSdk?: ClaudeSdkSeam;
	/** Test seam: stands in for every OpenCode server the daemon reaches. */
	openCodeInstances?: OpenCodeInstances;
	/** Test seam: stands in for project shell environment capture and readiness. */
	shellEnv?: ProjectShellEnvResolver;
	/** Test seam: shortened poll intervals and SSE grace/staleness, so gating runs in test time. */
	pollerTimings?: PollerTimings;
}

/**
 * Compose all daemon lifecycle Layers into a single Layer using tiered
 * `Layer.provideMerge` composition.
 *
 * Tiers (AP-37 / AP-R2-16):
 *   Tier 0 — Foundation: independent Layers with no inter-dependencies
 *   Tier 1 — Services: Layers that depend on foundation Tags
 *   Tier 2 — Registries: state containers and factories
 *   Tier 3 — Servers: imperative server lifecycle (still takes DaemonLifecycleContext)
 *   Tier 4 — Background: optional background service fibers
 *   Tier 5 — Scoped fibers: discovery, prefetch, WS routing (need registries + config)
 *
 * Each tier uses `Layer.provideMerge` so downstream tiers can access
 * upstream Tags without re-providing them. Scope finalizers run in
 * reverse order on shutdown.
 */
export const makeDaemonLive = (options: DaemonLiveOptions) => {
	const { configDir, socketPath } = options;
	const launchLogin =
		options.launchLogin ?? captureClaudeLaunchLogin(process.env);
	const accountsState = accountsStateFromConfig(
		options.persistedConfig ?? defaultDaemonConfig(),
		launchLogin,
	);
	const configMigration =
		options.persistedConfig === undefined
			? Layer.empty
			: Layer.effectDiscard(
					migrateDaemonConfig(
						options.persistedConfig,
						configDir,
						options.persistedConfigNeedsMigration ?? false,
					),
				);
	const storageStartup = makeDaemonSharedStoreLayer(
		configDir,
		options.persistedConfig ?? defaultDaemonConfig(),
	).pipe(Layer.provideMerge(configMigration), Layer.provide(PinoLoggerLive));

	// Tier 0: Foundation (no inter-dependencies)
	// These Layers have zero dependencies on other Tags. They form the base
	// of the Layer stack that all subsequent tiers build on.
	const foundation = Layer.mergeAll(
		EventLoopBlockMonitorLive.pipe(Layer.provide(PinoLoggerLive)),
		SubprocessLive,
		Layer.effectDiscard(
			Effect.acquireRelease(Effect.sync(startContentionMetrics), (metrics) =>
				Effect.tryPromise(async () => {
					await metrics?.close();
				}).pipe(
					Effect.catch((error) =>
						Effect.logError("Contention metrics shutdown failed", error),
					),
				),
			),
		),
		SessionActivityDaemonLive.pipe(
			Layer.provideMerge(Layer.merge(DaemonEventBusLive, SessionEventBusLive)),
		),
		BrowserRpcConnectionsLive,
		PinoLoggerLive,
		makeDaemonTracingLive(resolveTraceConfig(configDir)),
		DaemonConfigRefLive(options.initialConfig),
		options.configMirror
			? DaemonConfigMirrorLive(options.configMirror)
			: Layer.empty,
		DaemonLifecycleContextLive(socketPath),
		InstanceHealthCheckLive,
		SignalHandlerLayer,
		ProcessErrorHandlerLayer,
		makeConfigWriterLive(configDir),
	).pipe(Layer.provideMerge(storageStartup));

	// These Layers depend on Tags from Tier 0 (primarily DaemonConfigRefTag).
	// Layer.provideMerge makes Tier 0 Tags available AND passes them through.
	//
	// TlsCertLive depends on both DaemonConfigRefTag (Tier 0) and EnsureCertsTag.
	// EnsureCertsLive is provided to TlsCertLive directly (intra-tier dependency).
	const tlsCertWithDeps = TlsCertLive(configDir).pipe(
		Layer.provide(EnsureCertsLive),
	);
	const services = Layer.mergeAll(
		Layer.suspend(() => makeOverridesStateLive(loadRelaySettings(configDir))),
		CategorySetLive(configDir),
		AuthManagerFromConfigLive,
		tlsCertWithDeps,
		EnsureCertsLive,
		PushNotificationManagerLive(configDir),
		options.shellEnv
			? Layer.succeed(ProjectShellEnvTag, options.shellEnv)
			: makeProjectShellEnvLive(),
		makeAccountResourceScopesLive(),
	).pipe(Layer.provideMerge(foundation));

	const versionCheckLayer = options.versionCheck
		? makeVersionCheckerLive(options.versionCheck)
		: Layer.succeed(VersionCheckerTag, {
				getLatestKnown: () => Effect.succeed(null),
				getCurrentVersion: () => Effect.succeed("unknown"),
			});
	const portScannerLayer = options.portScanner
		? makePortScannerLive(options.portScanner)
		: Layer.succeed(PortScannerTag, {
				getKnownPorts: () => Effect.succeed(new Set<number>()),
				scanNow: () => Effect.succeed({ discovered: [], lost: [], active: [] }),
			});
	const auxiliaryServices = Layer.mergeAll(
		versionCheckLayer,
		portScannerLayer,
		WorktreeCleanupQueueLive,
	).pipe(Layer.provideMerge(services));

	// State containers and factories. ProjectRegistryLive and
	// InstanceManagerStateLive have no construction deps but are logically
	// grouped here. RelayFactoryLive needs DaemonConfigRefTag (from Tier 0,
	// available via Tier 1's provideMerge passthrough).
	//
	const stateLayer = makeDaemonStateLive(
		options.persistedConfig === undefined
			? undefined
			: {
					...options.persistedConfig,
					instances: options.persistedConfig.instances ?? [],
				},
	).pipe(
		Layer.tap((context) =>
			Ref.update(Context.get(context, DaemonStateTag), (current) => ({
				...current,
				configDir,
				socketPath,
				keepAwake: options.initialConfig.keepAwake,
				...(options.initialConfig.keepAwakeCommand !== undefined && {
					keepAwakeCommand: options.initialConfig.keepAwakeCommand,
				}),
				...(options.initialConfig.keepAwakeArgs !== undefined && {
					keepAwakeArgs: options.initialConfig.keepAwakeArgs,
				}),
			})),
		),
	);

	// Compose registry layers explicitly to preserve type information.
	// RelayFactoryLive has R = DaemonConfigRefTag, which is satisfied by
	// the services tier (via provideMerge passthrough from foundation).
	const projectRegistryLayer = options.persistedConfig
		? makeProjectRegistryFromDaemonStateLive
		: makeProjectRegistryLive();
	const instanceManagerOptions = {
		launchLogin,
		accountsState: {
			...accountsState,
			// OpenCode startup owns creating its managed default and its metadata.
			accounts: accountsState.accounts.filter(
				(account) =>
					account.id !== MANAGED_OPENCODE_ACCOUNT_ID ||
					options.persistedConfig?.instances?.some(
						({ id }) => id === account.id,
					),
			),
		},
		...(options.defaultOpencodeUrl !== undefined && {
			defaultOpencodeUrl: options.defaultOpencodeUrl,
		}),
		...(options.smartDefault !== undefined && {
			smartDefault: options.smartDefault,
		}),
		...(options.smartDefaultUrl !== undefined && {
			smartDefaultUrl: options.smartDefaultUrl,
		}),
	};
	const instanceManagerLayer = options.persistedConfig
		? makeInstanceManagerStateFromDaemonStateLive(
				undefined,
				instanceManagerOptions,
			)
		: makeInstanceManagerStateLive(undefined, [], instanceManagerOptions);

	const registryBase = Layer.mergeAll(
		projectRegistryLayer,
		instanceManagerLayer,
	)
		.pipe(Layer.provideMerge(stateLayer))
		.pipe(Layer.provideMerge(auxiliaryServices));
	const registryState = Layer.merge(
		CursorAccountResourcesLive(configDir),
		CodexAccountResourcesLive(configDir),
	).pipe(Layer.provideMerge(registryBase));

	const effectSnapshotLayer = ConfigSnapshotFromEffectStateLive.pipe(
		Layer.provideMerge(
			ClaudeAccountScopesLive(configDir).pipe(
				Layer.provideMerge(registryState),
			),
		),
	);

	const withConfigPersistence = ConfigPersistenceLive.pipe(
		Layer.provideMerge(effectSnapshotLayer),
	);
	const withAvatar = UserAvatarLive.pipe(
		Layer.provide(AccountPictureLive),
		Layer.provideMerge(withConfigPersistence),
	);
	const withManagedOpenCodeServers = ManagedOpenCodeLifecycleLive(
		configDir,
	).pipe(Layer.provideMerge(withAvatar));

	// The one owner of Conduit's map onto OpenCode's own session ids (82tn.80).
	const withOpenCodeSessionIds = Layer.unwrap(
		Effect.gen(function* () {
			const store = yield* PersistenceStore;
			return OpenCodeSessionIdsLive.pipe(
				Layer.provide(Layer.succeedContext(store)),
			);
		}),
	).pipe(Layer.provideMerge(withManagedOpenCodeServers));
	const withOpenCodeInstances = (
		options.openCodeInstances
			? Layer.succeed(OpenCodeInstancesTag, options.openCodeInstances)
			: OpenCodeInstancesLive
	).pipe(Layer.provideMerge(withOpenCodeSessionIds));
	const withSessionDirectory = Layer.unwrap(
		Effect.gen(function* () {
			const store = yield* PersistenceStore;
			return makeSharedSessionDirectoryLive.pipe(
				Layer.provide(Layer.succeedContext(store)),
			);
		}),
	).pipe(Layer.provideMerge(withOpenCodeInstances));
	// Each registered project's OpenCode stream lives in its owner scope (82tn.16).
	const withOwnerScopes = Layer.unwrap(
		Effect.gen(function* () {
			const store = yield* PersistenceStore;
			const registry = yield* ProjectRegistryTag;
			return makeOpenCodeProjectStreamsLive(() =>
				[...HashMap.values(Ref.getUnsafe(registry))].map(
					({ project }) => project,
				),
			).pipe(Layer.provide(Layer.succeedContext(store)));
		}),
	).pipe(
		Layer.provideMerge(
			OwnerScopesLive.pipe(Layer.provideMerge(withSessionDirectory)),
		),
	);
	const withProjectContext = ProjectContextLive.pipe(
		Layer.provideMerge(withOwnerScopes),
	);
	const withInputDrafts = Layer.unwrap(
		Effect.gen(function* () {
			const store = yield* PersistenceStore;
			yield* releaseInputDraftClaims().pipe(Effect.provide(store));
			return InputDraftsLive.pipe(Layer.provide(Layer.succeedContext(store)));
		}),
	).pipe(
		// One alert feed for the daemon: every project's relay publishes to it,
		// so a tab on any project hears completions from all of them (82tn.12).
		Layer.merge(AlertsLive),
		Layer.provideMerge(withProjectContext),
	);
	// One PortWatcher per daemon (CONTRACT.md 8.7), serving every registered project's sessions.
	// One watcher, one alarm scheduler, one retention scheduler and one status poller per daemon,
	// serving registered projects' sessions; retention and the poller run once at start, so a
	// project no tab opens is reclaimed and settled too.
	const withPortWatcher = Layer.unwrap(
		Effect.gen(function* () {
			const store = yield* PersistenceStore;
			const registry = yield* ProjectRegistryTag;
			const served = allProjects.pipe(
				Effect.map((projects) => projects.map(({ slug }) => slug)),
				Effect.provideService(ProjectRegistryTag, registry),
			);
			return Layer.merge(
				makePortWatcherLive(
					(sessionId) =>
						readCodexSessionIdentity(configDir, sessionId)?.threadId,
					served,
				),
				makeRunLedgerSchedulerLive(served),
			).pipe(
				Layer.merge(
					makeStatusPollerCoreLive(
						served,
						options.pollerTimings?.statusPollerInterval,
					),
				),
				Layer.merge(
					Layer.effectDiscard(
						Effect.flatMap(EventRetentionSchedulerTag, (s) => s.kick),
					).pipe(Layer.provideMerge(makeEventRetentionSchedulerLive(served))),
				),
				Layer.provide(
					makePersistenceDaemonLayer().pipe(
						Layer.provideMerge(Layer.succeedContext(store)),
					),
				),
			);
		}),
	).pipe(Layer.provideMerge(withInputDrafts));
	// Runner adapters record account usage readings (Codex), so Usage precedes them.
	const withProviderAdapters = makeProviderAdaptersLive(
		configDir,
		options.claudeSdk
			? {
					claudeSdk: options.claudeSdk,
					claudeRunnerFactory: makeClaudeSessionRunner,
				}
			: {},
	).pipe(
		Layer.provideMerge(UsageLive().pipe(Layer.provideMerge(withPortWatcher))),
	);
	const withWorktrees = Layer.mergeAll(
		makeWorktreeLive(configDir, {
			setupTimeoutMs: ENV.worktreeSetupTimeoutMs,
		}),
		MessageSurfacingSettingsLive,
	).pipe(Layer.provideMerge(withProviderAdapters));
	const withSessionGit = Layer.unwrap(
		Effect.gen(function* () {
			const store = yield* PersistenceStore;
			return SessionGitLive.pipe(
				Layer.provide(
					makePersistenceDaemonLayer().pipe(
						Layer.provideMerge(Layer.succeedContext(store)),
					),
				),
			);
		}),
	).pipe(Layer.provideMerge(withWorktrees));
	const withSessionDiff = SessionDiffLive(configDir).pipe(
		Layer.provideMerge(withSessionGit),
	);
	const withWorkingTreeEdits = Layer.unwrap(
		Effect.map(PersistenceStore, (store) =>
			WorkingTreeEditsLive.pipe(Layer.provide(Layer.succeedContext(store))),
		),
	).pipe(Layer.provideMerge(withSessionDiff));
	const withGitChanges = Layer.effectDiscard(
		Effect.gen(function* () {
			const git = yield* SessionGit;
			const bus = yield* DaemonEventBusTag;
			yield* git.changes.pipe(
				Stream.runForEach(() =>
					PubSub.publish(bus, DaemonEvent.ProjectsChanged()),
				),
				Effect.forkScoped,
			);
		}),
	).pipe(Layer.provideMerge(withWorkingTreeEdits));
	const withSessionWorkspace = Layer.unwrap(
		Effect.gen(function* () {
			const store = yield* PersistenceStore;
			return SessionWorkspaceLive.pipe(
				Layer.provide(
					makePersistenceDaemonLayer().pipe(
						Layer.provideMerge(Layer.succeedContext(store)),
					),
				),
			);
		}),
	).pipe(Layer.provideMerge(withGitChanges));
	const withSessionSetup = Layer.unwrap(
		Effect.gen(function* () {
			const store = yield* PersistenceStore;
			return DaemonSessionSetupLive.pipe(
				Layer.provide(
					makePersistenceDaemonLayer().pipe(
						Layer.provideMerge(Layer.succeedContext(store)),
					),
				),
			);
		}),
	).pipe(Layer.provideMerge(withSessionWorkspace));
	// Before runs can start: it finishes evictions a crash interrupted.
	const withEviction = Layer.unwrap(
		Effect.gen(function* () {
			const store = yield* PersistenceStore;
			return FolderTimelineEvictionLive.pipe(
				Layer.provide(
					makePersistenceDaemonLayer().pipe(
						Layer.provideMerge(Layer.succeedContext(store)),
					),
				),
			);
		}),
	).pipe(Layer.provideMerge(withSessionSetup));
	const withSessionManager = Layer.mergeAll(
		SessionManagerOwnerLive,
		DaemonTurnsLive,
		ProviderTurnsLive,
	).pipe(Layer.provideMerge(withEviction));
	const withOrchestration = Layer.mergeAll(
		DaemonOrchestrationLive,
		PermissionTimeoutLive,
		makeHostedTerminalsLive(configDir),
		// One send limiter for the daemon, keyed by tab, as t3code keeps its limits
		// server-wide (apps/server/src/server.ts:375). Process-fake benchmarks lift it.
		RateLimiterLive({
			maxRequests:
				process.env["NODE_ENV"] === "test" &&
				process.send &&
				process.env["CONDUIT_TEST_CLAUDE_QUERY_MODULE"]
					? 10_000
					: 5,
			windowMs: 10_000,
		}),
	).pipe(Layer.provideMerge(withSessionManager));
	// Each project's context comes from the registry, not from its relay (82tn.16).
	const withProjectServices = makeProjectServicesLive({
		configDir,
		claudeSdk: options.claudeSdk,
		pollerTimings: options.pollerTimings,
	}).pipe(Layer.provideMerge(withOrchestration));
	const withRelayCache = makeRelayCacheLayer().pipe(
		Layer.provideMerge(withProjectServices),
	);

	const withKeepAwake = makeKeepAwakeLive(options.keepAwake).pipe(
		Layer.provideMerge(withRelayCache),
	);
	const withDaemonControl = DaemonHandleLive.pipe(
		Layer.provideMerge(withKeepAwake),
	);

	// Tier 3: Servers (imperative lifecycle)
	const httpRequestHandler = makeDaemonHttpRouterLive(options.staticDir);
	// The listening server is the server layer's, as t3code's HTTP layer owns
	// its server (apps/server/src/server.ts:305-320).
	const http = HttpServerLive.pipe(
		Layer.provideMerge(httpRequestHandler),
		Layer.provideMerge(HttpServerRefLive),
	);

	const tailscale = TailscaleServeLive.pipe(
		Layer.provideMerge(TailscaleCliLive),
		Layer.provideMerge(http),
		Layer.provideMerge(withDaemonControl),
	);
	const servers = OnboardingServerLive(options.staticDir).pipe(
		Layer.provideMerge(tailscale),
	);

	const withDaemonWiring = Layer.merge(
		DaemonWiringLive,
		ProjectShellEnvWiringLive,
	).pipe(Layer.provideMerge(servers));

	// Tier 4: Background services (optional)
	// When a config is not provided, a no-op stub Layer provides the Tag
	// so the service is always resolvable. This avoids type erasure and
	// ensures wiring tests can verify all Tags without any casts.
	const storageMonLayer = options.storageMon
		? makeStorageMonitorLive(options.storageMon)
		: Layer.succeed(StorageMonitorTag, {
				getUsage: () => Effect.succeed(0),
				getLastCheck: () => Effect.succeed(0),
			});
	const withBackground = storageMonLayer.pipe(
		Layer.provideMerge(withDaemonWiring),
	);

	const withWsRelayRouter = ProjectRpcContextsLive.pipe(
		Layer.provideMerge(
			Layer.merge(WebSocketRelayRouterLive, DaemonWsRpcHandlersLive),
		),
		Layer.provideMerge(withBackground),
	);

	// Tier 5: Scoped fiber Layers (need registries + config)
	// Side-effect-only Layers (scopedDiscard) that fork background fibers.
	// They read Tags from upstream tiers via Layer.provideMerge passthrough.
	// One goal-stuck and one workspace-hint reactor for every project (82tn.16).
	const reactors = Layer.unwrap(
		Effect.gen(function* () {
			const store = yield* PersistenceStore;
			return Layer.merge(
				GoalStuckStopReactorLive,
				SessionWorkspaceHintReactorLive,
			).pipe(
				Layer.provide(
					makePersistenceDaemonLayer().pipe(
						Layer.provideMerge(Layer.succeedContext(store)),
					),
				),
			);
		}),
	);
	const scopedFibers = Layer.mergeAll(
		DaemonRpcServerLive,
		AskAlertsLive,
		reactors,
		AutoSettleLive(),
		WorktreeCleanupLive(),
		WebSocketRoutingLive,
		SessionPrefetchLive,
		ServerBuildUpdateLive,
		makePreviewGateLive(configDir),
	).pipe(Layer.provideMerge(withWsRelayRouter));

	return scopedFibers;
};
