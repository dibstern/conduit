import { SqlClient } from "@effect/sql";
import { Cause, Effect, Exit, Runtime } from "effect";
import { defaultInstanceIdForDriver } from "../contracts/provider-instance.js";
import { OpenCodeInstancesTag } from "../domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
import { backgroundOpenCodeAPI } from "../domain/relay/Layers/relay-core-layers.js";
import { makeEffectOpenCodeRuntimeIngress } from "../domain/relay/Services/opencode-runtime-ingress-service.js";
import type { ProjectSettingsTag } from "../domain/relay/Services/project-settings.js";
import { RelayStatusSnapshotTag } from "../domain/relay/Services/relay-status-snapshot.js";
import { resolveOrphanedClaudePermissions } from "../domain/relay/Services/resolve-orphaned-claude-permissions.js";
import { restoreClaudeQuestionsFromStore } from "../domain/relay/Services/restore-claude-questions.js";
import {
	ConfigTag,
	PollerManagerTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { announceBackgroundWork } from "../domain/relay/Services/session-attention.js";
import { restoreSessionPermissionModes } from "../domain/relay/Services/session-manager-permission-mode.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import { restoreSessionModelSettings } from "../domain/relay/Services/session-model-settings.js";
import {
	type OverridesStateTag,
	setContextWindow,
	setDefaultModel,
	setDefaultPermissionMode,
	setDefaultVariant,
	setModel,
	setVariant,
} from "../domain/relay/Services/session-overrides-state.js";
import {
	PollerPubSubTag,
	PollerStateTag,
} from "../domain/relay/Services/session-status-poller.js";
import { SSEStreamTag } from "../domain/relay/Services/sse-stream-service.js";
import { formatErrorDetail } from "../errors.js";
import type { Logger } from "../logger.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import { latestTurnSettingsQuery } from "../persistence/startup-restore-queries.js";
import { ClaudeProviderInstance } from "../provider/claude/claude-provider-instance.js";
import { getOrchestrationLayer } from "../provider/orchestration-wiring.js";
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
import { wireRelayWebSocketCallbacksEffect } from "./websocket-callback-wiring.js";

interface StartupInputs {
	config: ProjectRelayConfig;
	log: Logger;
	wsLog: Logger;
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
		// Relay startup never contacts OpenCode, so the default model comes from
		// relay settings only. Before initialize: it picks the first session's
		// provider.
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
		const instance = yield* orchestration.registry.getInstanceEffect("claude");
		if (instance instanceof ClaudeProviderInstance)
			yield* instance.recoverEffect();
		const restoredPermissionModes = yield* restoreSessionPermissionModes();
		if (restoredPermissionModes > 0) {
			yield* Effect.sync(() =>
				log.info(
					`Restored permission modes for ${restoredPermissionModes} session(s)`,
				),
			);
		}
		// Model choices live in memory, so after a restart a Claude session would
		// fall back to the global default (possibly another harness) for both the
		// picker and its next turn. Its latest turn is the durable record.
		yield* sql<{ session_id: string; requested_model: string }>`
			SELECT t.session_id, t.requested_model, MAX(t.requested_at)
			FROM turns t JOIN sessions s ON s.id = t.session_id
			WHERE s.provider = 'claude' AND t.requested_model IS NOT NULL
			GROUP BY t.session_id`.pipe(
			Effect.flatMap((rows) =>
				Effect.forEach(rows, (row) =>
					setModel(row.session_id, {
						providerID: "claude",
						modelID: row.requested_model,
					}),
				),
			),
			Effect.catchAll((error) =>
				Effect.sync(() =>
					log.warn(
						`Could not restore session models: ${formatErrorDetail(error)}`,
					),
				),
			),
		);
		// Effort and context window are in-memory too; the latest sent turn's
		// command payload is their durable record. A choice changed after that
		// turn was never sent, so it is not restored.
		// The driver is synchronous and payloads run to megabytes, so the query
		// reads the latest turn per session from receipts and both settings from
		// an index, never the payloads themselves.
		yield* sql
			.unsafe<{
				session_id: string;
				variant: string | null;
				context_window: string | null;
			}>(latestTurnSettingsQuery)
			.pipe(
				Effect.flatMap((rows) =>
					Effect.forEach(rows, (row) =>
						Effect.all([
							row.variant
								? setVariant(row.session_id, row.variant)
								: Effect.void,
							row.context_window
								? setContextWindow(row.session_id, row.context_window)
								: Effect.void,
						]),
					),
				),
				Effect.catchAll((error) =>
					Effect.sync(() =>
						log.warn(
							`Could not restore session effort and context window: ${formatErrorDetail(error)}`,
						),
					),
				),
			);
		// Settings recorded on the session row postdate the last turn that
		// carried them, so they win over the turns-table restore above.
		yield* restoreSessionModelSettings().pipe(
			Effect.catchAll((error) =>
				Effect.sync(() =>
					log.warn(
						`Could not restore session model settings: ${formatErrorDetail(error)}`,
					),
				),
			),
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
		const sessionsResult = yield* Effect.either(readQueryEffect.listSessions());
		if (sessionsResult._tag === "Right" && sessionsResult.right.length > 0)
			yield* statusSnapshot.setSessionCount(sessionsResult.right.length);
		if (sessionsResult._tag === "Left")
			yield* Effect.sync(() =>
				log.warn(
					`Session list unavailable at startup: ${formatErrorDetail(sessionsResult.left)}`,
				),
			);
		const sessions =
			sessionsResult._tag === "Right" ? sessionsResult.right : [];
		const sessionId =
			(sessions.find((session) => !session.parent_id) ?? sessions[0])?.id ?? "";
		yield* PollerStateTag;
		yield* PollerPubSubTag;
		const statusPoller = yield* StatusPollerTag;
		const pollerManager = yield* PollerManagerTag;
		const instances = yield* OpenCodeInstancesTag;
		const opencodeRuntimeIngress = yield* makeEffectOpenCodeRuntimeIngress(
			log.child("opencode-runtime-ingress"),
			(sessionId, instanceId, signal) =>
				Effect.gen(function* () {
					const client = yield* instances.use(instanceId);
					return yield* Effect.tryPromise(() =>
						client.session.messages(sessionId, { signal }),
					);
				}).pipe(Effect.scoped),
		);
		layers.setHistoryIngress(opencodeRuntimeIngress);
		if (config.signal?.aborted) {
			return yield* Effect.fail(
				new RelayCreationAbortedError({ slug: config.slug }),
			);
		}
		return {
			sql,
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

function wireStartupCallbacks(
	inputs: StartupInputs,
	services: AcquiredStartupServices,
) {
	const { wsLog } = inputs;
	const { orchestration, sseStream, wsHandler } = services;
	return Effect.gen(function* () {
		yield* Effect.sync(() => {
			orchestration.wireSSEToInstance((event, handler) => {
				sseStream.on(event, handler);
			});
		});
		yield* wireRelayWebSocketCallbacksEffect({
			wsHandler,
			log: wsLog,
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
			providerInstanceId: defaultInstanceIdForDriver("opencode"),
			onDoneProcessed: monitoring.recordDoneDelivered,
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
				yield* wireStartupCallbacks(inputs, services);
				const monitoring = yield* startMonitoringAndPollers(inputs, services);
				const { stopMonitoring } = monitoring;
				yield* startSseConsumers(inputs, services, monitoring).pipe(
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
