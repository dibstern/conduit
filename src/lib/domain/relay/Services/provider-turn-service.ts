import { Context, Effect, FiberMap, Layer } from "effect";
import type { ClaudeEventPersistEffectTag } from "../../../persistence/effect/claude-event-persist-effect.js";
import type { ProviderStateEffectTag } from "../../../persistence/effect/provider-state-effect.js";
import type { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import type { CanonicalEvent } from "../../../persistence/events.js";
import type { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import type {
	PendingInteractionServiceTag,
	PendingQuestion,
} from "./pending-interaction-service.js";
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
import { OverridesStateTag } from "./session-overrides-state.js";
import type { SessionTitleServiceTag } from "./session-title-service.js";

export { isProviderTurnInterruptProvider } from "./provider-turn-dispatch.js";

export interface ProviderTurnServiceSendInput {
	readonly clientId: string;
	readonly commandId: string;
	readonly sessionId: string;
	readonly text: string;
	readonly images?: readonly string[];
	readonly model?: {
		readonly providerID: string;
		readonly modelID: string;
	};
	readonly modelUserSelected: boolean;
	readonly agent?: string;
	readonly variant?: string;
	readonly contextWindow?: string;
	readonly errorDelivery?: "client" | "session";
	/** Committed with the handoff's outbox row, in one transaction. */
	readonly events?: readonly CanonicalEvent[];
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
		| OverridesStateTag
		| OrchestrationEngineTag
		| ReadQueryEffectTag
		| ClaudeEventPersistEffectTag
		| ProviderRuntimeIngestionTag
		| ProviderStateEffectTag
		| SessionTitleServiceTag
		| ProviderTurnDispatchFibersTag
	>();
	const runtime = yield* Effect.runtime<OverridesStateTag>();
	const overridesRef = yield* OverridesStateTag;
	const providedContext = Context.add(context, ProviderTurnTimeoutRuntimeTag, {
		runtime,
		overridesRef,
	});
	const service: ProviderTurnService = {
		completeRecoveredQuestion: (question, result, answers) =>
			completeRecoveredQuestion(question, result, answers).pipe(
				Effect.provide(providedContext),
			),
		prepareTurnSession: (input) =>
			prepareTurnSession(input).pipe(Effect.provide(providedContext)),
		sendTurn: (input) => sendTurn(input).pipe(Effect.provide(providedContext)),
		interruptTurn: (input) =>
			interruptTurn(input).pipe(Effect.provide(providedContext)),
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
	| OverridesStateTag
	| OrchestrationEngineTag
	| ReadQueryEffectTag
	| ClaudeEventPersistEffectTag
	| ProviderRuntimeIngestionTag
	| ProviderStateEffectTag
	| SessionTitleServiceTag
> = Layer.effect(ProviderTurnServiceTag, makeProviderTurnService).pipe(
	Layer.provide(ProviderTurnDispatchFibersLive),
);
