// Monitoring Wiring (G2)
// Constructs PipelineDeps, EffectDeps, monitoring reducer state, SSE tracker,
// poller gating config, and wires the statusPoller "changed" handler.
//
// Extracted from createProjectRelay() — all closure captures are explicit params.

import { SqlClient } from "@effect/sql";
import { Cause, Effect, Runtime } from "effect";
import type { Alert } from "../contracts/ws-rpc.js";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../daemon/config-persistence.js";
import {
	type AlertsTag,
	publishAlert,
} from "../domain/relay/Services/alerts.js";
import { OPENCODE_PROVIDER_ID } from "../domain/relay/Services/provider-turn-dispatch.js";
import { StatusPollerTag } from "../domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import {
	clearProcessingTimeout,
	type OverridesStateTag,
} from "../domain/relay/Services/session-overrides-state.js";
import type { Message } from "../instance/sdk-types.js";
import type { Logger } from "../logger.js";
import type { PushNotificationSender } from "../server/push.js";
import type { RelayMessage } from "../shared-types.js";
import { type EffectDeps, executeEffects } from "./effect-executor.js";
import {
	applyPipelineResult,
	applyPipelineResultEffect,
	type PipelineDeps,
	type ProcessingTimeoutsPort,
	processEvent,
} from "./event-pipeline.js";
import {
	assembleContext,
	evaluateAll,
	initialMonitoringState,
	selectMonitoringCandidates,
} from "./monitoring-reducer.js";
import type {
	MonitoringEffect,
	MonitoringState,
	PollerGatingConfig,
	SessionEvalContext,
} from "./monitoring-types.js";
import { DEFAULT_POLLER_GATING_CONFIG } from "./monitoring-types.js";
import { resolveNotifications } from "./notification-policy.js";
import { createSessionSSETracker } from "./session-sse-tracker.js";
import { sendPushForEvent, sendPushForEventEffect } from "./sse-wiring.js";

/** Structural interface for the message poller manager's capabilities needed by monitoring wiring. */
interface PollerManagerLike {
	startPolling(sessionId: string, seedMessages?: Message[]): void;
	stopPolling(sessionId: string): void;
}

interface OpenCodeSessionReaderLike {
	session: {
		messages(sessionId: string): Promise<Message[]>;
	};
}

interface SSEConnectionHealthLike {
	isConnected(): boolean;
}

interface MonitoringWsHandlerLike {
	broadcast(msg: RelayMessage): void;
	sendToSession(sessionId: string, msg: RelayMessage): void;
	getClientsForSession(sessionId: string): string[];
	broadcastPerSessionEvent(sessionId: string, msg: RelayMessage): void;
}

/** Narrowed Effect session service capabilities needed by monitoring wiring. */
interface SessionServiceLike {
	pushViewerFamilies(): Promise<void>;
	getSessionParentMap(options?: {
		readonly activityOnly?: boolean;
	}): Map<string, string>;
}

interface LegacyStatusPollerPort {
	on(
		event: "changed",
		callback: (
			statuses: Record<
				string,
				import("../instance/sdk-types.js").SessionStatus
			>,
			statusesChanged: boolean,
		) => void | Promise<void>,
	): void;
	start(): void;
	stop?(): void;
	drain?(): Promise<void>;
	getCurrentStatuses?(): Record<
		string,
		import("../instance/sdk-types.js").SessionStatus
	>;
	getSessionProviders?(): ReadonlyMap<string, string>;
	isProcessing?(sessionId: string): boolean;
	markMessageActivity?(sessionId: string): void;
	clearMessageActivity(sessionId: string): void;
	notifySSEIdle?(sessionId: string): void;
}

export interface MonitoringWiringDeps {
	client: OpenCodeSessionReaderLike;
	wsHandler: MonitoringWsHandlerLike;
	sessionService: SessionServiceLike;
	processingTimeouts: ProcessingTimeoutsPort;
	statusPoller: LegacyStatusPollerPort;
	pollerManager: PollerManagerLike;
	sseStream: SSEConnectionHealthLike;
	config: {
		configDir?: string;
		pollerGatingConfig?: Partial<PollerGatingConfig>;
		pushManager?: PushNotificationSender;
		slug: string;
	};
	statusLog: Logger;
	sseLog: Logger;
	pipelineLog: Logger;
	state?: MonitoringWiringStateAccess;
	/** Sync wiring only; the Effect wiring publishes to AlertsTag. */
	publishAlert: (alert: Alert) => void;
}

