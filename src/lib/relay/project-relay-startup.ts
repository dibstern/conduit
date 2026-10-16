import { SqlClient } from "@effect/sql";
import { Cause, Effect, Exit, Option, Runtime } from "effect";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../contracts/provider-instance.js";
import type { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../domain/daemon/Services/opencode-instances-service.js";
import { SessionActivityTag } from "../domain/daemon/Services/session-activity.js";
import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
import { backgroundOpenCodeAPI } from "../domain/relay/Layers/relay-core-layers.js";
import { makeEffectOpenCodeRuntimeIngress } from "../domain/relay/Services/opencode-runtime-ingress-service.js";
import type { ProjectSettingsTag } from "../domain/relay/Services/project-settings.js";
import { RelayStatusSnapshotTag } from "../domain/relay/Services/relay-status-snapshot.js";
import { resolveOrphanedClaudePermissions } from "../domain/relay/Services/resolve-orphaned-claude-permissions.js";
import { restoreClaudeQuestionsFromStore } from "../domain/relay/Services/restore-claude-questions.js";
import {
	ConfigTag,
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
import { SSEStreamTag } from "../domain/relay/Services/sse-stream-service.js";
import { OpenCodeTerminalServiceTag } from "../domain/relay/Services/terminal-service.js";
import { formatErrorDetail } from "../errors.js";
import type { Logger } from "../logger.js";
import { ProjectionRunnerEffectTag } from "../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import { getOrchestrationLayer } from "../provider/orchestration-wiring.js";
import { RunnerProviderInstance } from "../provider/runner/runner-provider-instance.js";
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
		const activity = yield* SessionActivityTag;
		const projectSettingsContext = yield* Effect.context<
			ProjectSettingsTag | OverridesStateTag | ConfigTag
		>();
		const api = yield* OpenCodeAPITag;
		const translator = yield* TranslatorTag;
		const wsHandler = yield* WebSocketHandlerTag;
		const rpcWsHandler = yield* makeWsRpcWebSocketHandler({
			context: Effect.suspend(() =>
				Effect.map(relayManagedRuntime.runtimeEffect, (value) => value.context),
			),
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
			Effect.catchAll((error) =>
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
			Effect.catchAll((error) =>
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
			Effect.catchAll((error) =>
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
		const runFork = Runtime.runFork(
			yield* Effect.runtime<
				| SessionManagerServiceTag
				| Effect.Effect.Context<ReturnType<typeof announceBackgroundWork>>
			>(),
		);
		// Read-model only: creating a first session could call OpenCode, so attach
		// creates it instead (getDefaultSessionId).
		const readQueryEffect = yield* ReadQueryEffectTag;
		const sessionsResult = yield* Effect.either(
			Effect.all({
				count: sql<{
					count: number;
				}>`SELECT COUNT(*) AS count FROM sessions`.pipe(
					Effect.map((rows) => rows[0]?.count ?? 0),
				),
				sessionId: sql<{ id: string | null }>`SELECT COALESCE(
					(SELECT id FROM sessions WHERE parent_id IS NULL OR parent_id = ''
						ORDER BY updated_at DESC, id DESC LIMIT 1),
					(SELECT id FROM sessions ORDER BY updated_at DESC, id DESC LIMIT 1)
				) AS id`.pipe(Effect.map((rows) => rows[0]?.id ?? undefined)),
			}),
		);
		if (sessionsResult._tag === "Right" && sessionsResult.right.count > 0)
			yield* statusSnapshot.setSessionCount(sessionsResult.right.count);
		if (sessionsResult._tag === "Left")
			yield* Effect.sync(() =>
				log.warn(
					`Session list unavailable at startup: ${formatErrorDetail(sessionsResult.left)}`,
				),
			);
		const sessionId =
			(sessionsResult._tag === "Right"
				? sessionsResult.right.sessionId
				: undefined) ?? "";
		yield* PollerStateTag;
		yield* PollerPubSubTag;
		const statusPoller = yield* StatusPollerTag;
		const pollerManager = yield* PollerManagerTag;
		const instances = yield* OpenCodeInstancesTag;
		const pickContext = yield* Effect.context<
			AccountDirectory | ConfigTag | LoggerTag | OrchestrationEngineTag
		>();
		const opencodeRuntimeIngress = yield* makeEffectOpenCodeRuntimeIngress(
			log.child("opencode-runtime-ingress"),
			(sessionId, instanceId, signal) =>
				Effect.gen(function* () {
					const client = yield* instances.ifRunning(instanceId);
					if (Option.isNone(client)) {
						// Empty history would incorrectly mark the backfill complete.
						return yield* Effect.fail(
							new Error(`OpenCode instance "${instanceId}" is not running`),
						);
					}
					return yield* Effect.tryPromise(() =>
						client.value.session.messages(sessionId, { signal }),
					);
				}).pipe(Effect.scoped),
			(sessionId, messageId) =>
				orchestration.openCodeInstance.inputIdForUserEcho(sessionId, messageId),
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
					Effect.catchAll((cause) =>
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
		layers.setHistoryIngress(opencodeRuntimeIngress);
		if (config.signal?.aborted) {
			return yield* Effect.fail(
				new RelayCreationAbortedError({ slug: config.slug }),
			);
		}
		return {
			sql,
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
			sessionId,
			orchestration,
			statusPoller,
			pollerManager,
			opencodeRuntimeIngress,
		};
	});
}

type AcquiredStartupServices = Effect.Effect.Success<
	ReturnType<typeof acquireStartupServices>
>;

function wireStartupCallbacks(services: AcquiredStartupServices) {
	const { orchestration, sseStream } = services;
	return Effect.gen(function* () {
		yield* Effect.sync(() => {
			orchestration.wireSSEToInstance((event, handler) => {
				sseStream.on(event, handler);
			});
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
			client: yield* backgroundOpenCodeAPI.pipe(
				Effect.provideService(ConfigTag, config),
			),
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

type StartupMonitoring = Effect.Effect.Success<
	ReturnType<typeof startMonitoringAndPollers>
>;

function startSseConsumers(
	inputs: StartupInputs,
	services: AcquiredStartupServices,
	monitoring: StartupMonitoring,
) {
	const { config, sseLog, pipelineLog } = inputs;
	const {
		api,
		translator,
		wsHandler,
		statusPoller,
		opencodeRuntimeIngress,
		sseStream,
		orchestration,
	} = services;
	return Effect.gen(function* () {
		const terminal = yield* OpenCodeTerminalServiceTag;
		const sseConsumerDeps = {
			translator,
			wsHandler,
			...(config.pushManager != null && {
				pushManager: config.pushManager,
			}),
			log: sseLog,
			pipelineLog,
			replyPermission: (
				sessionId: string,
				permissionId: string,
				response: "once",
			) => api.permission.reply(sessionId, permissionId, response),
			statusPoller,
			slug: config.slug,
			providerInstanceId: MANAGED_OPENCODE_ACCOUNT_ID,
			onDoneProcessed: monitoring.recordDoneDelivered,
			onPtysChanged: terminal.onOpenCodePtysChanged,
			opencodeRuntimeIngress,
		};
		yield* wireSSEConsumerEffect(sseConsumerDeps, sseStream);
		// Other OpenCode instances delivering events for this project join the
		// SAME pipeline — turn completion via wireSSEToInstance,
		// streaming/persistence via wireSSEConsumerEffect. Pending prompt and
		// status recovery runs per instance stream in OpenCode Instances, and
		// the ingress translator reset stays owned by the selected instance's
		// reconnects so another instance's (re)connect cannot reset in-flight
		// default-session ingestion state.
		yield* sseStream.wireInstanceStreams((stream, instanceId) =>
			Effect.gen(function* () {
				yield* Effect.sync(() =>
					orchestration.wireSSEToInstance((event, handler) => {
						stream.on(event, handler);
					}),
				);
				yield* wireSSEConsumerEffect(
					{
						...sseConsumerDeps,
						providerInstanceId: instanceId,
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
				yield* wireStartupCallbacks(services);
				const monitoring = yield* startMonitoringAndPollers(inputs, services);
				const { stopMonitoring } = monitoring;
				yield* Effect.gen(function* () {
					yield* startSseConsumers(inputs, services, monitoring);
					yield* (yield* SessionSetupTag).recover;
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
					runFork,
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
					activity: services.activity,
					projectSettingsContext: services.projectSettingsContext,
					sessionManagerService,
					// The sidebar and open family feeds follow the stamped row.
					announceBackgroundWork: (changedSessionId: string) => {
						runFork(
							announceBackgroundWork(changedSessionId).pipe(
								Effect.catchAllCause((cause) =>
									Effect.sync(() =>
										log.warn(
											`Failed to announce background work: ${Cause.pretty(cause)}`,
										),
									),
								),
							),
						);
					},
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
