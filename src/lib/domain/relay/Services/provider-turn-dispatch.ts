import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	Context,
	Deferred,
	Effect,
	Fiber,
	FiberMap,
	Ref,
	Result,
	Schema,
} from "effect";
import { SqlClient } from "effect/sql";
import { type Account, AccountSchema } from "../../../contracts/account.js";
import { AccountUnroutable } from "../../../contracts/limit-recovery.js";
import {
	PROVIDER_DRIVERS,
	type ProviderDriverKind,
	type ProviderDriverTraits,
} from "../../../contracts/provider-instance.js";
import { isPlaceholderTitle } from "../../../contracts/session-title.js";
import {
	type SessionWorkspace,
	SessionWorkspaceSchema,
} from "../../../contracts/session-workspace.js";
import {
	MissingWorktreeError,
	WorktreeRecoveryError,
} from "../../../contracts/worktree.js";
import * as Failure from "../../../effect/failure-classification.js";
import { formatErrorDetail, RelayError } from "../../../errors.js";
import { realWorkspacePath } from "../../../git/worktrees.js";
import { ClaudeEventPersistEffectTag } from "../../../persistence/effect/claude-event-persist-effect.js";
import { requeueFailedSteers } from "../../../persistence/effect/input-requeue-effect.js";
import { ProviderStateEffectTag } from "../../../persistence/effect/provider-state-effect.js";
import {
	ReadQueryEffectTag,
	sessionGoalState,
} from "../../../persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../persistence/events.js";
import type { SessionRow } from "../../../persistence/read-model-types.js";
import { ProviderInstanceFailure } from "../../../provider/errors.js";
import { openCodeInputMessageId } from "../../../provider/opencode/opencode-input-message-id.js";
import { createRelayEventSink } from "../../../provider/relay-event-sink.js";
import {
	catalogFromProviderList,
	harnessForModelProvider,
	ModelNotInCatalog,
	resolveTurnSettings,
	type TurnSettings,
} from "../../../provider/turn-settings.js";
import type { ModelInfo, SendTurnInput } from "../../../provider/types.js";
import {
	effectiveSessionFolders,
	effectiveWorkingDirectory,
} from "../../../session/session-workspace.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import { WorktreeServiceTag } from "../../daemon/Services/worktree-service.js";
import { publishAlert } from "./alerts.js";
import { PendingInteractionServiceTag } from "./pending-interaction-service.js";
import { ProjectSettingsTag } from "./project-settings.js";
import { ProviderRuntimeIngestionTag } from "./provider-runtime-ingestion-service.js";
import type { ProviderTurnServiceSendInput } from "./provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "./services.js";
import {
	clearProcessingTimeout,
	getPermissionMode,
	makeProcessingTimeoutHooks,
	OverridesStateTag,
	PROCESSING_TIMEOUT_DURATION,
	setPermissionMode,
	startProcessingTimeout,
} from "./session-overrides-state.js";
import { storedSessionPick } from "./session-pick.js";
import { SessionSetupTag } from "./session-setup.js";
import { SessionTitleServiceTag } from "./session-title-service.js";
import {
	inspectSessionWorktree,
	recreateSessionWorktrees,
	SessionWorkspaceTag,
} from "./session-workspace.js";
import { SSEStreamTag } from "./sse-stream-service.js";
import { makeFailTurn, makeSilenceNotice } from "./turn-failure.js";

export const CLAUDE_PROVIDER_ID = "claude";
export const OPENCODE_PROVIDER_ID = "opencode";

/** The launch fields shared by a draft warm and its eventual first send. */
export const buildSessionLaunchInput = (
	account: Account,
	pick: TurnSettings,
	permissionMode: NonNullable<SendTurnInput["permissionMode"]>,
	folders: {
		readonly workspaceRoot: string;
		readonly extraFolders: readonly string[];
	},
	agent?: string,
) => ({
	account,
	instanceId: account.id,
	model: pick.model,
	...folders,
	...(account.driver === "claude"
		? { configDir: account.folder, folderSource: "account" as const }
		: {}),
	permissionMode,
	...(agent ? { agent } : {}),
	variant: pick.effort,
	contextWindow: pick.contextWindow,
});

