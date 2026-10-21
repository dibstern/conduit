import { Effect, Result } from "effect";
import { SqlClient } from "effect/sql";
import { accountsStateFromConfig, resolve } from "../../account-directory.js";
import {
	defaultDaemonConfig,
	loadDaemonConfigResult,
	resolveClaudeLaunchConfig,
} from "../../daemon/config-persistence.js";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import {
	makeProviderStateEffect,
	ProviderStateEffectTag,
} from "../../persistence/effect/provider-state-effect.js";
import {
	makeReadQueryEffect,
	ReadQueryEffectTag,
} from "../../persistence/effect/read-query-effect.js";
import { runnerFailure, runnerSinkId } from "../runner/runner-protocol.js";
import { recoverRunnerCommands } from "../runner/runner-recovery.js";
import type { SessionFailure, SessionTurn } from "../runner/session-runner.js";
import type { ProviderCall, ProviderNativeSession } from "../types.js";
import type { ClaudeSessionRunnerDeps } from "./claude-provider-runtime.js";
import type { ClaudeRunnerSocket } from "./claude-runner-protocol.js";
import { normalizeClaudeSessionTurn } from "./claude-runner-wire.js";
import { captureClaudeLaunchLogin } from "./claude-sdk-env.js";
import { sendPreparedClaudeTurn } from "./prepare-turn.js";
export const recoverClaudeRunnerCommands = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	connection: ClaudeRunnerSocket,
	failTurn: (sinkId: string, failure: SessionFailure) => Effect.Effect<void>,
	closing: () => boolean,
	deps: ClaudeSessionRunnerDeps,
	liveSession: Effect.Effect<
		ProviderNativeSession | undefined
	> = Effect.succeed(undefined),
	/** Prefer a sink the runner still holds under the input id. */
	resolveSinkId: (
		commandId: string,
		inputId: string,
		attempt: number,
		nativeResumeFallback?: boolean,
	) => string = (commandId, _inputId, attempt, nativeResumeFallback) =>
		runnerSinkId(commandId, attempt, nativeResumeFallback),
) =>
	Effect.gen(function* () {
		const config = yield* Effect.suspend(() =>
			Effect.fromResult(loadDaemonConfigResult(deps.daemonConfigDir)),
		).pipe(
			Effect.catchTag("NotFound", () => Effect.succeed(defaultDaemonConfig())),
		);
		const accounts = accountsStateFromConfig(
			config,
			captureClaudeLaunchLogin(process.env),
		);
		const driverForAccount = (id: string) =>
			Result.getOrUndefined(resolve(accounts, { _tag: "Id", id }))?.driver;
		return yield* recoverRunnerCommands(sql, sessionId, "claude", {
			driverForAccount,
			decodeInput: (row) => ({
				...normalizeClaudeSessionTurn(
					JSON.parse(row.payload_json) as SessionTurn,
					() => resolveClaudeLaunchConfig(config),
				),
				commandAttempt: row.attempt_count,
			}),
			resolveSinkId,
			closing,
			failTurn,
			replay: (row, input) => {
				return Effect.gen(function* () {
					const admittedAccountId =
						input.account?.id ?? input.instanceId ?? row.provider_id;
					let call: ProviderCall | undefined;
					if (deps.recoveryForSession) {
						// The shared adapter borrows environment preparation and account resolution from the project's engine.
						const recovery = yield* deps.recoveryForSession(sessionId);
						if (!recovery)
							return yield* Effect.fail(
								new Error(
									`Project services unavailable for recovered session ${sessionId}`,
								),
							);
						call = yield* recovery.resolveCallContext({
							sessionId,
							...(input.account ? { account: input.account } : {}),
							providerId: admittedAccountId,
							workspaceRoot: input.workspaceRoot,
							extraFolders: input.extraFolders,
							prepareShellEnv: true,
							requireRoutableAccount: true,
						});
						const matchesAdmission =
							call !== undefined &&
							call.account.id === admittedAccountId &&
							call.account.driver === "claude";
						if (!matchesAdmission)
							return yield* Effect.fail(
								new Error(
									`Claude account "${admittedAccountId}" is unavailable for recovery`,
								),
							);
					} else {
						// Standalone compatibility runtimes still own their environment resolver.
						const prepareShellEnv = deps.prepareShellEnv;
						if (prepareShellEnv)
							yield* Effect.tryPromise(() =>
								prepareShellEnv(input.workspaceRoot),
							).pipe(
								Effect.timeoutOption("10 seconds"),
								Effect.catch(() => Effect.void),
							);
					}
					// The shared recovery drops a result that arrives while closing.
					if (closing()) return undefined;
					const instanceId =
						call?.account.id ?? input.instanceId ?? row.provider_id;
					const shellEnv = call
						? call.shellEnv
						: (deps.shellEnv?.(input.workspaceRoot) ?? { ...process.env });
					const state = yield* makeProviderStateEffect.pipe(
						Effect.provideService(PersistenceProjectTag, {
							projectId: row.project_key,
						}),
					);
					const read = yield* makeReadQueryEffect;
					return yield* sendPreparedClaudeTurn({
						sessionId,
						instanceId,
						commandId: row.command_id,
						userText: input.prompt,
						options: {
							liveSession: yield* liveSession,
							configDir: input.configDir,
							folderSource: input.folderSource,
							agent: input.agent,
							userMessageId:
								input.continuation?.cutOffMessageId ?? input.inputId,
							continuation: input.continuation,
							nativeResumeFallback: input.nativeResumeFallback,
							rewind: input.rewind,
							sessionForkSdk: deps.sessionForkSdk,
							workspaceRoot: input.workspaceRoot,
							modelContextWindow:
								input.contextWindow === "1m" ? 1000000 : undefined,
						},
						send: (prepared, nativeResumeFallback) =>
							connection.commandEffect(
								row.command_id,
								{
									type: "send-turn",
									sinkId: resolveSinkId(
										row.command_id,
										input.inputId,
										row.attempt_count,
										nativeResumeFallback,
									),
									aborted: false,
									shellEnv,
									claudeSettingsOverrides: deps.claudeSettingsOverrides?.(),
									input: {
										...input,
										...(call
											? {
													projectId: call.projectId,
													account: call.account,
													workspaceRoot: call.workspaceRoot,
													extraFolders: call.extraFolders,
													shellEnv: call.shellEnv,
												}
											: {}),
										instanceId,
										prompt: prepared.prompt,
										text: input.prompt,
										configDir: prepared.configDir,
										resumeSessionId: prepared.resumeSessionId,
										resumeSessionAt: prepared.resumeSessionAt,
										forkSession: prepared.forkSession,
										clearInheritedGoal: prepared.clearInheritedGoal,
										startFreshNativeSession:
											prepared.resumeSessionId === undefined ||
											input.rewind !== undefined,
										nativeResumeFallback,
										nativeThread: prepared.nativeThread,
										...(prepared.handoff ? { handoff: prepared.handoff } : {}),
									},
								},
								row.attempt_count,
							),
					}).pipe(
						Effect.provideService(ProviderStateEffectTag, state),
						Effect.provideService(ReadQueryEffectTag, read),
					);
				}).pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
					Effect.mapError((cause) => runnerFailure("recover turn", cause)),
				);
			},
		});
	});
