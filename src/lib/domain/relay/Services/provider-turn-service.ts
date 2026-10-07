import type { SqlClient } from "@effect/sql";
import { Context, Deferred, Effect, FiberMap, Layer, type Scope } from "effect";
import type { ClaudeEventPersistEffectTag } from "../../../persistence/effect/claude-event-persist-effect.js";
import type { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import type { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import type { ProviderStateEffectTag } from "../../../persistence/effect/provider-state-effect.js";
import type { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import type { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import type { AlertsTag } from "./alerts.js";
import type {
	PendingInteractionServiceTag,
	PendingQuestion,
} from "./pending-interaction-service.js";
import type { PendingSendOwnershipTag } from "./pending-send-ownership.js";
import type { ProviderRuntimeIngestionTag } from "./provider-runtime-ingestion-service.js";
import {
	ProviderTurnDispatchFibersTag,
	ProviderTurnTimeoutRuntimeTag,
	sendTurn,
} from "./provider-turn-dispatch.js";
import {
	completeRecoveredQuestion,
	interruptTurn,
	prepareTurnSession,
} from "./provider-turn-session.js";
import type {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "./services.js";
import type { SessionManagerServiceTag } from "./session-manager-service.js";
import {
	clearProcessingTimeout,
	OverridesStateTag,
	PROCESSING_TIMEOUT_DURATION,
	startProcessingTimeout,
} from "./session-overrides-state.js";
import type { SessionTitleServiceTag } from "./session-title-service.js";
import { makeFailTurn } from "./turn-failure.js";

export { isProviderTurnInterruptProvider } from "./provider-turn-dispatch.js";

export interface ProviderTurnServiceSendInput {
	readonly clientId: string;
	readonly commandId: string;
	readonly sessionId: string;
	readonly text: string;
	/** Hidden resumption of the original request, with no new user message. */
	readonly continuation?: { readonly cutOffMessageId: string };
	readonly images?: readonly string[];
	readonly model?: {
		readonly providerID: string;
		readonly modelID: string;
	};
	readonly modelUserSelected: boolean;
	readonly agent?: string;
	readonly variant?: string;
	readonly contextWindow?: string;
}

export interface ProviderTurnServicePrepareInput {
	readonly clientId: string;
	readonly commandId: string;
	readonly sessionId: string;
	readonly model?: ProviderTurnServiceSendInput["model"];
	readonly modelUserSelected: boolean;
}

export interface ProviderTurnServiceInterruptInput {
	readonly clientId: string;
	readonly commandId: string;
	readonly sessionId: string;
}

export interface ProviderTurnService {
	/** Hold new user turns until account mutation and runner replacement finish. */
	readonly holdUserTurnsForAccountSwitch: (
		sessionId: string,
	) => Effect.Effect<void, never, Scope.Scope>;
	readonly completeRecoveredQuestion?: (
		question: PendingQuestion,
		result: string | null,
		answers?: Record<string, unknown>,
	) => Effect.Effect<
		void,
		Effect.Effect.Error<ReturnType<typeof completeRecoveredQuestion>>
	>;
	readonly prepareTurnSession: (
		input: ProviderTurnServicePrepareInput,
	) => Effect.Effect<
		string,
		Effect.Effect.Error<ReturnType<typeof prepareTurnSession>>,
		OverridesStateTag
	>;
	readonly sendTurn: (
		input: ProviderTurnServiceSendInput,
	) => Effect.Effect<
		void,
		Effect.Effect.Error<ReturnType<typeof sendTurn>>,
		OverridesStateTag
	>;
	readonly interruptTurn: (
		input: ProviderTurnServiceInterruptInput,
	) => Effect.Effect<void, never, OverridesStateTag>;
}

export class ProviderTurnServiceTag extends Context.Tag("ProviderTurnService")<
	ProviderTurnServiceTag,
	ProviderTurnService
>() {}

const makeProviderTurnService = Effect.gen(function* () {
	const context = yield* Effect.context<
		| OpenCodeAPITag
		| WebSocketHandlerTag
		| LoggerTag
		| ConfigTag
		| SessionManagerServiceTag
		| PendingInteractionServiceTag
		| PendingSendOwnershipTag
		| OverridesStateTag
		| OrchestrationEngineTag
		| ReadQueryEffectTag
		| ClaudeEventPersistEffectTag
		| ProviderRuntimeIngestionTag
		| AlertsTag
		| ProviderStateEffectTag
		| SessionTitleServiceTag
		| ProviderTurnDispatchFibersTag
		| SqlClient.SqlClient
		| EventStoreEffectTag
		| ProjectionRunnerEffectTag
	>();
	const runtime = yield* Effect.runtime<OverridesStateTag>();
	const overridesRef = yield* OverridesStateTag;
	const providedContext = Context.add(context, ProviderTurnTimeoutRuntimeTag, {
		runtime,
		overridesRef,
	});
	// A Stop ends with session-wide frames (idle status, done) that can trail
	// the button press. A prompt sent before they go out would be ended by
	// them, so a new prompt waits for the session's Stop to finish first.
	const stopping = new Map<string, Deferred.Deferred<void>>();
	const accountSwitches = new Map<string, Deferred.Deferred<void>>();
	const awaitStop = (sessionId: string) =>
		Effect.gen(function* () {
			const stop = stopping.get(sessionId);
			if (stop)
				yield* Deferred.await(stop).pipe(
					Effect.timeout("5 seconds"),
					Effect.ignore,
				);
			// A switch can begin while this send awaits an earlier Stop.
			const switching = accountSwitches.get(sessionId);
			if (switching) yield* Deferred.await(switching);
		});
	const service: ProviderTurnService = {
		holdUserTurnsForAccountSwitch: (sessionId) =>
			Effect.acquireRelease(
				Effect.gen(function* () {
					const hold = yield* Deferred.make<void>();
					accountSwitches.set(sessionId, hold);
					return hold;
				}),
				(hold) =>
					Effect.sync(() => accountSwitches.delete(sessionId)).pipe(
						Effect.zipRight(Deferred.succeed(hold, undefined)),
					),
			).pipe(Effect.asVoid),
		completeRecoveredQuestion: (question, result, answers) =>
			completeRecoveredQuestion(question, result, answers).pipe(
				Effect.provide(providedContext),
			),
		prepareTurnSession: (input) =>
			awaitStop(input.sessionId).pipe(
				Effect.zipRight(prepareTurnSession(input)),
				Effect.provide(providedContext),
			),
		sendTurn: (input) =>
			Effect.gen(function* () {
				// A user may already have prepared before the switch acquired its
				// hold. Wait again before routing; the switch's own turn owns the hold.
				if (!input.continuation) yield* awaitStop(input.sessionId);
				if (input.continuation) {
					const failTurn = yield* makeFailTurn;
					yield* startProcessingTimeout(
						input.sessionId,
						PROCESSING_TIMEOUT_DURATION,
						() =>
							failTurn(
								input.sessionId,
								"The continuation received no response. Try again.",
								"PROCESSING_TIMEOUT",
							),
					);
				}
				yield* sendTurn(input).pipe(
					Effect.onError(() =>
						input.continuation
							? clearProcessingTimeout(input.sessionId)
							: Effect.void,
					),
				);
			}).pipe(Effect.provide(providedContext)),
		interruptTurn: (input) =>
			Effect.gen(function* () {
				const stop = yield* Deferred.make<void>();
				stopping.set(input.sessionId, stop);
				yield* interruptTurn(input).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							if (stopping.get(input.sessionId) === stop)
								stopping.delete(input.sessionId);
						}).pipe(Effect.zipRight(Deferred.succeed(stop, undefined))),
					),
				);
			}).pipe(Effect.provide(providedContext)),
	};
	return service;
});

const ProviderTurnDispatchFibersLive = Layer.scoped(
	ProviderTurnDispatchFibersTag,
	FiberMap.make<string, void, unknown>(),
);

export const ProviderTurnServiceLive: Layer.Layer<
	ProviderTurnServiceTag,
	never,
	| OpenCodeAPITag
	| WebSocketHandlerTag
	| LoggerTag
	| ConfigTag
	| SessionManagerServiceTag
	| PendingInteractionServiceTag
	| PendingSendOwnershipTag
	| OverridesStateTag
	| OrchestrationEngineTag
	| ReadQueryEffectTag
	| ClaudeEventPersistEffectTag
	| ProviderRuntimeIngestionTag
	| AlertsTag
	| ProviderStateEffectTag
	| SessionTitleServiceTag
	| SqlClient.SqlClient
	| EventStoreEffectTag
	| ProjectionRunnerEffectTag
> = Layer.effect(ProviderTurnServiceTag, makeProviderTurnService).pipe(
	Layer.provide(ProviderTurnDispatchFibersLive),
);
