import { Effect } from "effect";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { DaemonSessionQueryServiceTag } from "../../domain/relay/Services/daemon-session-query-service.js";
import { ConfigTag, LoggerTag } from "../../domain/relay/Services/services.js";
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
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

export const sessionsHandlers = {
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
	| "MarkSessionUnread"
	| "MarkSessionRead"
	| "MarkSessionSeen"
	| "CreateSession"
	| "ViewSession"
	| "DeleteSession"
	| "ForkSession"
	| "LoadMoreHistory"
	| "RewindSession"
>;
