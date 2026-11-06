import { Effect, FiberSet, Layer, Option, Schedule, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../contracts/provider-instance.js";
import * as Failure from "../../../effect/failure-classification.js";
import { formatErrorDetail } from "../../../errors.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { retireAsksOnProjectRemoval } from "../../../persistence/effect/retire-pending-prompts.js";
import {
	GOAL_READ_TEXT,
	goalCommandText,
} from "../../../provider/goal-tracker.js";
import { getOrchestrationLayer } from "../../../provider/orchestration-wiring.js";
import { runningRunnerCommands } from "../../../provider/runner/runner-recovery.js";
import {
	createMonitoringWiringState,
	wireMonitoringEffect,
} from "../../../relay/monitoring-wiring.js";
import { wirePollersEffect } from "../../../relay/poller-wiring.js";
import { makeSessionLifecycleWiringLive } from "../../../relay/session-lifecycle-wiring.js";
import { wireSSEConsumerEffect } from "../../../relay/sse-wiring.js";
import type { PushNotificationSender } from "../../../server/push.js";
import { EventRetentionSchedulerTag } from "../../persistence/Services/event-retention-scheduler.js";
import { PersistenceProjectTag } from "../../persistence/Services/persistence-service.js";
import { makeReadOpenCodeMessages } from "../../relay/Layers/project-ingestion-layer.js";
import { ContinuationTag } from "../../relay/Services/continuation.js";
import { OpenCodeRuntimeIngressTag } from "../../relay/Services/opencode-runtime-ingress-service.js";
import { RelayStatusSnapshotTag } from "../../relay/Services/relay-status-snapshot.js";
import { restoreAsyncQuestionsFromStore } from "../../relay/Services/restore-async-questions.js";
import { restoreClaudeQuestionsFromStore } from "../../relay/Services/restore-claude-questions.js";
import {
	ConfigTag,
	LoggerTag,
	PollerManagerTag,
	StatusPollerTag,
	TranslatorTag,
} from "../../relay/Services/services.js";
import { announceBackgroundWork } from "../../relay/Services/session-attention.js";
import { SessionInboxTag } from "../../relay/Services/session-inbox.js";
import type { SessionManagerServiceTag } from "../../relay/Services/session-manager-service.js";
import { restoreSessionSettings } from "../../relay/Services/session-model-settings.js";
import { backfillSessionPicks } from "../../relay/Services/session-pick.js";
import { SessionSetupTag } from "../../relay/Services/session-setup.js";
import { SessionWorkspaceTag } from "../../relay/Services/session-workspace.js";
import { SSEStreamTag } from "../../relay/Services/sse-stream-service.js";
import { OpenCodeTerminalServiceTag } from "../../relay/Services/terminal-service.js";
import { makeFailTurn } from "../../relay/Services/turn-failure.js";
import { AccountDirectory } from "../Services/account-directory.js";
import { DaemonTurns } from "../Services/daemon-turns.js";
import { OpenCodeInstancesTag } from "../Services/opencode-instances-service.js";
import {
	type ProviderAdapterProjectContext,
	ProviderAdapters,
} from "../Services/provider-adapters.js";
import { SessionActivityTag } from "../Services/session-activity.js";

/** The project's stored session count, which the status snapshot starts from. */
export const readPersistedStartupSessions = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const { projectId } = yield* PersistenceProjectTag;
	const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
		FROM sessions WHERE project_id = ${projectId}`;
	return rows[0]?.count ?? 0;
});

/**
 * Starts one registered project in its generation (82tn.16, lane 16q):
 * provider registration and recovery, projection recovery, OpenCode command
 * recovery, the SSE consumer, the status poller's listeners, session setup
 * recovery, then the inbox. Everything it starts is held by `scope`, so the
 * project's removal or a failed start ends it. t3code runs the same order once
 * per server (apps/server/src/serverRuntimeStartup.ts:411-440 and 533-565).
 */
export const startProject = (options: {
	readonly scope: Scope.Scope;
	readonly pushManager?: PushNotificationSender | undefined;
}) =>
	Effect.gen(function* () {
		const { scope, pushManager } = options;
		const config = yield* ConfigTag;
		const log = yield* LoggerTag;
		const sseLog = log.child("sse");
		const pipelineLog = log.child("pipeline");
		const sql = yield* SqlClient.SqlClient;
		const persistenceProject = yield* PersistenceProjectTag;
		const activity = yield* SessionActivityTag;
		const translator = yield* TranslatorTag;
		const statusSnapshot = yield* RelayStatusSnapshotTag;
		const sseStream = yield* SSEStreamTag;
		const statusPoller = yield* StatusPollerTag;
		const pollerManager = yield* PollerManagerTag;
		// Recover pending state before initialization advances projector cursors.
		yield* restoreClaudeQuestionsFromStore;
		yield* restoreAsyncQuestionsFromStore;
		yield* retireAsksOnProjectRemoval(scope);
		const orchestration = yield* getOrchestrationLayer;
		// Callback work runs in the start's scope and ends with it.
		const run = yield* FiberSet.runtime(yield* FiberSet.make())<
			| SessionManagerServiceTag
			| Effect.Services<ReturnType<typeof announceBackgroundWork>>
		>();
		const onBackgroundWorkChanged = (sessionId: string) => {
			run(
				Effect.gen(function* () {
					// 8.6: recovery's resends reach the ledger as the browser's goal actions do; a
					// re-read (8.5) carries no action and answers no pending one.
					for (const { id, action } of activity.goals.takeResends(sessionId))
						yield* orchestration.engine
							.dispatchEffect({
								type: "native_command",
								sessionId,
								commandId: id,
								text: action ? goalCommandText(action) : GOAL_READ_TEXT,
								...(action ? { goal: action } : {}),
							})
							.pipe(
								Effect.catch(() =>
									Effect.sync(() => activity.goals.drop(sessionId, id)),
								),
							);
					yield* announceBackgroundWork(sessionId);
					if (
						config.requestWorktreeCleanup &&
						activity.background.backgroundOf(sessionId) === undefined &&
						(yield* sql<{ settled_at: number | null }>`
							SELECT settled_at FROM sessions WHERE id = ${sessionId}
						`)[0]?.settled_at != null
					)
						yield* config.requestWorktreeCleanup();
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.sync(() =>
							log.warn(
								`Failed to announce background work: ${Failure.renderCause(cause)}`,
							),
						),
					),
				),
			);
		};
		const adapters = yield* ProviderAdapters;
		yield* orchestration.engine.prepareProjectRecovery(
			persistenceProject.projectId,
		);
		yield* adapters.registerProject(
			persistenceProject.projectId,
			yield* Effect.context<ProviderAdapterProjectContext>(),
			onBackgroundWorkChanged,
			orchestration.engine.ownsPendingSend.bind(orchestration.engine),
		);
		yield* adapters.recover;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		if (!(yield* projectionRunner.isRecovered()))
			yield* projectionRunner.recover();
		const backfilled = yield* backfillSessionPicks().pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					log.warn(
						`Could not backfill session picks: ${formatErrorDetail(error)}`,
					);
					return 0;
				}),
			),
		);
		if (backfilled > 0)
			log.info(`Backfilled picks for ${backfilled} session(s)`);
		// Restore only the durable pick; past turns never override it.
		const restored = yield* restoreSessionSettings().pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					log.warn(
						`Could not restore session settings: ${formatErrorDetail(error)}`,
					);
					return { modelSettings: 0, permissionModes: 0 };
				}),
			),
		);
		if (restored.permissionModes > 0)
			log.info(
				`Restored permission modes for ${restored.permissionModes} session(s)`,
			);
		const sessions = yield* Effect.result(readPersistedStartupSessions);
		if (sessions._tag === "Success" && sessions.success > 0)
			yield* statusSnapshot.setSessionCount(sessions.success);
		if (sessions._tag === "Failure")
			log.warn(
				`Session list unavailable at startup: ${formatErrorDetail(sessions.failure)}`,
			);
		const instances = yield* OpenCodeInstancesTag;
		const workspace = yield* SessionWorkspaceTag;
		const readOpenCodeMessages = yield* makeReadOpenCodeMessages;
		const ingress = yield* OpenCodeRuntimeIngressTag;
		const accounts = yield* (yield* AccountDirectory).snapshot;
		const recoveryCommands = yield* runningRunnerCommands(
			sql,
			"opencode",
			(id) => accounts.accounts.find((account) => account.id === id)?.driver,
		);
		const readOpenCodeStatuses = (instanceId: string, sessionId: string) =>
			Effect.gen(function* () {
				const { directory, hasWorkspace } = yield* workspace.withLaunch(
					sessionId,
					Effect.gen(function* () {
						// A reset clears the workspace row but remains an explicit move.
						const [row] = yield* sql<{ has_workspace: number }>`
							SELECT workspace IS NOT NULL OR EXISTS (
								SELECT 1 FROM events WHERE session_id = ${sessionId}
								AND type = 'session.workspace_changed' AND json_extract(data, '$.cause') != 'branch-rename'
							) AS has_workspace FROM sessions WHERE id = ${sessionId}`;
						return {
							directory: yield* workspace.get(sessionId),
							hasWorkspace: row?.has_workspace === 1,
						};
					}),
				);
				const client = yield* instances.ifRunning(instanceId, directory);
				if (Option.isNone(client))
					return (yield* instances.isManagedStopped(instanceId))
						? ("stopped" as const)
						: undefined;
				return yield* Effect.tryPromise({
					try: async () => {
						const statuses = await client.value.session.statuses();
						if (statuses[sessionId] !== undefined) return statuses;
						// OpenCode omits idle sessions. Validate the native identity
						// before using an omission as proof of idle.
						const session = await client.value.session.get(sessionId);
						if (session.id !== sessionId || !session.directory) return statuses;
						if (session.directory !== directory) {
							// An explicit workspace can outlive stale native detail. Both
							// scopes must be idle; a native-only default cannot override it.
							if (!hasWorkspace) return statuses;
							const nativeStatuses = await client.value.session.statuses(
								session.directory,
							);
							const nativeStatus = nativeStatuses[sessionId];
							if (nativeStatus && nativeStatus.type !== "idle")
								return { ...statuses, [sessionId]: nativeStatus };
							const current = await client.value.session.get(sessionId);
							if (
								current.id !== sessionId ||
								current.directory !== session.directory
							)
								return statuses;
						}
						return { ...statuses, [sessionId]: { type: "idle" as const } };
					},
					catch: (cause) => cause,
				});
			}).pipe(Effect.scoped);
		const recoverOpenCodeCommands = ingress
			.recoverCommands(
				recoveryCommands,
				readOpenCodeStatuses,
				yield* makeFailTurn,
			)
			.pipe(
				Effect.andThen(
					ingress.recoverObservedRuns(readOpenCodeStatuses, [
						MANAGED_OPENCODE_ACCOUNT_ID,
						...accounts.accounts
							.filter((account) => account.driver === "opencode")
							.map((account) => account.id),
					]),
				),
			);

		yield* (yield* EventRetentionSchedulerTag).kick;
		yield* statusPoller.on("changed", () => {
			run(recoverOpenCodeCommands);
		});
		// Lifecycle and monitoring wiring share one view of the project's pollers.
		const monitoringState = createMonitoringWiringState();
		yield* Layer.build(
			makeSessionLifecycleWiringLive({
				translator,
				sseTracker: monitoringState.sseTracker,
				getMonitoringState: monitoringState.getMonitoringState,
				setMonitoringState: monitoringState.setMonitoringState,
			}),
		);
		const monitoring = yield* wireMonitoringEffect({
			// Poller seeding is background work: it must not restart OpenCode.
			readMessages: readOpenCodeMessages,
			hasViewers: activity.hasViewers,
			pollerManager,
			sseStream,
			config: {
				...(config.configDir != null && { configDir: config.configDir }),
				...(config.pollerGatingConfig != null && {
					pollerGatingConfig: config.pollerGatingConfig,
				}),
				...(pushManager != null && { pushManager }),
				slug: config.slug,
			},
			statusLog: log.child("status-poller"),
			sseLog,
			pipelineLog,
			state: monitoringState,
		});
		// Quiesce monitoring first, so a late status change cannot restart a
		// message poller while the scope closes.
		yield* Scope.addFinalizer(scope, Effect.sync(monitoring.stopMonitoring));
		yield* wirePollersEffect({
			pollerManager,
			sseStream,
			hasViewers: activity.hasViewers,
			pipelineDeps: monitoring.pipelineDeps,
			sseTracker: monitoringState.sseTracker,
			config: {
				...(pushManager != null && { pushManager }),
				slug: config.slug,
			},
			pollerLog: log.child("msg-poller"),
			onDoneProcessed: monitoring.recordDoneDelivered,
		});
		const consumer = {
			translator,
			hasViewers: activity.hasViewers,
			...(pushManager != null && { pushManager }),
			log: sseLog,
			pipelineLog,
			statusPoller,
			slug: config.slug,
			providerInstanceId: MANAGED_OPENCODE_ACCOUNT_ID,
			onDoneProcessed: monitoring.recordDoneDelivered,
			// A PTY another client opens reaches the project's terminals with no tab open.
			onPtysChanged: (yield* OpenCodeTerminalServiceTag).onOpenCodePtysChanged,
			opencodeRuntimeIngress: ingress,
		};
		yield* wireSSEConsumerEffect(consumer, sseStream);
		// Other OpenCode instances delivering events for this project join the
		// same pipeline; each instance keeps its own reconnect state.
		yield* sseStream.wireInstanceStreams((stream, instanceId) =>
			wireSSEConsumerEffect(
				{ ...consumer, providerInstanceId: instanceId },
				stream,
			),
		);
		yield* sseStream.connectEffect();
		// Events arriving while the project is closed wait in the daemon's stream.
		yield* Scope.addFinalizer(scope, sseStream.disconnectEffect());
		yield* recoverOpenCodeCommands;
		// An unavailable provider may later be idle without ever producing a
		// status transition. Retry only the frozen startup claims.
		yield* Effect.forkIn(
			recoverOpenCodeCommands.pipe(Effect.repeat(Schedule.spaced("1 second"))),
			scope,
		);
		yield* (yield* SessionSetupTag).recover(config.slug);
		// The project lends its continuation to the daemon's one sweep while open.
		const continuation = yield* ContinuationTag;
		const continuationContext =
			yield* Effect.context<
				Effect.Services<ReturnType<typeof continuation.applyLimitPolicy>>
			>();
		yield* Effect.forkIn(
			(yield* DaemonTurns)
				.attach(config.slug, {
					sweep: continuation
						.sweepDueContinuations()
						.pipe(Effect.provideContext(continuationContext)),
					applyLimitPolicy: (sessionId) =>
						continuation
							.applyLimitPolicy(sessionId)
							.pipe(Effect.provideContext(continuationContext)),
				})
				.pipe(Effect.andThen(Effect.never), Effect.scoped),
			scope,
		);
		// Providers are registered and recovered; queued inputs may drain.
		yield* (yield* SessionInboxTag).start;
		// Everything wired here is held until the project's start scope closes.
	}).pipe(Effect.provideService(Scope.Scope, options.scope));
