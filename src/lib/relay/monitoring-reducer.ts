import type { SessionStatus } from "../instance/opencode-client.js";
import type {
	MonitoringEffect,
	PollerGatingConfig,
	SessionEvalContext,
	SessionMonitorPhase,
	SSECoverage,
} from "./monitoring-types.js";
import { deriveSSECoverage } from "./session-sse-tracker.js";
import type { SessionSSETracker } from "./session-sse-tracker.js";

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
			const graceExpired = ctx.now - current.busySince > config.sseGracePeriodMs;
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
					lastSSEAt: sse.kind === "active" ? sse.lastEventAt : current.lastSSEAt,
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
