import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/effect/pending-interaction-service.js";
import type {
	OpenCodeModelService,
	PollerManagerShape,
	SessionManagerShape,
	StatusPollerShape,
} from "../../../src/lib/effect/services.js";
import {
	LoggerTag,
	OpenCodeAPITag,
	OpenCodeModelServiceTag,
	PollerManagerTag,
	SessionManagerTag,
	SessionOverridesTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import {
	type SessionManagerService,
	SessionManagerServiceTag,
} from "../../../src/lib/effect/session-manager-service.js";
import { handleViewSession } from "../../../src/lib/handlers/session.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { PermissionId } from "../../../src/lib/shared-types.js";
import {
	makeMockLogger,
	makeMockSessionManagerService,
	makeMockSessionManagerShape,
	makeMockSessionOverrides,
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
	const sessionMgr = options.sessionMgr ?? makeMockSessionManagerShape();
	const sessionManagerService =
		options.sessionManagerService ?? makeMockSessionManagerService();
	const statusPoller: StatusPollerShape = {
		isProcessing: vi.fn(() => false),
		clearMessageActivity: vi.fn(),
	};
	const pollerManager: PollerManagerShape = {
		isPolling: vi.fn(() => true),
		startPolling: vi.fn(),
		stopPolling: vi.fn(),
	};

	const logger = options.logger ?? makeMockLogger();

	const baseLayer = Layer.mergeAll(
		Layer.succeed(OpenCodeAPITag, api),
		Layer.succeed(OpenCodeModelServiceTag, modelService),
		Layer.succeed(WebSocketHandlerTag, wsHandler),
		Layer.succeed(SessionManagerTag, sessionMgr),
		Layer.succeed(SessionManagerServiceTag, sessionManagerService),
		Layer.succeed(SessionOverridesTag, makeMockSessionOverrides()),
		Layer.succeed(LoggerTag, logger),
		PendingInteractionServiceLive,
		Layer.succeed(StatusPollerTag, statusPoller),
		Layer.succeed(PollerManagerTag, pollerManager),
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