export interface MonitoringWiringStateAccess {
	sseTracker: ReturnType<typeof createSessionSSETracker>;
	getMonitoringState: () => MonitoringState;
	setMonitoringState: (state: MonitoringState) => void;
}

export interface MonitoringWiringResult {
	pipelineDeps: PipelineDeps;
	sseTracker: ReturnType<typeof createSessionSSETracker>;
	pollerGatingCfg: PollerGatingConfig;
	getMonitoringState: () => MonitoringState;
	setMonitoringState: (state: MonitoringState) => void;
	/** Stop accepting status-poller updates before relay shutdown drains sources. */
	stopMonitoring: () => void;
	/**
	 * Record that a "done" event was delivered via SSE or message poller.
	 * Prevents the status-poller's processAndApplyDone from synthesizing
	 * a duplicate "done" for the same busy→idle cycle.
	 */
	recordDoneDelivered: (sessionId: string) => void;
}

export type EffectMonitoringWiringDeps = Omit<
	MonitoringWiringDeps,
	"sessionService" | "processingTimeouts" | "statusPoller" | "publishAlert"
>;

export type EffectMonitoringWiringResult = Omit<
	MonitoringWiringResult,
	"pipelineDeps"
> & {
	pipelineDeps: Omit<PipelineDeps, "processingTimeouts">;
};

export function createMonitoringWiringState(): MonitoringWiringStateAccess {
	const sseTracker = createSessionSSETracker();
	let monitoringState: MonitoringState = initialMonitoringState();
	return {
		sseTracker,
		getMonitoringState: () => monitoringState,
		setMonitoringState: (state) => {
			monitoringState = state;
		},
	};
}

function providerStreamsLifecycle(
	daemonConfig: ReturnType<typeof loadDaemonConfig>,
	provider: string | undefined,
): boolean {
	const driver =
		provider === undefined
			? undefined
			: resolveProviderRoutingDriver(daemonConfig, provider);
	return driver !== undefined && driver !== OPENCODE_PROVIDER_ID;
}

