import { Effect, Layer } from "effect";
import {
	PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { SessionManagerServiceTag } from "../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeOverridesStateLive } from "../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	handleSSEEventEffect,
	type SSEWiringDeps,
	wireSSEConsumerEffect,
} from "../../src/lib/relay/sse-wiring.js";
import { makeMockSessionManagerService } from "./mock-factories.js";

export function makeSSETestServices() {
	const pendingInteractions = Effect.runSync(
		PendingInteractionServiceTag.pipe(
			Effect.provide(PendingInteractionServiceLive),
		),
	);
	const sessionService = makeMockSessionManagerService();
	const layer = Layer.mergeAll(
		Layer.succeed(PendingInteractionServiceTag, pendingInteractions),
		makeOverridesStateLive(),
		Layer.succeed(SessionManagerServiceTag, sessionService),
	);
	return { pendingInteractions, sessionService, layer };
}

export async function runSSEEvent(
	deps: SSEWiringDeps,
	event: Parameters<typeof handleSSEEventEffect>[1],
	services = makeSSETestServices(),
) {
	await Effect.runPromise(
		handleSSEEventEffect(deps, event).pipe(Effect.provide(services.layer)),
	);
}

export async function wireSSEConsumerForTest(
	deps: SSEWiringDeps,
	consumer: Parameters<typeof wireSSEConsumerEffect>[1],
	services = makeSSETestServices(),
) {
	await Effect.runPromise(
		wireSSEConsumerEffect(deps, consumer).pipe(Effect.provide(services.layer)),
	);
}
