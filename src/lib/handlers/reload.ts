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
import { SessionWorkspaceTag } from "../domain/relay/Services/session-workspace.js";
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

		const engineResult = yield* Effect.result(
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
				const endSessionResult = yield* Effect.result(
					engine.dispatchEffect({
						type: "end_session",
						commandId: input.commandId,
						sessionId: input.sessionId,
						...(instanceId === undefined
							? {}
							: { targetProviderId: instanceId }),
						...(account === undefined ? {} : { account }),
					}),
				);
				if (endSessionResult._tag === "Failure") {
					log.warn(
						`endSession failed: ${formatErrorDetail(endSessionResult.failure)}`,
					);
				}
				if (
					account !== undefined &&
					PROVIDER_DRIVERS[account.driver].catalogSource === "discovery"
				) {
					const warnRefresh = (error: unknown) =>
						Effect.sync(() =>
							log.warn(
								`Provider catalog refresh failed: ${formatErrorDetail(error)}`,
							),
						);
					yield* Effect.gen(function* () {
						const workspaceRoot = yield* (yield* SessionWorkspaceTag).get(
							input.sessionId,
						);
						// Commands use the session workspace; models/agents use the project root, and the client refetches as soon as this returns.
						yield* Effect.forEach(
							[
								{
									type: "discover" as const,
									providerId: account.id,
									account,
									workspaceRoot,
									sessionId: input.sessionId,
									refresh: true,
								},
								{
									type: "discover" as const,
									providerId: account.id,
									account,
									refresh: true,
								},
							],
							(command) =>
								engine.dispatchEffect(command).pipe(Effect.catch(warnRefresh)),
							{ concurrency: 2, discard: true },
						);
					}).pipe(Effect.catch(warnRefresh));
				}
			}).pipe(Effect.scoped),
		);
		if (engineResult._tag === "Failure") {
			log.warn(`endSession failed: ${formatErrorDetail(engineResult.failure)}`);
		}

		return { sessionId: input.sessionId };
	});
