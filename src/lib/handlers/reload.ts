// User-facing action: end the provider's session-level state so the next
// prompt picks up newly-added skills/commands from disk. The client refetches
// the command and model lists (GetCommands/GetModels) once this returns.

import { Effect } from "effect";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../daemon/config-persistence.js";
import { OpenCodeInstancesTag } from "../domain/daemon/Services/opencode-instances-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
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
		const log = yield* LoggerTag;

		log.info(
			`client=${input.clientId} session=${input.sessionId} Reloading provider session`,
		);

		const engineResult = yield* Effect.either(
			Effect.gen(function* () {
				const engine = yield* OrchestrationEngineTag;
				const instanceId = yield* engine.getProviderForSessionEffect(
					input.sessionId,
				);
				if (instanceId !== undefined) {
					const config = yield* ConfigTag;
					if (
						resolveProviderRoutingDriver(
							loadDaemonConfig(config.configDir),
							instanceId,
						) === "opencode"
					) {
						// Refresh is an explicit user action; its subsequent catalog reads are passive.
						yield* (yield* OpenCodeInstancesTag).use(instanceId);
					}
				}
				yield* engine.dispatchEffect({
					type: "end_session",
					commandId: input.commandId,
					sessionId: input.sessionId,
				});
			}).pipe(Effect.scoped),
		);
		if (engineResult._tag === "Left") {
			log.warn(`endSession failed: ${formatErrorDetail(engineResult.left)}`);
		}

		return { sessionId: input.sessionId };
	});