/** Apply the same folder mapping and missing-extra-folder policy before any launch. */
export const resolveLaunchFolders = (
	state: SessionWorkspace | null,
	sessionId?: string,
	workingDirectory?: string,
) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const workspaceRoot =
			workingDirectory ?? effectiveWorkingDirectory(config.projectDir, state);
		const effectiveFolders = effectiveSessionFolders(
			[config.projectDir, ...(config.extraFolders ?? [])],
			state,
		);
		const extraFolders: string[] = [];
		const launchFolders = state
			? effectiveFolders
					.map(({ directory }) => directory)
					.filter((folder) => folder !== workspaceRoot)
			: (config.extraFolders ?? []);
		for (const folder of launchFolders) {
			if (existsSync(folder)) extraFolders.push(folder);
			else {
				const message = `Extra folder "${folder}" does not exist and was skipped.`;
				const log = yield* LoggerTag;
				if (sessionId === undefined) {
					log.debug(message);
					continue;
				}
				log.warn(`session=${sessionId} ${message}`);
				yield* publishAlert({
					_tag: "alert",
					kind: "warning",
					alertId: randomUUID(),
					sessionId,
					message,
				});
			}
		}
		return { workspaceRoot, extraFolders, effectiveFolders };
	});

/** Shared folder mapping for launches and browser requests; recheck session folders at launch. */
export const resolveSessionFolders = (
	session: Pick<SessionRow, "id" | "workspace">,
	{
		fallbackMissingWorktree = false,
		recreateMissingWorktree = false,
	}: {
		readonly fallbackMissingWorktree?: boolean;
		readonly recreateMissingWorktree?: boolean;
	} = {},
) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const workspace = yield* Effect.serviceOption(SessionWorkspaceTag);
		const read = yield* Effect.serviceOption(ReadQueryEffectTag);
		// Snapshot-only callers can resolve without relay services. Live relays
		// provide both services, including in the provider turn's captured context.
		// A second tab may have read session.created before the draft's launch
		// move finished. Wait and reread; rollback must never fall back to main.
		const savedWorkspace =
			workspace._tag === "Some" && read._tag === "Some"
				? yield* workspace.value.withLaunch(
						session.id,
						Effect.gen(function* () {
							const row = yield* read.value.getSession(session.id);
							if (!row)
								return yield* Effect.fail(
									new RelayError(`Session ${session.id} not found`, {
										code: "SESSION_NOT_FOUND",
									}),
								);
							return row.workspace;
						}),
					)
				: session.workspace;
		let state =
			savedWorkspace == null
				? null
				: yield* Schema.decodeUnknownEffect(
						Schema.fromJsonString(SessionWorkspaceSchema),
					)(savedWorkspace);
		let workspaceRoot = effectiveWorkingDirectory(config.projectDir, state);
		const missing = yield* inspectSessionWorktree(
			{ id: session.id, workspace: state },
			config,
		);
		// A deleted branch can never be recreated, so a fresh turn continues in
		// the main folder. The "missing" cause tells the UI the session moved.
		if (
			missing?.reason === "branch-missing" &&
			fallbackMissingWorktree &&
			workspace._tag === "Some" &&
			existsSync(config.projectDir)
		) {
			workspaceRoot = yield* workspace.value.withLaunch(
				session.id,
				workspace.value.move(session.id, config.projectDir, "missing"),
			);
			state = null;
		} else if (missing) {
			const branch =
				missing.folders?.find(({ reason }) => reason === "branch-missing")
					?.branch ?? missing.branch;
			const error = new MissingWorktreeError({
				path: workspaceRoot,
				message:
					missing.reason === "branch-missing"
						? `Worktree missing: ${workspaceRoot}. Branch${branch ? ` ${branch}` : ""} no longer exists, so it cannot be recreated. Continue in main folder before sending another message.`
						: `Worktree missing: ${workspaceRoot}. Recreate worktree or Continue in main folder before sending another message.`,
			});
			const worktrees = yield* Effect.serviceOption(WorktreeServiceTag);
			if (
				!recreateMissingWorktree ||
				!missing.canRecreate ||
				workspace._tag === "None" ||
				read._tag === "None" ||
				worktrees._tag === "None"
			)
				return yield* error;
			// The locked reread above has finished. Recreation owns the same
			// non-reentrant launch lock, so it must run outside that block.
			const recreated = yield* recreateSessionWorktrees(session.id).pipe(
				Effect.provideService(SessionWorkspaceTag, workspace.value),
				Effect.provideService(ReadQueryEffectTag, read.value),
				Effect.provideService(WorktreeServiceTag, worktrees.value),
				Effect.mapError((cause) =>
					cause instanceof WorktreeRecoveryError &&
					cause.reason === "branch-missing"
						? new MissingWorktreeError({
								path: workspaceRoot,
								message: `Worktree missing: ${workspaceRoot}. ${cause.message}`,
							})
						: error,
				),
			);
			workspaceRoot = recreated.directory;
		}
		if (!existsSync(workspaceRoot)) {
			const fallback =
				fallbackMissingWorktree &&
				workspace._tag === "Some" &&
				state?.origin === "existing" &&
				workspaceRoot !== config.projectDir;
			if (!fallback || !existsSync(config.projectDir))
				return yield* Effect.fail(
					new RelayError(
						`Main project folder does not exist: ${fallback ? config.projectDir : workspaceRoot}`,
						{
							code: "FILE_NOT_FOUND",
						},
					),
				);
			workspaceRoot = yield* workspace.value.withLaunch(
				session.id,
				workspace.value.move(session.id, config.projectDir, "missing"),
			);
			state = null;
		}
		return yield* resolveLaunchFolders(state, session.id, workspaceRoot);
	});

