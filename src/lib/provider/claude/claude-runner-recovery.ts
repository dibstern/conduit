import { SqlClient } from "@effect/sql";
import { Effect, Either } from "effect";
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
import {
	recoverRunnerCommands,
	settleUnclaimedRunnerCommands,
} from "../runner/runner-recovery.js";
import type { ProviderNativeSession } from "../types.js";
import type { ClaudeSessionRunnerDeps } from "./claude-provider-runtime.js";
import {
	type ClaudeRunnerSocket,
	claudeRunnerFailure,
	claudeRunnerSinkId,
	normalizeClaudeSessionTurn,
} from "./claude-runner-protocol.js";
import { captureClaudeLaunchLogin } from "./claude-sdk-env.js";
import type {
	ClaudeSessionFailure,
	ClaudeSessionTurn,
} from "./claude-session-runner.js";
import { sendPreparedClaudeTurn } from "./prepare-turn.js";
export const recoverClaudeRunnerCommands = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	connection: ClaudeRunnerSocket,
	failTurn: (
		sinkId: string,
		failure: ClaudeSessionFailure,
	) => Effect.Effect<void>,
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
		claudeRunnerSinkId(commandId, attempt, nativeResumeFallback),
) =>
	Effect.gen(function* () {
		const config = yield* Effect.suspend(() =>
			loadDaemonConfigResult(deps.daemonConfigDir),
		).pipe(
			Effect.catchTag("NotFound", () => Effect.succeed(defaultDaemonConfig())),
		);
		const accounts = accountsStateFromConfig(
			config,
			captureClaudeLaunchLogin(process.env),
		);
		const driverForAccount = (id: string) =>
			Either.getOrUndefined(resolve(accounts, { _tag: "Id", id }))?.driver;
		return yield* recoverRunnerCommands(sql, sessionId, "claude", {
			driverForAccount,
			decodeInput: (row) => ({
				...normalizeClaudeSessionTurn(
					JSON.parse(row.payload_json) as ClaudeSessionTurn,
					() => resolveClaudeLaunchConfig(config),
				),
				commandAttempt: row.attempt_count,
			}),
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
							Effect.catchAll(() => Effect.void),
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
							continuation: input.continuation !== undefined,
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
					Effect.mapError((cause) =>
						claudeRunnerFailure("recover turn", cause),
					),
				);
			},
			onCompleted: (row, input, result) =>
				result.handoff && deps.persistHandoffDelivered
					? deps.persistHandoffDelivered(
							sessionId,
							{
								...result.handoff,
								instanceId: input.instanceId ?? row.provider_id,
							},
							row.command_id,
						)
					: Effect.void,
		});
	});

export const settleUnclaimedClaudeRunnerCommands = <E>(
	sql: SqlClient.SqlClient,
	claimedSessions: ReadonlySet<string>,
	failTurn: (
		sinkId: string,
		turn: {
			sessionId: string;
			userMessageId?: string;
			messageId: string;
			terminal: boolean;
		},
		failure: ClaudeSessionFailure,
	) => Effect.Effect<void, E>,
	daemonConfigDir?: string,
) =>
	Effect.gen(function* () {
		const config = yield* Effect.suspend(() =>
			loadDaemonConfigResult(daemonConfigDir),
		).pipe(
			Effect.catchTag("NotFound", () => Effect.succeed(defaultDaemonConfig())),
		);
		const accounts = accountsStateFromConfig(
			config,
			captureClaudeLaunchLogin(process.env),
		);
		return yield* settleUnclaimedRunnerCommands(
			sql,
			claimedSessions,
			"claude",
			(id) =>
				Either.getOrUndefined(resolve(accounts, { _tag: "Id", id }))?.driver,
			failTurn,
		);
	});
