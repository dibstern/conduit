// User-facing action: end the provider's session-level state so the next
// prompt picks up newly-added skills/commands from disk. The client refetches
// the command and model lists (GetCommands/GetModels) once this returns.

import { Effect } from "effect";
import { PROVIDER_DRIVERS } from "../contracts/provider-instance.js";
import { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../domain/daemon/Services/opencode-instances-service.js";
import {
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
				const account =
					instanceId === undefined
						? undefined
						: yield* (yield* AccountDirectory).resolve({
								_tag: "Id",
								id: instanceId,
							});
				if (
					account !== undefined &&
					PROVIDER_DRIVERS[account.driver].runsOpenCodeServer
				) {
					// Refresh is an explicit user action; its subsequent catalog reads are passive.
					yield* (yield* OpenCodeInstancesTag).use(account.id);
				}
				yield* engine.dispatchEffect({
					type: "end_session",
					commandId: input.commandId,
					sessionId: input.sessionId,
					...(instanceId === undefined ? {} : { targetProviderId: instanceId }),
					...(account === undefined ? {} : { account }),
				});
			}).pipe(Effect.scoped),
		);
		if (engineResult._tag === "Left") {
			log.warn(`endSession failed: ${formatErrorDetail(engineResult.left)}`);
		}

		return { sessionId: input.sessionId };
	});
