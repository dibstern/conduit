// ─── Timer Wiring (G5) ───────────────────────────────────────────────────────
// Permission timeout checks as a scoped Effect Layer.
// Rate limiter cleanup is handled by the Effect RateLimiterLive scoped fiber.
//
// Fiber is automatically interrupted on scope close (ManagedRuntime.dispose).

import { Duration, Effect, Layer, Schedule } from "effect";
import {
	PermissionBridgeTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import type { PermissionId } from "../shared-types.js";

// ─── Effect Layer ───────────────────────────────────────────────────────────

/**
 * Scoped Layer that checks for timed-out permissions every 30 seconds
 * and broadcasts resolution messages to all connected clients.
 *
 * Requires: PermissionBridgeTag, WebSocketHandlerTag (provided via bridge or native Layers).
 */
export const PermissionTimeoutLive: Layer.Layer<
	never,
	never,
	PermissionBridgeTag | WebSocketHandlerTag
> = Layer.scopedDiscard(
	Effect.gen(function* () {
		const permissionBridge = yield* PermissionBridgeTag;
		const wsHandler = yield* WebSocketHandlerTag;

		yield* Effect.forkScoped(
			Effect.repeat(
				Effect.sync(() => {
					const timedOutPerms = permissionBridge.checkTimeouts();
					for (const entry of timedOutPerms) {
						wsHandler.broadcast({
							type: "permission_resolved",
							sessionId: entry.sessionId,
							requestId: entry.id as PermissionId,
							decision: "timeout",
						});
					}
				}),
				Schedule.fixed(Duration.seconds(30)),
			),
		);
	}),
);
