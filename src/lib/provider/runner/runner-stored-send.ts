import { Effect, Result, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import {
	accountsStateFromConfig,
	NO_OPENCODE_HEALTH,
	resolve,
} from "../../account-directory.js";
import { AccountSchema } from "../../contracts/account.js";
import { AttachmentRefSchema } from "../../contracts/attachment-ref.js";
import { ProjectShellEnvConfigSchema } from "../../contracts/project-shell-env.js";
import {
	SessionGoalChangedPayloadSchema,
	SessionHandoffDeliveredPayloadSchema,
} from "../../contracts/stored-event.js";
import { defaultDaemonConfig } from "../../daemon/config-persistence.js";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import { makeAttachmentStore } from "../../persistence/attachment-store.js";
import {
	makeProviderStateEffect,
	ProviderStateEffectTag,
} from "../../persistence/effect/provider-state-effect.js";
import {
	makeReadQueryEffect,
	ReadQueryEffectTag,
} from "../../persistence/effect/read-query-effect.js";
import { SessionPermissionModeSchema } from "../../shared-types.js";
import type { ClaudeSessionRunnerDeps } from "../claude/claude-provider-runtime.js";
import {
	claudeLaunchConfigFromAccounts,
	normalizeClaudeSessionTurn,
} from "../claude/claude-runner-wire.js";
import {
	ClaudeConfigDirSchema,
	ClaudeFolderSourceSchema,
	captureClaudeLaunchLogin,
	configuredClaudeConfigDir,
} from "../claude/claude-sdk-env.js";
import { launchClaudeTurn } from "../claude/prepare-turn.js";
import { resolveTurnImages } from "../resolve-turn-images.js";
import type { SendToken } from "../run-ledger/run-ledger-model.js";
import type {
	ProviderCall,
	ProviderNativeSession,
	TurnResult,
} from "../types.js";
import { currentSendToken, runnerFailure } from "./runner-protocol.js";
import {
	launchRunnerTurn,
	type RunnerDriverPieces,
	type RunnerProviderInstanceDeps,
} from "./runner-provider-instance.js";
import type { runningRunnerCommands } from "./runner-recovery.js";
import { terminalFailureResult, toStoreFault } from "./send-settlement.js";
import type {
	DurableSessionTurn,
	SessionCommand,
	SessionFailure,
} from "./session-runner.js";

const StoredTurn = Schema.Struct({
	sessionId: Schema.optionalKey(Schema.String),
	projectId: Schema.optionalKey(Schema.String),
	inputId: Schema.optionalKey(Schema.String),
	userMessageId: Schema.optionalKey(Schema.String),
	commandId: Schema.optionalKey(Schema.String),
	turnId: Schema.optionalKey(Schema.String),
	prompt: Schema.String,
	text: Schema.optionalKey(Schema.String),
	workspaceMoveDirective: Schema.optionalKey(Schema.String),
	workspaceRoot: Schema.optionalKey(Schema.String),
	extraFolders: Schema.optionalKey(Schema.Array(Schema.String)),
	history: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				id: Schema.optionalKey(Schema.String),
				role: Schema.Literals(["user", "assistant"]),
				content: Schema.optionalKey(Schema.String),
				text: Schema.optionalKey(Schema.String),
				parts: Schema.optionalKey(
					Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
				),
				tokens: Schema.optionalKey(Schema.Unknown),
				cost: Schema.optionalKey(Schema.Number),
				time: Schema.optionalKey(Schema.Unknown),
			}),
		),
	),
	providerState: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Unknown),
	),
	account: Schema.optionalKey(AccountSchema),
	instanceId: Schema.optionalKey(Schema.String),
	shellEnv: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Union([Schema.String, Schema.Undefined]),
		),
	),
	shellConfig: Schema.optionalKey(ProjectShellEnvConfigSchema),
	continuation: Schema.optionalKey(
		Schema.Union([
			Schema.Boolean,
			Schema.Struct({ cutOffMessageId: Schema.String }),
		]),
	),
	nativeThread: Schema.optionalKey(
		Schema.Struct({
			projectId: Schema.String,
			configDir: Schema.optionalKey(
				Schema.Union([ClaudeConfigDirSchema, Schema.String]),
			),
			resumeSessionId: Schema.String,
			firstSequence: Schema.Number,
			deliveredThrough: Schema.Number,
		}),
	),
	resumeSessionId: Schema.optionalKey(Schema.String),
	resumeSessionAt: Schema.optionalKey(Schema.String),
	rewind: Schema.optionalKey(
		Schema.Struct({
			resumeSessionAt: Schema.NullOr(Schema.String),
			targetMessageId: Schema.optionalKey(Schema.String),
			removedMessageIds: Schema.optionalKey(Schema.Array(Schema.String)),
		}),
	),
	forkSession: Schema.optionalKey(Schema.Boolean),
	clearInheritedGoal: Schema.optionalKey(Schema.Boolean),
	startFreshNativeSession: Schema.optionalKey(Schema.Boolean),
	nativeResumeFallback: Schema.optionalKey(Schema.Boolean),
	model: Schema.optionalKey(
		Schema.Struct({ providerId: Schema.String, modelId: Schema.String }),
	),
	configDir: Schema.optionalKey(
		Schema.Union([ClaudeConfigDirSchema, Schema.String]),
	),
	folderSource: Schema.optionalKey(ClaudeFolderSourceSchema),
	expectedApiModelId: Schema.optionalKey(Schema.NullOr(Schema.String)),
	goalState: Schema.optionalKey(SessionGoalChangedPayloadSchema),
	cumulativeTokens: Schema.optionalKey(Schema.Number),
	autoSettleAfterDays: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	permissionMode: Schema.optionalKey(SessionPermissionModeSchema),
	sideThread: Schema.optionalKey(Schema.Boolean),
	variant: Schema.optionalKey(Schema.String),
	contextWindow: Schema.optionalKey(Schema.String),
	images: Schema.optionalKey(Schema.Array(AttachmentRefSchema)),
	agent: Schema.optionalKey(Schema.String),
	handoff: Schema.optionalKey(SessionHandoffDeliveredPayloadSchema),
});

