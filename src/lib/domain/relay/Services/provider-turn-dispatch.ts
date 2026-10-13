import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { SqlClient } from "@effect/sql";
import {
	Context,
	Deferred,
	Effect,
	Either,
	Fiber,
	FiberMap,
	Ref,
	type Runtime,
	Schema,
} from "effect";
import type { ProviderDriverKind } from "../../../contracts/provider-instance.js";
import { isPlaceholderTitle } from "../../../contracts/session-title.js";
import { SessionWorkspaceSchema } from "../../../contracts/session-workspace.js";
import {
	MissingWorktreeError,
	WorktreeRecoveryError,
} from "../../../contracts/worktree.js";
import {
	loadDaemonConfig,
	resolveClaudeInstanceConfigDir,
	resolveProviderRoutingDriver,
} from "../../../daemon/config-persistence.js";
import { formatErrorDetail, RelayError } from "../../../errors.js";
import { realWorkspacePath } from "../../../git/worktrees.js";
import { ClaudeEventPersistEffectTag } from "../../../persistence/effect/claude-event-persist-effect.js";
import { ProviderStateEffectTag } from "../../../persistence/effect/provider-state-effect.js";
import {
	ReadQueryEffectTag,
	sessionGoalState,
} from "../../../persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../persistence/events.js";
import type { SessionRow } from "../../../persistence/read-model-types.js";
import { createRelayEventSink } from "../../../provider/relay-event-sink.js";
import {
	catalogFromProviderList,
	harnessForModelProvider,
	ModelNotInCatalog,
	resolveTurnSettings,
} from "../../../provider/turn-settings.js";
import type {
	ModelInfo,
	SendTurnInput,
	TurnResult,
} from "../../../provider/types.js";
import {
	effectiveSessionFolders,
	effectiveWorkingDirectory,
} from "../../../session/session-workspace.js";
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
	type OverridesState,
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
import { makeFailTurn } from "./turn-failure.js";

export const CLAUDE_PROVIDER_ID = "claude";
export const OPENCODE_PROVIDER_ID = "opencode";

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
				: yield* Schema.decodeUnknown(Schema.parseJson(SessionWorkspaceSchema))(
						savedWorkspace,
					);
		let workspaceRoot = effectiveWorkingDirectory(config.projectDir, state);
		const missing = yield* inspectSessionWorktree(
			{ id: session.id, workspace: state },
			config,
		);
		if (missing) {
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
			workspaceRoot = yield* workspace.value.move(
				session.id,
				config.projectDir,
				"missing",
			);
			state = null;
		}
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
				// Not the turn's failure: the launch goes on without the folder, so
				// the user is warned rather than shown a failed turn.
				const message = `Extra folder "${folder}" does not exist and was skipped.`;
				const log = yield* LoggerTag;
				log.warn(`session=${session.id} ${message}`);
				yield* publishAlert({
					_tag: "alert",
					kind: "warning",
					alertId: randomUUID(),
					sessionId: session.id,
					message,
				});
			}
		}
		return { workspaceRoot, extraFolders, effectiveFolders };
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

export class ProviderTurnDispatchFibersTag extends Context.Tag(
	"ProviderTurnDispatchFibers",
)<ProviderTurnDispatchFibersTag, FiberMap.FiberMap<string, void, unknown>>() {}

export class ProviderTurnTimeoutRuntimeTag extends Context.Tag(
	"ProviderTurnTimeoutRuntime",
)<
	ProviderTurnTimeoutRuntimeTag,
	{
		readonly runtime: Runtime.Runtime<OverridesStateTag>;
		readonly overridesRef: Ref.Ref<OverridesState>;
	}
>() {}

export function isProviderTurnInterruptProvider(
	driver: ProviderDriverKind,
): boolean {
	return driver === CLAUDE_PROVIDER_ID;
}

export function isClaudeDriver(driver: ProviderDriverKind): boolean {
	return driver === CLAUDE_PROVIDER_ID;
}

