import { Effect, Result } from "effect";
import { SqlClient } from "effect/sql";
import { resolve } from "../../account-directory.js";
import { makeAttachmentStore } from "../../persistence/attachment-store.js";
import type { ProviderStateEffect } from "../../persistence/effect/provider-state-effect.js";
import { resolveTurnImages } from "../resolve-turn-images.js";
import type { ProcessRunnerDriver } from "./process-session-runner.js";
import type { RunnerProviderInstanceDeps } from "./runner-provider-instance.js";
import { recoverRunnerCommands } from "./runner-recovery.js";
import type {
	DurableSessionTurn,
	SessionCommand,
	SessionFailure,
} from "./session-runner.js";

export const makeRunnerCommandRecovery =
	(options: {
		readonly driverKind: string;
		readonly accounts: RunnerProviderInstanceDeps["accounts"];
		readonly autoSettleAfterDays?: RunnerProviderInstanceDeps["autoSettleAfterDays"];
		readonly state: Pick<ProviderStateEffect, "getState">;
		readonly providerStateKeys: readonly string[];
		/** Send-turn fields resolved at replay time, such as account credentials. */
		readonly replayCommandFields?: (
			accountId: string,
		) => Effect.Effect<
			Partial<Extract<SessionCommand, { type: "send-turn" }>>,
			SessionFailure
		>;
	}): ProcessRunnerDriver["recoverCommands"] =>
	(
		sql,
		sessionId,
		connection,
		failTurn,
		closing,
		_liveSession,
		resolveSinkId,
		replayTurn,
	) =>
		Effect.gen(function* () {
			const accounts = yield* options.accounts;
			const attachments = yield* makeAttachmentStore.pipe(
				Effect.provideService(SqlClient.SqlClient, sql),
			);
			// Admission precedes first-turn preparation. Restore state saved before the runner hop.
			const stored = yield* options.state.getState(sessionId);
			return yield* recoverRunnerCommands(sql, sessionId, options.driverKind, {
				driverForAccount: (id) =>
					Result.getOrUndefined(resolve(accounts, { _tag: "Id", id }))?.driver,
				decodeInput: (row) => {
					const input = JSON.parse(row.payload_json) as DurableSessionTurn;
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
				replay: (row, input) => {
					const sinkId = resolveSinkId(
						row.command_id,
						input.inputId,
						row.attempt_count,
						input.nativeResumeFallback,
					);
					return replayTurn(row.provider_id, input, sinkId, (dispatch) =>
						Effect.gen(function* () {
							const resolved = yield* resolveTurnImages(
								input,
								attachments,
							).pipe(
								Effect.mapError(
									(cause): SessionFailure => ({
										operation: "resolveTurnImages",
										message: cause.message,
										...(cause._tag === "AttachmentMissing"
											? { code: "attachment_missing", retryable: false }
											: {}),
									}),
								),
							);
							// Pre-snapshot commands fall back to current daemon memory.
							const autoSettleAfterDays =
								input.autoSettleAfterDays !== undefined
									? input.autoSettleAfterDays
									: yield* options.autoSettleAfterDays ??
											Effect.succeed(undefined);
							const fields = options.replayCommandFields
								? yield* options.replayCommandFields(row.provider_id)
								: {};
							return yield* dispatch(
								connection.commandEffect(
									row.command_id,
									{
										...fields,
										type: "send-turn",
										sinkId,
										aborted: false,
										autoSettleAfterDays,
										input: resolved,
									},
									row.attempt_count,
								),
							);
						}),
					);
				},
			});
		});
