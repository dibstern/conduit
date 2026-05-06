// ─── Monitoring State & SSE Tracker Effect Services ────────────────────────
// Thin Ref-backed services for monitoring state and SSE event tracking.
// Replaces the imperative closures returned by wireMonitoring().

import { Context, Layer, Ref } from "effect";
import type { MonitoringState } from "../relay/monitoring-types.js";
import type { SessionSSETracker } from "../relay/session-sse-tracker.js";

// ─── Monitoring State Tag ──────────────────────────────────────────────────

export class MonitoringStateTag extends Context.Tag("MonitoringState")<
	MonitoringStateTag,
	Ref.Ref<MonitoringState>
>() {}

export const MonitoringStateLive: Layer.Layer<MonitoringStateTag> =
	Layer.effect(
		MonitoringStateTag,
		Ref.make<MonitoringState>({ sessions: new Map() }),
	);

// ─── SSE Tracker Tag ───────────────────────────────────────────────────────

export class SSETrackerTag extends Context.Tag("SSETracker")<
	SSETrackerTag,
	SessionSSETracker
>() {}

export const SSETrackerLive: Layer.Layer<SSETrackerTag> = Layer.succeed(
	SSETrackerTag,
	(() => {
		const timestamps = new Map<string, number>();
		return {
			recordEvent(sessionId: string, now: number) {
				timestamps.set(sessionId, now);
			},
			getLastEventAt(sessionId: string) {
				return timestamps.get(sessionId);
			},
			remove(sessionId: string) {
				timestamps.delete(sessionId);
			},
		};
	})(),
);