/** Browser requests identify a session; project-level requests keep the primary folder. */
export const resolveSessionRequestFolders = (sessionId: string | undefined) =>
	Effect.gen(function* () {
		if (sessionId === undefined) {
			const config = yield* ConfigTag;
			const extraFolders = config.extraFolders ?? [];
			return {
				workspaceRoot: config.projectDir,
				extraFolders,
				effectiveFolders: effectiveSessionFolders(
					[config.projectDir, ...extraFolders],
					null,
				),
			};
		}
		const session = yield* (yield* ReadQueryEffectTag).getSession(sessionId);
		if (!session)
			return yield* Effect.fail(
				new RelayError(`Session ${sessionId} not found`, {
					code: "SESSION_NOT_FOUND",
				}),
			);
		return yield* resolveSessionFolders(session);
	});

export class ProviderTurnDispatchFibersTag extends Context.Service<
	ProviderTurnDispatchFibersTag,
	FiberMap.FiberMap<string, void, unknown>
>()("ProviderTurnDispatchFibers") {}

const loadClaudeHistoryMetadata = (sessionId: string) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const readQuery = yield* ReadQueryEffectTag;
		const result = yield* Effect.result(
			readQuery.getSessionHistoryMetadata(sessionId),
		);
		if (result._tag === "Success") {
			return result.success;
		}
		log.warn(
			`Failed to load prior Claude history metadata for ${sessionId}: ${
				result.failure instanceof Error
					? result.failure.message
					: result.failure
			}`,
		);
		return undefined;
	});

const hasNewerHandoff = (
	input: ProviderTurnServiceSendInput,
	sql: SqlClient.SqlClient,
) => {
	const handoff = input.events?.find((event) => event.type === "input.sent");
	return handoff
		? sql`SELECT 1 FROM events WHERE session_id = ${input.sessionId}
		AND type = 'input.sent' AND sequence > (SELECT sequence FROM events
			WHERE event_id = ${handoff.eventId}) LIMIT 1`.pipe(
				Effect.map((rows) => rows.length > 0),
				Effect.orElseSucceed(() => true),
			)
		: Effect.succeed(false);
};

/**
 * Restore a failed delivery's placement or queue position. The durable receipt
 * already owns ordinary provider failure; transport/commit failures still need
 * their own owned error event.
 */
