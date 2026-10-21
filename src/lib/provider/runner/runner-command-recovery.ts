import { Effect, Result } from "effect";
import { resolve } from "../../account-directory.js";
import type { ProviderStateEffect } from "../../persistence/effect/provider-state-effect.js";
import type { TurnResult } from "../types.js";
import type { ProcessRunnerDriver } from "./process-session-runner.js";
import type { RunnerProviderInstanceDeps } from "./runner-provider-instance.js";
import { recoverRunnerCommands } from "./runner-recovery.js";
import type { SessionTurn } from "./session-runner.js";

export const makeRunnerCommandRecovery =
	(options: {
		readonly driverKind: string;
		readonly accounts: RunnerProviderInstanceDeps["accounts"];
		readonly state: ProviderStateEffect;
		readonly providerStateKeys: readonly string[];
		readonly onCompleted?: (
			commandId: string,
			input: SessionTurn,
			result: TurnResult,
		) => Effect.Effect<unknown, unknown>;
	}): ProcessRunnerDriver["recoverCommands"] =>
	(
		sql,
		sessionId,
		connection,
		failTurn,
		closing,
		_liveSession,
		resolveSinkId,
	) =>
		Effect.gen(function* () {
			const accounts = yield* options.accounts;
			// Admission precedes first-turn preparation. Restore state saved before the runner hop.
			const stored = yield* options.state.getState(sessionId);
			return yield* recoverRunnerCommands(sql, sessionId, options.driverKind, {
				driverForAccount: (id) =>
					Result.getOrUndefined(resolve(accounts, { _tag: "Id", id }))?.driver,
				decodeInput: (row) => {
					const input = JSON.parse(row.payload_json) as SessionTurn;
					return {
						...input,
						commandAttempt: row.attempt_count,
						providerState: {
							...input.providerState,
							...Object.fromEntries(
								options.providerStateKeys
									.filter(
										(key) =>
											stored[key] !== undefined &&
											typeof input.providerState[key] !== "string",
									)
									.map((key) => [key, stored[key]]),
							),
						},
					};
				},
				resolveSinkId,
				closing,
				failTurn,
				onCompleted: (row, input, result) =>
					options.onCompleted?.(row.command_id, input, result) ?? Effect.void,
				replay: (row, input) =>
					connection.commandEffect(
						row.command_id,
						{
							type: "send-turn",
							sinkId: resolveSinkId(
								row.command_id,
								input.inputId,
								row.attempt_count,
								input.nativeResumeFallback,
							),
							aborted: false,
							input,
						},
						row.attempt_count,
					),
			});
		});
