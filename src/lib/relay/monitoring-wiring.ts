// ─── Monitoring Wiring (G2) ──────────────────────────────────────────────────
// Constructs PipelineDeps, EffectDeps, monitoring reducer state, SSE tracker,
// poller gating config, and wires the statusPoller "changed" handler.
//
// Extracted from createProjectRelay() — all closure captures are explicit params.

import { Cause, Effect, Runtime } from "effect";
import { StatusPollerTag } from "../domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import {
	clearProcessingTimeout,
	type OverridesStateTag,
} from "../domain/relay/Services/session-overrides-state.js";
import {
	clearMessageActivity,
	type PollerStateTag,
} from "../domain/relay/Services/session-status-poller.js";
import type { Message } from "../instance/sdk-types.js";
import type { Logger } from "../logger.js";
import type { PushNotificationManager } from "../server/push.js";
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
import { sendPushForEvent } from "./sse-wiring.js";

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

// ─── Deps interface ──────────────────────────────────────────────────────────

/** Narrowed Effect session service capabilities needed by monitoring wiring. */
interface SessionServiceLike {
	sendDualSessionLists(
		send: (msg: Extract<RelayMessage, { type: "session_list" }>) => void,
		options?: {
			statuses?:
				| Record<string, import("../instance/sdk-types.js").SessionStatus>
				| undefined;
		},
	): Promise<void>;
	getSessionParentMap(): Map<string, string>;
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
	isProcessing?(sessionId: string): boolean;
	markMessageActivity?(sessionId: string): void;
	clearMessageActivity(sessionId: string): void;
	notifySSEIdle?(sessionId: string): void;
	reconcileNow?(): Promise<void>;
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
		pollerGatingConfig?: Partial<PollerGatingConfig>;
		pushManager?: PushNotificationManager;
		slug: string;
	};
	statusLog: Logger;
	sseLog: Logger;
	pipelineLog: Logger;
	state?: MonitoringWiringStateAccess;
}

// ─── Return type ─────────────────────────────────────────────────────────────

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
	"sessionService" | "processingTimeouts" | "statusPoller"
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

const processAndApplyDoneEffect = (
	sessionId: string,
	isSubagent: boolean,
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

		const doneMsg = { type: "done" as const, sessionId, code: 0 };
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
		);
		const pushManager = deps.config.pushManager;
		if (notification.sendPush && pushManager) {
			yield* Effect.sync(() =>
				sendPushForEvent(pushManager, doneMsg, deps.sseLog, {
					slug: deps.config.slug,
					sessionId,
				}),
			);
		}
		if (
			notification.broadcastCrossSession &&
			notification.crossSessionPayload
		) {
			yield* Effect.sync(() =>
				deps.wsHandler.broadcast(
					notification.crossSessionPayload as RelayMessage,
				),
			);
		}
	});

