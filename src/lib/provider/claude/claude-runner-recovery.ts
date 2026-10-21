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
import type {
	SessionCommand,
	SessionFailure,
	SessionTurn,
} from "../runner/session-runner.js";
import type { ProviderNativeSession, TurnResult } from "../types.js";
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
	sendTurn: (
		commandId: string,
		command: Extract<SessionCommand, { type: "send-turn" }>,
		attempt: number,
	) => Effect.Effect<TurnResult | undefined, SessionFailure> = (
		commandId,
		command,
		attempt,
	) => connection.commandEffect(commandId, command, attempt),
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
		const accountForId = (id: string) =>
			Result.getOrUndefined(resolve(accounts, { _tag: "Id", id }));
		const driverForAccount = (id: string) => accountForId(id)?.driver;
		return yield* recoverRunnerCommands(sql, sessionId, "claude", {
			driverForAccount,
			decodeInput: (row) => {
				const input = normalizeClaudeSessionTurn(
					JSON.parse(row.payload_json) as SessionTurn,
					() => resolveClaudeLaunchConfig(config),
				);
				// Credentials are omitted from the durable payload. Capture them
				// once for this replay, preserving its admitted identity and folder.
				const account = accountForId(input.account?.id ?? row.provider_id);
				return {
					...input,
					...(account
						? {
								account: input.account
									? { ...input.account, env: account.env }
									: account,
							}
						: {}),
					commandAttempt: row.attempt_count,
				};
			},
			resolveSinkId,
			closing,
			failTurn,
			replay: (row, input) => {
				const instanceId = input.instanceId ?? row.provider_id;
				return Effect.gen(function* () {
					// Recovery can race the project's asynchronous environment capture.
					const prepareShellEnv = deps.prepareShellEnv;
					if (prepareShellEnv)
						yield* Effect.tryPromise(() =>
							prepareShellEnv(input.workspaceRoot),
						).pipe(
							Effect.timeoutOption("10 seconds"),
							Effect.catch(() => Effect.void),
						);
					// The shared recovery drops a result that arrives while closing.
					if (closing()) return undefined;
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
							sendTurn(
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
									shellEnv: deps.shellEnv?.(input.workspaceRoot) ?? {
										...process.env,
									},
									claudeSettingsOverrides: deps.claudeSettingsOverrides?.(),
									input: {
										...input,
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
