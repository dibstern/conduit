import { SqlClient } from "@effect/sql";
import { Effect, Schema } from "effect";
import {
	type ContinuationError,
	ContinuationErrorSchema,
} from "../../contracts/limit-recovery.js";
import { SessionHandoffDeliveredPayloadSchema } from "../../contracts/stored-event.js";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../../daemon/config-persistence.js";
import { QuotaCheckTag } from "../../domain/daemon/Services/quota-check.js";
import {
	ContinuationTag,
	previewContinuation,
} from "../../domain/relay/Services/continuation.js";
import { DaemonSessionQueryServiceTag } from "../../domain/relay/Services/daemon-session-query-service.js";
import { InstanceManagementServiceTag } from "../../domain/relay/Services/instance-management-service.js";
import { ConfigTag, LoggerTag } from "../../domain/relay/Services/services.js";
import { forkSession } from "../../domain/relay/Services/session-command.js";
import { SessionManagerServiceTag } from "../../domain/relay/Services/session-manager-service.js";
import { rewindSessionToMessage } from "../../handlers/prompt.js";
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
	setSessionAutoSettleForClient,
	setSessionPinnedForClient,
	setSessionSettledForClient,
	snoozeSessionForClient,
	unsnoozeSessionForClient,
	viewSessionForClient,
} from "../../handlers/session.js";
import { preWarmSession } from "../../handlers/session-prewarm.js";
import { ReadQueryEffectTag } from "../../persistence/effect/read-query-effect.js";
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

export const sessionsHandlers = {
	GetGoalDetails: (request) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const read = yield* ReadQueryEffectTag;
			const session = yield* read.getSession(request.sessionId);
			if (!session) {
				return yield* new WsRpcError({
					message: `Session ${request.sessionId} not found`,
				});
			}
			if (
				resolveProviderRoutingDriver(
					loadDaemonConfig(config.configDir),
					session.provider,
				) !== "claude"
			) {
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
	ResolveSession: (request) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const sessionManager = yield* SessionManagerServiceTag;
			const exists = yield* sessionManager.sessionExists(request.sessionId);
			return { projectSlug: exists ? config.slug : null };
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
		reloadProviderSessionForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			commandId: request.commandId,
		}).pipe(
			Effect.as({
				projectSlug: request.projectSlug,
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
		previewContinuation(request.sessionId, request.instanceId).pipe(
			Effect.catchAll(
				(error): Effect.Effect<never, WsRpcError | ContinuationError> =>
					Schema.is(ContinuationErrorSchema)(error)
						? Effect.fail(error)
						: mapRpcFailure("PreviewContinuation")(error),
			),
		),
	QuotaForAccounts: (_request) =>
		Effect.gen(function* () {
			const quota = yield* QuotaCheckTag;
			const management = yield* Effect.serviceOption(
				InstanceManagementServiceTag,
			);
			const config = yield* ConfigTag;
			const instances =
				management._tag === "Some"
					? yield* management.value.list()
					: (loadDaemonConfig(config.configDir)?.instances ?? []);
			const accounts = yield* Effect.forEach(
				instances.filter((instance) => instance.driver === "claude"),
				(instance) =>
					quota
						.check(instance.id)
						.pipe(Effect.map((quota) => ({ instanceId: instance.id, quota }))),
				{ concurrency: 8 },
			);
			return { accounts };
		}).pipe(Effect.catchAll(mapRpcFailure("QuotaForAccounts"))),
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
		createSessionForClient({
			clientId: request.originId,
			...(request.title != null ? { title: request.title } : {}),
			...(request.instanceId != null ? { instanceId: request.instanceId } : {}),
			...(request.providerId != null ? { providerId: request.providerId } : {}),
			...(request.model != null ? { model: request.model } : {}),
		}).pipe(
			Effect.map((session) => ({
				projectSlug: request.projectSlug,
				sessionId: session.id,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `CreateSession failed: ${String(error)}`,
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
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `DeleteSession failed: ${String(error)}`,
					}),
				),
			),
		),
	ForkSession: (request) =>
		forkSessionForClient({
			clientId: request.originId,
			...(request.sessionId != null ? { sessionId: request.sessionId } : {}),
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
							projectSlug: request.projectSlug,
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
						error instanceof WsRpcError
							? error
							: new WsRpcError({
									message: `ForkSession failed: ${String(error)}`,
								}),
					);
				}),
			),
		),
	StartSideThread: (request) =>
		Effect.gen(function* () {
			const session = yield* forkSession(request.parentSessionId, {
				side: { title: request.title },
			});
			// Refresh now rather than on the next projection burst: the side
			// thread's first turn must not read as activity on its parent.
			const sessionManager = yield* SessionManagerServiceTag;
			yield* sessionManager.refreshSessionLineage();
			return { sessionId: session.id };
		}).pipe(
			Effect.catchTag("SessionCommandError", (error) =>
				Effect.fail(
					new WsRpcError({ message: error.message ?? String(error.cause) }),
				),
			),
			Effect.catchAll(mapRpcFailure("StartSideThread")),
		),
	LoadMoreHistory: (request) =>
		loadMoreHistoryForSession({
			sessionId: request.sessionId,
			...(request.before ? { before: request.before } : {}),
		}).pipe(
			Effect.map((page) => ({
				projectSlug: request.projectSlug,
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
	| "ResolveSession"
	| "ListDaemonSessions"
	| "ReloadProviderSession"
	| "RenameSession"
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
>;
