import { Clock, Effect, Ref, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { validateAttachmentDataUrls } from "../../attachment-data-url.js";
import {
	AccountUnroutable,
	type ContinuationError,
	ContinuationErrorSchema,
} from "../../contracts/limit-recovery.js";
import {
	PROVIDER_DRIVERS,
	PROVIDER_SESSION_CAPABILITIES,
} from "../../contracts/provider-instance.js";
import { WorkspaceMoveError } from "../../contracts/session-workspace.js";
import { SessionHandoffDeliveredPayloadSchema } from "../../contracts/stored-event.js";
import {
	WorktreeBranchRenameError,
	WorktreeCreationError,
	WorktreeRecoveryError,
} from "../../contracts/worktree.js";
import {
	DraftAlreadySent,
	DraftAttachmentMissing,
	WsRpcError,
} from "../../contracts/ws-rpc.js";
import { autoSettleIdleWindowMs } from "../../daemon/config-persistence.js";
import { AccountDirectory } from "../../domain/daemon/Services/account-directory.js";
import { DaemonConfigRefTag } from "../../domain/daemon/Services/daemon-config-ref.js";
import { SessionGit } from "../../domain/daemon/Services/session-git.js";
import { Usage } from "../../domain/daemon/Services/usage.js";
import { WorktreeServiceTag } from "../../domain/daemon/Services/worktree-service.js";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import {
	ContinuationTag,
	previewContinuation,
} from "../../domain/relay/Services/continuation.js";
import { DaemonSessionQueryServiceTag } from "../../domain/relay/Services/daemon-session-query-service.js";
import {
	DraftPreWarmTag,
	draftLaunchKey,
} from "../../domain/relay/Services/draft-prewarm.js";
import { GoalSummaryServiceTag } from "../../domain/relay/Services/goal-summary-service.js";
import { InputDraftsTag } from "../../domain/relay/Services/input-drafts.js";
import {
	BackgroundLivenessTag,
	ConfigTag,
	LoggerTag,
} from "../../domain/relay/Services/services.js";
import { setRead } from "../../domain/relay/Services/session-attention.js";
import { forkSession } from "../../domain/relay/Services/session-command.js";
import {
	createLocalSessionId,
	SessionManagerServiceTag,
} from "../../domain/relay/Services/session-manager-service.js";
import { SessionSetupTag } from "../../domain/relay/Services/session-setup.js";
import {
	recreateSessionWorktrees,
	SessionWorkspaceTag,
} from "../../domain/relay/Services/session-workspace.js";
import { dismissWorkspaceHint } from "../../domain/relay/Services/session-workspace-hint.js";
import { prepareSessionWorktreeDeletion } from "../../domain/relay/Services/session-worktree-deletion.js";
import { makeSurfacingFeedback } from "../../domain/relay/Services/surfacing-feedback.js";
import * as Failure from "../../effect/failure-classification.js";
import { ENV } from "../../env.js";
import { formatErrorDetail } from "../../errors.js";
import {
	listLocalBranches,
	listProjectWorktrees,
	realWorkspacePath,
} from "../../git/worktrees.js";
import {
	rewindSessionToMessage,
	sendMessageToSession,
	undoSessionRewind,
} from "../../handlers/prompt.js";
import { reloadProviderSessionForClient } from "../../handlers/reload.js";
import {
	createSessionForClient,
	deleteSessionForClient,
	forkSessionForClient,
	loadMoreHistoryForSession,
	markSessionReadForClient,
	markSessionSeenForClient,
	markSessionUnreadForClient,
	renameSessionForClient,
	resolveSessionCreation,
	resolveSessionCreationAccount,
	setSessionArchivedForClient,
	setSessionAutoSettleForClient,
	setSessionJevForClient,
	setSessionPinnedForClient,
	setSessionSettledForClient,
	snoozeSessionForClient,
	unsnoozeSessionForClient,
	viewSessionForClient,
} from "../../handlers/session.js";
import {
	preWarmDraft,
	resolveDraftLaunchInput,
} from "../../handlers/session-draft-prewarm.js";
import { preWarmSession } from "../../handlers/session-prewarm.js";
import { ReadQueryEffectTag } from "../../persistence/effect/read-query-effect.js";
import { isPickRejection, PickRequired } from "../../provider/turn-settings.js";
import { saveRelaySettings } from "../../relay/relay-settings.js";
import { getAutoSettleOutlook } from "../../session/auto-settle-policy.js";
import { readPersistedAutoSettleFacts } from "../../session/auto-settle-reader.js";
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

const sideThreadStarts = Semaphore.makeUnsafe(1);

/** The outlook the sweep would reach once nobody is viewing the session. */
const readAutoSettleOutlook = (sessionId: string) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		const { projectDir } = yield* ConfigTag;
		const { projectId } = yield* PersistenceProjectTag;
		const facts = (yield* readPersistedAutoSettleFacts(
			projectId,
			now,
			sessionId,
			projectDir,
		)).get(sessionId);
		if (facts === undefined)
			return yield* new WsRpcError({
				message: `Unknown session: ${sessionId}`,
				code: "unknown-session",
			});
		const backgroundOf = yield* BackgroundLivenessTag;
		const config = yield* Ref.get(yield* DaemonConfigRefTag);
		return getAutoSettleOutlook(
			{
				...facts,
				hasLiveBackgroundWork: backgroundOf(sessionId) !== undefined,
			},
			now,
			autoSettleIdleWindowMs(config.autoSettleAfterDays),
		);
	});

