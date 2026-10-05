// Timer Wiring (G5)
// Permission timeout checks as a scoped Effect Layer.
// Rate limiter cleanup is handled by the Effect RateLimiterLive scoped fiber.
//
// Fiber is automatically interrupted on scope close (ManagedRuntime.dispose).

import { Duration, Effect, Layer, Schedule } from "effect";
import { PendingInteractionServiceTag } from "../domain/relay/Services/pending-interaction-service.js";
import type { LoggerTag } from "../domain/relay/Services/services.js";
import { recordPermissionTimedOut } from "../handlers/permissions.js";

/**
 * Scoped Layer that checks for timed-out permissions every 30 seconds and
 * records the ones no provider turn was waiting on as rejected, which takes
 * their cards down through the approvals subscription. An awaited one fails
 * its turn, and the turn records the resolution itself.
 *
 * Requires: PendingInteractionServiceTag, LoggerTag.
 */
export const PermissionTimeoutLive: Layer.Layer<
	never,
	never,
	PendingInteractionServiceTag | LoggerTag
> = Layer.scopedDiscard(
	Effect.gen(function* () {
		const pendingInteractions = yield* PendingInteractionServiceTag;

		yield* Effect.forkScoped(
			Effect.repeat(
				Effect.gen(function* () {
					const timedOutPerms =
						yield* pendingInteractions.takeTimedOutPermissions();
					for (const entry of timedOutPerms) {
						if (!entry.awaited) yield* recordPermissionTimedOut(entry);
					}
				}),
				Schedule.fixed(Duration.seconds(30)),
			),
		);
	}),
);
