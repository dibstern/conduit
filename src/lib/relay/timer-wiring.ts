// ─── Timer Wiring (G5) ───────────────────────────────────────────────────────
// Sets up periodic timers: permission timeout checks.
// Rate limiter cleanup is handled by the Effect RateLimiterLive scoped fiber.
//
// Extracted from createProjectRelay() — all closure captures are explicit params.

import type { PermissionBridge } from "../bridges/permission-bridge.js";
import type { WebSocketHandler } from "../server/ws-handler.js";
import type { PermissionId } from "../shared-types.js";

// ─── Deps interface ──────────────────────────────────────────────────────────

export interface TimerWiringDeps {
	permissionBridge: PermissionBridge;
	wsHandler: WebSocketHandler;
}

// ─── Return type ─────────────────────────────────────────────────────────────

export interface TimerWiringResult {
	timeoutTimer: ReturnType<typeof setInterval>;
}

// ─── Wiring function ─────────────────────────────────────────────────────────

export function wireTimers(deps: TimerWiringDeps): TimerWiringResult {
	const { permissionBridge, wsHandler } = deps;

	// ── Permission/question timeout checks ──────────────────────────────────

	const timeoutTimer = setInterval(() => {
		const timedOutPerms = permissionBridge.checkTimeouts();
		for (const entry of timedOutPerms) {
			wsHandler.broadcast({
				type: "permission_resolved",
				sessionId: entry.sessionId,
				requestId: entry.id as PermissionId,
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

	return { timeoutTimer };
}
