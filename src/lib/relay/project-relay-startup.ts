import { SqlClient } from "@effect/sql";
import { Cause, Effect, Exit, Runtime } from "effect";
import { defaultInstanceIdForDriver } from "../contracts/provider-instance.js";
import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
import { OpenCodeInstanceClientsTag } from "../domain/relay/Services/opencode-instance-clients.js";
import { makeEffectOpenCodeRuntimeIngress } from "../domain/relay/Services/opencode-runtime-ingress-service.js";
import { RelayCommandGateTag } from "../domain/relay/Services/relay-command-gate.js";
import { RelayStatusSnapshotTag } from "../domain/relay/Services/relay-status-snapshot.js";
import { resolveOrphanedClaudePermissions } from "../domain/relay/Services/resolve-orphaned-claude-permissions.js";
import { restoreClaudeQuestionsFromStore } from "../domain/relay/Services/restore-claude-questions.js";
import {
	PollerManagerTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { announceBackgroundWork } from "../domain/relay/Services/session-attention.js";
import { restoreSessionPermissionModes } from "../domain/relay/Services/session-manager-permission-mode.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import {
	setDefaultModel,
	setDefaultPermissionMode,
	setDefaultVariant,
} from "../domain/relay/Services/session-overrides-state.js";
import {
	PollerPubSubTag,
	PollerStateTag,
} from "../domain/relay/Services/session-status-poller.js";
import { SSEStreamTag } from "../domain/relay/Services/sse-stream-service.js";
import { formatErrorDetail } from "../errors.js";
import type { Logger } from "../logger.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
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
		const opencodePathCheck = yield* Effect.either(
			Effect.tryPromise({
				try: () => api.app.path(),
				catch: (cause) => cause,
			}),
		);
		const opencodeAvailable = opencodePathCheck._tag === "Right";
		if (opencodeAvailable) {
			yield* Effect.sync(() =>
				log.info(`✓ OpenCode is reachable at ${config.opencodeUrl}`),
			);
		} else {
			yield* Effect.sync(() =>
				log.warn(
					`OpenCode is unavailable at ${config.opencodeUrl}: ${
						opencodePathCheck.left instanceof Error
							? opencodePathCheck.left.message
							: String(opencodePathCheck.left)
					}; continuing so other providers can load`,
				),
			);
		}

		let defaultModel = initialDefaultModel;
		if (!defaultModel) {
			const configResult = yield* Effect.either(
				Effect.tryPromise(() => api.config.get()),
			);
			if (configResult._tag === "Right") {
				const configModel =
					typeof configResult.right?.["model"] === "string"
						? configResult.right["model"]
						: "";
				if (configModel) {
					const slashIdx = configModel.indexOf("/");
					const provider = slashIdx > 0 ? configModel.slice(0, slashIdx) : "";
					const modelId =
						slashIdx > 0 ? configModel.slice(slashIdx + 1) : configModel;
					if (provider && modelId) {
						defaultModel = {
							providerID: provider,
							modelID: modelId,
						};
						yield* Effect.sync(() =>
							log.info(`✓ Default model from project config: ${configModel}`),
						);
					}
				}
			} else {
				yield* Effect.sync(() =>
					log.warn(
						`Config API unavailable: ${formatErrorDetail(configResult.left)}`,
					),
				);
			}
		}

		// Before initialize: the default model picks the first session's provider.
		if (defaultModel) {
			yield* setDefaultModel(defaultModel);
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
		const sessionId = opencodeAvailable
			? yield* sessionManagerService.initialize(config.sessionTitle)
			: yield* Effect.gen(function* () {
					const readQueryEffect = yield* ReadQueryEffectTag;
					const sessionsResult = yield* Effect.either(
						readQueryEffect.listSessions(),
					);
					if (
						sessionsResult._tag === "Right" &&
						sessionsResult.right.length > 0
					) {
						yield* statusSnapshot.setSessionCount(sessionsResult.right.length);
						const topLevel = sessionsResult.right.find(
							(session) => !session.parent_id,
						);
						return (topLevel ?? sessionsResult.right[0])?.id ?? "";
					}
					if (sessionsResult._tag === "Left") {
						yield* Effect.sync(() =>
							log.warn(
								`Session list unavailable while OpenCode is down: ${formatErrorDetail(sessionsResult.left)}`,
							),
						);
					}
					return "";
				});
		yield* PollerStateTag;
		yield* PollerPubSubTag;
		const statusPoller = yield* StatusPollerTag;
		const pollerManager = yield* PollerManagerTag;
		const instanceClients = yield* OpenCodeInstanceClientsTag;
		const opencodeRuntimeIngress = yield* makeEffectOpenCodeRuntimeIngress(
			log.child("opencode-runtime-ingress"),
			(sessionId, instanceId, signal) =>
				Effect.gen(function* () {
					const client = (yield* instanceClients.clientFor(instanceId)) ?? api;
					return yield* Effect.tryPromise(() =>
						client.session.messages(sessionId, { signal }),
					);
				}),
		);
		layers.setHistoryIngress(opencodeRuntimeIngress);
		if (config.signal?.aborted) {
			return yield* Effect.fail(
				new RelayCreationAbortedError({ slug: config.slug }),
			);
		}
		return {
			sql,
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
			opencodeAvailable,
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
	const { config, wsLog } = inputs;
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
			clientInitOptions: {
				...(config.getInstances != null && {
					getInstances: config.getInstances,
				}),
				...(config.getCachedUpdate != null && {
					getCachedUpdate: config.getCachedUpdate,
				}),
			},
		});
	});
}

function startMonitoringAndPollers(
	inputs: StartupInputs,
	services: AcquiredStartupServices,
) {
	if (!services.opencodeAvailable) return Effect.succeed(undefined);
	const { config, statusLog, sseLog, pipelineLog, pollerLog, layers } = inputs;
	const { monitoringStateAccess } = layers;
	const { api, wsHandler, pollerManager, sseStream } = services;
	return Effect.gen(function* () {
		const monitoring = yield* wireMonitoringEffect({
			client: api,
			wsHandler,
			pollerManager,
			sseStream,
			config: {
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

type StartupMonitoring = Exclude<
	Effect.Effect.Success<ReturnType<typeof startMonitoringAndPollers>>,
	undefined
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
			getSessionStatuses: () => statusPoller.getCurrentStatuses(),
			listPendingQuestions: () => api.question.list(),
			listPendingPermissions: () => api.permission.list(),
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
		yield* sseStream.connectEffect();
		// Named OpenCode instances: lazily created
		// per-instance SSE streams join the SAME pipeline — turn
		// completion via wireSSEToInstance, streaming/persistence via
		// wireSSEConsumerEffect. Pending permission/question recovery
		// lists stay on the default api (accepted degradation), and the
		// ingress translator reset stays owned by the default stream's
		// reconnects so a named stream's (re)connect cannot reset
		// in-flight default-session ingestion state.
		const instanceClients = yield* OpenCodeInstanceClientsTag;
		yield* instanceClients.registerStreamWirer((stream, instanceId) =>
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
				const stopMonitoring = monitoring?.stopMonitoring ?? (() => {});
				yield* Effect.gen(function* () {
					if (monitoring)
						yield* startSseConsumers(inputs, services, monitoring);
					const gate = yield* RelayCommandGateTag;
					yield* gate.markReady();
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
					sessionManagerService,
					// The sidebar follows the stamped row; open session views follow
					// their family push.
					announceBackgroundWork: (changedSessionId: string) => {
						runFork(
							announceBackgroundWork(changedSessionId).pipe(
								Effect.andThen(sessionManagerService.pushViewerFamilies()),
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
