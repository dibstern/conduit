import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import type {
	OpenCodeModelService,
	PollerManagerShape,
	SessionManagerShape,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	LoggerTag,
	OpenCodeModelServiceTag,
	PollerManagerTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	type SessionManagerService,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	makeOverridesStateLive,
	startProcessingTimeout,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { handleViewSession } from "../../../src/lib/handlers/session.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { PermissionId } from "../../../src/lib/shared-types.js";
import {
	makeMockLogger,
	makeMockSessionManagerService,
	makeMockSessionManagerShape,
	makeMockStatusPoller,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

function makeSessionMetadataLayer(options: {
	readonly api?: OpenCodeAPI;
	readonly logger?: ReturnType<typeof makeMockLogger>;
	readonly modelService?: OpenCodeModelService;
	readonly sessionMgr?: SessionManagerShape;
	readonly sessionManagerService?: SessionManagerService;
}) {
	const api =
		options.api ??
		({
			session: {
				get: vi.fn(async () => {
					throw new Error("session.get must come from model service");
				}),
			},
			permission: { list: vi.fn(async () => []) },
			question: { list: vi.fn(async () => []) },
		} as unknown as OpenCodeAPI);
	const modelService =
		options.modelService ??
		({
			listProviders: vi.fn(() =>
				Effect.succeed({ connected: [], defaults: {}, providers: [] }),
			),
			getSession: vi.fn(() =>
				Effect.succeed({
					id: "session-1",
					projectID: "project-1",
					directory: "/tmp/project",
					title: "Session 1",
					version: "1.0.0",
					time: { created: 0, updated: 0 },
					modelID: "gpt-4",
					providerID: "openai",
				}),
			),
			persistDefaultModel: vi.fn(() => Effect.succeed(undefined)),
		} satisfies OpenCodeModelService);
	const wsHandler = makeMockWebSocketHandler();
	const _sessionMgr = options.sessionMgr ?? makeMockSessionManagerShape();
	const sessionManagerService =
		options.sessionManagerService ?? makeMockSessionManagerService();
	const statusPoller = makeMockStatusPoller({
		isProcessing: vi.fn(() => false),
		clearMessageActivity: vi.fn(),
	});
	const pollerManager: PollerManagerShape = {
		on: vi.fn(),
		isPolling: vi.fn(() => true),
		startPolling: vi.fn(),
		stopPolling: vi.fn(),
		notifySSEEvent: vi.fn(),
	};

	const logger = options.logger ?? makeMockLogger();

	const baseLayer = Layer.mergeAll(
		Layer.succeed(OpenCodeAPITag, api),
		Layer.succeed(OpenCodeModelServiceTag, modelService),
		Layer.succeed(WebSocketHandlerTag, wsHandler),
		Layer.succeed(SessionManagerServiceTag, sessionManagerService),
		Layer.succeed(LoggerTag, logger),
		PendingInteractionServiceLive,
		Layer.succeed(StatusPollerTag, statusPoller),
		Layer.succeed(PollerManagerTag, pollerManager),
		makeOverridesStateLive(),
	);

	return {
		api,
		logger,
		modelService,
		wsHandler,
		layer: baseLayer,
	};
}

describe("session handlers with Effect-native model service", () => {
	it.effect(
		"loads view-session REST history through SessionManagerService",
		() => {
			const legacyLoadPreRenderedHistory = vi.fn(async () => {
				throw new Error("legacy loadPreRenderedHistory should not be used");
			});
			const loadPreRenderedHistory = vi.fn(() =>
				Effect.succeed({
					messages: [
						{
							id: "msg-1",
							role: "assistant" as const,
							parts: [{ id: "part-1", type: "text" as const, text: "hello" }],
						},
					],
					hasMore: false,
				}),
			);
			const sessionManagerService = makeMockSessionManagerService({
				loadPreRenderedHistory,
			});
			const { wsHandler, layer } = makeSessionMetadataLayer({
				sessionMgr: makeMockSessionManagerShape({
					loadPreRenderedHistory: legacyLoadPreRenderedHistory,
				}),
				sessionManagerService,
			});

			return handleViewSession(
				"client-1",
				{ sessionId: "session-1" },
				/* skipMetadata */ true,
			).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(loadPreRenderedHistory).toHaveBeenCalledWith("session-1");
					expect(legacyLoadPreRenderedHistory).not.toHaveBeenCalled();
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "session_switched",
						id: "session-1",
						sessionId: "session-1",
						history: {
							messages: [
								{
									id: "msg-1",
									role: "assistant",
									parts: [{ id: "part-1", type: "text", text: "hello" }],
								},
							],
							hasMore: false,
						},
					});
				}),
			);
		},
	);

	it.effect(
		"loads view-session SQLite history through ReadQueryEffectTag",
		() => {
			const loadPreRenderedHistory = vi.fn(() =>
				Effect.succeed({ messages: [], hasMore: false }),
			);
			const sessionManagerService = makeMockSessionManagerService({
				loadPreRenderedHistory,
			});
			const readQueryEffect = {
				getToolContent: vi.fn(() => Effect.succeed(undefined)),
				getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
				getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
				listSessions: vi.fn(() => Effect.succeed([])),
				getSessionMessagesWithParts: vi.fn(() =>
					Effect.succeed([
						{
							id: "msg-sqlite-1",
							session_id: "session-1",
							turn_id: "turn-1",
							role: "user",
							text: "Earlier prompt",
							cost: null,
							tokens_in: null,
							tokens_out: null,
							tokens_cache_read: null,
							tokens_cache_write: null,
							is_streaming: 0,
							created_at: 10,
							updated_at: 11,
							parts: [
								{
									id: "part-sqlite-1",
									message_id: "msg-sqlite-1",
									type: "text",
									text: "Earlier prompt",
									tool_name: null,
									call_id: null,
									input: null,
									result: null,
									duration: null,
									status: null,
									sort_order: 0,
									created_at: 10,
									updated_at: 11,
								},
							],
						},
					]),
				),
			} satisfies ReadQueryEffect;
			const { wsHandler, layer } = makeSessionMetadataLayer({
				sessionManagerService,
			});

			return handleViewSession(
				"client-1",
				{ sessionId: "session-1" },
				/* skipMetadata */ true,
			).pipe(
				Effect.provide(
					Layer.merge(
						layer,
						Layer.succeed(ReadQueryEffectTag, readQueryEffect),
					),
				),
				Effect.tap(() => {
					expect(
						readQueryEffect.getSessionMessagesWithParts,
					).toHaveBeenCalledWith("session-1");
					expect(loadPreRenderedHistory).not.toHaveBeenCalled();
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "session_switched",
						id: "session-1",
						sessionId: "session-1",
						history: {
							messages: [
								{
									id: "msg-sqlite-1",
									role: "user",
									text: "Earlier prompt",
									time: { created: 10, completed: 11 },
									parts: [
										{
											id: "part-sqlite-1",
											type: "text",
											text: "Earlier prompt",
										},
									],
								},
							],
							hasMore: false,
						},
					});
				}),
			);
		},
	);

	it.effect("loads session model metadata through the model service", () => {
		const { api, modelService, wsHandler, layer } = makeSessionMetadataLayer(
			{},
		);

		return handleViewSession("client-1", { sessionId: "session-1" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(modelService.getSession).toHaveBeenCalledWith("session-1");
				expect(api.session.get).not.toHaveBeenCalled();
				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "model_info",
					model: "gpt-4",
					provider: "openai",
				});
			}),
		);
	});

	it.effect(
		"reports processing when the Effect timeout state has an active turn",
		() => {
			const { wsHandler, layer } = makeSessionMetadataLayer({});

			return Effect.gen(function* () {
				yield* startProcessingTimeout(
					"session-1",
					"2 minutes",
					() => Effect.void,
				);
				yield* handleViewSession(
					"client-1",
					{ sessionId: "session-1" },
					/* skipMetadata */ true,
				);

				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "status",
					sessionId: "session-1",
					status: "processing",
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"replays pending permissions from PendingInteractionService",
		() => {
			const { wsHandler, layer } = makeSessionMetadataLayer({});

			return Effect.gen(function* () {
				const pendingInteractions = yield* PendingInteractionServiceTag;
				yield* pendingInteractions.recordPermissionRequest({
					requestId: "perm-1" as PermissionId,
					sessionId: "session-1",
					toolName: "Bash",
					toolInput: {
						patterns: ["git *"],
						metadata: { command: "git status" },
					},
					always: [],
				});

				yield* handleViewSession("client-1", { sessionId: "session-1" });
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "permission_request",
						sessionId: "session-1",
						requestId: "perm-1",
						toolName: "Bash",
						toolInput: {
							patterns: ["git *"],
							metadata: { command: "git status" },
						},
					});
				}),
			);
		},
	);

	it.effect("replays pending questions from PendingInteractionService", () => {
		const { wsHandler, layer } = makeSessionMetadataLayer({});

		return Effect.gen(function* () {
			const pendingInteractions = yield* PendingInteractionServiceTag;
			yield* pendingInteractions.recordQuestionRequest({
				requestId: "question-1",
				sessionId: "session-1",
				questions: [
					{
						question: "Continue?",
						header: "Confirm",
						options: [{ label: "Yes", description: "Continue" }],
						multiSelect: false,
					},
				],
				toolCallId: "toolu-1",
			});

			yield* handleViewSession("client-1", { sessionId: "session-1" });
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "ask_user",
					sessionId: "session-1",
					toolId: "question-1",
					questions: [
						{
							question: "Continue?",
							header: "Confirm",
							options: [{ label: "Yes", description: "Continue" }],
							multiSelect: false,
						},
					],
					toolUseId: "toolu-1",
				});
			}),
		);
	});

	it.effect(
		"logs model metadata lookup failures and still sends session lists",
		() => {
			const legacySendDualSessionLists = vi.fn(async () => {
				throw new Error("legacy session manager sendDual should not be called");
			});
			const sessionManagerService = makeMockSessionManagerService({
				sendDualSessionLists: vi.fn(() => Effect.void),
			});
			const logger = makeMockLogger();
			const modelService: OpenCodeModelService = {
				listProviders: vi.fn(() =>
					Effect.succeed({ connected: [], defaults: {}, providers: [] }),
				),
				getSession: vi.fn(() =>
					Effect.tryPromise(async () => {
						throw new Error("session metadata unavailable");
					}),
				),
				persistDefaultModel: vi.fn(() => Effect.succeed(undefined)),
			};
			const { wsHandler, layer } = makeSessionMetadataLayer({
				logger,
				modelService,
				sessionMgr: makeMockSessionManagerShape({
					sendDualSessionLists: legacySendDualSessionLists,
				}),
				sessionManagerService,
			});

			return handleViewSession("client-1", { sessionId: "session-1" }).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(logger.warn).toHaveBeenCalledWith(
						expect.stringContaining("Failed to get model info for session-1:"),
					);
					expect(wsHandler.sendTo).not.toHaveBeenCalledWith("client-1", {
						type: "model_info",
						model: "gpt-4",
						provider: "openai",
					});
					expect(legacySendDualSessionLists).not.toHaveBeenCalled();
					expect(sessionManagerService.sendDualSessionLists).toHaveBeenCalled();
				}),
			);
		},
	);

	it.effect("does not send model_info when the session has no model id", () => {
		const modelService: OpenCodeModelService = {
			listProviders: vi.fn(() =>
				Effect.succeed({ connected: [], defaults: {}, providers: [] }),
			),
			getSession: vi.fn(() =>
				Effect.succeed({
					id: "session-1",
					projectID: "project-1",
					directory: "/tmp/project",
					title: "Session 1",
					version: "1.0.0",
					time: { created: 0, updated: 0 },
				}),
			),
			persistDefaultModel: vi.fn(() => Effect.succeed(undefined)),
		};
		const { wsHandler, layer } = makeSessionMetadataLayer({ modelService });

		return handleViewSession("client-1", { sessionId: "session-1" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(modelService.getSession).toHaveBeenCalledWith("session-1");
				expect(wsHandler.sendTo).not.toHaveBeenCalledWith("client-1", {
					type: "model_info",
					model: "gpt-4",
					provider: "openai",
				});
			}),
		);
	});
});
