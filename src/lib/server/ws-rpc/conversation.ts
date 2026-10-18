import { Effect } from "effect";
import { AccountUnroutable } from "../../contracts/limit-recovery.js";
import { PROVIDER_DRIVERS } from "../../contracts/provider-instance.js";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { AccountDirectory } from "../../domain/daemon/Services/account-directory.js";
import { RateLimiterTag } from "../../domain/relay/Layers/rate-limiter-layer.js";
import { RecapServiceTag } from "../../domain/relay/Services/recap-service.js";
import { ConfigTag, LoggerTag } from "../../domain/relay/Services/services.js";
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
import { stopBackgroundTaskById } from "../../handlers/background-tasks.js";
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
import { ReadQueryEffectTag } from "../../persistence/effect/read-query-effect.js";
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
	ExplainAsk: (request) =>
		RecapServiceTag.pipe(
			Effect.flatMap((service) => service.explainAsk(request)),
			Effect.catchAll(mapRpcFailure("ExplainAsk")),
		),
	ListRecaps: (request) =>
		RecapServiceTag.pipe(
			Effect.flatMap((service) => service.list(request)),
			Effect.catchAll(mapRpcFailure("ListRecaps")),
		),
	GenerateRecap: (request) =>
		RecapServiceTag.pipe(
			Effect.flatMap((service) => service.generate(request)),
			Effect.catchAll(mapRpcFailure("GenerateRecap")),
		),
	StopBackgroundTask: (request) =>
		stopBackgroundTaskById(request.sessionId, request.taskId).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll(mapRpcFailure("StopBackgroundTask")),
		),
	SwitchPermissionMode: (request) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
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
				// OpenCode enforces a Side Thread's mode through session rules.
				const session = yield* (yield* ReadQueryEffectTag).getSession(
					request.sessionId,
				);
				if (
					session?.side_thread === 1 &&
					PROVIDER_DRIVERS[
						(yield* (yield* AccountDirectory).resolve({
							_tag: "Id",
							id: session.provider,
						})).driver
					].runsOpenCodeServer
				) {
					const opencode = registry.getInstance("opencode");
					if (opencode?.setPermissionModeEffect) {
						yield* opencode.setPermissionModeEffect(
							request.sessionId,
							request.mode,
						);
					}
				}
				yield* setPermissionMode(request.sessionId, request.mode);
				log.info(
					`client=${request.originId ?? "rpc"} session=${request.sessionId} Switched permission mode to: ${request.mode}`,
				);
				return { projectSlug: config.slug, mode: request.mode };
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
			});
			return "refused" in sent
				? { ok: false as const, reason: sent.refused }
				: {
						ok: true as const,
						sessionId: sent.sessionId ?? request.sessionId,
						handedOff: sent.handedOff,
					};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					error instanceof AccountUnroutable
						? error
						: new WsRpcError({
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
				...(request.interrupt ? { interrupt: true } : {}),
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
			Effect.catchAll(mapRpcFailure("CancelSession")),
		),
} satisfies Pick<
	WsRpcHandlerMap,
	| "ListRecaps"
	| "GenerateRecap"
	| "ExplainAsk"
	| "StopBackgroundTask"
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
