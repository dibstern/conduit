import { Effect, Result, Semaphore } from "effect";
import { resolve } from "../../account-directory.js";
import type { ProcessRunnerDriver } from "./process-session-runner.js";
import { runnerFailure } from "./runner-protocol.js";
import type {
	RunnerDriverPieces,
	RunnerProviderInstanceDeps,
} from "./runner-provider-instance.js";
import { recoverRunnerCommands } from "./runner-recovery.js";
import type { SessionTurn } from "./session-runner.js";

export const makeRunnerCommandRecovery =
	(options: {
		readonly driverKind: string;
		readonly accounts: RunnerProviderInstanceDeps["accounts"];
		readonly autoSettleAfterDays?: RunnerProviderInstanceDeps["autoSettleAfterDays"];
		readonly prepareTurnEffect: RunnerDriverPieces["prepareTurnEffect"];
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
		sendTurn,
		admitReplay,
	) =>
		Effect.gen(function* () {
			const accounts = yield* options.accounts;
			// Preparation can suspend. Keep the stored session order through dispatch.
			const replayLock = yield* Semaphore.make(1);
			return yield* recoverRunnerCommands(sql, sessionId, options.driverKind, {
				driverForAccount: (id) =>
					Result.getOrUndefined(resolve(accounts, { _tag: "Id", id }))?.driver,
				decodeInput: (row) => ({
					...(JSON.parse(row.payload_json) as SessionTurn),
					commandAttempt: row.attempt_count,
				}),
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
					// Acks and recovery mutate pendingSendCommands. Only hello proves
					// the runner already journaled this attempt, even after logout.
					if (
						connection.retainedSends?.some(
							(send) =>
								send.commandId === row.command_id &&
								send.attempt === row.attempt_count,
						)
					)
						return connection.commandEffect(
							row.command_id,
							{ type: "send-turn", sinkId, aborted: false, input },
							row.attempt_count,
						);
					return admitReplay(
						sinkId,
						replayTurn(row.provider_id, input, sinkId, (dispatch) =>
							Effect.gen(function* () {
								// Pre-snapshot commands fall back to current daemon memory.
								const autoSettleAfterDays =
									input.autoSettleAfterDays !== undefined
										? input.autoSettleAfterDays
										: yield* options.autoSettleAfterDays ??
												Effect.succeed(undefined);
								const current = Result.getOrUndefined(
									resolve(yield* options.accounts, {
										_tag: "Id",
										id: input.account?.id ?? row.provider_id,
									}),
								);
								if (!current || current.driver !== options.driverKind)
									return yield* Effect.fail({
										operation: "prepare recovered turn",
										message: `Account "${input.account?.id ?? row.provider_id}" is unavailable`,
										code: "account_unavailable",
										retryable: false,
									});
								// Credentials are omitted from the outbox. Restore only env,
								// preserving the account identity and folder admitted with the turn.
								const prepared = yield* options
									.prepareTurnEffect({
										...input,
										account: input.account
											? { ...input.account, env: current.env }
											: current,
										autoSettleAfterDays,
									})
									.pipe(
										Effect.mapError((cause) =>
											runnerFailure("prepare turn", cause),
										),
									);
								return yield* dispatch(
									sendTurn(
										row.command_id,
										{
											type: "send-turn",
											sinkId,
											aborted: false,
											autoSettleAfterDays,
											...prepared,
										},
										row.attempt_count,
									),
								);
							}),
						).pipe(replayLock.withPermits(1)),
					);
				},
			});
		});
