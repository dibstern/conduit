import { Chunk, Effect, Layer, PubSub, Queue } from "effect";
import type { Alert } from "../../src/lib/contracts/ws-rpc.js";
import {
	type AlertLedger,
	AlertLedgerTag,
} from "../../src/lib/domain/relay/Services/alert-ledger.js";
import {
	AlertsLive,
	AlertsTag,
} from "../../src/lib/domain/relay/Services/alerts.js";
import {
	PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	ProjectSettingsLive,
	ProjectSettingsTag,
} from "../../src/lib/domain/relay/Services/project-settings.js";
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
	const projectSettings = Effect.runSync(
		ProjectSettingsTag.pipe(Effect.provide(ProjectSettingsLive)),
	);
	const sessionService = makeMockSessionManagerService();
	const alertLedger: AlertLedger = {
		deliver: (_alert, send) => send.pipe(Effect.as(true)),
	};
	const alerts = Effect.runSync(AlertsTag.pipe(Effect.provide(AlertsLive)));
	const layer = Layer.mergeAll(
		Layer.succeed(AlertLedgerTag, alertLedger),
		Layer.succeed(AlertsTag, alerts),
		Layer.succeed(PendingInteractionServiceTag, pendingInteractions),
		makeOverridesStateLive(),
		Layer.succeed(SessionManagerServiceTag, sessionService),
		Layer.succeed(ProjectSettingsTag, projectSettings),
	);
	return {
		pendingInteractions,
		projectSettings,
		sessionService,
		alerts,
		layer,
	};
}

/** Runs one SSE event and returns the alerts it published. */
export async function runSSEEvent(
	deps: SSEWiringDeps,
	event: Parameters<typeof handleSSEEventEffect>[1],
	services = makeSSETestServices(),
): Promise<Alert[]> {
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const seen = yield* PubSub.subscribe(services.alerts);
				yield* handleSSEEventEffect(deps, event);
				return Chunk.toArray(yield* Queue.takeAll(seen));
			}),
		).pipe(Effect.provide(services.layer)),
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
