import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { accountsStateFromConfig, resolve } from "../../account-directory.js";
import { AccountSchema } from "../../contracts/account.js";
import { AttachmentRefSchema } from "../../contracts/attachment-ref.js";
import { ProjectShellEnvConfigSchema } from "../../contracts/project-shell-env.js";
import {
	SessionGoalChangedPayloadSchema,
	SessionHandoffDeliveredPayloadSchema,
} from "../../contracts/stored-event.js";
import { defaultDaemonConfig } from "../../daemon/config-persistence.js";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import * as Failure from "../../effect/failure-classification.js";
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
import { sendPreparedClaudeTurn } from "../claude/prepare-turn.js";
import { resolveTurnImages } from "../resolve-turn-images.js";
import type {
	ProviderCall,
	ProviderNativeSession,
	TurnResult,
} from "../types.js";
import {
	type RunnerHello,
	type RunnerSendAnswer,
	type RunnerSocket,
	runnerFailure,
} from "./runner-protocol.js";
import type { RunnerProviderInstanceDeps } from "./runner-provider-instance.js";
import { runningRunnerCommands } from "./runner-recovery.js";
import type {
	DurableSessionTurn,
	SessionCommand,
	SessionFailure,
} from "./session-runner.js";

// Delete this compatibility module once no main-built runner can remain alive (32.13).
// These fields restore sinks and answer waiters only. A send is decided by replaying
// its unchanged journal key, exactly as ecb3840d did, never from the legacy hello.
export const legacyRunnerRetainedSends = (
	hello: RunnerHello,
): NonNullable<RunnerHello["sendCommands"]> => hello.sendCommands ?? [];

export const legacyRunnerAnswerCompletions = (
	hello: RunnerHello,
): readonly {
	readonly commandId: string;
	readonly failure?: SessionFailure;
}[] => hello.completedCommands ?? [];

export const legacyRunnerBindings = (
	hello: RunnerHello,
): NonNullable<RunnerHello["bindings"]> => hello.bindings ?? [];

