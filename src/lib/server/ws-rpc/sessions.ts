import { SqlClient } from "@effect/sql";
import { Effect, Schema } from "effect";
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
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { AccountDirectory } from "../../domain/daemon/Services/account-directory.js";
import { Usage } from "../../domain/daemon/Services/usage.js";
import { WorktreeServiceTag } from "../../domain/daemon/Services/worktree-service.js";
import {
	ContinuationTag,
	previewContinuation,
} from "../../domain/relay/Services/continuation.js";
import { DaemonSessionQueryServiceTag } from "../../domain/relay/Services/daemon-session-query-service.js";
import {
	DraftPreWarmTag,
	draftLaunchKey,
} from "../../domain/relay/Services/draft-prewarm.js";
import { ConfigTag, LoggerTag } from "../../domain/relay/Services/services.js";
import { forkSession } from "../../domain/relay/Services/session-command.js";
import { SessionGitServiceTag } from "../../domain/relay/Services/session-git-service.js";
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
	setSessionAutoSettleForClient,
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
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

const sideThreadStarts = Effect.unsafeMakeSemaphore(1);

export const sessionsHandlers = {
	ListBranches: (_request) =>
		Effect.flatMap(ConfigTag, (config) =>
			listLocalBranches(config.projectDir),
		).pipe(Effect.catchAll(mapRpcFailure("ListBranches"))),
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
		}).pipe(Effect.catchAll(mapRpcFailure("ListWorktrees"))),
	InspectSessionWorktrees: (request) =>
		Effect.gen(function* () {
			const read = yield* ReadQueryEffectTag;
			if (!(yield* read.getSession(request.sessionId)))
				return yield* new WsRpcError({ message: "Session not found." });
			const plan = yield* prepareSessionWorktreeDeletion(request.sessionId);
			return {
				worktrees: plan.worktrees,
				removeWorktrees: plan.removeWorktrees,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("InspectSessionWorktrees"))),
	RenameSessionBranch: (request) =>
		Effect.gen(function* () {
			const workspace = yield* SessionWorkspaceTag;
			yield* workspace.renameBranch(request.sessionId, request.branchName);
			const git = yield* Effect.serviceOption(SessionGitServiceTag);
			if (git._tag === "Some") yield* git.value.refresh();
			return { ok: true as const };
		}).pipe(
			Effect.catchAll(
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
				directory: yield* workspace.move(
					request.sessionId,
					request.path,
					"user",
				),
			};
		}).pipe(
			Effect.catchAll(
				(error): Effect.Effect<never, WorkspaceMoveError | WsRpcError> =>
					error instanceof WorkspaceMoveError
						? Effect.fail(error)
						: mapRpcFailure("MoveSessionWorkspace")(error),
			),
		),
	RecreateSessionWorktree: (request) =>
		recreateSessionWorktrees(request.sessionId).pipe(
			Effect.catchAll(
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
				workspace
					.move(request.sessionId, config.projectDir, "user")
					.pipe(Effect.map((directory) => ({ directory }))),
			);
		}).pipe(
			Effect.catchAll(
				(error): Effect.Effect<never, WorkspaceMoveError | WsRpcError> =>
					error instanceof WorkspaceMoveError
						? Effect.fail(error)
						: mapRpcFailure("ContinueSessionInMainFolder")(error),
			),
		),
	DismissWorkspaceHint: (request) =>
		dismissWorkspaceHint(request.sessionId, request.path).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll(mapRpcFailure("DismissWorkspaceHint")),
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
					message: "Goal details are available only for Claude sessions",
				});
			}
			return yield* read.getGoalDetails(request.sessionId);
		}).pipe(Effect.catchAll(mapRpcFailure("GetGoalDetails"))),
	PreWarmSession: (request) =>
		preWarmSession(request.sessionId).pipe(
			Effect.catchAll(mapRpcFailure("PreWarmSession")),
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
		}).pipe(Effect.catchAll(mapRpcFailure("ResolveSession"))),
	ListDaemonSessions: (request) =>
		Effect.gen(function* () {
			const daemonSessions = yield* DaemonSessionQueryServiceTag;
			const result = yield* daemonSessions.list({
				...(request.limit !== undefined ? { limit: request.limit } : {}),
				...(request.roots !== undefined ? { roots: request.roots } : {}),
				...(request.search !== undefined ? { search: request.search } : {}),
				...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
				...(request.scope !== undefined ? { scope: request.scope } : {}),
				...(request.exclude !== undefined ? { exclude: request.exclude } : {}),
			});
			return {
				projectSlug: request.projectSlug,
				...result,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("ListDaemonSessions"))),
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
				Effect.catchAll((error) =>
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
			Effect.catchAll((error) =>
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
			Effect.mapError(
				(error) =>
					new WsRpcError({
						message: `SetSessionSettled failed: ${String(error.cause)}`,
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
			Effect.mapError(
				(error) =>
					new WsRpcError({
						message: `SetSessionPinned failed: ${String(error.cause)}`,
					}),
			),
		),
	SetSessionAutoSettle: (request) =>
		setSessionAutoSettleForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			disabled: request.disabled,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll(mapRpcFailure("SetSessionAutoSettle")),
		),
	SnoozeSession: (request) =>
		snoozeSessionForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			until: request.until,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.mapError(
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
			Effect.catchAll(mapRpcFailure("DismissCutOff")),
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
			Effect.catchAll(
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
			Effect.catchAll(mapRpcFailure("CancelContinuation")),
		),
	PreviewContinuation: (request) =>
		previewContinuation(
			request.sessionId,
			request.instanceId,
			request.accountRef,
		).pipe(
			Effect.catchAll(
				(error): Effect.Effect<never, WsRpcError | ContinuationError> =>
					Schema.is(ContinuationErrorSchema)(error)
						? Effect.fail(error)
						: mapRpcFailure("PreviewContinuation")(error),
			),
		),
	QuotaForAccounts: (_request) =>
		Effect.flatMap(Usage, (usage) => usage.refresh()).pipe(
			Effect.catchAll(mapRpcFailure("QuotaForAccounts")),
		),
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
			const data = yield* Schema.decodeUnknown(
				Schema.parseJson(SessionHandoffDeliveredPayloadSchema),
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
		}).pipe(Effect.catchAll(mapRpcFailure("GetContinuationHandoff"))),
	UnsnoozeSession: (request) =>
		unsnoozeSessionForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.mapError(
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
			Effect.catchAll((error) =>
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
			Effect.catchAll(mapRpcFailure("MarkSessionSeen")),
		),
	MarkSessionRead: (request) =>
		markSessionReadForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `MarkSessionRead failed: ${String(error)}`,
					}),
				),
			),
		),
	CreateSession: (request) =>
		Effect.gen(function* () {
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
			const launchKey = resolvedCreation
				? yield* resolveDraftLaunchInput(resolvedCreation, path).pipe(
						Effect.map(draftLaunchKey),
						Effect.catchAllCause((cause) =>
							Effect.gen(function* () {
								const log = yield* LoggerTag;
								log.debug(`Draft launch comparison failed: ${String(cause)}`);
								return undefined;
							}),
						),
					)
				: undefined;
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
			};
			if (request.newWorktree) {
				yield* takeReservation;
				if (path !== undefined)
					return yield* new WsRpcError({
						message: "Choose either a new worktree or an existing worktree.",
					});
				const config = yield* ConfigTag;
				if (!PROVIDER_SESSION_CAPABILITIES[account.driver].supportsNewWorktree)
					return yield* new WorkspaceMoveError({
						path: config.projectDir,
						reason: "unsupported-provider",
					});
				const worktrees = yield* WorktreeServiceTag;
				const sessionId = createLocalSessionId();
				const session = yield* workspace.withLaunch(
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
								Effect.catchAllCause((cause) =>
									worktrees
										.rollback(created)
										.pipe(Effect.zipRight(Effect.failCause(cause))),
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
			// Taking a reservation and arming its rollback must not be split by interruption.
			const session = yield* Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const reservedSessionId = yield* takeReservation;
					const create = createSessionForClient({
						...options,
						...(reservedSessionId === undefined
							? {}
							: { sessionId: reservedSessionId }),
						...(path === undefined
							? {}
							: {
									initializeWorkspace: (sessionId: string) =>
										workspace
											.move(sessionId, path, "launch")
											.pipe(Effect.asVoid),
								}),
					});
					return yield* restore(
						path === undefined ? create : workspace.withLaunch(create),
					).pipe(
						Effect.onError(() =>
							reservedSessionId && drafts._tag === "Some"
								? drafts.value.discardSession(reservedSessionId)
								: Effect.void,
						),
					);
				}),
			);
			return {
				projectSlug: request.projectSlug,
				sessionId: session.id,
			};
		}).pipe(
			Effect.tap(() =>
				Effect.gen(function* () {
					if (
						request.draftId === undefined ||
						request.worktreePath !== undefined
					)
						return;
					const config = yield* ConfigTag;
					yield* Effect.try(() =>
						saveRelaySettings(
							{ lastSessionMode: request.newWorktree ? "worktree" : "local" },
							config.configDir,
						),
					).pipe(
						Effect.catchAll((cause) =>
							Effect.gen(function* () {
								const log = yield* LoggerTag;
								log.warn("Failed to persist last session mode", { cause });
							}),
						),
					);
				}),
			),
			Effect.catchAll(
				(
					error,
				): Effect.Effect<
					never,
					| WorkspaceMoveError
					| WorktreeCreationError
					| AccountUnroutable
					| WsRpcError
				> =>
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
			Effect.map(({ draft }) => ({ ok: true as const, draft })),
			Effect.catchAll((error) =>
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
			Effect.catchAll((error) =>
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
								parentId: session.parentId,
								...(session.forkMessageId && {
									forkMessageId: session.forkMessageId,
								}),
								...(session.forkPointTimestamp != null && {
									forkPointTimestamp: session.forkPointTimestamp,
								}),
							}),
				),
				Effect.catchAll((error) =>
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
				...(request.images ? { images: request.images } : {}),
			}).pipe(Effect.catchAll(mapRpcFailure("StartSideThread")));
			return { sessionId };
		}).pipe(
			Effect.catchTag("SessionCommandError", (error) =>
				Effect.fail(
					new WsRpcError({ message: error.message ?? String(error.cause) }),
				),
			),
			Effect.catchAll(
				(error): Effect.Effect<never, AccountUnroutable | WsRpcError> =>
					error instanceof AccountUnroutable
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
				Effect.catchAll((error) =>
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
			Effect.catchAll(mapRpcFailure("UndoRewind")),
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
			Effect.catchAll((error) =>
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
	| "PreWarmSession"
	| "PreWarmDraft"
	| "ResolveSession"
	| "ListDaemonSessions"
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
	| "SetSessionPinned"
	| "SetSessionAutoSettle"
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
