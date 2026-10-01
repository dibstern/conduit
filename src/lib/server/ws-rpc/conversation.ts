import { Effect } from "effect";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { RateLimiterTag } from "../../domain/relay/Layers/rate-limiter-layer.js";
import {
	LoggerTag,
	WebSocketHandlerTag,
} from "../../domain/relay/Services/services.js";
import { persistSessionPermissionMode } from "../../domain/relay/Services/session-manager-permission-mode.js";
import {
	getPermissionMode,
	setPermissionMode,
} from "../../domain/relay/Services/session-overrides-state.js";
import {
	handleAskUserResponse,
	handlePermissionResponse,
	handleQuestionReject,
} from "../../handlers/permissions.js";
import {
	cancelSessionById,
	sendMessageToSession,
	syncInputDraftForSession,
} from "../../handlers/prompt.js";
import { ProviderRegistryTag } from "../../provider/provider-registry.js";
import type { PermissionId } from "../../shared-types.js";
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

export const conversationHandlers = {
	SwitchPermissionMode: (request) =>
		Effect.gen(function* () {
			const previousMode = yield* getPermissionMode(request.sessionId);
			const log = yield* LoggerTag;
			yield* persistSessionPermissionMode(request.sessionId, request.mode);

			return yield* Effect.gen(function* () {
				const wsHandler = yield* WebSocketHandlerTag;
				const registry = yield* ProviderRegistryTag;
				const providerInstance = registry.getInstance("claude");
				if (providerInstance?.setPermissionModeEffect) {
					yield* providerInstance.setPermissionModeEffect(
						request.sessionId,
						request.mode,
					);
				}
				yield* setPermissionMode(request.sessionId, request.mode);
				wsHandler.sendToSession(request.sessionId, {
					type: "permission_mode_info",
					mode: request.mode,
				});
				log.info(
					`client=${request.originId ?? "rpc"} session=${request.sessionId} Switched permission mode to: ${request.mode}`,
				);
				return { projectSlug: request.projectSlug, mode: request.mode };
			}).pipe(
				Effect.tapError(() =>
					persistSessionPermissionMode(request.sessionId, previousMode).pipe(
						Effect.catchAll((compensationError) =>
							Effect.sync(() => {
								log.error(
									`session=${request.sessionId} Failed to restore permission mode to ${previousMode} after SwitchPermissionMode failure`,
									compensationError,
								);
							}),
						),
					),
				),
			);
		}).pipe(Effect.catchAll(mapRpcFailure("SwitchPermissionMode"))),
	RespondPermission: (request) =>
		handlePermissionResponse(request.originId, {
			requestId: request.requestId as PermissionId,
			commandId: request.commandId,
			decision: request.decision,
			...(request.persistScope != null
				? { persistScope: request.persistScope }
				: {}),
			...(request.persistPattern != null
				? { persistPattern: request.persistPattern }
				: {}),
			...(request.permissionDestination != null
				? { permissionDestination: request.permissionDestination }
				: {}),
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `RespondPermission failed: ${String(error)}`,
					}),
				),
			),
		),
	AnswerQuestion: (request) =>
		handleAskUserResponse(request.originId, {
			toolId: request.toolId,
			commandId: request.commandId,
			answers: request.answers,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `AnswerQuestion failed: ${String(error)}`,
					}),
				),
			),
		),
	RejectQuestion: (request) =>
		handleQuestionReject(request.originId, {
			toolId: request.toolId,
			commandId: request.commandId,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `RejectQuestion failed: ${String(error)}`,
					}),
				),
			),
		),
	SendMessage: (request) =>
		Effect.gen(function* () {
			const limiter = yield* RateLimiterTag;
			const result = yield* limiter.checkLimit(
				request.originId ?? request.sessionId,
			);
			if (!result.allowed) {
				return yield* Effect.fail(
					new WsRpcError({
						message: `Rate limited. Try again in ${Math.ceil((result.retryAfterMs ?? 1000) / 1000)}s`,
					}),
				);
			}
			const sessionId = yield* sendMessageToSession({
				clientId: request.originId ?? "rpc",
				sessionId: request.sessionId,
				text: request.text,
				commandId: request.commandId,
				...(request.images ? { images: request.images } : {}),
				...(request.originId ? { originId: request.originId } : {}),
				errorDelivery: "session",
			});
			return { ok: true as const, sessionId: sessionId ?? request.sessionId };
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SendMessage failed: ${String(error)}`,
					}),
				),
			),
		),
	SyncInputDraft: (request) =>
		syncInputDraftForSession({
			sessionId: request.sessionId,
			text: request.text,
			...(request.originId ? { from: request.originId } : {}),
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SyncInputDraft failed: ${String(error)}`,
					}),
				),
			),
		),
	CancelSession: (request) =>
		cancelSessionById("rpc", request.sessionId, request.commandId).pipe(
			Effect.as({ ok: true as const }),
		),
} satisfies Pick<
	WsRpcHandlerMap,
	| "SwitchPermissionMode"
	| "RespondPermission"
	| "AnswerQuestion"
	| "RejectQuestion"
	| "SendMessage"
	| "SyncInputDraft"
	| "CancelSession"
>;