const executeMonitoringEffectsEffect = (
	effects: readonly MonitoringEffect[],
	deps: EffectMonitoringWiringDeps,
	pipelineDeps: Omit<PipelineDeps, "processingTimeouts">,
	doneDeliveredByPrimary: Set<string>,
	monitoringActive: () => boolean,
) =>
	Effect.gen(function* () {
		for (const effect of effects) {
			switch (effect.effect) {
				case "start-poller": {
					if (!monitoringActive()) break;
					const messages = yield* Effect.tryPromise(() =>
						deps.client.session.messages(effect.sessionId),
					).pipe(
						Effect.catchAll((err) =>
							Effect.sync(() => {
								deps.statusLog.warn(
									`Failed to seed poller for ${effect.sessionId.slice(0, 12)}, will retry: ${err instanceof Error ? err.message : err}`,
								);
								return undefined;
							}),
						),
					);
					if (!monitoringActive() || messages === undefined) break;
					yield* Effect.sync(() =>
						deps.pollerManager.startPolling(effect.sessionId, messages),
					);
					break;
				}

				case "stop-poller":
					yield* Effect.sync(() =>
						deps.pollerManager.stopPolling(effect.sessionId),
					);
					yield* clearProcessingTimeout(effect.sessionId);
					yield* clearMessageActivity(effect.sessionId);
					break;

				case "notify-busy":
					yield* Effect.sync(() =>
						deps.wsHandler.sendToSession(effect.sessionId, {
							type: "status",
							status: "processing",
						} as RelayMessage),
					);
					break;

				case "notify-idle":
					yield* processAndApplyDoneEffect(
						effect.sessionId,
						effect.isSubagent,
						doneDeliveredByPrimary,
						deps,
						pipelineDeps,
					);
					yield* clearProcessingTimeout(effect.sessionId);
					yield* clearMessageActivity(effect.sessionId);
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

// ─── Wiring function ─────────────────────────────────────────────────────────

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

	// ── Monitoring reducer state ──────────────────────────────────────────────
	const { sseTracker, getMonitoringState, setMonitoringState } = state;
	let monitoringActive = true;
	const pollerGatingCfg: PollerGatingConfig = {
		...DEFAULT_POLLER_GATING_CONFIG,
		...config.pollerGatingConfig,
	};

	// ── Done dedup tracking ──────────────────────────────────────────────────
	// Tracks sessions that received a "done" via SSE or message poller in the
	// current busy cycle. processAndApplyDone consumes (check + delete) entries
	// to avoid synthesizing a duplicate "done" when SSE already delivered one.
	const doneDeliveredByPrimary = new Set<string>();

	// ── Shared pipeline deps (used by status poller + message poller) ──────
	const pipelineDeps: PipelineDeps = {
		processingTimeouts,
		wsHandler,
		log: pipelineLog,
	};

	// ── Effect executor deps (used by monitoring reducer effects) ─────────
	const effectDeps: EffectDeps = {
		startPoller: (sessionId) => {
			if (!monitoringActive) return;
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
		processAndApplyDone: (sessionId, isSubagent) => {
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
			);
			if (notification.sendPush && config.pushManager) {
				sendPushForEvent(config.pushManager, doneMsg, sseLog, {
					slug: config.slug,
					sessionId,
				});
			}
			if (
				notification.broadcastCrossSession &&
				notification.crossSessionPayload
			) {
				wsHandler.broadcast(notification.crossSessionPayload as RelayMessage);
			}
		},
		clearProcessingTimeout: (sessionId) =>
			processingTimeouts.clearProcessingTimeout(sessionId),
		clearMessageActivity: (sessionId) =>
			statusPoller.clearMessageActivity(sessionId),
		log: statusLog,
	};

	// ── Session status poller wiring ────────────────────────────────────────

	statusPoller.on("changed", async (statuses, statusesChanged) => {
		if (!monitoringActive) return;

		// ── Session list broadcast (only when statuses actually changed) ────
		if (statusesChanged) {
			try {
				await sessionService.sendDualSessionLists(
					(msg) => wsHandler.broadcast(msg),
					{ statuses },
				);
			} catch (err) {
				statusLog.warn(
					`Failed to broadcast session list: ${err instanceof Error ? err.message : err}`,
				);
			}
		}

		if (!monitoringActive) return;

		// ── Monitoring reducer: evaluate all sessions ──────────────────────
		const parentMap = sessionService.getSessionParentMap();
		const now = Date.now();
		const contexts = new Map<string, SessionEvalContext>();
		for (const [sessionId, status] of Object.entries(statuses)) {
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
				),
			);
		}

		const prevState = getMonitoringState();
		const result = evaluateAll(prevState, contexts, pollerGatingCfg);
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
	| SessionManagerServiceTag
	| StatusPollerTag
	| PollerStateTag
	| OverridesStateTag
> =>
	Effect.gen(function* () {
		const statusPoller = yield* StatusPollerTag;
		const runtime = yield* Effect.runtime<
			SessionManagerServiceTag | PollerStateTag | OverridesStateTag
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
		yield* statusPoller.on("changed", (statuses, statusesChanged) => {
			runFork(
				Effect.gen(function* () {
					if (!monitoringActive) return;
					const sessionService = yield* SessionManagerServiceTag;

					if (statusesChanged) {
						yield* sessionService
							.sendDualSessionLists((msg) => wsHandler.broadcast(msg), {
								statuses,
							})
							.pipe(
								Effect.catchAll((err) =>
									Effect.sync(() =>
										statusLog.warn(
											`Failed to broadcast session list: ${err instanceof Error ? err.message : err}`,
										),
									),
								),
							);
					}

					if (!monitoringActive) return;

					const parentMap = yield* sessionService.getSessionParentMap();
					const now = Date.now();
					const contexts = new Map<string, SessionEvalContext>();
					for (const [sessionId, status] of Object.entries(statuses)) {
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
							),
						);
					}

					const prevState = getMonitoringState();
					const result = evaluateAll(prevState, contexts, pollerGatingCfg);
					setMonitoringState(result.state);

					if (result.effects.length > 0) {
						yield* executeMonitoringEffectsEffect(
							result.effects,
							deps,
							pipelineDeps,
							doneDeliveredByPrimary,
							() => monitoringActive,
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
