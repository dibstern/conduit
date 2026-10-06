import { Effect } from "effect";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { RateLimiterTag } from "../../domain/relay/Layers/rate-limiter-layer.js";
import { LoggerTag } from "../../domain/relay/Services/services.js";
import {
	type SessionInbox,
	type SessionInboxOutcome,
	SessionInboxTag,
} from "../../domain/relay/Services/session-inbox.js";
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

const inboxCommand = <E>(
	name: string,
	run: (inbox: SessionInbox) => Effect.Effect<SessionInboxOutcome, E, never>,
) =>
	SessionInboxTag.pipe(
		Effect.flatMap(run),
		Effect.map((outcome) =>
			outcome === "accepted"
				? { ok: true as const }
				: { ok: false as const, reason: outcome },
		),
		Effect.catchAll((error) =>
			Effect.fail(
				new WsRpcError({ message: `${name} failed: ${String(error)}` }),
			),
		),
	);

export const conversationHandlers = {
	SwitchPermissionMode: (request) =>
		Effect.gen(function* () {
			const previousMode = yield* getPermissionMode(request.sessionId);
			const log = yield* LoggerTag;
			yield* persistSessionPermissionMode(request.sessionId, request.mode);

			return yield* Effect.gen(function* () {
				const registry = yield* ProviderRegistryTag;
				const providerInstance = registry.getInstance("claude");
				if (providerInstance?.setPermissionModeEffect) {
					yield* providerInstance.setPermissionModeEffect(
						request.sessionId,
						request.mode,
					);
				}
				yield* setPermissionMode(request.sessionId, request.mode);
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
			Effect.catchAll(mapRpcFailure("AnswerQuestion")),
		),
	RejectQuestion: (request) =>
		handleQuestionReject(request.originId, {
			toolId: request.toolId,
			commandId: request.commandId,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll(mapRpcFailure("RejectQuestion")),
		),
	"input.submit": (request) =>
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
			const sent = yield* sendMessageToSession({
				clientId: request.originId ?? "rpc",
				sessionId: request.sessionId,
				text: request.text,
				commandId: request.inputId,
				delivery: request.delivery,
				...(request.images ? { images: request.images } : {}),
				errorDelivery: "session",
			});
			return sent.refused
				? { ok: false as const, reason: sent.refused }
				: { ok: true as const, sessionId: sent.sessionId ?? request.sessionId };
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `input.submit failed: ${String(error)}`,
					}),
				),
			),
		),
	"input.cancel": (request) =>
		inboxCommand("input.cancel", (inbox) =>
			inbox.cancel({
				clientId: "rpc",
				sessionId: request.sessionId,
				inputId: request.inputId,
			}),
		),
	"input.sendNow": (request) =>
		inboxCommand("input.sendNow", (inbox) =>
			inbox.sendNow({
				clientId: request.originId ?? "rpc",
				sessionId: request.sessionId,
				inputId: request.inputId,
			}),
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
	| "input.submit"
	| "input.cancel"
	| "input.sendNow"
	| "SyncInputDraft"
	| "CancelSession"
>;
