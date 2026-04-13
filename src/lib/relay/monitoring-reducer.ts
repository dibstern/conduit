import type { SessionStatus } from "../instance/sdk-types.js";
import type {
	MonitoringEffect,
	MonitoringState,
	PollerGatingConfig,
	PollerStartReason,
	SessionEvalContext,
	SessionMonitorPhase,
	SSECoverage,
} from "./monitoring-types.js";
import type { SessionSSETracker } from "./session-sse-tracker.js";
import { deriveSSECoverage } from "./session-sse-tracker.js";

export function assembleContext(
	sessionId: string,
	status: SessionStatus,
	sseHealth: { connected: boolean },
	sseTracker: SessionSSETracker,
	parentMap: ReadonlyMap<string, string>,
	hasViewers: (sessionId: string) => boolean,
	now: number,
): SessionEvalContext {
	return {
		now,
		status,
		sseConnected: sseHealth.connected,
		lastSSEEventAt: sseTracker.getLastEventAt(sessionId),
		isSubagent: parentMap.has(sessionId),
		hasViewers: hasViewers(sessionId),
	};
}

export function evaluateSession(
	sessionId: string,
	current: SessionMonitorPhase,
	ctx: SessionEvalContext,
	config: Readonly<PollerGatingConfig>,
): {
	readonly phase: SessionMonitorPhase;
	readonly effects: readonly MonitoringEffect[];
} {
	const isBusy = ctx.status.type === "busy" || ctx.status.type === "retry";
	const sse: SSECoverage = deriveSSECoverage(
		ctx.sseConnected,
		ctx.lastSSEEventAt,
		ctx.now,
		config.sseActiveThresholdMs,
	);
	const effects: MonitoringEffect[] = [];

	switch (current.phase) {
		case "idle": {
			if (!isBusy) return { phase: current, effects: [] };
			effects.push({ effect: "notify-busy", sessionId });
			if (sse.kind === "active") {
				return {
					phase: {
						phase: "busy-sse-covered",
						busySince: ctx.now,
						lastSSEAt: sse.lastEventAt,
					},
					effects,
				};
			}
			return {
				phase: { phase: "busy-grace", busySince: ctx.now },
				effects,
			};
		}

		case "busy-grace": {
			if (!isBusy) {
				effects.push({
					effect: "notify-idle",
					sessionId,
					isSubagent: ctx.isSubagent,
				});
				return { phase: { phase: "idle" }, effects };
			}
			if (sse.kind === "active") {
				return {
					phase: {
						phase: "busy-sse-covered",
						busySince: current.busySince,
						lastSSEAt: sse.lastEventAt,
					},
					effects: [],
				};
			}
			const graceExpired =
				ctx.now - current.busySince > config.sseGracePeriodMs;
			if (graceExpired) {
				const reason =
					sse.kind === "disconnected"
						? ("sse-disconnected" as const)
						: sse.kind === "never-seen"
							? ("no-sse-history" as const)
							: ("sse-grace-expired" as const);
				effects.push({ effect: "start-poller", sessionId, reason });
				return {
					phase: {
						phase: "busy-polling",
						busySince: current.busySince,
						pollerStartedAt: ctx.now,
					},
					effects,
				};
			}
			return { phase: current, effects: [] };
		}

		case "busy-sse-covered": {
			if (!isBusy) {
				effects.push({
					effect: "notify-idle",
					sessionId,
					isSubagent: ctx.isSubagent,
				});
				return { phase: { phase: "idle" }, effects };
			}
			if (sse.kind === "disconnected") {
				effects.push({
					effect: "start-poller",
					sessionId,
					reason: "sse-disconnected",
				});
				return {
					phase: {
						phase: "busy-polling",
						busySince: current.busySince,
						pollerStartedAt: ctx.now,
					},
					effects,
				};
			}
			if (sse.kind === "stale") {
				effects.push({
					effect: "start-poller",
					sessionId,
					reason: "sse-stale",
				});
				return {
					phase: {
						phase: "busy-polling",
						busySince: current.busySince,
						pollerStartedAt: ctx.now,
					},
					effects,
				};
			}
			return {
				phase: {
					phase: "busy-sse-covered",
					busySince: current.busySince,
					lastSSEAt:
						sse.kind === "active" ? sse.lastEventAt : current.lastSSEAt,
				},
				effects: [],
			};
		}

		case "busy-polling": {
			if (!isBusy) {
				const stopReason = ctx.hasViewers
					? ("idle-has-viewers" as const)
					: ("idle-no-viewers" as const);
				effects.push({ effect: "stop-poller", sessionId, reason: stopReason });
				effects.push({
					effect: "notify-idle",
					sessionId,
					isSubagent: ctx.isSubagent,
				});
				return { phase: { phase: "idle" }, effects };
			}
			if (sse.kind === "active") {
				effects.push({
					effect: "stop-poller",
					sessionId,
					reason: "sse-now-covering",
				});
				return {
					phase: {
						phase: "busy-sse-covered",
						busySince: current.busySince,
						lastSSEAt: sse.lastEventAt,
					},
					effects,
				};
			}
			return { phase: current, effects: [] };
		}

		case "busy-capped": {
			if (!isBusy) {
				effects.push({
					effect: "notify-idle",
					sessionId,
					isSubagent: ctx.isSubagent,
				});
				return { phase: { phase: "idle" }, effects };
			}
			if (sse.kind === "active") {
				return {
					phase: {
						phase: "busy-sse-covered",
						busySince: current.busySince,
						lastSSEAt: sse.lastEventAt,
					},
					effects: [],
				};
			}
			return { phase: current, effects: [] };
		}

		default: {
			const _exhaustive: never = current;
			return _exhaustive;
		}
	}
}

