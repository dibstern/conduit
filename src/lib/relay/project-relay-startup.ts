import { Effect, Exit, Option, Schedule, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../contracts/provider-instance.js";
import { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../domain/daemon/Services/opencode-instances-service.js";
import {
	type ProviderAdapterProjectContext,
	ProviderAdapters,
} from "../domain/daemon/Services/provider-adapters.js";
import { SessionActivityTag } from "../domain/daemon/Services/session-activity.js";
import { EventRetentionSchedulerTag } from "../domain/persistence/Services/event-retention-scheduler.js";
import { PersistenceProjectTag } from "../domain/persistence/Services/persistence-service.js";
import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
import { makeEffectOpenCodeRuntimeIngress } from "../domain/relay/Services/opencode-runtime-ingress-service.js";
import type { ProjectSettingsTag } from "../domain/relay/Services/project-settings.js";
import { makeEventSinkFactory } from "../domain/relay/Services/provider-turn-dispatch.js";
import { RelayStatusSnapshotTag } from "../domain/relay/Services/relay-status-snapshot.js";
import { resolveOrphanedClaudePermissions } from "../domain/relay/Services/resolve-orphaned-claude-permissions.js";
import { restoreClaudeQuestionsFromStore } from "../domain/relay/Services/restore-claude-questions.js";
import {
	type ConfigTag,
	type LoggerTag,
	type OrchestrationEngineTag,
	PollerManagerTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { announceBackgroundWork } from "../domain/relay/Services/session-attention.js";
import { SessionInboxTag } from "../domain/relay/Services/session-inbox.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import { restoreSessionSettings } from "../domain/relay/Services/session-model-settings.js";
import {
	type OverridesStateTag,
	setDefaultModel,
	setDefaultPermissionMode,
	setDefaultVariant,
} from "../domain/relay/Services/session-overrides-state.js";
import {
	backfillSessionPicks,
	loadServerSessionPick,
} from "../domain/relay/Services/session-pick.js";
import { SessionSetupTag } from "../domain/relay/Services/session-setup.js";
import {
	PollerPubSubTag,
	PollerStateTag,
} from "../domain/relay/Services/session-status-poller.js";
import {
	makeSessionOpenCodeClient,
	SessionWorkspaceTag,
} from "../domain/relay/Services/session-workspace.js";
import { SSEStreamTag } from "../domain/relay/Services/sse-stream-service.js";
import { OpenCodeTerminalServiceTag } from "../domain/relay/Services/terminal-service.js";
import { makeFailTurn } from "../domain/relay/Services/turn-failure.js";
import * as Failure from "../effect/failure-classification.js";
import { ENV } from "../env.js";
import { formatErrorDetail } from "../errors.js";
import type { Logger } from "../logger.js";
import { ProjectionRunnerEffectTag } from "../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import { getOrchestrationLayer } from "../provider/orchestration-wiring.js";
import { RunnerProviderInstance } from "../provider/runner/runner-provider-instance.js";
import { runningRunnerCommands } from "../provider/runner/runner-recovery.js";
import { makeWsRpcWebSocketHandler } from "../server/ws-rpc-handler.js";
import type { ProjectRelayConfig } from "../types.js";
import { wireMonitoringEffect } from "./monitoring-wiring.js";
import { wirePollersEffect } from "./poller-wiring.js";
import {
	type createProjectRelayLayers,
	TranslatorTag,
} from "./project-relay-layers.js";
import type { parseDefaultModel, RelaySettings } from "./relay-settings.js";
import { RelayCreationAbortedError } from "./relay-stack.js";
import { wireSSEConsumerEffect } from "./sse-wiring.js";

export const readPersistedStartupSessions = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const { projectId } = yield* PersistenceProjectTag;
	return yield* Effect.all({
		count: sql<{ count: number }>`SELECT COUNT(*) AS count FROM sessions
			WHERE project_id = ${projectId}`.pipe(
			Effect.map((rows) => rows[0]?.count ?? 0),
		),
		sessionId: sql<{ id: string | null }>`SELECT COALESCE(
			(SELECT id FROM sessions WHERE project_id = ${projectId}
				AND (parent_id IS NULL OR parent_id = '')
				ORDER BY updated_at DESC, id DESC LIMIT 1),
			(SELECT id FROM sessions WHERE project_id = ${projectId}
				ORDER BY updated_at DESC, id DESC LIMIT 1)
		) AS id`.pipe(Effect.map((rows) => rows[0]?.id ?? undefined)),
	});
});

interface StartupInputs {
	config: ProjectRelayConfig;
	log: Logger;
	sseLog: Logger;
	statusLog: Logger;
	pollerLog: Logger;
	pipelineLog: Logger;
	relaySettings: RelaySettings;
	initialDefaultModel: ReturnType<typeof parseDefaultModel>;
	initialDefaultVariant: string;
	layers: ReturnType<typeof createProjectRelayLayers>;
}

function acquireStartupServices(inputs: StartupInputs) {
	const {
		config,
		log,
		relaySettings,
		initialDefaultModel,
		initialDefaultVariant,
		layers,
	} = inputs;
	const { relayManagedRuntime } = layers;
	return Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const persistenceProject = yield* PersistenceProjectTag;
		const activity = yield* SessionActivityTag;
		const projectSettingsContext = yield* Effect.context<
			ProjectSettingsTag | OverridesStateTag | ConfigTag
		>();
		const api = yield* OpenCodeAPITag;
		const translator = yield* TranslatorTag;
		const wsHandler = yield* WebSocketHandlerTag;
		const rpcWsHandler = yield* makeWsRpcWebSocketHandler({
			context: Effect.suspend(() => relayManagedRuntime.contextEffect),
			runFork: relayManagedRuntime.runFork,
		});
		const statusSnapshot = yield* RelayStatusSnapshotTag;
		const sseStream = yield* SSEStreamTag;
		// Defaults come from settings; legacy pick repair uses only stored history.
		if (initialDefaultModel) {
			yield* setDefaultModel(initialDefaultModel);
		}
		if (initialDefaultVariant) {
			yield* setDefaultVariant(initialDefaultVariant);
		}
		if (relaySettings.defaultPermissionMode !== undefined) {
			yield* setDefaultPermissionMode(relaySettings.defaultPermissionMode);
		}
		// Recover pending state before initialization advances projector cursors.
		yield* restoreClaudeQuestionsFromStore;
		const orchestration = yield* getOrchestrationLayer;
		const runFork = Effect.runForkWith(
			yield* Effect.context<
				| SessionManagerServiceTag
				| Effect.Services<ReturnType<typeof announceBackgroundWork>>
			>(),
		);
		const onBackgroundWorkChanged = (sessionId: string) => {
			runFork(
				Effect.gen(function* () {
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
		const sharedAdapters = yield* Effect.serviceOption(ProviderAdapters);
		if (Option.isSome(sharedAdapters)) {
			yield* sharedAdapters.value
				.registerProject(
					persistenceProject.projectId,
					yield* Effect.context<ProviderAdapterProjectContext>(),
					onBackgroundWorkChanged,
				)
				.pipe(Effect.provideService(Scope.Scope, relayManagedRuntime.scope));
			yield* sharedAdapters.value.recover;
		} else
			for (const providerId of orchestration.registry.listProviders()) {
				const instance =
					yield* orchestration.registry.getInstanceEffect(providerId);
				if (instance instanceof RunnerProviderInstance)
					yield* instance.recoverEffect();
			}
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
		const rejectedPermissions = yield* resolveOrphanedClaudePermissions.pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					log.warn(
						`Could not reject Claude permissions left pending by a crash: ${formatErrorDetail(error)}`,
					);
					return 0;
				}),
			),
		);
		if (rejectedPermissions > 0) {
			yield* Effect.sync(() =>
				log.info(
					`Rejected ${rejectedPermissions} Claude permission(s) left pending by a crash`,
				),
			);
		}
		const sessionManagerService = yield* SessionManagerServiceTag;
		// Read-model only: creating a first session could call OpenCode, so attach
		// creates it instead (getDefaultSessionId).
		const readQueryEffect = yield* ReadQueryEffectTag;
		const sessionsResult = yield* Effect.result(readPersistedStartupSessions);
		if (sessionsResult._tag === "Success" && sessionsResult.success.count > 0)
			yield* statusSnapshot.setSessionCount(sessionsResult.success.count);
		if (sessionsResult._tag === "Failure")
			yield* Effect.sync(() =>
				log.warn(
					`Session list unavailable at startup: ${formatErrorDetail(sessionsResult.failure)}`,
				),
			);
		const sessionId =
			(sessionsResult._tag === "Success"
				? sessionsResult.success.sessionId
				: undefined) ?? "";
		yield* PollerStateTag;
		yield* PollerPubSubTag;
		const statusPoller = yield* StatusPollerTag;
		const pollerManager = yield* PollerManagerTag;
		const sessionClient = yield* makeSessionOpenCodeClient;
		const instances = yield* OpenCodeInstancesTag;
		const workspace = yield* SessionWorkspaceTag;
		const readOpenCodeMessages = (
			sessionId: string,
			instanceId?: string,
			signal?: AbortSignal,
			directory?: string,
		) =>
			Effect.gen(function* () {
				const client = yield* sessionClient(sessionId, instanceId, directory);
				if (Option.isNone(client))
					return yield* Effect.fail(
						new Error(`Session ${sessionId} has no OpenCode instance`),
					);
				return yield* Effect.tryPromise({
					try: () =>
						client.value.session.messages(
							sessionId,
							signal === undefined ? undefined : { signal },
						),
					catch: (cause) => cause,
				});
			}).pipe(Effect.scoped);
		const pickContext = yield* Effect.context<
			AccountDirectory | ConfigTag | LoggerTag | OrchestrationEngineTag
		>();
		const opencodeRuntimeIngress = yield* makeEffectOpenCodeRuntimeIngress(
			log.child("opencode-runtime-ingress"),
			readOpenCodeMessages,
			(sessionId, messageId, compaction) =>
				orchestration.openCodeInstance.inputIdForUserEcho(
					sessionId,
					messageId,
					compaction,
				),
			(instanceId, parentId) =>
				Effect.gen(function* () {
					const parent = parentId
						? yield* readQueryEffect.getSession(parentId)
						: undefined;
					return yield* loadServerSessionPick("opencode", instanceId, parent, {
						startIfStopped: false,
					});
				}).pipe(
					Effect.provide(pickContext),
					Effect.catch((cause) =>
						Effect.sync(() => {
							log.warn("Could not resolve native OpenCode session pick", {
								instanceId,
								parentId,
								cause: formatErrorDetail(cause),
							});
							return undefined;
						}),
					),
				),
		);
		const accounts = yield* (yield* AccountDirectory).snapshot;
		const recoveryCommands = yield* runningRunnerCommands(
			sql,
			"opencode",
			(id) => accounts.accounts.find((account) => account.id === id)?.driver,
		);
		const readOpenCodeStatuses = (instanceId: string, sessionId: string) =>
			Effect.gen(function* () {
				const { directory, hasWorkspace } = yield* workspace.withLaunch(
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
		const recoverObservedRuns = opencodeRuntimeIngress.recoverObservedRuns(
			readOpenCodeStatuses,
			[
				MANAGED_OPENCODE_ACCOUNT_ID,
				...accounts.accounts
					.filter((account) => account.driver === "opencode")
					.map((account) => account.id),
			],
		);
		const recoverOpenCodeCommands = opencodeRuntimeIngress
			.recoverCommands(
				recoveryCommands,
				readOpenCodeStatuses,
				yield* makeFailTurn,
			)
			.pipe(Effect.andThen(recoverObservedRuns));

		layers.setHistoryIngress(opencodeRuntimeIngress);
		if (config.signal?.aborted) {
			return yield* Effect.fail(
				new RelayCreationAbortedError({ slug: config.slug }),
			);
		}
		return {
			sql,
			persistenceProject,
			activity,
			projectSettingsContext,
			translator,
			api,
			wsHandler,
			rpcWsHandler,
			statusSnapshot,
			sseStream,
			sessionManagerService,
			runFork,
			onBackgroundWorkChanged,
			sessionId,
			orchestration,
			statusPoller,
			recoverOpenCodeCommands,
			pollerManager,
			opencodeRuntimeIngress,
			readOpenCodeMessages,
		};
	});
}

type AcquiredStartupServices = Effect.Success<
	ReturnType<typeof acquireStartupServices>
>;

function wireStartupCallbacks(services: AcquiredStartupServices) {
	return Effect.gen(function* () {
		yield* services.statusPoller.on("changed", () => {
			services.runFork(services.recoverOpenCodeCommands);
		});
	});
}

function startMonitoringAndPollers(
	inputs: StartupInputs,
	services: AcquiredStartupServices,
) {
	const { config, statusLog, sseLog, pipelineLog, pollerLog, layers } = inputs;
	const { monitoringStateAccess } = layers;
	const { wsHandler, pollerManager, sseStream } = services;
	return Effect.gen(function* () {
		const monitoring = yield* wireMonitoringEffect({
			// Poller seeding is background work: it must not restart OpenCode.
			readMessages: services.readOpenCodeMessages,
			wsHandler,
			pollerManager,
			sseStream,
			config: {
				...(config.configDir != null && { configDir: config.configDir }),
				...(config.pollerGatingConfig != null && {
					pollerGatingConfig: config.pollerGatingConfig,
				}),
				...(config.pushManager != null && {
					pushManager: config.pushManager,
				}),
				slug: config.slug,
			},
			statusLog,
			sseLog,
			pipelineLog,
			state: monitoringStateAccess,
		});
		yield* wirePollersEffect({
			pollerManager,
			sseStream,
			wsHandler,
			pipelineDeps: monitoring.pipelineDeps,
			sseTracker: monitoringStateAccess.sseTracker,
			config: {
				...(config.pushManager != null && {
					pushManager: config.pushManager,
				}),
				slug: config.slug,
			},
			pollerLog,
			onDoneProcessed: monitoring.recordDoneDelivered,
		}).pipe(
			Effect.onExit((exit) =>
				Exit.isFailure(exit)
					? Effect.sync(monitoring.stopMonitoring)
					: Effect.void,
			),
		);
		return monitoring;
	});
}

type StartupMonitoring = Effect.Success<
	ReturnType<typeof startMonitoringAndPollers>
>;

function startSseConsumers(
	inputs: StartupInputs,
	services: AcquiredStartupServices,
	monitoring: StartupMonitoring,
) {
	const { config, sseLog, pipelineLog } = inputs;
	const {
		translator,
		wsHandler,
		statusPoller,
		opencodeRuntimeIngress,
		sseStream,
	} = services;
	return Effect.gen(function* () {
		const terminal = yield* OpenCodeTerminalServiceTag;
		const workspace = yield* SessionWorkspaceTag;
		const instances = yield* OpenCodeInstancesTag;
		const replyPermission =
			(instanceId: string) =>
			(sessionId: string, permissionId: string, response: "once") =>
				Effect.gen(function* () {
					const directory = yield* workspace.get(sessionId);
					const client = yield* instances.use(instanceId, directory);
					yield* Effect.tryPromise(() =>
						client.permission.reply(sessionId, permissionId, response),
					);
				}).pipe(Effect.scoped);
		const sseConsumerDeps = {
			translator,
			wsHandler,
			...(config.pushManager != null && {
				pushManager: config.pushManager,
			}),
			log: sseLog,
			pipelineLog,
			replyPermission: replyPermission(MANAGED_OPENCODE_ACCOUNT_ID),
			statusPoller,
			slug: config.slug,
			providerInstanceId: MANAGED_OPENCODE_ACCOUNT_ID,
			onDoneProcessed: monitoring.recordDoneDelivered,
			onPtysChanged: terminal.onOpenCodePtysChanged,
			opencodeRuntimeIngress,
		};
		yield* wireSSEConsumerEffect(sseConsumerDeps, sseStream);
		// Other OpenCode instances delivering events for this project join the
		// SAME streaming and durable completion pipeline via wireSSEConsumerEffect.
		// Pending prompt and
		// status recovery runs per instance stream in OpenCode Instances, and
		// the ingress translator reset stays owned by the selected instance's
		// reconnects so another instance's (re)connect cannot reset in-flight
		// default-session ingestion state.
		yield* sseStream.wireInstanceStreams((stream, instanceId) =>
			Effect.gen(function* () {
				yield* wireSSEConsumerEffect(
					{
						...sseConsumerDeps,
						providerInstanceId: instanceId,
						replyPermission: replyPermission(instanceId),
					},
					stream,
				);
			}),
		);
		yield* sseStream.connectEffect();
	});
}

export async function startProjectRelay(inputs: StartupInputs) {
	const { config, log, layers } = inputs;
	const { relayManagedRuntime } = layers;
	try {
		if (config.signal?.aborted) {
			throw new RelayCreationAbortedError({ slug: config.slug });
		}
		// External startup boundary for createProjectRelay()'s Promise API.
		return await relayManagedRuntime.runPromise(
			Effect.gen(function* () {
				const services = yield* acquireStartupServices(inputs);
				yield* (yield* EventRetentionSchedulerTag).kick;
				yield* wireStartupCallbacks(services);
				const monitoring = yield* startMonitoringAndPollers(inputs, services);
				const { stopMonitoring } = monitoring;
				yield* Effect.gen(function* () {
					yield* startSseConsumers(inputs, services, monitoring);
					yield* services.recoverOpenCodeCommands;
					// An unavailable provider may later be idle without ever producing
					// a status transition. Retry only the frozen startup claims.
					yield* Effect.forkIn(
						services.recoverOpenCodeCommands.pipe(
							Effect.repeat(Schedule.spaced("1 second")),
						),
						relayManagedRuntime.scope,
					);
					yield* (yield* SessionSetupTag).recover;
					const makeInteractions = yield* makeEventSinkFactory;
					// Recovery must settle crashed turns before an outbox claim can
					// resend them. The runtime scope stops this fiber before providers
					// and persistence are released, including failed startup.
					yield* Effect.forkIn(
						services.orchestration.drainSideEffects(makeInteractions).pipe(
							Effect.catchCause((cause) =>
								Failure.isInterruptedOnly(cause)
									? Effect.interrupt
									: Effect.logError(
											"Provider command outbox drain failed",
											cause,
										),
							),
							// A sweep may wait for whole turns. Keep scanning newly due
							// sessions while the reactor holds each active session's lease.
							Effect.forkIn(relayManagedRuntime.scope),
							Effect.repeat(Schedule.spaced(ENV.outboxDrainIntervalMs)),
						),
						relayManagedRuntime.scope,
					);
					// Providers are registered and recovered; queued inputs may drain.
					yield* (yield* SessionInboxTag).start;
				}).pipe(
					Effect.onExit((exit) =>
						Exit.isFailure(exit) ? Effect.sync(stopMonitoring) : Effect.void,
					),
				);
				const {
					sql,
					sessionManagerService,
					api,
					wsHandler,
					rpcWsHandler,
					sseStream,
					sessionId,
					orchestration,
					statusSnapshot,
					translator,
				} = services;
				return {
					sql,
					persistenceProject: services.persistenceProject,
					activity: services.activity,
					projectSettingsContext: services.projectSettingsContext,
					sessionManagerService,
					// The sidebar and open family feeds follow the stamped row.
					announceBackgroundWork: services.onBackgroundWorkChanged,
					api,
					wsHandler,
					rpcWsHandler,
					sseStream,
					sessionId,
					orchestration,
					statusSnapshot,
					translator,
					opencodeRuntimeIngress: services.opencodeRuntimeIngress,
					stopMonitoring,
				};
			}),
			{ signal: config.signal },
		);
	} catch (err) {
		await relayManagedRuntime.dispose();
		throw err;
	}
}