const loadClaudeHistoryMetadata = (sessionId: string) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const readQuery = yield* ReadQueryEffectTag;
		const result = yield* Effect.either(
			readQuery.getSessionHistoryMetadata(sessionId),
		);
		if (result._tag === "Right") {
			return result.right;
		}
		log.warn(
			`Failed to load prior Claude history metadata for ${sessionId}: ${
				result.left instanceof Error ? result.left.message : result.left
			}`,
		);
		return undefined;
	});

/**
 * End a send that failed. Each failure gets exactly one turn.error: a provider
 * that already ended the turn it was handed (failed, interrupted or completed
 * it) recorded that end through this send's sink. A handoff that ended before
 * its message was placed still shows the send, and its turn ends failed so a
 * queue behind it pauses instead of draining. A continuation places nothing:
 * its turn is the cut-off's.
 */
const failUnfinishedSend = (
	input: ProviderTurnServiceSendInput,
	driver: ProviderDriverKind | undefined,
	endedByProvider: boolean,
	error: string,
	code: string,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const sql = yield* SqlClient.SqlClient;
		const failTurn = yield* makeFailTurn;
		yield* clearProcessingTimeout(input.sessionId);
		const inputId = input.continuation ? undefined : input.commandId;
		const unplaced =
			driver !== undefined &&
			inputId !== undefined &&
			(yield* sql`SELECT 1 FROM messages
				WHERE session_id = ${input.sessionId}
					AND (id = ${inputId} OR input_id = ${inputId})
				LIMIT 1`.pipe(
				Effect.map((rows) => rows.length === 0),
				Effect.orElseSucceed(() => false),
			));
		if (unplaced) {
			const persist = yield* ClaudeEventPersistEffectTag;
			yield* persist
				.persistUserMessage(input.sessionId, input.text, {
					messageId: inputId,
					inputId,
					provider: driver,
				})
				.pipe(
					Effect.catchAll((cause) =>
						Effect.sync(() =>
							log.warn(
								`session=${input.sessionId} Failed to place unsent user message: ${formatErrorDetail(cause)}`,
							),
						),
					),
				);
		}
		// A provider's own turn end cannot have ended a turn placed only now.
		if (endedByProvider && !unplaced) return;
		yield* failTurn(input.sessionId, error, code, inputId);
	});