export const sessionsHandlers = {
	SetSurfacingMark: ({ sessionId, partId, mark }) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const { projectId } = yield* PersistenceProjectTag;
			const [owned] = yield* sql<{
				id: string;
			}>`SELECT mp.id FROM message_parts mp JOIN messages m ON m.id = mp.message_id JOIN sessions s ON s.id = m.session_id WHERE mp.id = ${partId} AND m.session_id = ${sessionId} AND s.project_id = ${projectId}`;
			if (!owned)
				return yield* new WsRpcError({
					message: "Part does not belong to this session",
				});
			const feedback = yield* makeSurfacingFeedback;
			yield* feedback.set(partId, mark);
			return { ok: true as const };
		}).pipe(Effect.catch(mapRpcFailure("SetSurfacingMark"))),
	ListBranches: (_request) =>
		Effect.flatMap(ConfigTag, (config) =>
			listLocalBranches(config.projectDir),
		).pipe(Effect.catch(mapRpcFailure("ListBranches"))),
	ListWorktrees: (request) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const workspace = yield* SessionWorkspaceTag;
			const directory = !("sessionId" in request)
				? undefined
				: yield* workspace
						.get(request.sessionId)
						.pipe(
							Effect.flatMap((path) =>
								realWorkspacePath(path).pipe(Effect.orElseSucceed(() => path)),
							),
						);
			return {
				...(directory === undefined ? {} : { directory }),
				worktrees: yield* listProjectWorktrees([
					config.projectDir,
					...(config.extraFolders ?? []),
				]),
			};
		}).pipe(Effect.catch(mapRpcFailure("ListWorktrees"))),
	InspectSessionWorktrees: (request) =>
		Effect.gen(function* () {
			const read = yield* ReadQueryEffectTag;
			if (!(yield* read.getSession(request.sessionId)))
				return yield* new WsRpcError({ message: "Session not found." });
			const plan = yield* prepareSessionWorktreeDeletion(request.sessionId);
			const config = yield* ConfigTag;
			// The daemon read resolves an unreadable project to "off", which asks.
			const rules = config.getWorktreeCleanup
				? yield* config.getWorktreeCleanup()
				: "off";
			return {
				worktrees: plan.worktrees,
				removeWorktrees: plan.removeWorktrees,
				onDelete:
					rules !== "off" && rules.onDelete
						? ("remove" as const)
						: ("ask" as const),
			};
		}).pipe(Effect.catch(mapRpcFailure("InspectSessionWorktrees"))),
	RenameSessionBranch: (request) =>
		Effect.gen(function* () {
			const workspace = yield* SessionWorkspaceTag;
			yield* workspace.renameBranch(request.sessionId, request.branchName);
			const git = yield* Effect.serviceOption(SessionGit);
			if (git._tag === "Some")
				yield* git.value.invalidate({ sessionId: request.sessionId });
			return { ok: true as const };
		}).pipe(
			Effect.catch(
				(
					error,
				): Effect.Effect<never, WorktreeBranchRenameError | WsRpcError> =>
					error instanceof WorktreeBranchRenameError
						? Effect.fail(error)
						: mapRpcFailure("RenameSessionBranch")(error),
			),
		),
	MoveSessionWorkspace: (request) =>
		Effect.gen(function* () {
			const workspace = yield* SessionWorkspaceTag;
			return {
				directory: yield* workspace.withLaunch(
					request.sessionId,
					workspace.move(request.sessionId, request.path, "user"),
				),
			};
		}).pipe(
			Effect.catch(
				(error): Effect.Effect<never, WorkspaceMoveError | WsRpcError> =>
					error instanceof WorkspaceMoveError
						? Effect.fail(error)
						: mapRpcFailure("MoveSessionWorkspace")(error),
			),
		),
	RecreateSessionWorktree: (request) =>
		recreateSessionWorktrees(request.sessionId).pipe(
			Effect.catch(
				(error): Effect.Effect<never, WorktreeRecoveryError | WsRpcError> =>
					error instanceof WorktreeRecoveryError
						? Effect.fail(error)
						: mapRpcFailure("RecreateSessionWorktree")(error),
			),
		),
	ContinueSessionInMainFolder: (request) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const workspace = yield* SessionWorkspaceTag;
			return yield* workspace.withLaunch(
				request.sessionId,
				workspace
					.move(request.sessionId, config.projectDir, "user")
					.pipe(Effect.map((directory) => ({ directory }))),
			);
		}).pipe(
			Effect.catch(
				(error): Effect.Effect<never, WorkspaceMoveError | WsRpcError> =>
					error instanceof WorkspaceMoveError
						? Effect.fail(error)
						: mapRpcFailure("ContinueSessionInMainFolder")(error),
			),
		),
	DismissWorkspaceHint: (request) =>
		dismissWorkspaceHint(request.sessionId, request.path).pipe(
			Effect.as({ ok: true as const }),
			Effect.catch(mapRpcFailure("DismissWorkspaceHint")),
		),
	GetGoalDetails: (request) =>
		Effect.gen(function* () {
			const read = yield* ReadQueryEffectTag;
			const session = yield* read.getSession(request.sessionId);
			if (!session) {
				return yield* new WsRpcError({
					message: `Session ${request.sessionId} not found`,
				});
			}
			const account = yield* (yield* AccountDirectory).resolve({
				_tag: "Id",
				id: session.provider,
			});
			if (!PROVIDER_DRIVERS[account.driver].supportsGoalState) {
				return yield* new WsRpcError({
					message: "This provider does not support goal details",
				});
			}
			const summaries = yield* GoalSummaryServiceTag;
			return yield* (yield* SqlClient.SqlClient).withTransaction(
				Effect.gen(function* () {
					const details = yield* read.getGoalDetails(request.sessionId);
					const summary = yield* summaries.metadata(request.sessionId);
					return { ...details, ...summary };
				}),
			);
		}).pipe(Effect.catch(mapRpcFailure("GetGoalDetails"))),
	GenerateGoalSummary: (request) =>
		Effect.gen(function* () {
			const read = yield* ReadQueryEffectTag;
			const session = yield* read.getSession(request.sessionId);
			if (!session) {
				return yield* new WsRpcError({
					message: `Session ${request.sessionId} not found`,
				});
			}
			const account = yield* (yield* AccountDirectory).resolve({
				_tag: "Id",
				id: session.provider,
			});
			if (!PROVIDER_DRIVERS[account.driver].supportsGoalState) {
				return yield* new WsRpcError({
					message: "Goal summaries are available only for Claude sessions",
				});
			}
			return yield* (yield* GoalSummaryServiceTag).generate(request.sessionId);
		}).pipe(Effect.catch(mapRpcFailure("GenerateGoalSummary"))),
	PreWarmSession: (request) =>
		preWarmSession(request.sessionId).pipe(
			Effect.catch(mapRpcFailure("PreWarmSession")),
		),
	PreWarmDraft: preWarmDraft,
	ResolveSession: (request) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const sessionManager = yield* SessionManagerServiceTag;
			const exists = yield* sessionManager.sessionExists(request.sessionId);
			if (!exists)
				return yield* new WsRpcError({
					message: `Unknown session: ${request.sessionId}`,
					code: "unknown-session",
				});
			return { projectSlug: config.slug };
		}).pipe(Effect.catch(mapRpcFailure("ResolveSession"))),
	ListDaemonSessions: (request) =>
		Effect.gen(function* () {
			const daemonSessions = yield* DaemonSessionQueryServiceTag;
			const result = yield* daemonSessions.list({
				...(request.limit !== undefined ? { limit: request.limit } : {}),
				...(request.roots !== undefined ? { roots: request.roots } : {}),
				...(request.search !== undefined ? { search: request.search } : {}),
				...(request.includeArchived !== undefined
					? { includeArchived: request.includeArchived }
					: {}),
				...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
				...(request.scope !== undefined ? { scope: request.scope } : {}),
				...(request.exclude !== undefined ? { exclude: request.exclude } : {}),
			});
			return {
				projectSlug: request.projectSlug,
				...result,
			};
		}).pipe(Effect.catch(mapRpcFailure("ListDaemonSessions"))),
	ListArchivedSessions: (request) =>
		Effect.gen(function* () {
			const daemonSessions = yield* DaemonSessionQueryServiceTag;
			return yield* daemonSessions.listArchived({
				...(request.limit !== undefined ? { limit: request.limit } : {}),
				...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
			});
		}).pipe(Effect.catch(mapRpcFailure("ListArchivedSessions"))),
	ReloadProviderSession: (request) =>
		Effect.flatMap(ConfigTag, (config) =>
			reloadProviderSessionForClient({
				clientId: request.originId ?? "rpc",
				sessionId: request.sessionId,
				commandId: request.commandId,
			}).pipe(
				Effect.as({
					projectSlug: config.slug,
					sessionId: request.sessionId,
				}),
				Effect.catch((error) =>
					Effect.fail(
						new WsRpcError({
							message: `ReloadProviderSession failed: ${String(error)}`,
						}),
					),
				),
			),
		),
	RenameSession: (request) =>
		renameSessionForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			title: request.title,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catch((error) =>
				Effect.fail(
					new WsRpcError({
						message: `RenameSession failed: ${String(error)}`,
					}),
				),
			),
		),
	SetSessionSettled: (request) =>
		setSessionSettledForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			settled: request.settled,
		}).pipe(
			Effect.as({ ok: true as const }),
			Failure.mapEffectFailures(
				(error) =>
					new WsRpcError({
						message: `SetSessionSettled failed: ${String(error.cause)}`,
					}),
			),
		),
	SetSessionArchived: (request) =>
		setSessionArchivedForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			archived: request.archived,
		}).pipe(
			Effect.as({ ok: true as const }),
			Failure.mapEffectFailures(
				(error) =>
					new WsRpcError({
						message: `SetSessionArchived failed: ${String(error.cause)}`,
					}),
			),
		),
	SetSessionPinned: (request) =>
		setSessionPinnedForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			pinned: request.pinned,
		}).pipe(
			Effect.as({ ok: true as const }),
			Failure.mapEffectFailures(
				(error) =>
					new WsRpcError({
						message: `SetSessionPinned failed: ${String(error.cause)}`,
					}),
			),
		),
	GetSessionAutoSettleOutlook: (request) =>
		readAutoSettleOutlook(request.sessionId).pipe(
			Effect.catch(mapRpcFailure("GetSessionAutoSettleOutlook")),
		),
	SetSessionAutoSettle: (request) =>
		setSessionAutoSettleForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			disabled: request.disabled,
		}).pipe(
			Effect.andThen(readAutoSettleOutlook(request.sessionId)),
			Effect.catch(mapRpcFailure("SetSessionAutoSettle")),
		),
	SetSessionJev: (request) =>
		setSessionJevForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			jev: request.jev,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catch(mapRpcFailure("SetSessionJev")),
		),
	SnoozeSession: (request) =>
		snoozeSessionForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			until: request.until,
		}).pipe(
			Effect.as({ ok: true as const }),
			Failure.mapEffectFailures(
				(error) =>
					new WsRpcError({
						message: `SnoozeSession failed: ${String(error.cause)}`,
					}),
			),
		),
	DismissCutOff: (request) =>
		Effect.flatMap(ContinuationTag, (continuation) =>
			continuation.dismissCutOff(request.sessionId),
		).pipe(
			Effect.as({ ok: true as const }),
			Effect.catch(mapRpcFailure("DismissCutOff")),
		),
	ContinueSession: (request) =>
		Effect.gen(function* () {
			const continuation = yield* ContinuationTag;
			yield* continuation.requestContinuation(request.sessionId, {
				instanceId: request.instanceId,
				...(request.accountRef === undefined
					? {}
					: { accountRef: request.accountRef }),
				expectedInstanceId: request.expectedInstanceId,
				reason: request.at === undefined ? "user" : "reset",
				...(request.at === undefined ? {} : { at: request.at }),
			});
			return { ok: true as const };
		}).pipe(
			Effect.catch(
				(error): Effect.Effect<never, WsRpcError | ContinuationError> =>
					Schema.is(ContinuationErrorSchema)(error)
						? Effect.fail(error)
						: mapRpcFailure("ContinueSession")(error),
			),
		),
	CancelContinuation: (request) =>
		Effect.flatMap(ContinuationTag, (continuation) =>
			continuation.cancelContinuation(request.sessionId),
		).pipe(
			Effect.as({ ok: true as const }),
			Effect.catch(mapRpcFailure("CancelContinuation")),
		),
	PreviewContinuation: (request) =>
		previewContinuation(
			request.sessionId,
			request.instanceId,
			request.accountRef,
		).pipe(
			Effect.catch(
				(error): Effect.Effect<never, WsRpcError | ContinuationError> =>
					Schema.is(ContinuationErrorSchema)(error)
						? Effect.fail(error)
						: mapRpcFailure("PreviewContinuation")(error),
			),
		),
	QuotaForAccounts: (_request) =>
		Effect.flatMap(Usage, (usage) =>
			usage.refresh({ maxAge: ENV.quotaReadMaxAgeMs }),
		).pipe(Effect.catch(mapRpcFailure("QuotaForAccounts"))),
	GetContinuationHandoff: (request) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			// Sequence bounds distinguish later switches to the same account and
			// select its first completed handoff, including a retry after a crash.
			const [row] = yield* sql<{
				event_id: string;
				created_at: number;
				data: string;
			}>`
				WITH resume AS (
					SELECT sequence FROM events WHERE session_id = ${request.sessionId}
					AND type = 'session.resumed' AND created_at = ${request.at}
					AND json_extract(data, '$.instanceId') = ${request.instanceId}
					ORDER BY sequence DESC LIMIT 1
				)
				SELECT event_id, created_at, data FROM events
				WHERE session_id = ${request.sessionId} AND type = 'session.handoff_delivered'
				AND json_extract(data, '$.instanceId') = ${request.instanceId}
				AND sequence > (SELECT sequence FROM resume)
				AND sequence < COALESCE((SELECT MIN(sequence) FROM events WHERE session_id = ${request.sessionId} AND type = 'session.resumed' AND sequence > (SELECT sequence FROM resume)), 9223372036854775807)
				ORDER BY sequence ASC LIMIT 1`;
			if (!row) return { handoff: null };
			const data = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(SessionHandoffDeliveredPayloadSchema),
			)(row.data);
			return {
				handoff: {
					...data,
					firstMessageIncluded: data.firstMessageIncluded ?? false,
					eventId: row.event_id,
					at: row.created_at,
					instanceId: request.instanceId,
				},
			};
		}).pipe(Effect.catch(mapRpcFailure("GetContinuationHandoff"))),
	UnsnoozeSession: (request) =>
		unsnoozeSessionForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
		}).pipe(
			Effect.as({ ok: true as const }),
			Failure.mapEffectFailures(
				(error) =>
					new WsRpcError({
						message: `UnsnoozeSession failed: ${String(error.cause)}`,
					}),
			),
		),
	MarkSessionUnread: (request) =>
		markSessionUnreadForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catch((error) =>
				Effect.fail(
					new WsRpcError({
						message: `MarkSessionUnread failed: ${String(error)}`,
					}),
				),
			),
		),
	MarkSessionSeen: (request) =>
		markSessionSeenForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			upTo: request.upTo,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catch(mapRpcFailure("MarkSessionSeen")),
		),
	MarkSessionRead: (request) =>
		markSessionReadForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catch((error) =>
				Effect.fail(
					new WsRpcError({
						message: `MarkSessionRead failed: ${String(error)}`,
					}),
				),
			),
		),
	SetMessagesRead: (request) =>
		setRead(request.partIds, request.read, request.sessionId).pipe(
			Effect.as({ ok: true as const }),
			Effect.catch(mapRpcFailure("SetMessagesRead")),
		),
	CreateSession: (request) =>
		Effect.gen(function* () {
			const draftId = request.draftId;
			let publishPromotion: Effect.Effect<void> = Effect.void;
			const create = Effect.gen(function* () {
				if (request.worktreeBase !== undefined && !request.newWorktree)
					return yield* new WsRpcError({
						message: "worktreeBase requires newWorktree: true.",
					});
				if (
					request.permissionMode == null ||
					!request.model?.modelId.trim() ||
					!request.model.providerId.trim()
				)
					return yield* new PickRequired();
				const workspace = yield* SessionWorkspaceTag;
				const path = request.worktreePath;
				const account = yield* resolveSessionCreationAccount(request);
				const drafts = yield* Effect.serviceOption(DraftPreWarmTag);
				const draftId = request.draftId;
				const resolvedCreation =
					draftId &&
					!request.newWorktree &&
					PROVIDER_DRIVERS[account.driver].supportsNativeResume
						? yield* resolveSessionCreation({ ...request, account }).pipe(
								Effect.onError(() =>
									drafts._tag === "Some"
										? drafts.value
												.take(request.originId, draftId, undefined)
												.pipe(Effect.asVoid)
										: Effect.void,
								),
							)
						: undefined;
				const draftLaunch = resolvedCreation
					? yield* resolveDraftLaunchInput(resolvedCreation, path).pipe(
							Effect.catchCause((cause) =>
								Effect.gen(function* () {
									const log = yield* LoggerTag;
									log.debug(`Draft launch comparison failed: ${String(cause)}`);
									return undefined;
								}),
							),
						)
					: undefined;
				const launchKey =
					draftLaunch === undefined ? undefined : draftLaunchKey(draftLaunch);
				// A mismatched or missing key discards the reservation instead of adopting it.
				const takeReservation =
					draftId && drafts._tag === "Some"
						? drafts.value.take(request.originId, draftId, launchKey)
						: Effect.succeed(undefined);
				const options = {
					clientId: request.originId,
					account,
					...(request.title != null ? { title: request.title } : {}),
					...(request.model != null ? { model: request.model } : {}),
					permissionMode: request.permissionMode,
					...(resolvedCreation === undefined ? {} : { resolvedCreation }),
					...(draftId === undefined
						? {}
						: {
								draftId,
								draftChange: (sessionId: string) => {
									const change = inputDrafts.promotionChange(
										{ draft: draftId },
										sessionId,
										request.draftText ?? "",
									);
									publishPromotion = change.publish;
									return { write: change.write, publish: Effect.void };
								},
							}),
				};
				if (request.newWorktree) {
					yield* takeReservation;
					if (path !== undefined)
						return yield* new WsRpcError({
							message: "Choose either a new worktree or an existing worktree.",
						});
					const config = yield* ConfigTag;
					if (
						!PROVIDER_SESSION_CAPABILITIES[account.driver].supportsNewWorktree
					)
						return yield* new WorkspaceMoveError({
							path: config.projectDir,
							reason: "unsupported-provider",
						});
					const worktrees = yield* WorktreeServiceTag;
					const sessionId = createLocalSessionId();
					const session = yield* workspace.withLaunch(
						sessionId,
						Effect.uninterruptibleMask((restore) =>
							Effect.gen(function* () {
								// The id belongs to this launch, but no session exists until Git succeeds.
								const created = yield* restore(
									worktrees.create(
										[config.projectDir, ...(config.extraFolders ?? [])].map(
											(folder) => ({
												path: folder,
												projectSlug: config.slug,
												sessionId,
											}),
										),
										request.worktreeBase === undefined
											? undefined
											: { [config.projectDir]: request.worktreeBase },
									),
								);
								const session = yield* restore(
									createSessionForClient({
										...options,
										sessionId,
										directory:
											created.worktrees[config.projectDir] ?? config.projectDir,
										initializeWorkspace: (id: string) =>
											Effect.forEach(
												Object.entries(created.worktrees),
												([folder, path], index) =>
													workspace.move(
														id,
														path,
														"launch",
														"conduit",
														folder,
														index === 0 ? created.ownership : undefined,
													),
												{ discard: true },
											),
									}),
								).pipe(
									Effect.catchCause((cause) =>
										worktrees
											.rollback(created)
											.pipe(Effect.andThen(Effect.failCause(cause))),
									),
								);
								const setup = yield* Effect.serviceOption(SessionSetupTag);
								if (setup._tag === "Some")
									yield* setup.value.start(
										session.id,
										created.worktrees[config.projectDir] ?? config.projectDir,
									);
								return session;
							}),
						),
					);
					return { projectSlug: request.projectSlug, sessionId: session.id };
				}
				if (
					path !== undefined &&
					!PROVIDER_SESSION_CAPABILITIES[account.driver].supportsWorktree
				) {
					yield* takeReservation;
					return yield* new WorkspaceMoveError({
						path,
						reason: "unsupported-provider",
					});
				}
				// Taking a reservation and arming its rollback must not be split by interruption.
				const session = yield* Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						const reservedSessionId = yield* takeReservation;
						const reservedCall =
							reservedSessionId &&
							draftLaunch?.projectId !== undefined &&
							draftLaunch.shellEnv !== undefined
								? {
										...draftLaunch,
										sessionId: reservedSessionId,
										projectId: draftLaunch.projectId,
										shellEnv: draftLaunch.shellEnv,
										shellConfig: draftLaunch.shellConfig,
									}
								: undefined;
						const sessionId =
							reservedSessionId ??
							(path === undefined ? undefined : createLocalSessionId());
						const create = createSessionForClient({
							...options,
							...(sessionId === undefined ? {} : { sessionId }),
							...(path === undefined
								? {}
								: {
										directory: path,
										initializeWorkspace: (sessionId: string) =>
											workspace
												.move(sessionId, path, "launch")
												.pipe(Effect.asVoid),
									}),
						});
						return yield* restore(
							path === undefined || sessionId === undefined
								? create
								: workspace.withLaunch(sessionId, create),
						).pipe(
							Effect.onError(() =>
								reservedSessionId && drafts._tag === "Some"
									? drafts.value.discardSession(
											reservedSessionId,
											...(reservedCall ? ([reservedCall] as const) : []),
										)
									: Effect.void,
							),
						);
					}),
				);
				return {
					projectSlug: request.projectSlug,
					sessionId: session.id,
				};
			});
			if (draftId === undefined) return yield* create;
			const inputDrafts = yield* InputDraftsTag;
			const config = yield* ConfigTag;
			return yield* Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const claimed = yield* inputDrafts.claim(draftId, config.slug);
					if (!claimed) {
						// The loser's prewarmed session would otherwise linger until its TTL.
						const prewarm = yield* Effect.serviceOption(DraftPreWarmTag);
						if (prewarm._tag === "Some")
							yield* prewarm.value.take(request.originId, draftId, undefined);
						return yield* new DraftAlreadySent({ draftId });
					}
					const session = yield* restore(create).pipe(
						Effect.onError(() =>
							inputDrafts
								.releaseClaim(draftId)
								.pipe(
									Effect.catch((cause) =>
										Effect.logError(
											`Could not release draft claim ${draftId}: ${cause}`,
										),
									),
								),
						),
					);
					if (request.worktreePath === undefined) {
						yield* Effect.try(() =>
							saveRelaySettings(
								{ lastSessionMode: request.newWorktree ? "worktree" : "local" },
								config.configDir,
							),
						).pipe(
							Effect.catchCause((cause) =>
								Effect.gen(function* () {
									const log = yield* LoggerTag;
									log.warn("Failed to persist last session mode", { cause });
								}),
							),
						);
					}
					yield* publishPromotion;
					return session;
				}),
			);
		}).pipe(
			Effect.catch(
				(
					error,
				): Effect.Effect<
					never,
					| WorkspaceMoveError
					| WorktreeCreationError
					| AccountUnroutable
					| DraftAlreadySent
					| WsRpcError
				> =>
					error instanceof DraftAlreadySent ||
					error instanceof AccountUnroutable ||
					error instanceof WorkspaceMoveError ||
					error instanceof WorktreeCreationError
						? Effect.fail(error)
						: Effect.fail(
								new WsRpcError({
									message: isPickRejection(error)
										? error.message
										: `CreateSession failed: ${formatErrorDetail(error)}`,
								}),
							),
			),
		),
	ViewSession: (request) =>
		viewSessionForClient({
			clientId: request.originId,
			sessionId: request.sessionId,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catch((error) =>
				Effect.fail(
					new WsRpcError({
						message: `ViewSession failed: ${String(error)}`,
					}),
				),
			),
		),
	DeleteSession: (request) =>
		deleteSessionForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			...(request.removeWorktrees === undefined
				? {}
				: { removeWorktrees: request.removeWorktrees }),
		}).pipe(
			Effect.map((worktreeWarnings) => ({
				ok: true as const,
				...(worktreeWarnings.length > 0 ? { worktreeWarnings } : {}),
			})),
			Effect.catch((error) =>
				Effect.fail(
					new WsRpcError({
						message: `DeleteSession failed: ${String(error)}`,
					}),
				),
			),
		),
	ForkSession: (request) =>
		Effect.flatMap(ConfigTag, (config) =>
			forkSessionForClient({
				clientId: request.originId,
				...("sessionId" in request ? { sessionId: request.sessionId } : {}),
				...(request.messageId != null ? { messageId: request.messageId } : {}),
				...(request.instanceId != null
					? { instanceId: request.instanceId }
					: {}),
			}).pipe(
				Effect.flatMap((session) =>
					session == null
						? Effect.fail(
								new WsRpcError({
									message: "ForkSession failed: no active session",
								}),
							)
						: Effect.succeed({
								projectSlug: config.slug,
								sessionId: session.id,
								forkedFrom: session.forkedFrom,
								...(session.forkMessageId && {
									forkMessageId: session.forkMessageId,
								}),
								...(session.forkPointTimestamp != null && {
									forkPointTimestamp: session.forkPointTimestamp,
								}),
							}),
				),
				Effect.catch((error) =>
					Effect.gen(function* () {
						const log = yield* LoggerTag;
						log.warn("ForkSession failed", { cause: error });
						return yield* Effect.fail(
							error instanceof WsRpcError || error instanceof AccountUnroutable
								? error
								: new WsRpcError({
										message: `ForkSession failed: ${String(error)}`,
									}),
						);
					}),
				),
			),
		),
	StartSideThread: (request) =>
		Effect.gen(function* () {
			// Validate before the fork creates any events or provider commands.
			yield* Effect.try({
				try: () =>
					validateAttachmentDataUrls(
						request.images?.filter((image) => typeof image === "string"),
					),
				catch: (cause) =>
					new WsRpcError({
						message: cause instanceof Error ? cause.message : String(cause),
					}),
			});
			// A retry (lost reply, crash before admission) resumes the thread its
			// input already started; serialized so a concurrent duplicate cannot
			// fork a second one.
			const sql = yield* SqlClient.SqlClient;
			const sessionId = yield* Effect.gen(function* () {
				const [started] = yield* sql<{ session_id: string }>`
					SELECT session_id FROM events
					WHERE type = 'session.created'
						AND json_extract(data, '$.startInputId') = ${request.inputId}
					LIMIT 1`;
				if (started) return started.session_id;
				const session = yield* forkSession(request.sessionId, {
					side: { title: request.title, inputId: request.inputId },
				});
				// Refresh now rather than on the next projection burst: the side
				// thread's first turn must not read as activity on its parent.
				const sessionManager = yield* SessionManagerServiceTag;
				yield* sessionManager.refreshSessionLineage();
				return session.id;
			}).pipe(sideThreadStarts.withPermits(1));
			// Idempotent per input id, so a retry re-admits only a lost prompt.
			yield* sendMessageToSession({
				clientId: request.originId ?? "rpc",
				sessionId,
				text: request.text,
				commandId: request.inputId,
				draftKey: request.draftKey ?? { session: request.sessionId },
				...(request.draftText !== undefined
					? { draftText: request.draftText }
					: {}),
				...(request.attachmentIds
					? { attachmentIds: request.attachmentIds }
					: {}),
				...(request.images ? { images: request.images } : {}),
			});
			return { sessionId };
		}).pipe(
			Effect.catch(
				(
					error,
				): Effect.Effect<
					never,
					AccountUnroutable | WsRpcError | DraftAttachmentMissing
				> =>
					error instanceof AccountUnroutable ||
					error instanceof DraftAttachmentMissing
						? Effect.fail(error)
						: mapRpcFailure("StartSideThread")(error),
			),
		),
	LoadMoreHistory: (request) =>
		Effect.flatMap(ConfigTag, (config) =>
			loadMoreHistoryForSession({
				sessionId: request.sessionId,
				...(request.before ? { before: request.before } : {}),
			}).pipe(
				Effect.map((page) => ({
					projectSlug: config.slug,
					sessionId: page.sessionId,
					messages: page.messages,
					hasMore: page.hasMore,
				})),
				Effect.catch((error) =>
					Effect.fail(
						new WsRpcError({
							message: `LoadMoreHistory failed: ${String(error)}`,
						}),
					),
				),
			),
		),
	UndoRewind: (request) =>
		undoSessionRewind({
			clientId: "rpc",
			sessionId: request.sessionId,
		}).pipe(
			Effect.as({ ok: true as const, sessionId: request.sessionId }),
			Effect.catch(mapRpcFailure("UndoRewind")),
		),
	RewindSession: (request) =>
		rewindSessionToMessage({
			clientId: "rpc",
			sessionId: request.sessionId,
			messageId: request.messageId,
		}).pipe(
			Effect.as({
				ok: true as const,
				sessionId: request.sessionId,
				messageId: request.messageId,
			}),
			Effect.catch((error) =>
				Effect.fail(
					new WsRpcError({
						message: `RewindSession failed: ${String(error)}`,
					}),
				),
			),
		),
} satisfies Pick<
	WsRpcHandlerMap,
	| "GetGoalDetails"
	| "GenerateGoalSummary"
	| "PreWarmSession"
	| "PreWarmDraft"
	| "ResolveSession"
	| "ListDaemonSessions"
	| "ListArchivedSessions"
	| "ReloadProviderSession"
	| "RenameSession"
	| "RenameSessionBranch"
	| "ListWorktrees"
	| "InspectSessionWorktrees"
	| "ListBranches"
	| "MoveSessionWorkspace"
	| "RecreateSessionWorktree"
	| "ContinueSessionInMainFolder"
	| "DismissWorkspaceHint"
	| "SetSessionSettled"
	| "SetSurfacingMark"
	| "SetSessionArchived"
	| "SetSessionPinned"
	| "GetSessionAutoSettleOutlook"
	| "SetSessionAutoSettle"
	| "SetSessionJev"
	| "SnoozeSession"
	| "UnsnoozeSession"
	| "DismissCutOff"
	| "ContinueSession"
	| "CancelContinuation"
	| "PreviewContinuation"
	| "QuotaForAccounts"
	| "GetContinuationHandoff"
	| "MarkSessionUnread"
	| "MarkSessionRead"
	| "SetMessagesRead"
	| "MarkSessionSeen"
	| "CreateSession"
	| "ViewSession"
	| "DeleteSession"
	| "ForkSession"
	| "StartSideThread"
	| "LoadMoreHistory"
	| "RewindSession"
	| "UndoRewind"
>;