const restoreFailedPlacement = (
	input: ProviderTurnServiceSendInput,
	driver: ProviderDriverKind | undefined,
	runId?: string,
	failure?: { readonly message: string; readonly code: string },
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const sql = yield* SqlClient.SqlClient;
		const handoff = input.events?.find((event) => event.type === "input.sent");
		if (handoff) {
			const [requeued] = yield* sql`SELECT 1 FROM events
				WHERE session_id = ${input.sessionId} AND type = 'input.requeued'
				AND json_extract(data, '$.sentSequence') = (SELECT sequence FROM events
					WHERE event_id = ${handoff.eventId}) LIMIT 1`;
			// Recovery can publish before this old dispatch unwinds. Its timeout
			// and failure must never affect a turn the user has already retried.
			if (requeued) return false;
		}
		const inputId = input.continuation ? undefined : input.commandId;
		const userMessageId =
			input.continuation?.cutOffMessageId ??
			(driver === "opencode" && runId
				? openCodeInputMessageId(input.commandId)
				: input.commandId);
		const unplaced =
			inputId !== undefined &&
			(yield* sql`SELECT 1 FROM messages
				WHERE session_id = ${input.sessionId}
					AND (id = ${inputId} OR input_id = ${inputId})
				LIMIT 1`.pipe(
				Effect.map((rows) => rows.length === 0),
				Effect.orElseSucceed(() => false),
			));
		if (unplaced) {
			// A failed steer stays in the inbox. Settlement requeues it only once
			// its provider can no longer deliver it; no synthetic message consumes it.
			if (input.steer) {
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* requeueFailedSteers(
					sql,
					persist,
					input.sessionId,
					input.commandId,
				);
				return false;
			}
			if (driver === "codex" && runId) {
				const [failedRewind] = yield* sql`
					SELECT 1 FROM provider_command_outbox o
					JOIN provider_runs r ON r.id = o.run_id AND r.session_id = o.session_id
					WHERE o.session_id = ${input.sessionId} AND o.run_id = ${runId}
						AND o.effect_type = 'send_turn'
						AND json_extract(o.payload_json, '$.inputId') = ${input.commandId}
						AND json_type(o.payload_json, '$.rewind') = 'object'
						AND r.status = 'error' AND r.started_at IS NULL LIMIT 1`;
				// A failed native revert must leave its input unplaced.
				if (failedRewind) return false;
			}
			const persist = yield* ClaudeEventPersistEffectTag;
			yield* persist
				.persistUserMessage(input.sessionId, input.text, {
					messageId: userMessageId,
					inputId,
					...(driver ? { provider: driver } : {}),
					...(runId ? { runId } : {}),
					...(!runId && failure ? { failure } : {}),
					...(input.images ? { images: input.images } : {}),
				})
				.pipe(
					Effect.catch((cause) =>
						Effect.sync(() =>
							log.warn(
								`session=${input.sessionId} Failed to place unsent user message: ${formatErrorDetail(cause)}`,
							),
						),
					),
				);
			// An unreserved input's placement and terminal committed together.
			if (!runId && failure) return false;
		}
		return { runId };
	});

export const makeEventSinkFactory = Effect.gen(function* () {
	const pendingInteractionService = yield* PendingInteractionServiceTag;
	const runtime = yield* Effect.context<OverridesStateTag>();
	const overridesRef = yield* OverridesStateTag;
	const persist = yield* ClaudeEventPersistEffectTag;
	const ingestion = yield* ProviderRuntimeIngestionTag;
	return (sessionId: string, driver: string) =>
		createRelayEventSink({
			sessionId,
			providerId: driver,
			...makeProcessingTimeoutHooks(runtime, sessionId),
			applyReportedPermissionMode: (mode) =>
				setPermissionMode(sessionId, mode).pipe(
					Effect.provideService(OverridesStateTag, overridesRef),
				),
			persist,
			ingestion: {
				ingest: (event, onPrompt) =>
					Effect.contextWith((caller: Context.Context<never>) =>
						ingestion
							.ingest(event, onPrompt)
							.pipe(Effect.provide(Context.merge(runtime, caller))),
					),
			},
			pendingInteractions: {
				beginPermissionRequest: (request) =>
					pendingInteractionService.beginPermissionRequest(request),
				resolvePermissionRequest: (requestId, response) =>
					pendingInteractionService.resolvePermissionRequest(
						requestId,
						response,
					),
				beginQuestionRequest: (request) =>
					pendingInteractionService.beginQuestionRequest(request),
				resolveQuestionRequest: (requestId, answers) =>
					pendingInteractionService.resolveQuestionRequest(requestId, answers),
				cancelSessionInteractions: (reason, options) =>
					pendingInteractionService.cancelSessionInteractions(
						sessionId,
						reason,
						options,
					),
			},
		});
});

const handleDispatchFailure = (
	input: ProviderTurnServiceSendInput,
	sendErr: unknown,
	driver: ProviderDriverKind | undefined,
	runId?: string,
	failureCode?: string,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		log.warn(
			`client=${input.clientId} session=${input.sessionId} Failed to send message:`,
			formatErrorDetail(sendErr),
		);
		const missing = sendErr instanceof MissingWorktreeError;
		const error = missing
			? { message: sendErr.message, code: "WORKTREE_MISSING" }
			: RelayError.fromCaught(
					sendErr,
					"SEND_FAILED",
					failureCode ? undefined : "Failed to send message",
				);
		if (
			!input.steer &&
			!(yield* hasNewerHandoff(input, yield* SqlClient.SqlClient))
		)
			yield* clearProcessingTimeout(input.sessionId);
		const placement = yield* restoreFailedPlacement(input, driver, runId, {
			message: error.message,
			code: failureCode ?? error.code,
		});
		if (placement)
			yield* (yield* makeFailTurn)(
				input.sessionId,
				error.message,
				failureCode ?? error.code,
				placement.runId
					? { runId: placement.runId }
					: { inputId: input.commandId },
			);
		if (missing) {
			const ws = yield* Effect.serviceOption(WebSocketHandlerTag);
			if (
				ws._tag === "Some" &&
				ws.value.getClientsForSession(input.sessionId).length > 0
			)
				yield* publishAlert({
					_tag: "alert",
					kind: "error",
					alertId: randomUUID(),
					sessionId: input.sessionId,
					message: error.message,
				});
		}
	});