const processAndApplyDoneEffect = (
	sessionId: string,
	isSubagent: boolean,
	busySince: number,
	doneDeliveredByPrimary: Set<string>,
	deps: EffectMonitoringWiringDeps,
	pipelineDeps: Omit<PipelineDeps, "processingTimeouts">,
) =>
	Effect.gen(function* () {
		const alreadyDelivered = doneDeliveredByPrimary.has(sessionId);
		if (alreadyDelivered) {
			doneDeliveredByPrimary.delete(sessionId);
			yield* Effect.sync(() =>
				deps.statusLog.info(
					`Skipping synthetic done for ${sessionId.slice(0, 12)} — already delivered by primary path`,
				),
			);
			return;
		}

		const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
		let originId: string | undefined;
		if (sql._tag === "Some") {
			originId = yield* Effect.gen(function* () {
				const [turn] = yield* sql.value<{
					assistant_message_id: string | null;
					requested_at: number;
				}>`
					SELECT assistant_message_id, requested_at FROM turns
					WHERE session_id = ${sessionId}
					ORDER BY requested_at DESC, rowid DESC LIMIT 1`;
				const [terminal] = yield* sql.value<{
					origin_id: string;
					message_id: string | null;
					created_at: number;
				}>`
					SELECT COALESCE(NULLIF(json_extract(data, '$.messageId'), ''), event_id) AS origin_id,
						json_extract(data, '$.messageId') AS message_id, created_at
					FROM events WHERE session_id = ${sessionId}
						AND type IN ('turn.completed', 'turn.error')
					ORDER BY sequence DESC LIMIT 1`;
				if (
					terminal &&
					(!turn ||
						(terminal.created_at >= turn.requested_at &&
							(!terminal.message_id ||
								terminal.message_id === turn.assistant_message_id)))
				)
					return terminal.origin_id;
				if (turn) {
					if (turn.assistant_message_id) return turn.assistant_message_id;
					const [message] = yield* sql.value<{ id: string }>`
						SELECT id FROM messages WHERE session_id = ${sessionId}
							AND role = 'assistant' AND created_at >= ${turn.requested_at}
						ORDER BY created_at DESC, rowid DESC LIMIT 1`;
					return message?.id;
				}
				return undefined;
			}).pipe(
				Effect.catchAllCause((cause) =>
					Effect.sync(() => {
						deps.statusLog.warn(
							`Failed to identify poller completion: ${Cause.pretty(cause)}`,
						);
						return undefined;
					}),
				),
			);
		}
		const doneMsg = {
			type: "done" as const,
			sessionId,
			code: 0,
			...(originId && {
				alertId: JSON.stringify([sessionId, originId, "done"]),
				// Usually the turn's assistant message. Sent after the next turn
				// started, it lets the browser tell this done is late.
				messageId: originId,
			}),
		};
		const doneViewers = deps.wsHandler.getClientsForSession(sessionId);
		const doneResult = processEvent(
			doneMsg,
			sessionId,
			doneViewers,
			"status-poller",
		);
		yield* applyPipelineResultEffect(doneResult, sessionId, pipelineDeps);

		const notification = resolveNotifications(
			doneMsg,
			doneResult.route,
			isSubagent,
			sessionId,
			JSON.stringify([sessionId, "poller", busySince, "done"]),
		);
		const pushManager = deps.config.pushManager;
		if (notification.sendPush && pushManager) {
			yield* sendPushForEventEffect(pushManager, doneMsg, deps.sseLog, {
				slug: deps.config.slug,
				sessionId,
			});
		}
		if (!originId && !isSubagent && sql._tag === "Some" && pushManager) {
			// The provider can know the completed assistant message before its
			// terminal event reaches this relay. Resolve that identity off the tick.
			yield* Effect.forkDaemon(
				Effect.tryPromise(() => deps.client.session.messages(sessionId)).pipe(
					Effect.flatMap((messages) => {
						const lastMessage = messages.at(-1);
						if (lastMessage?.role !== "assistant") return Effect.void;
						return sendPushForEventEffect(
							pushManager,
							{
								...doneMsg,
								alertId: JSON.stringify([sessionId, lastMessage.id, "done"]),
							},
							deps.sseLog,
							{ slug: deps.config.slug, sessionId },
						);
					}),
					Effect.catchAllCause((cause) =>
						Effect.sync(() =>
							deps.statusLog.warn(
								`Failed to identify provider completion: ${Cause.pretty(cause)}`,
							),
						),
					),
				),
			);
		}
		if (notification.alert) yield* publishAlert(notification.alert);
	});

