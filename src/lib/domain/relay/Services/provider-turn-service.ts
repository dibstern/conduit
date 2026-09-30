import { Context, Effect, FiberMap, Layer } from "effect";
import type { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import type {
	PendingInteractionServiceTag,
	PendingQuestion,
} from "./pending-interaction-service.js";
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
import type { ConfigTag, LoggerTag, WebSocketHandlerTag } from "./services.js";
import type { SessionManagerServiceTag } from "./session-manager-service.js";
import { OverridesStateTag } from "./session-overrides-state.js";

export {
	isProviderTurnInterruptProvider,
	ProviderRuntimeIngestionRequired,
} from "./provider-turn-dispatch.js";

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
	) => Effect.Effect<void, unknown>;
	readonly prepareTurnSession: (
		input: ProviderTurnServicePrepareInput,
	) => Effect.Effect<string, unknown, OverridesStateTag>;
	readonly sendTurn: (
		input: ProviderTurnServiceSendInput,
	) => Effect.Effect<void, unknown, OverridesStateTag>;
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
		| ProviderTurnDispatchFibersTag
	>();
	const runtime = yield* Effect.runtime<OverridesStateTag>();
	const overridesRef = yield* OverridesStateTag;
	const providedContext = Context.add(context, ProviderTurnTimeoutRuntimeTag, {
		runtime,
		overridesRef,
	});
	const service: ProviderTurnService = {
		completeRecoveredQuestion: (question, result) =>
			completeRecoveredQuestion(question, result).pipe(
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
> = Layer.effect(ProviderTurnServiceTag, makeProviderTurnService).pipe(
	Layer.provide(ProviderTurnDispatchFibersLive),
);