// ── Batch evaluation ────────────────────────────────────────────────────

export function initialMonitoringState(): MonitoringState {
	return { sessions: new Map() };
}

export function evaluateAll(
	state: MonitoringState,
	contexts: ReadonlyMap<string, SessionEvalContext>,
	config: Readonly<PollerGatingConfig>,
): {
	readonly state: MonitoringState;
	readonly effects: readonly MonitoringEffect[];
} {
	const newSessions = new Map<string, SessionMonitorPhase>();
	const effects: MonitoringEffect[] = [];

	// Evaluate sessions present in contexts
	for (const [sessionId, evalCtx] of contexts) {
		const current = state.sessions.get(sessionId) ?? { phase: "idle" as const };
		const result = evaluateSession(sessionId, current, evalCtx, config);
		newSessions.set(sessionId, result.phase);
		effects.push(...result.effects);
	}

	// Handle deleted sessions (in previous state but not in current contexts)
	for (const [sessionId, phase] of state.sessions) {
		if (!contexts.has(sessionId)) {
			if (phase.phase === "busy-polling") {
				effects.push({
					effect: "stop-poller",
					sessionId,
					reason: "session-deleted",
				});
			}
			if (phase.phase !== "idle") {
				effects.push({
					effect: "notify-idle",
					sessionId,
					isSubagent: false,
				});
			}
			// Don't add to newSessions — session is removed
		}
	}

	// Apply safety cap on concurrent pollers
	return applySafetyCap(state, newSessions, effects, config, contexts);
}

/** Enforce maxPollers limit and promote capped sessions when room is available. */
function applySafetyCap(
	oldState: MonitoringState,
	newSessions: Map<string, SessionMonitorPhase>,
	effects: MonitoringEffect[],
	config: Readonly<PollerGatingConfig>,
	contexts: ReadonlyMap<string, SessionEvalContext>,
): {
	readonly state: MonitoringState;
	readonly effects: readonly MonitoringEffect[];
} {
	// Count continuing pollers: sessions that were busy-polling before and remain busy-polling
	let continuingPollers = 0;
	for (const [sessionId, oldPhase] of oldState.sessions) {
		if (oldPhase.phase === "busy-polling") {
			const newPhase = newSessions.get(sessionId);
			if (newPhase && newPhase.phase === "busy-polling") {
				continuingPollers++;
			}
		}
	}

	const startEffects = effects.filter((e) => e.effect === "start-poller");
	const totalPollers = continuingPollers + startEffects.length;

	if (totalPollers > config.maxPollers) {
		// Too many pollers — drop excess start-poller effects and cap those sessions
		const toKeep = startEffects.length - (totalPollers - config.maxPollers);
		let kept = 0;
		const filtered = effects.filter((e) => {
			if (e.effect !== "start-poller") return true;
			if (kept < toKeep) {
				kept++;
				return true;
			}
			// Cap this session instead of starting a poller
			const phase = newSessions.get(e.sessionId);
			const ctx = contexts.get(e.sessionId);
			const now = ctx?.now ?? Date.now();
			if (phase && phase.phase === "busy-polling") {
				newSessions.set(e.sessionId, {
					phase: "busy-capped",
					busySince: phase.busySince,
					cappedAt: now,
				});
			}
			return false;
		});

		return { state: { sessions: newSessions }, effects: filtered };
	}

	// Under cap — promote any busy-capped sessions that have room
	let currentTotal = totalPollers;
	const promotionEffects: MonitoringEffect[] = [];

	for (const [sessionId, phase] of newSessions) {
		if (currentTotal >= config.maxPollers) break;
		if (phase.phase === "busy-capped") {
			const ctx = contexts.get(sessionId);
			const now = ctx?.now ?? Date.now();
			const reason: PollerStartReason = ctx
				? !ctx.sseConnected
					? "sse-disconnected"
					: ctx.lastSSEEventAt === undefined
						? "no-sse-history"
						: "sse-grace-expired"
				: "sse-grace-expired";
			promotionEffects.push({
				effect: "start-poller",
				sessionId,
				reason,
			});
			newSessions.set(sessionId, {
				phase: "busy-polling",
				busySince: phase.busySince,
				pollerStartedAt: now,
			});
			currentTotal++;
		}
	}

	return {
		state: { sessions: newSessions },
		effects: [...effects, ...promotionEffects],
	};
}