const LegacyTurn = Schema.Struct({
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

/** Main's replay is the owner until its one reply passes common settlement. */
export const recoverLegacyRunnerCommands = (options: {
	readonly sql: SqlClient.SqlClient;
	readonly sessionId: string;
	readonly driverKind: string;
	readonly accounts?: RunnerProviderInstanceDeps["accounts"];
	readonly ownsPendingSend: (row: RunningRunnerCommand) => boolean;
	readonly retain: (commandId: string, attempt: number) => void;
	readonly ready: Effect.Effect<void, SessionFailure>;
	readonly replay: (row: RunningRunnerCommand) => Effect.Effect<
		{
			readonly result: TurnResult | undefined;
			readonly nativeResumeFallback: boolean;
		},
		SessionFailure
	>;
	readonly settle: (
		answer: Extract<RunnerSendAnswer, { readonly status: "finished" }>,
	) => Effect.Effect<void, SessionFailure>;
	readonly release: (commandId: string) => Effect.Effect<void>;
	readonly closing: () => boolean;
	readonly fail: (failure: SessionFailure) => void;
	readonly runFork: (effect: Effect.Effect<void>) => unknown;
}): Effect.Effect<void, SessionFailure> =>
	Effect.gen(function* () {
		const accounts = yield* options.accounts ?? Effect.succeed(undefined);
		const rows = yield* runningRunnerCommands(
			options.sql,
			options.driverKind,
			(accountId) =>
				accounts?.accounts.find(({ id }) => id === accountId)?.driver ??
				accounts?.deleted.find(({ id }) => id === accountId)?.driver ??
				(accountId === options.driverKind ? options.driverKind : undefined),
			options.sessionId,
		).pipe(
			Effect.mapError((cause) =>
				runnerFailure("recover runner commands", cause),
			),
		);
		for (const row of rows) {
			if (
				row.error_code === "delivery_indeterminate" ||
				options.ownsPendingSend(row)
			)
				continue;
			options.retain(row.command_id, row.attempt_count);
			const work = Effect.gen(function* () {
				// A cached key can reply immediately. Failure handling becomes active
				// only once the attachment has finished its recovery transition.
				yield* options.ready;
				if (options.closing()) return;
				const outcome = yield* Effect.result(options.replay(row));
				if (options.closing()) return;
				yield* options.settle({
					commandId: row.command_id,
					attempt: row.attempt_count,
					status: "finished",
					nativeResumeFallback:
						outcome._tag === "Success"
							? outcome.success.nativeResumeFallback
							: true,
					...(outcome._tag === "Success"
						? outcome.success.result
							? { result: outcome.success.result }
							: {}
						: { failure: outcome.failure }),
				});
				const pending =
					outcome._tag === "Success" &&
					(outcome.success.result === undefined ||
						["accepted", "joined", "indeterminate"].includes(
							outcome.success.result.status,
						));
				if (!pending) yield* options.release(row.command_id);
			});
			options.runFork(
				work.pipe(
					Effect.catchCause((cause) =>
						Effect.sync(() =>
							options.fail(
								runnerFailure(
									"recover runner commands",
									Failure.squashCause(cause),
								),
							),
						),
					),
				),
			);
		}
	});

/** Main's same-key replay preparation; the caller owns admission and settlement. */
export const replayLegacyRunnerSend = (options: {
	readonly sql: SqlClient.SqlClient;
	readonly row: RunningRunnerCommand;
	readonly driverKind: string;
	readonly connection: RunnerSocket;
	readonly deps: {
		readonly accounts?: RunnerProviderInstanceDeps["accounts"];
		readonly autoSettleAfterDays?: RunnerProviderInstanceDeps["autoSettleAfterDays"];
		readonly recoveryForSession?: RunnerProviderInstanceDeps["recoveryForSession"];
		readonly sessionForkSdk?: ClaudeSessionRunnerDeps["sessionForkSdk"];
		readonly claudeSettingsOverrides?: ClaudeSessionRunnerDeps["claudeSettingsOverrides"];
		readonly replayCommandFields?: (
			accountId: string,
		) => Effect.Effect<
			Partial<Extract<SessionCommand, { type: "send-turn" }>>,
			SessionFailure
		>;
	};
	readonly liveSession: Effect.Effect<ProviderNativeSession | undefined>;
	readonly resolveSinkId: (
		commandId: string,
		inputId: string,
		attempt: number,
		nativeResumeFallback?: boolean,
	) => string;
	readonly send: (
		commandId: string,
		command: Extract<SessionCommand, { type: "send-turn" }>,
		attempt: number,
	) => Effect.Effect<TurnResult | undefined, SessionFailure>;
	readonly closing: () => boolean;
}): Effect.Effect<
	{
		readonly result: TurnResult | undefined;
		readonly nativeResumeFallback: boolean;
	},
	SessionFailure
> =>
	Effect.gen(function* () {
		const { row, deps, driverKind } = options;
		const accounts = yield* deps.accounts ??
			Effect.sync(() =>
				accountsStateFromConfig(
					defaultDaemonConfig(),
					captureClaudeLaunchLogin(process.env),
				),
			);
		const accountForId = (id: string) =>
			Result.getOrUndefined(resolve(accounts, { _tag: "Id", id }));
		const payload = yield* Schema.decodeUnknownEffect(
			Schema.fromJsonString(LegacyTurn),
		)(row.payload_json);
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
			});
		const account = accountForId(payload.account?.id ?? row.provider_id);
		let input: DurableSessionTurn = {
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
			...(driverKind === "claude" && account
				? {
						account: payload.account
							? { ...payload.account, env: account.env }
							: account,
					}
				: {}),
		};
		const state = yield* makeProviderStateEffect.pipe(
			Effect.provideService(PersistenceProjectTag, {
				projectId: row.project_key,
			}),
		);
		switch (driverKind) {
			case "claude":
				break;
			default: {
				const stored = yield* state.getState(row.session_id);
				const key = `${driverKind}.forkDigest`;
				input = {
					...input,
					providerState: {
						...input.providerState,
						...(stored[key] !== undefined &&
						typeof input.providerState[key] !== "string"
							? { [key]: stored[key] }
							: {}),
					},
				};
			}
		}
		const attachments = yield* makeAttachmentStore;
		const resolved = yield* resolveTurnImages(input, attachments).pipe(
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
		const autoSettleAfterDays =
			input.autoSettleAfterDays !== undefined
				? input.autoSettleAfterDays
				: yield* deps.autoSettleAfterDays ?? Effect.succeed(undefined);
		let nativeResumeFallback = input.nativeResumeFallback === true;
		switch (driverKind) {
			case "claude":
				break;
			default: {
				const fields = deps.replayCommandFields
					? yield* deps.replayCommandFields(row.provider_id)
					: {};
				const result = yield* options.send(
					row.command_id,
					{
						...fields,
						type: "send-turn",
						sinkId: options.resolveSinkId(
							row.command_id,
							input.inputId,
							row.attempt_count,
							input.nativeResumeFallback,
						),
						aborted: false,
						autoSettleAfterDays,
						input: resolved,
					},
					row.attempt_count,
				);
				return { result, nativeResumeFallback };
			}
		}
		const { images: _images, ...claudeTurn } = input;
		const launch = yield* Effect.try(() =>
			// Main selects the folder before filling or refreshing account credentials.
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
		if (options.closing()) return { result: undefined, nativeResumeFallback };
		const instanceId = call?.account.id ?? input.instanceId ?? row.provider_id;
		const shellEnv = call?.shellEnv ?? input.shellEnv ?? { ...process.env };
		const read = yield* makeReadQueryEffect;
		const result = yield* sendPreparedClaudeTurn({
			sessionId: row.session_id,
			instanceId,
			commandId: row.command_id,
			userText: input.prompt,
			options: {
				liveSession: yield* options.liveSession,
				configDir: launch.configDir,
				folderSource: launch.folderSource,
				agent: input.agent,
				userMessageId: input.continuation?.cutOffMessageId ?? input.inputId,
				continuation: input.continuation,
				nativeResumeFallback: input.nativeResumeFallback,
				rewind: input.rewind,
				sessionForkSdk: deps.sessionForkSdk,
				workspaceRoot: input.workspaceRoot,
				modelContextWindow: input.contextWindow === "1m" ? 1000000 : undefined,
			},
			send: (prepared, fallback) => {
				nativeResumeFallback = fallback;
				return options.send(
					row.command_id,
					{
						type: "send-turn",
						sinkId: options.resolveSinkId(
							row.command_id,
							input.inputId,
							row.attempt_count,
							fallback,
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
							nativeResumeFallback: fallback,
							nativeThread: prepared.nativeThread,
							...(prepared.handoff ? { handoff: prepared.handoff } : {}),
						},
					},
					row.attempt_count,
				);
			},
		}).pipe(
			Effect.provideService(ProviderStateEffectTag, state),
			Effect.provideService(ReadQueryEffectTag, read),
		);
		return { result, nativeResumeFallback };
	}).pipe(
		Effect.provideService(SqlClient.SqlClient, options.sql),
		Effect.mapError((cause) => runnerFailure("recover turn", cause)),
	);