const makeEventSink = (sessionId: string, driver: ProviderDriverKind) =>
	Effect.gen(function* () {
		const pendingInteractionService = yield* PendingInteractionServiceTag;
		const { runtime, overridesRef } = yield* ProviderTurnTimeoutRuntimeTag;
		const persist = yield* ClaudeEventPersistEffectTag;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		return createRelayEventSink({
			sessionId,
			providerId: driver,
			...makeProcessingTimeoutHooks(runtime, sessionId),
			applyReportedPermissionMode: (mode) =>
				setPermissionMode(sessionId, mode).pipe(
					Effect.provideService(OverridesStateTag, overridesRef),
				),
			persist,
			ingestion: {
				ingest: (event) =>
					ingestion
						.ingest(event)
						.pipe(
							Effect.mapInputContext((caller: Context.Context<never>) =>
								Context.merge(runtime.context, caller),
							),
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

const TURN_END_TYPES = new Set([
	"turn.completed",
	"turn.error",
	"turn.interrupted",
]);

const handleDispatchFailure = (
	input: ProviderTurnServiceSendInput,
	sendErr: unknown,
	driver: ProviderDriverKind | undefined,
	endedByProvider = false,
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
			: RelayError.fromCaught(sendErr, "SEND_FAILED", "Failed to send message");
		yield* failUnfinishedSend(
			input,
			driver,
			endedByProvider,
			error.message,
			error.code,
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

const handleDispatchResult = (
	input: ProviderTurnServiceSendInput,
	result: TurnResult,
	driver: ProviderDriverKind,
	endedByProvider: boolean,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		// The interrupter already sent done; finalizing again can end a newer turn.
		if (result.status === "interrupted" && !result.error) return;
		// One provider result finalises once: the input that owns it does that,
		// so an input it folded in finalises nothing.
		if (result.status === "joined") return;

		// Other non-`completed` terminal statuses (error / cancelled / orphaned)
		// must finalize the turn: a completed turn's `done` arrives via the
		// streamed provider events. A provider that streamed its own turn end
		// already finalized it; otherwise the browser would stay
		// "processing" until the 2-minute PROCESSING_TIMEOUT, so record it here.
		if (result.status !== "completed") {
			const msg =
				result.error?.message ??
				(result.status === "error" ? "Send failed" : `Turn ${result.status}`);
			log.warn(
				`client=${input.clientId} session=${input.sessionId} engine dispatch ${result.status}: ${msg}`,
			);
			yield* failUnfinishedSend(
				input,
				driver,
				endedByProvider,
				msg,
				"SEND_FAILED",
			);
			return;
		}

		if (!result.providerStateUpdates?.length) {
			return;
		}
		const providerState = yield* ProviderStateEffectTag;

		const updates = result.providerStateUpdates.map((update) => ({
			key: update.key,
			value: String(update.value),
		}));
		const saveResult = yield* Effect.either(
			providerState.saveUpdates(input.sessionId, updates),
		);
		if (saveResult._tag === "Left") {
			log.warn(
				`Non-fatal provider state persistence error for ${input.sessionId}: ${formatErrorDetail(saveResult.left)}`,
			);
		}
	});

const prepareEngineTurnInput = (
	resolvedInput: ProviderTurnServiceSendInput,
	providerId: string,
	driver: ProviderDriverKind,
	claudeConfigDir: string | undefined,
) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		const sessionRow = yield* readQuery.getSession(resolvedInput.sessionId);
		if (sessionRow?.pending_rewind_message_id && resolvedInput.continuation) {
			yield* clearProcessingTimeout(resolvedInput.sessionId);
			return undefined;
		}
		const harness = isClaudeDriver(driver) ? "claude" : "opencode";
		const pick = storedSessionPick(sessionRow, harness);
		if (!pick) {
			yield* clearProcessingTimeout(resolvedInput.sessionId);
			const failTurn = yield* makeFailTurn;
			yield* failTurn(
				resolvedInput.sessionId,
				"A session model pick is required before sending a message.",
				"PICK_REQUIRED",
				resolvedInput.continuation ? undefined : resolvedInput.commandId,
			);
			return undefined;
		}
		let catalog: readonly ModelInfo[] | undefined;
		if (harness === "claude") {
			const projectSettings = yield* Effect.serviceOption(ProjectSettingsTag);
			const providers =
				projectSettings._tag === "Some"
					? (yield* Ref.get(projectSettings.value.live)).providerModels
					: undefined;
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
						? Either.right(cached.value)
						: yield* Effect.either(
								models.value.listProviders({
									instanceId: providerId,
									startIfStopped: true,
									requireFresh: true,
								}),
							);
				if (Either.isRight(available))
					catalog = available.right.providers.flatMap((provider) =>
						(provider.models ?? []).map((model) => ({
							...model,
							providerId: provider.id || provider.name,
						})),
					);
			}
		}
		const resolved =
			harnessForModelProvider(pick.model.providerId) !== harness
				? Either.left(new ModelNotInCatalog({ harness, ...pick.model }))
				: catalog === undefined
					? Either.right(pick)
					: resolveTurnSettings(pick, catalog);
		if (Either.isLeft(resolved)) {
			yield* clearProcessingTimeout(resolvedInput.sessionId);
			const failTurn = yield* makeFailTurn;
			yield* failTurn(
				resolvedInput.sessionId,
				resolved.left.message,
				"PICK_REJECTED",
				resolvedInput.continuation ? undefined : resolvedInput.commandId,
			);
			return undefined;
		}
		const settings = resolved.right;
		const priorHistoryMetadata = isClaudeDriver(driver)
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
		if (driver === "opencode") {
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
		const eventSink = yield* makeEventSink(resolvedInput.sessionId, driver);
		const imageList =
			resolvedInput.images && resolvedInput.images.length > 0
				? Array.from(resolvedInput.images)
				: undefined;
		let workspaceMoveSequence: number | undefined;
		let workspaceMoveDirective: string | undefined;
		if (isClaudeDriver(driver) && !resolvedInput.steer) {
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
			instanceId: providerId,
			model: settings.model,
			...folders,
			...(claudeConfigDir === undefined ? {} : { configDir: claudeConfigDir }),
			...(isClaudeDriver(driver) && sessionRow
				? { goalState: sessionGoalState(sessionRow) }
				: {}),
			...(isClaudeDriver(driver)
				? {
						cumulativeTokens: priorHistoryMetadata?.cumulativeTokens ?? 0,
					}
				: {}),
			eventSink,
			abortSignal: new AbortController().signal,
			permissionMode: yield* getPermissionMode(resolvedInput.sessionId),
			...(sessionRow?.side_thread === 1 ? { sideThread: true } : {}),
			...(imageList ? { images: imageList } : {}),
			...(resolvedInput.agent ? { agent: resolvedInput.agent } : {}),
			variant: settings.effort,
			contextWindow: settings.contextWindow,
		};

		return { sendTurnInput, workspaceMoveSequence };
	});

const dispatchEngineTurn = (
	resolvedInput: ProviderTurnServiceSendInput,
	providerId: string,
	driver: ProviderDriverKind,
	sendTurnInput: SendTurnInput,
	workspaceMoveSequence: number | undefined,
) =>
	Effect.gen(function* () {
		const orchestrationEngine = yield* OrchestrationEngineTag;
		const dispatchFibers = yield* ProviderTurnDispatchFibersTag;
		const previousProviderId =
			yield* orchestrationEngine.getProviderForSessionEffect(
				resolvedInput.sessionId,
			);
		const restorePreviousBinding = Effect.sync(() => {
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

		// Each failure gets exactly one turn.error. A provider that ended the
		// turn it was handed records that end through this send's sink: `push`
		// on the inline path, `noteActivity` where the reactor ingests output.
		// Only a turn it left open is Conduit's to fail: a send that fails after
		// its turn was interrupted (a reload ends the session) must not turn
		// that interrupted turn into an error.
		let endedByProvider = false;
		const { eventSink } = sendTurnInput;
		const watchedInput: SendTurnInput = {
			...sendTurnInput,
			eventSink: {
				...eventSink,
				push: (event) =>
					eventSink.push(event).pipe(
						Effect.tap(() => {
							if (TURN_END_TYPES.has(event.type)) endedByProvider = true;
						}),
					),
				noteActivity: (event) => {
					if (TURN_END_TYPES.has(event.type)) endedByProvider = true;
					eventSink.noteActivity?.(event);
				},
			},
		};
		const events = (resolvedInput.events ?? []).map((event) =>
			event.type === "input.sent" && workspaceMoveSequence !== undefined
				? { ...event, data: { ...event.data, workspaceMoveSequence } }
				: event,
		);
		// Continuations have no inbox admission, but handing their directive to
		// Claude still consumes exactly this move, atomically with the outbox.
		if (
			workspaceMoveSequence !== undefined &&
			!events.some((event) => event.type === "input.sent")
		)
			events.push(
				canonicalEvent(
					"input.sent",
					resolvedInput.sessionId,
					{
						sessionId: resolvedInput.sessionId,
						inputId: sendTurnInput.inputId,
						workspaceMoveSequence,
					},
					{ provider: "claude" },
				),
			);
		const dispatchProgram = Effect.try({
			try: () =>
				orchestrationEngine.dispatchEffect({
					type: "send_turn",
					commandId: resolvedInput.commandId,
					providerId,
					input: watchedInput,
					...(events.length > 0 ? { events } : {}),
					onAccepted: Deferred.succeed(accepted, undefined),
				}),
			catch: (cause) => cause,
		}).pipe(
			Effect.flatten,
			Effect.flatMap((result) =>
				handleDispatchResult(resolvedInput, result, driver, endedByProvider),
			),
			Effect.catchAll((error) =>
				restorePreviousBinding.pipe(
					Effect.zipRight(
						handleDispatchFailure(
							resolvedInput,
							error,
							driver,
							endedByProvider,
						),
					),
				),
			),
			Effect.onInterrupt(() => restorePreviousBinding),
			Effect.ensuring(Deferred.succeed(accepted, undefined)),
		);
		const fiber = yield* FiberMap.run(
			dispatchFibers,
			`${resolvedInput.sessionId}:${sendTurnInput.inputId}`,
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
	driver: ProviderDriverKind,
	claudeConfigDir: string | undefined,
) =>
	Effect.gen(function* () {
		const prepared = yield* prepareEngineTurnInput(
			input,
			providerId,
			driver,
			claudeConfigDir,
		).pipe(
			Effect.catchIf(
				(cause) =>
					cause instanceof MissingWorktreeError ||
					(cause instanceof RelayError && cause.code === "FILE_NOT_FOUND"),
				(cause) => handleDispatchFailure(input, cause, driver),
			),
		);
		if (!prepared) return;
		yield* dispatchEngineTurn(
			input,
			providerId,
			driver,
			prepared.sendTurnInput,
			prepared.workspaceMoveSequence,
		);
	});

/** The handoff is where a turn starts working: arm its timeout. The browser's
 *  processing phase follows the session's shell row (ni8.35). */
const startProcessing = (input: ProviderTurnServiceSendInput) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const failTurn = yield* makeFailTurn;
		const { sessionId } = input;
		yield* startProcessingTimeout(sessionId, PROCESSING_TIMEOUT_DURATION, () =>
			Effect.suspend(() => {
				log.warn(
					`client=${input.clientId} session=${sessionId} Processing timeout (120s) — failing the turn`,
				);
				return failTurn(
					sessionId,
					input.continuation
						? "The continuation received no response. Try again."
						: "No response received — the model may be unavailable or your usage quota may be exhausted. Try a different model.",
					"PROCESSING_TIMEOUT",
					input.continuation ? undefined : input.commandId,
				);
			}),
		);
	});

export const sendTurn = (input: ProviderTurnServiceSendInput) =>
	Effect.gen(function* () {
		const setup = yield* Effect.serviceOption(SessionSetupTag);
		if (setup._tag === "Some") yield* setup.value.wait(input.sessionId);
		if (!input.steer) yield* startProcessing(input);
		const config = yield* ConfigTag;
		const engine = yield* OrchestrationEngineTag;
		const providerId =
			(yield* (yield* ReadQueryEffectTag).getSession(input.sessionId))
				?.provider ??
			(yield* engine.getProviderForSessionEffect(input.sessionId));
		if (!providerId) {
			yield* clearProcessingTimeout(input.sessionId);
			const failTurn = yield* makeFailTurn;
			yield* failTurn(
				input.sessionId,
				"A session model pick is required before sending a message.",
				"PICK_REQUIRED",
				input.commandId,
			);
			return;
		}
		const daemonConfig = loadDaemonConfig(config.configDir);
		const driver = resolveProviderRoutingDriver(daemonConfig, providerId);
		if (driver === undefined) {
			yield* handleDispatchFailure(
				input,
				new Error(
					`Cannot resolve provider instance for turn routing: ${providerId}`,
				),
				undefined,
			);
			return;
		}
		yield* sendViaEngine(
			input,
			providerId,
			driver,
			resolveClaudeInstanceConfigDir(daemonConfig, providerId),
		).pipe(Effect.provideService(OrchestrationEngineTag, engine));
	});