export type RunningRunnerCommand = Effect.Success<
	ReturnType<typeof runningRunnerCommands>
>[number];

export interface StoredSendOutcome {
	readonly result: TurnResult | undefined;
	readonly nativeResumeFallback: boolean;
}

const recoveryFailure = (operation: string, cause: unknown): SessionFailure => {
	const failure = runnerFailure(operation, cause);
	return failure.retryable === undefined &&
		toStoreFault(cause)._tag === "StoreUnavailable"
		? { ...failure, retryable: true }
		: failure;
};

/** Rebuilds a stored send from its outbox row and transmits it; the caller owns admission and settlement. */
export const replayStoredSend = (options: {
	readonly sql: SqlClient.SqlClient;
	readonly row: RunningRunnerCommand;
	readonly driverKind: string;
	readonly replayLock: Semaphore.Semaphore;
	readonly prepareTurnEffect?: RunnerDriverPieces["prepareTurnEffect"];
	readonly admitReplay: (
		input: DurableSessionTurn,
		sinkId: string,
		replay: Effect.Effect<StoredSendOutcome, SessionFailure>,
	) => Effect.Effect<StoredSendOutcome, SessionFailure>;
	readonly deps: {
		readonly accounts?: RunnerProviderInstanceDeps["accounts"];
		readonly autoSettleAfterDays?: RunnerProviderInstanceDeps["autoSettleAfterDays"];
		readonly recoveryForSession?: RunnerProviderInstanceDeps["recoveryForSession"];
		readonly sessionForkSdk?: ClaudeSessionRunnerDeps["sessionForkSdk"];
		readonly claudeSettingsOverrides?: ClaudeSessionRunnerDeps["claudeSettingsOverrides"];
	};
	readonly liveSession: Effect.Effect<ProviderNativeSession | undefined>;
	readonly resolveSinkId: (
		commandId: string,
		inputId: string,
		attempt: number,
		nativeResumeFallback?: boolean,
	) => string;
	readonly send: (
		token: SendToken,
		command: Extract<SessionCommand, { type: "send-turn" }>,
	) => Effect.Effect<TurnResult | undefined, SessionFailure>;
	readonly closing: () => boolean;
}): Effect.Effect<StoredSendOutcome, SessionFailure> =>
	Effect.gen(function* () {
		const { row, deps, driverKind } = options;
		const payload = yield* Schema.decodeUnknownEffect(
			Schema.fromJsonString(StoredTurn),
		)(row.payload_json).pipe(
			Effect.mapError((cause) => ({
				...runnerFailure("decodeRunnerTurn", cause),
				code: "invalid_runner_turn",
				retryable: false,
			})),
		);
		const { nativeThread, continuation, configDir, ...turn } = payload;
		const inputId =
			continuation === true
				? payload.commandId
				: (payload.inputId ??
					payload.userMessageId ??
					payload.commandId ??
					payload.turnId);
		if (inputId === undefined)
			return yield* Effect.fail({
				operation: "decodeRunnerTurn",
				message: "Runner turn input id is required",
				code: "invalid_runner_turn",
				retryable: false,
			});
		const input: DurableSessionTurn = {
			...turn,
			sessionId: payload.sessionId ?? row.session_id,
			inputId,
			workspaceRoot: payload.workspaceRoot ?? "",
			extraFolders: payload.extraFolders ?? [],
			history: payload.history ?? [],
			providerState: payload.providerState ?? {},
			configDir:
				typeof configDir === "string"
					? configuredClaudeConfigDir(configDir)
					: configDir,
			...(typeof continuation === "object"
				? { continuation }
				: continuation === true && payload.userMessageId !== undefined
					? { continuation: { cutOffMessageId: payload.userMessageId } }
					: {}),
			...(nativeThread
				? {
						nativeThread: {
							...nativeThread,
							configDir:
								typeof nativeThread.configDir === "string"
									? configuredClaudeConfigDir(nativeThread.configDir)
									: nativeThread.configDir,
						},
					}
				: {}),
			...(row.run_id ? { runId: row.run_id } : {}),
			commandAttempt: row.attempt_count,
		};
		const sinkId = options.resolveSinkId(
			row.command_id,
			input.inputId,
			row.attempt_count,
			input.nativeResumeFallback,
		);
		const admittedInput = input;
		return yield* options.admitReplay(
			input,
			sinkId,
			Effect.gen(function* () {
				const accounts = yield* deps.accounts ??
					Effect.sync(() =>
						accountsStateFromConfig(
							defaultDaemonConfig(),
							captureClaudeLaunchLogin(process.env),
						),
					);
				const account = Result.getOrUndefined(
					resolve(
						accounts,
						{
							_tag: "Id",
							id: admittedInput.account?.id ?? row.provider_id,
						},
						NO_OPENCODE_HEALTH,
					),
				);
				const input =
					driverKind === "claude" && account
						? {
								...admittedInput,
								account: admittedInput.account
									? { ...admittedInput.account, env: account.env }
									: account,
							}
						: admittedInput;
				const state = yield* makeProviderStateEffect.pipe(
					Effect.provideService(PersistenceProjectTag, {
						projectId: row.project_key,
					}),
				);
				const attachments = yield* makeAttachmentStore;
				const resolved = yield* resolveTurnImages(input, attachments).pipe(
					Effect.mapError(
						(cause): SessionFailure => ({
							operation: "resolveTurnImages",
							message: cause.message,
							...(cause._tag === "AttachmentMissing"
								? { code: "attachment_missing", retryable: false }
								: {
										retryable: toStoreFault(cause)._tag === "StoreUnavailable",
									}),
						}),
					),
				);
				const autoSettleAfterDays =
					input.autoSettleAfterDays !== undefined
						? input.autoSettleAfterDays
						: yield* deps.autoSettleAfterDays ?? Effect.succeed(undefined);
				const nativeResumeFallback = input.nativeResumeFallback === true;
				switch (driverKind) {
					case "claude":
						break;
					default: {
						if (!account || account.driver !== driverKind)
							return yield* Effect.fail({
								operation: "prepare recovered turn",
								message: `Account "${input.account?.id ?? row.provider_id}" is unavailable`,
								code: "account_unavailable",
								retryable: false,
							});
						if (!options.prepareTurnEffect)
							return yield* Effect.fail({
								operation: "prepare recovered turn",
								message: `Recovery preparation is unavailable for ${driverKind}`,
								retryable: false,
							});
						const prepared = yield* launchRunnerTurn(
							{ prepareTurnEffect: options.prepareTurnEffect },
							{
								...resolved,
								// Credentials are omitted from the outbox; keep the admitted identity.
								account: input.account
									? { ...input.account, env: account.env }
									: account,
								autoSettleAfterDays,
							},
						).pipe(
							Effect.mapError((cause) =>
								recoveryFailure("prepare turn", cause),
							),
						);
						const result = yield* options.send(currentSendToken(row), {
							type: "send-turn",
							sinkId: options.resolveSinkId(
								row.command_id,
								input.inputId,
								row.attempt_count,
								input.nativeResumeFallback,
							),
							aborted: false,
							autoSettleAfterDays,
							...prepared,
						});
						return { result, nativeResumeFallback };
					}
				}
				const { images: _images, ...claudeTurn } = input;
				const launch = yield* Effect.try(() =>
					// Select the folder before filling or refreshing account credentials.
					normalizeClaudeSessionTurn(
						{ ...claudeTurn, account: payload.account },
						() => claudeLaunchConfigFromAccounts(accounts),
					),
				);
				const admittedAccountId =
					input.account?.id ?? input.instanceId ?? row.provider_id;
				let call: ProviderCall | undefined;
				if (deps.recoveryForSession) {
					const recovery = yield* deps.recoveryForSession(row.session_id);
					if (!recovery)
						return yield* Effect.fail({
							operation: "recover turn",
							message: `Project services unavailable for recovered session ${row.session_id}`,
						});
					const resolvedCall = yield* recovery.resolveCallContext({
						sessionId: row.session_id,
						...(input.account ? { account: input.account } : {}),
						providerId: admittedAccountId,
						workspaceRoot: input.workspaceRoot,
						extraFolders: input.extraFolders,
						prepareShellEnv: true,
						requireRoutableAccount: true,
					});
					if (
						resolvedCall?.account.id === admittedAccountId &&
						resolvedCall.account.driver === "claude"
					)
						call = resolvedCall;
					else
						return yield* Effect.fail({
							operation: "recover turn",
							message: `Claude account "${admittedAccountId}" is unavailable for recovery`,
						});
				}
				if (options.closing())
					return { result: undefined, nativeResumeFallback };
				const instanceId =
					call?.account.id ?? input.instanceId ?? row.provider_id;
				const shellEnv = call?.shellEnv ?? input.shellEnv ?? { ...process.env };
				const read = yield* makeReadQueryEffect;
				let primary: TurnResult | undefined;
				const result = yield* launchClaudeTurn({
					sessionId: row.session_id,
					instanceId,
					commandId: row.command_id,
					turn: input,
					launch: {
						configDir: launch.configDir,
						folderSource: launch.folderSource,
					},
					liveSession: yield* options.liveSession,
					sessionForkSdk: deps.sessionForkSdk,
					send: (planned) => {
						// A fresh fallback is the next transmission, never this claim's token
						// (4.8): the claim ends as its primary's rejection, which requeues it.
						if (planned.nativeResumeFallback && !nativeResumeFallback)
							return Effect.succeed(primary);
						return options
							.send(currentSendToken(row), {
								type: "send-turn",
								sinkId: options.resolveSinkId(
									row.command_id,
									input.inputId,
									row.attempt_count,
									planned.nativeResumeFallback,
								),
								aborted: false,
								autoSettleAfterDays,
								shellEnv,
								shellConfig: call?.shellConfig ?? input.shellConfig,
								claudeSettingsOverrides: deps.claudeSettingsOverrides?.(),
								input: {
									...resolved,
									...(call
										? {
												projectId: call.projectId,
												account: call.account,
												workspaceRoot: call.workspaceRoot,
												extraFolders: call.extraFolders,
												shellEnv: call.shellEnv,
												shellConfig: call.shellConfig,
											}
										: {}),
									instanceId,
									...planned,
								},
							})
							.pipe(
								Effect.tap((result) =>
									Effect.sync(() => {
										primary = result;
									}),
								),
								Effect.tapError((failure) =>
									Effect.sync(() => {
										primary = terminalFailureResult(failure);
									}),
								),
							);
					},
				}).pipe(
					Effect.provideService(ProviderStateEffectTag, state),
					Effect.provideService(ReadQueryEffectTag, read),
				);
				return { result, nativeResumeFallback };
			}).pipe(
				options.replayLock.withPermits(1),
				Effect.provideService(SqlClient.SqlClient, options.sql),
				Effect.mapError((cause) => recoveryFailure("recover turn", cause)),
			),
		);
	}).pipe(
		Effect.provideService(SqlClient.SqlClient, options.sql),
		Effect.mapError((cause) => recoveryFailure("recover turn", cause)),
	);