const executeMonitoringEffectsEffect = (
	effects: readonly MonitoringEffect[],
	deps: EffectMonitoringWiringDeps,
	pipelineDeps: Omit<PipelineDeps, "processingTimeouts">,
	doneDeliveredByPrimary: Set<string>,
	monitoringActive: () => boolean,
	// False once a newer reduction replaced this session's phase: the newer
	// tick owns the session and this batch's effects for it are obsolete.
	isCurrent: (sessionId: string) => boolean,
	canStartPoller: (sessionId: string) => boolean,
) =>
	Effect.gen(function* () {
		for (const effect of effects) {
			if (!isCurrent(effect.sessionId)) continue;
			switch (effect.effect) {
				case "start-poller": {
					if (!monitoringActive() || !canStartPoller(effect.sessionId)) break;
					const sessionId = effect.sessionId;
					// Seed off the tick: a hung messages() call must not delay
					// the effects that follow it (other sessions' stops and dones).
					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							const messages = yield* Effect.tryPromise(() =>
								deps.client.session.messages(sessionId),
							).pipe(
								Effect.catchAll((err) =>
									Effect.sync(() => {
										deps.statusLog.warn(
											`Failed to seed poller for ${sessionId.slice(0, 12)}, will retry: ${err instanceof Error ? err.message : err}`,
										);
										return undefined;
									}),
								),
							);
							if (messages === undefined) return;
							yield* Effect.sync(() => {
								// Check and start without yielding to a newer reduction.
								if (monitoringActive() && isCurrent(sessionId)) {
									deps.pollerManager.startPolling(sessionId, messages);
								}
							});
						}),
					);
					break;
				}

				case "stop-poller":
					yield* Effect.sync(() =>
						deps.pollerManager.stopPolling(effect.sessionId),
					);
					yield* clearProcessingTimeout(effect.sessionId);
					break;

				case "notify-busy":
					yield* Effect.sync(() =>
						deps.wsHandler.sendToSession(effect.sessionId, {
							type: "status",
							sessionId: effect.sessionId,
							status: "processing",
						}),
					);
					break;

				case "clear-processing":
				case "notify-idle":
					if (effect.effect === "notify-idle") {
						yield* processAndApplyDoneEffect(
							effect.sessionId,
							effect.isSubagent,
							effect.busySince,
							doneDeliveredByPrimary,
							deps,
							pipelineDeps,
						);
					}
					yield* clearProcessingTimeout(effect.sessionId);
					break;

				default: {
					const _exhaustive: never = effect;
					yield* Effect.sync(() =>
						deps.statusLog.warn(
							`Unknown effect: ${JSON.stringify(_exhaustive)}`,
						),
					);
				}
			}
		}
	});

