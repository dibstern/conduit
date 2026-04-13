// src/lib/relay/monitoring-types.ts
import type { SessionStatus } from "../instance/sdk-types.js";

// ── Session monitoring phases ────────────────────────────────────────────
export type SessionMonitorPhase =
	| { readonly phase: "idle" }
	| { readonly phase: "busy-grace"; readonly busySince: number }
	| {
			readonly phase: "busy-sse-covered";
			readonly busySince: number;
			readonly lastSSEAt: number;
	  }
	| {
			readonly phase: "busy-polling";
			readonly busySince: number;
			readonly pollerStartedAt: number;
	  }
	| {
			readonly phase: "busy-capped";
			readonly busySince: number;
			readonly cappedAt: number;
	  };

// ── SSE coverage ────────────────────────────────────────────────────────
export type SSECoverage =
	| { readonly kind: "active"; readonly lastEventAt: number }
	| { readonly kind: "stale"; readonly lastEventAt: number }
	| { readonly kind: "never-seen" }
	| { readonly kind: "disconnected" };

// ── Evaluation context ──────────────────────────────────────────────────
export interface SessionEvalContext {
	readonly now: number;
	readonly status: SessionStatus;
	readonly sseConnected: boolean;
	readonly lastSSEEventAt: number | undefined;
	readonly isSubagent: boolean;
	readonly hasViewers: boolean;
}

// ── Effect reasons (const-derived) ──────────────────────────────────────
export const POLLER_START_REASONS = [
	"sse-disconnected",
	"sse-stale",
	"no-sse-history",
	"sse-grace-expired",
] as const;
export type PollerStartReason = (typeof POLLER_START_REASONS)[number];

export const POLLER_STOP_REASONS = [
	"idle-no-viewers",
	"idle-has-viewers",
	"sse-now-covering",
	"session-deleted",
] as const;
export type PollerStopReason = (typeof POLLER_STOP_REASONS)[number];

// ── Effects ─────────────────────────────────────────────────────────────

export type MonitoringEffect =
	| {
			readonly effect: "start-poller";
			readonly sessionId: string;
			readonly reason: PollerStartReason;
	  }
	| {
			readonly effect: "stop-poller";
			readonly sessionId: string;
			readonly reason: PollerStopReason;
	  }
	| { readonly effect: "notify-busy"; readonly sessionId: string }
	| {
			readonly effect: "notify-idle";
			readonly sessionId: string;
			readonly isSubagent: boolean;
	  };

// ── Global state ────────────────────────────────────────────────────────
export interface MonitoringState {
	readonly sessions: ReadonlyMap<string, SessionMonitorPhase>;
}

// ── Configuration ───────────────────────────────────────────────────────
export interface PollerGatingConfig {
	readonly sseActiveThresholdMs: number;
	readonly sseGracePeriodMs: number;
	readonly maxPollers: number;
}

export const DEFAULT_POLLER_GATING_CONFIG: PollerGatingConfig = {
	sseActiveThresholdMs: 5_000,
	sseGracePeriodMs: 3_000,
	maxPollers: 50,
};
