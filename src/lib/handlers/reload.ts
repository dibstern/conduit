// User-facing action: end the provider's session-level state so the next
// prompt picks up newly-added skills/commands from disk. The client refetches
// the command and model lists (GetCommands/GetModels) once this returns.

import { Effect } from "effect";
import {
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { formatErrorDetail } from "../errors.js";

export interface ReloadProviderSessionInput {
	readonly clientId: string;
	readonly sessionId: string;
	readonly commandId: string;
}

export const reloadProviderSessionForClient = (
	input: ReloadProviderSessionInput,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		log.info(
			`client=${input.clientId} session=${input.sessionId} Reloading provider session`,
		);

		const engineResult = yield* Effect.either(
			Effect.gen(function* () {
				const engine = yield* OrchestrationEngineTag;
				yield* engine.dispatchEffect({
					type: "end_session",
					commandId: input.commandId,
					sessionId: input.sessionId,
				});
			}),
		);
		if (engineResult._tag === "Left") {
			log.warn(`endSession failed: ${formatErrorDetail(engineResult.left)}`);
		}

		wsHandler.sendTo(input.clientId, {
			type: "provider_session_reloaded",
			sessionId: input.sessionId,
		});
		return { sessionId: input.sessionId };
	});