const prepareEngineTurnInput = (
	resolvedInput: ProviderTurnServiceSendInput,
	initialAccount: Account,
) =>
	Effect.gen(function* () {
		// The committed turn owns its account even before a runner has a snapshot.
		let account = initialAccount;
		if (resolvedInput.steer) {
			const sql = yield* SqlClient.SqlClient;
			const [turn] = yield* sql<{ account_json: string | null }>`
				SELECT json_extract(o.payload_json, '$.account') AS account_json
				FROM provider_command_outbox o JOIN provider_runs r ON r.id = o.run_id
				WHERE o.session_id = ${resolvedInput.sessionId} AND o.effect_type = 'send_turn'
					AND r.status IN ('pending', 'running')
				ORDER BY CASE WHEN r.status = 'running' THEN 0 ELSE 1 END, o.request_sequence DESC LIMIT 1`;
			if (turn?.account_json) {
				const admittedAccount = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(AccountSchema),
				)(turn.account_json);
				const currentAccount = yield* (yield* AccountDirectory)
					.resolve({ _tag: "Id", id: admittedAccount.id })
					.pipe(
						Effect.mapError(
							(cause) =>
								new ProviderInstanceFailure({
									providerId: admittedAccount.driver,
									operation: "resolveSteeringAccount",
									cause,
								}),
						),
					);
				if (
					currentAccount.id !== admittedAccount.id ||
					currentAccount.driver !== admittedAccount.driver
				)
					return yield* Effect.fail(
						new ProviderInstanceFailure({
							providerId: admittedAccount.driver,
							operation: "resolveSteeringAccount",
							cause: new AccountUnroutable({
								ref: { _tag: "Id", id: admittedAccount.id },
							}),
						}),
					);
				account = {
					...admittedAccount,
					env: currentAccount.env,
				};
			}
		}
		const driver = account.driver;
		const providerId = account.id;
		const traits: ProviderDriverTraits = PROVIDER_DRIVERS[driver];
		const readQuery = yield* ReadQueryEffectTag;
		const sessionRow = yield* readQuery.getSession(resolvedInput.sessionId);
		if (sessionRow?.pending_rewind_message_id && resolvedInput.continuation) {
			yield* clearProcessingTimeout(resolvedInput.sessionId);
			return undefined;
		}
		const harness = driver;
		const pick = storedSessionPick(sessionRow, harness);
		if (!pick) {
			yield* handleDispatchFailure(
				resolvedInput,
				"A session model pick is required before sending a message.",
				driver,
				undefined,
				"PICK_REQUIRED",
			);
			return undefined;
		}
		let catalog: readonly ModelInfo[] | undefined;
		if (traits.catalogSource === "discovery") {
			const projectSettings = yield* Effect.serviceOption(ProjectSettingsTag);
			const catalogues =
				projectSettings._tag === "Some"
					? yield* Ref.get(projectSettings.value.live)
					: undefined;
			const providers =
				catalogues?.[`providerModels:${account.id}`] ??
				catalogues?.providerModels;
			if (providers !== undefined)
				catalog = catalogFromProviderList(providers.providers);
		} else {
			// A missing OpenCode catalog must never accept an unchecked pick.
			catalog = [];
			const models = yield* Effect.serviceOption(OpenCodeModelServiceTag);
			if (models._tag === "Some") {
				const cached = yield* models.value.cachedProviders(providerId);
				const available =
					cached._tag === "Some"
						? Result.succeed(cached.value)
						: yield* Effect.result(
								models.value.listProviders({
									instanceId: providerId,
									startIfStopped: true,
									requireFresh: true,
								}),
							);
				if (Result.isSuccess(available))
					catalog = available.success.providers.flatMap((provider) =>
						(provider.models ?? []).map((model) => ({
							...model,
							providerId: provider.id || provider.name,
						})),
					);
			}
		}
		const resolved =
			harnessForModelProvider(pick.model.providerId) !== harness
				? Result.fail(new ModelNotInCatalog({ harness, ...pick.model }))
				: catalog === undefined
					? Result.succeed(pick)
					: resolveTurnSettings(pick, catalog);
		if (Result.isFailure(resolved)) {
			yield* handleDispatchFailure(
				resolvedInput,
				resolved.failure.message,
				driver,
				undefined,
				"PICK_REJECTED",
			);
			return undefined;
		}
		const settings = resolved.success;
		const priorHistoryMetadata = traits.needsPriorHistoryMetadata
			? yield* loadClaudeHistoryMetadata(resolvedInput.sessionId)
			: undefined;
		const folders = yield* resolveSessionFolders(
			{
				id: resolvedInput.sessionId,
				workspace: sessionRow?.workspace ?? null,
			},
			{
				fallbackMissingWorktree: !resolvedInput.steer,
				recreateMissingWorktree: true,
			},
		);
		if (traits.runsOpenCodeServer) {
			const stream = yield* Effect.serviceOption(SSEStreamTag);
			if (stream._tag === "Some")
				yield* stream.value.includeDirectory(folders.workspaceRoot);
		}
		const inputId = resolvedInput.commandId;
		if (
			sessionRow &&
			!resolvedInput.continuation &&
			isPlaceholderTitle(sessionRow.title)
		) {
			const titleService = yield* SessionTitleServiceTag;
			yield* titleService.titleFromMessage({
				sessionId: resolvedInput.sessionId,
				message: resolvedInput.text,
			});
		}

		const providerStateEffect = yield* ProviderStateEffectTag;
		const providerState = yield* providerStateEffect.getState(
			resolvedInput.sessionId,
		);
		const eventSink = (yield* makeEventSinkFactory)(
			resolvedInput.sessionId,
			driver,
		);
		const imageList =
			resolvedInput.images && resolvedInput.images.length > 0
				? Array.from(resolvedInput.images)
				: undefined;
		let workspaceMoveSequence: number | undefined;
		let workspaceMoveDirective: string | undefined;
		if (traits.worktreeMoves === "tool-directive" && !resolvedInput.steer) {
			const workspace = yield* Effect.serviceOption(SessionWorkspaceTag);
			if (workspace._tag === "Some") {
				const state = yield* workspace.value.claudeWorktreeState(
					resolvedInput.sessionId,
				);
				if (state.directivePending) {
					const config = yield* ConfigTag;
					const checkouts = yield* Effect.forEach(
						[config.projectDir, ...(config.extraFolders ?? [])],
						(folder) =>
							realWorkspacePath(folder).pipe(
								Effect.orElseSucceed(() => folder),
							),
					);
					const directive = checkouts.includes(state.requestedPath)
						? '[Conduit workspace move] Call ExitWorktree with action "keep" before continuing.'
						: `[Conduit workspace move] Call EnterWorktree with path ${JSON.stringify(state.requestedPath)} before continuing.`;
					workspaceMoveSequence = state.userMoveSequence;
					workspaceMoveDirective = directive;
				}
			}
		}
		const sendTurnInput: SendTurnInput = {
			sessionId: resolvedInput.sessionId,
			inputId,
			prompt: resolvedInput.text,
			...(workspaceMoveDirective === undefined
				? {}
				: { workspaceMoveDirective }),
			...(resolvedInput.continuation
				? { continuation: resolvedInput.continuation }
				: {}),
			history: [],
			providerState,
			...buildSessionLaunchInput(
				account,
				settings,
				yield* getPermissionMode(resolvedInput.sessionId),
				folders,
				resolvedInput.agent,
			),
			...(yield* (yield* OrchestrationEngineTag).resolveCallContextEffect({
				sessionId: resolvedInput.sessionId,
				account: account,
				workspaceRoot: folders.workspaceRoot,
				extraFolders: folders.extraFolders,
				prepareShellEnv: true,
				requireRoutableAccount: true,
			})),
			...(traits.supportsGoalState && sessionRow
				? { goalState: sessionGoalState(sessionRow) }
				: {}),
			...(traits.needsPriorHistoryMetadata
				? {
						cumulativeTokens: priorHistoryMetadata?.cumulativeTokens ?? 0,
					}
				: {}),
			eventSink,
			abortSignal: new AbortController().signal,
			...(sessionRow?.side_thread === 1 ? { sideThread: true } : {}),
			...(imageList ? { images: imageList } : {}),
		};

		return { sendTurnInput, workspaceMoveSequence };
	});