export function wireMonitoring(
	deps: MonitoringWiringDeps,
): MonitoringWiringResult {
	const {
		client,
		wsHandler,
		sessionService,
		processingTimeouts,
		statusPoller,
		pollerManager,
		sseStream,
		config,
		statusLog,
		sseLog,
		pipelineLog,
		state = createMonitoringWiringState(),
	} = deps;

	const { sseTracker, getMonitoringState, setMonitoringState } = state;
	let monitoringActive = true;
	let providerCoveredSessions: ReadonlySet<string> = new Set();
	const pollerGatingCfg: PollerGatingConfig = {
		...DEFAULT_POLLER_GATING_CONFIG,
		...config.pollerGatingConfig,
	};

	// Tracks sessions that received a "done" via SSE or message poller in the
	// current busy cycle. processAndApplyDone consumes (check + delete) entries
	// to avoid synthesizing a duplicate "done" when SSE already delivered one.
	const doneDeliveredByPrimary = new Set<string>();

	// Shared pipeline deps (used by status poller + message poller)
	const pipelineDeps: PipelineDeps = {
		processingTimeouts,
		wsHandler,
		log: pipelineLog,
	};

	// Effect executor deps (used by monitoring reducer effects)
	const effectDeps: EffectDeps = {
		startPoller: (sessionId) => {
			if (!monitoringActive || providerCoveredSessions.has(sessionId)) return;
			client.session
				.messages(sessionId)
				.then((msgs) => {
					if (!monitoringActive) return;
					pollerManager.startPolling(sessionId, msgs);
				})
				.catch((err) =>
					statusLog.warn(
						`Failed to seed poller for ${sessionId.slice(0, 12)}, will retry: ${err instanceof Error ? err.message : err}`,
					),
				);
		},
		stopPoller: (sessionId) => pollerManager.stopPolling(sessionId),
		sendStatusToSession: (sessionId, msg) =>
			wsHandler.sendToSession(sessionId, msg),
		processAndApplyDone: (sessionId, isSubagent, busySince) => {
			// Dedup: if SSE or message poller already delivered a "done" for
			// this session in the current busy cycle, skip the synthetic
			// safety-net done. Consume the entry so the next cycle works.
			if (doneDeliveredByPrimary.has(sessionId)) {
				doneDeliveredByPrimary.delete(sessionId);
				statusLog.info(
					`Skipping synthetic done for ${sessionId.slice(0, 12)} — already delivered by primary path`,
				);
				return;
			}

			const doneMsg = { type: "done" as const, sessionId, code: 0 };
			const doneViewers = wsHandler.getClientsForSession(sessionId);
			const doneResult = processEvent(
				doneMsg,
				sessionId,
				doneViewers,
				"status-poller",
			);
			applyPipelineResult(doneResult, sessionId, pipelineDeps);

			const notification = resolveNotifications(
				doneMsg,
				doneResult.route,
				isSubagent,
				sessionId,
				JSON.stringify([sessionId, "poller", busySince, "done"]),
			);
			if (notification.sendPush && config.pushManager) {
				sendPushForEvent(config.pushManager, doneMsg, sseLog, {
					slug: config.slug,
					sessionId,
				});
			}
			if (notification.alert) deps.publishAlert(notification.alert);
		},
		clearProcessingTimeout: (sessionId) =>
			processingTimeouts.clearProcessingTimeout(sessionId),
		clearMessageActivity: (sessionId) =>
			statusPoller.clearMessageActivity(sessionId),
		log: statusLog,
	};

	statusPoller.on("changed", async (statuses, statusesChanged) => {
		if (!monitoringActive) return;

		// Session list broadcast (only when statuses actually changed)
		if (statusesChanged) {
			try {
				await sessionService.pushViewerFamilies();
			} catch (err) {
				statusLog.warn(
					`Failed to push viewed families: ${err instanceof Error ? err.message : err}`,
				);
			}
		}

		if (!monitoringActive) return;

		// Keep present idle candidates explicit; only missing statuses are deletions.
		const parentMap = sessionService.getSessionParentMap({
			activityOnly: true,
		});
		const providers = statusPoller.getSessionProviders?.();
		const daemonConfig = loadDaemonConfig(config.configDir);
		const now = Date.now();
		const prevState = getMonitoringState();
		const contexts = new Map<string, SessionEvalContext>();
		for (const sessionId of selectMonitoringCandidates(
			prevState,
			statuses,
			parentMap,
		)) {
			const status = statuses[sessionId];
			if (status == null) continue;
			contexts.set(
				sessionId,
				assembleContext(
					sessionId,
					status,
					{ connected: sseStream.isConnected() },
					sseTracker,
					parentMap,
					(sid) => wsHandler.getClientsForSession(sid).length > 0,
					now,
					providerStreamsLifecycle(daemonConfig, providers?.get(sessionId)),
				),
			);
		}

		const result = evaluateAll(prevState, contexts, pollerGatingCfg, parentMap);
		providerCoveredSessions = new Set(
			Array.from(contexts)
				.filter(([, context]) => context.providerStreamsLifecycle)
				.map(([sessionId]) => sessionId),
		);
		setMonitoringState(result.state);

		if (result.effects.length > 0) {
			executeEffects(result.effects, effectDeps);
		}

		// Log sessions that newly hit the safety cap
		for (const [sessionId, phase] of result.state.sessions) {
			if (
				phase.phase === "busy-capped" &&
				prevState.sessions.get(sessionId)?.phase !== "busy-capped"
			) {
				statusLog.warn(
					`Session ${sessionId.slice(0, 12)} capped — max ${DEFAULT_POLLER_GATING_CONFIG.maxPollers} concurrent pollers reached`,
				);
			}
		}
	});

	statusPoller.start();

	return {
		pipelineDeps,
		sseTracker,
		pollerGatingCfg,
		getMonitoringState,
		setMonitoringState,
		stopMonitoring: () => {
			monitoringActive = false;
		},
		recordDoneDelivered: (sessionId: string) => {
			doneDeliveredByPrimary.add(sessionId);
		},
	};
}

export const wireMonitoringEffect = (
	deps: EffectMonitoringWiringDeps,
): Effect.Effect<
	EffectMonitoringWiringResult,
	never,
	SessionManagerServiceTag | StatusPollerTag | OverridesStateTag | AlertsTag
