// ─── Timer Wiring (G5) ───────────────────────────────────────────────────────
// Permission timeout checks as a scoped Effect Layer.
// Rate limiter cleanup is handled by the Effect RateLimiterLive scoped fiber.
//
// Fiber is automatically interrupted on scope close (ManagedRuntime.dispose).

import { Duration, Effect, Layer, Schedule } from "effect";
import { PendingInteractionServiceTag } from "../effect/pending-interaction-service.js";
import { WebSocketHandlerTag } from "../effect/services.js";
import type { PermissionId } from "../shared-types.js";

// ─── Effect Layer ───────────────────────────────────────────────────────────

/**
 * Scoped Layer that checks for timed-out permissions every 30 seconds
 * and broadcasts resolution messages to all connected clients.
 *
 * Requires: PendingInteractionServiceTag, WebSocketHandlerTag.
 */
export const PermissionTimeoutLive: Layer.Layer<
	never,
	never,
	PendingInteractionServiceTag | WebSocketHandlerTag
> = Layer.scopedDiscard(
	Effect.gen(function* () {
		const pendingInteractions = yield* PendingInteractionServiceTag;
		const wsHandler = yield* WebSocketHandlerTag;

		yield* Effect.forkScoped(
			Effect.repeat(
				Effect.gen(function* () {
					const timedOutPerms =
						yield* pendingInteractions.takeTimedOutPermissions();
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