const dispatchEngineTurn = (
	resolvedInput: ProviderTurnServiceSendInput,
	providerId: string,
	account: Account,
	sendTurnInput: SendTurnInput,
	workspaceMoveSequence: number | undefined,
) =>
	Effect.gen(function* () {
		const driver = account.driver;
		const orchestrationEngine = yield* OrchestrationEngineTag;
		const dispatchFibers = yield* ProviderTurnDispatchFibersTag;
		const config = yield* ConfigTag;
		const readQuery = yield* ReadQueryEffectTag;
		const previousProviderId =
			yield* orchestrationEngine.getProviderForSessionEffect(
				resolvedInput.sessionId,
			);
		const restorePreviousBinding = Effect.gen(function* () {
			// Steers share the running turn's binding. A later handoff owns any
			// binding change made while an earlier dispatch unwinds.
			if (resolvedInput.steer) return;
			const sql = yield* SqlClient.SqlClient;
			if (yield* hasNewerHandoff(resolvedInput, sql)) return;
			if (previousProviderId) {
				orchestrationEngine.bindSession(
					resolvedInput.sessionId,
					previousProviderId,
				);
			} else {
				orchestrationEngine.unbindSession(resolvedInput.sessionId);
			}
		});
		yield* Effect.sync(() =>
			orchestrationEngine.bindSession(resolvedInput.sessionId, providerId),
		);

		// Resolved once the engine commits the handoff, or once the dispatch ends
		// without committing it. The caller waits on it so a submit behind this
		// one reads the committed handoff, not the moment before it.
		const accepted = yield* Deferred.make<void>();

		const events = (resolvedInput.events ?? []).map((event) =>
			event.type === "input.sent" && workspaceMoveSequence !== undefined
				? { ...event, data: { ...event.data, workspaceMoveSequence } }
				: event,
		);
		// A hidden continuation still has an exact handoff. Its event id pins
		// the timeout to this reservation even if the same input is retried.
		const existingHandoff = events.find((event) => event.type === "input.sent");
		const handoff =
			existingHandoff ??
			canonicalEvent(
				"input.sent",
				resolvedInput.sessionId,
				{
					sessionId: resolvedInput.sessionId,
					inputId: sendTurnInput.inputId,
					...(workspaceMoveSequence !== undefined
						? { workspaceMoveSequence }
						: {}),
				},
				{ provider: driver },
			);
		if (!existingHandoff) events.push(handoff);
		const handoffEventId = handoff.eventId;
		const dispatchedInput = { ...resolvedInput, events };
		let reservedRunId: string | undefined;
		const timeoutRuntime = yield* Effect.context<
			| SqlClient.SqlClient
			| OverridesStateTag
			| LoggerTag
			| ProviderRuntimeIngestionTag
			| OrchestrationEngineTag
		>();
		const dispatchProgram = Effect.try({
			try: () =>
				orchestrationEngine.dispatchEffect({
					type: "send_turn",
					commandId: resolvedInput.commandId,
					providerId,
					input: sendTurnInput,
					...(events.length > 0 ? { events } : {}),
					onAccepted: Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const [reservation] = yield* sql<{ run_id: string | null }>`
								SELECT json_extract(data, '$.runId') AS run_id FROM events
								WHERE session_id = ${resolvedInput.sessionId} AND type = 'run.requested'
									AND json_extract(data, '$.inputId') = ${sendTurnInput.inputId}
									AND sequence > (SELECT sequence FROM events WHERE event_id = ${handoffEventId})
								ORDER BY sequence LIMIT 1`;
						reservedRunId = reservation?.run_id ?? undefined;
						if (!resolvedInput.steer && reservedRunId) {
							const [active] = yield* sql`
									SELECT 1 FROM provider_runs run JOIN provider_runs reservation
										ON run.id = COALESCE(reservation.joined_into, reservation.id) AND run.session_id = reservation.session_id
										WHERE reservation.session_id = ${resolvedInput.sessionId} AND reservation.id = ${reservedRunId}
										AND run.status IN ('pending', 'running')`;
							if (active) {
								yield* startProcessing(resolvedInput, reservedRunId);
							}
						}
						yield* Deferred.succeed(accepted, undefined);
					}).pipe(Effect.provide(timeoutRuntime), Effect.orDie),
				}),
			catch: (cause) => cause,
		}).pipe(
			Effect.flatten,
			Effect.flatMap((result) =>
				result.status === "steer-declined"
					? (dispatchedInput.onSteerDeclined ?? Effect.void)
					: result.error
						? restoreFailedPlacement(
								dispatchedInput,
								driver,
								reservedRunId,
							).pipe(Effect.asVoid)
						: Effect.void,
			),
			Effect.catch((error) =>
				restorePreviousBinding.pipe(
					Effect.andThen(
						handleDispatchFailure(
							dispatchedInput,
							error,
							driver,
							reservedRunId,
						),
					),
				),
			),
			Effect.onInterrupt(() => restorePreviousBinding),
			Effect.ensuring(Deferred.succeed(accepted, undefined)),
			// The turn's outbox row is terminal here, so cleanup can now stop a
			// settled session's agent. Adopted runners wait for the hourly run.
			Effect.ensuring(
				Effect.gen(function* () {
					if (
						config.requestWorktreeCleanup &&
						(yield* readQuery.getSession(resolvedInput.sessionId))
							?.settled_at != null
					)
						yield* config.requestWorktreeCleanup();
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("Could not request cleanup after turn", {
							sessionId: resolvedInput.sessionId,
							cause: Failure.renderCause(cause),
						}),
					),
				),
			),
		);
		// A requeued input keeps its id, but its next handoff must not reuse
		// the failed dispatch fiber while that fiber is still unwinding.
		const handoffId =
			events.find((event) => event.type === "input.sent")?.eventId ??
			sendTurnInput.inputId;
		const fiber = yield* FiberMap.run(
			dispatchFibers,
			`${resolvedInput.sessionId}:${handoffId}`,
			dispatchProgram,
			{ onlyIfMissing: true },
		);
		// The race interrupts its loser, which an uninterruptible caller (a
		// continuation) would otherwise wait out for the whole turn. The
		// dispatch runs in the map, so only the wait is interrupted.
		yield* Effect.interruptible(
			Effect.raceFirst(
				Deferred.await(accepted),
				Fiber.await(fiber).pipe(Effect.asVoid),
			),
		);
	});

