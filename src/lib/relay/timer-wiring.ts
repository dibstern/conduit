// ─── Timer Wiring (G5) ───────────────────────────────────────────────────────
// Sets up periodic timers: permission timeout checks and rate limiter cleanup.
// Returns interval handles for stop() cleanup.
//
// Extracted from createProjectRelay() — all closure captures are explicit params.

import type { PermissionBridge } from "../bridges/permission-bridge.js";
import type { RateLimiter } from "../server/rate-limiter.js";
import type { WebSocketHandler } from "../server/ws-handler.js";
import type { PermissionId } from "../shared-types.js";

// ─── Deps interface ──────────────────────────────────────────────────────────

export interface TimerWiringDeps {
	permissionBridge: PermissionBridge;
	rateLimiter: RateLimiter;
	wsHandler: WebSocketHandler;
}

// ─── Return type ─────────────────────────────────────────────────────────────

export interface TimerWiringResult {
	timeoutTimer: ReturnType<typeof setInterval>;
	rateLimitCleanupTimer: ReturnType<typeof setInterval>;
}

// ─── Wiring function ─────────────────────────────────────────────────────────

export function wireTimers(deps: TimerWiringDeps): TimerWiringResult {
	const { permissionBridge, rateLimiter, wsHandler } = deps;

	// ── Permission/question timeout checks ──────────────────────────────────

	const timeoutTimer = setInterval(() => {
		const timedOutPerms = permissionBridge.checkTimeouts();
		for (const id of timedOutPerms) {
			wsHandler.broadcast({
				type: "permission_resolved",
				requestId: id as PermissionId,
				decision: "timeout",
			});
		}
		// Question timeouts are handled by OpenCode itself — no bridge tracking needed.
	}, 30_000);

	// Don't let the timer keep the process alive
	if (
		timeoutTimer &&
		typeof timeoutTimer === "object" &&
		"unref" in timeoutTimer
	) {
		timeoutTimer.unref();
	}

	// Periodic cleanup of stale rate-limiter entries (every 60s)
	const rateLimitCleanupTimer = setInterval(() => {
		rateLimiter.cleanup();
	}, 60_000);

	if (
		rateLimitCleanupTimer &&
		typeof rateLimitCleanupTimer === "object" &&
		"unref" in rateLimitCleanupTimer
	) {
		rateLimitCleanupTimer.unref();
	}

	return { timeoutTimer, rateLimitCleanupTimer };
}
