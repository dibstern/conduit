import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
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
	PermissionBridgeTag,
	PollerManagerTag,
	QuestionBridgeTag,
	SessionManagerTag,
	SessionOverridesTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import { handleViewSession } from "../../../src/lib/handlers/session.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import {
	makeMockLogger,
	makeMockPermissionBridge,
	makeMockQuestionBridge,
	makeMockSessionManagerShape,
	makeMockSessionOverrides,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

function makeSessionMetadataLayer(options: {
	readonly api?: OpenCodeAPI;
	readonly logger?: ReturnType<typeof makeMockLogger>;
	readonly modelService?: OpenCodeModelService;
	readonly sessionMgr?: SessionManagerShape;
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
		} satisfies OpenCodeModelService);
	const wsHandler = makeMockWebSocketHandler();
	const sessionMgr = options.sessionMgr ?? makeMockSessionManagerShape();
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

	return {
		api,
		logger,
		modelService,
		wsHandler,
		layer: Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, api),
			Layer.succeed(OpenCodeModelServiceTag, modelService),
			Layer.succeed(WebSocketHandlerTag, wsHandler),
			Layer.succeed(SessionManagerTag, sessionMgr),
			Layer.succeed(SessionOverridesTag, makeMockSessionOverrides()),
			Layer.succeed(LoggerTag, logger),
			Layer.succeed(PermissionBridgeTag, makeMockPermissionBridge()),
			Layer.succeed(QuestionBridgeTag, makeMockQuestionBridge()),
			Layer.succeed(StatusPollerTag, statusPoller),
			Layer.succeed(PollerManagerTag, pollerManager),
		),
	};
}

describe("session handlers with Effect-native model service", () => {
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
		"logs model metadata lookup failures and still sends session lists",
		() => {
			const sendDualSessionLists = vi.fn(async () => undefined);
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
			};
			const { wsHandler, layer } = makeSessionMetadataLayer({
				logger,
				modelService,
				sessionMgr: makeMockSessionManagerShape({ sendDualSessionLists }),
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
					expect(sendDualSessionLists).toHaveBeenCalled();
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