const sendViaEngine = (
	input: ProviderTurnServiceSendInput,
	providerId: string,
	account: Account,
) =>
	Effect.gen(function* () {
		const prepared = yield* prepareEngineTurnInput(input, account).pipe(
			Effect.catchIf(
				(cause) =>
					cause instanceof MissingWorktreeError ||
					(cause instanceof RelayError && cause.code === "FILE_NOT_FOUND"),
				(cause) => handleDispatchFailure(input, cause, account.driver),
			),
		);
		if (!prepared) return;
		yield* dispatchEngineTurn(
			input,
			providerId,
			prepared.sendTurnInput.account ?? account,
			prepared.sendTurnInput,
			prepared.workspaceMoveSequence,
		);
	});

/** Arm a notice for silence; only native evidence or Stop can end the run. */
const startProcessing = (input: ProviderTurnServiceSendInput, runId: string) =>
	Effect.gen(function* () {
		const notice = yield* makeSilenceNotice;
		yield* startProcessingTimeout(
			input.sessionId,
			PROCESSING_TIMEOUT_DURATION,
			() => notice(input.sessionId, runId, Boolean(input.continuation)),
		);
	});

export const sendTurn = (input: ProviderTurnServiceSendInput) =>
	Effect.gen(function* () {
		const setup = yield* Effect.serviceOption(SessionSetupTag);
		if (setup._tag === "Some") yield* setup.value.wait(input.sessionId);
		const engine = yield* OrchestrationEngineTag;
		const boundProviderId =
			(yield* (yield* ReadQueryEffectTag).getSession(input.sessionId))
				?.provider ??
			(yield* engine.getProviderForSessionEffect(input.sessionId));
		if (!boundProviderId) {
			yield* handleDispatchFailure(
				input,
				"A session model pick is required before sending a message.",
				undefined,
				undefined,
				"PICK_REQUIRED",
			);
			return;
		}
		const resolved =
			input.account === undefined
				? yield* Effect.result(
						(yield* AccountDirectory).resolve({
							_tag: "Id",
							id: boundProviderId,
						}),
					)
				: Result.succeed(input.account);
		if (Result.isFailure(resolved)) {
			yield* handleDispatchFailure(input, resolved.failure, undefined);
			return;
		}
		yield* sendViaEngine(input, boundProviderId, resolved.success).pipe(
			Effect.provideService(OrchestrationEngineTag, engine),
		);
	});