> =>
	Effect.gen(function* () {
		const statusPoller = yield* StatusPollerTag;
		const runtime = yield* Effect.runtime<
			SessionManagerServiceTag | OverridesStateTag | AlertsTag
		>();
		const {
			wsHandler,
			sseStream,
			config,
			statusLog,
			pipelineLog,
			state = createMonitoringWiringState(),
		} = deps;

		const { sseTracker, getMonitoringState, setMonitoringState } = state;
		let monitoringActive = true;
		const pollerGatingCfg: PollerGatingConfig = {
			...DEFAULT_POLLER_GATING_CONFIG,
			...config.pollerGatingConfig,
		};
		const doneDeliveredByPrimary = new Set<string>();
		const pipelineDeps: Omit<PipelineDeps, "processingTimeouts"> = {
			wsHandler,
			log: pipelineLog,
		};

		const runFork = Runtime.runFork(runtime);
		const tickSemaphore = yield* Effect.makeSemaphore(1);
		// Ticks can reach reduction out of order (the list broadcast before it is
		// async), so a snapshot older than the last reduced one is dropped.
		let capturedTicks = 0;
		let lastReducedTick = 0;
		yield* statusPoller.on("changed", (statuses, statusesChanged) => {
			const tick = ++capturedTicks;
			runFork(
				Effect.gen(function* () {
					if (!monitoringActive) return;
					const sessionService = yield* SessionManagerServiceTag;
					const providers = yield* statusPoller.getSessionProviders();
					const daemonConfig = loadDaemonConfig(config.configDir);

					if (statusesChanged) {
						yield* sessionService
							.pushViewerFamilies()
							.pipe(
								Effect.catchAll((err) =>
									Effect.sync(() =>
										statusLog.warn(
											`Failed to push viewed families: ${err instanceof Error ? err.message : err}`,
										),
									),
								),
							);
					}

					if (!monitoringActive) return;

					const parentMap = yield* sessionService.getSessionParentMap({
						activityOnly: true,
					});
					const reduced = yield* tickSemaphore.withPermits(1)(
						Effect.sync(() => {
							if (tick < lastReducedTick) return undefined;
							lastReducedTick = tick;
							const now = Date.now();
							const prevState = getMonitoringState();
							const contexts = new Map<string, SessionEvalContext>();
							for (const sessionId of selectMonitoringCandidates(
								prevState,
								statuses,
								parentMap,
							)) {
								const status = statuses[sessionId];
								if (status == null) continue;
								contexts.set(
									sessionId,
									assembleContext(
										sessionId,
										status,
										{ connected: sseStream.isConnected() },
										sseTracker,
										parentMap,
										(sid) => wsHandler.getClientsForSession(sid).length > 0,
										now,
										providerStreamsLifecycle(
											daemonConfig,
											providers.get(sessionId),
										),
									),
								);
							}

							const result = evaluateAll(
								prevState,
								contexts,
								pollerGatingCfg,
								parentMap,
							);
							setMonitoringState(result.state);
							return { prevState, result, contexts };
						}),
					);
					if (reduced === undefined) return;
					const { prevState, result, contexts } = reduced;

					if (result.effects.length > 0) {
						yield* executeMonitoringEffectsEffect(
							result.effects,
							deps,
							pipelineDeps,
							doneDeliveredByPrimary,
							() => monitoringActive,
							// Continuing phases retain their object; any transition replaces it.
							(sessionId) =>
								getMonitoringState().sessions.get(sessionId) ===
								result.state.sessions.get(sessionId),
							(sessionId) => !contexts.get(sessionId)?.providerStreamsLifecycle,
						);
					}

					for (const [sessionId, phase] of result.state.sessions) {
						if (
							phase.phase === "busy-capped" &&
							prevState.sessions.get(sessionId)?.phase !== "busy-capped"
						) {
							statusLog.warn(
								`Session ${sessionId.slice(0, 12)} capped — max ${DEFAULT_POLLER_GATING_CONFIG.maxPollers} concurrent pollers reached`,
							);
						}
					}
				}).pipe(
					Effect.catchAllCause((cause) =>
						Effect.sync(() =>
							statusLog.warn(
								`Status poller changed handler failed: ${Cause.pretty(cause)}`,
							),
						),
					),
				),
			);
		});
		yield* statusPoller.start();

		return {
			pipelineDeps,
			sseTracker,
			pollerGatingCfg,
			getMonitoringState,
			setMonitoringState,
			stopMonitoring: () => {
				monitoringActive = false;
			},
			recordDoneDelivered: (sessionId: string) => {
				doneDeliveredByPrimary.add(sessionId);
			},
		};
	});
