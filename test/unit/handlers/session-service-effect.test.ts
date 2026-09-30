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
import {
	handleViewSession,
	loadMoreHistoryForSession,
	setSessionPinnedForClient,
	setSessionSettledForClient,
} from "../../../src/lib/handlers/session.js";
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
	readonly clientSession?: string;
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
	const wsHandler = makeMockWebSocketHandler(
		options.clientSession === undefined
			? {}
			: { getClientSession: vi.fn(() => options.clientSession) },
	);
	const _sessionMgr = options.sessionMgr ?? makeMockSessionManagerShape();
	const sessionManagerService =
		options.sessionManagerService ?? makeMockSessionManagerService();
	const statusPoller = makeMockStatusPoller({
		isProcessing: vi.fn(() => Effect.succeed(false)),
		clearMessageActivity: vi.fn(() => Effect.void),
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
	for (const changed of [true, false]) {
		it.effect(`refreshes viewed families only when changed=${changed}`, () => {
			const service = makeMockSessionManagerService({
				setSessionSettled: vi.fn(() => Effect.succeed(changed)),
				setSessionPinned: vi.fn(() => Effect.succeed(changed)),
				pushViewerFamilies: vi.fn(() => Effect.void),
			});
			const { wsHandler, layer } = makeSessionMetadataLayer({
				sessionManagerService: service,
			});
			return Effect.gen(function* () {
				yield* setSessionSettledForClient({
					clientId: "c1",
					sessionId: "s1",
					settled: true,
				});
				yield* setSessionPinnedForClient({
					clientId: "c1",
					sessionId: "s1",
					pinned: false,
				});
				expect(service.setSessionSettled).toHaveBeenCalledWith("s1", true);
				expect(service.setSessionPinned).toHaveBeenCalledWith("s1", false);
				expect(service.pushViewerFamilies).toHaveBeenCalledTimes(
					changed ? 2 : 0,
				);
				expect(wsHandler.broadcast).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		});
	}
	const makeOpenCodeRowsReadQuery = (
		historyComplete: number,
		count = 1,
		provider = "opencode",
	) => {
		const projectedRows = Array.from({ length: count }, (_, index) => ({
			id: `msg-projected-${index + 1}`,
			session_id: "session-1",
			turn_id: "turn-1",
			role: "assistant",
			text: `Projected message ${index + 1}`,
			cost: null,
			tokens_in: null,
			tokens_out: null,
			tokens_cache_read: null,
			tokens_cache_write: null,
			context_window: null,
			version: 0,
			is_streaming: 0,
			is_backfilled: index === 0 ? 1 : 0,
			created_at: 10,
			updated_at: 11,
			parts: [],
		}));
		return {
			getToolContent: vi.fn(() => Effect.succeed(undefined)),
			getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
			getSession: vi.fn(() =>
				Effect.succeed({
					id: "session-1",
					provider,
					history_complete: historyComplete,
					provider_sid: "provider-session-1",
					version: 0,
					title: "OpenCode session",
					status: "idle",
					parent_id: null,
					fork_point_event: null,
					last_message_at: 11,
					last_turn_error_at: null,
					permission_mode: null,
					read_at: null,
					settled_at: null,
					pinned_at: null,
					snoozed_at: null,
					snoozed_until: null,
					woken_at: null,
					woken_reason: null,
					created_at: 10,
					updated_at: 11,
				}),
			),
			getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
			getSessionsForReconciliation: () => Effect.succeed([]),
			listSessions: vi.fn(() => Effect.succeed([])),
			listSessionInfos: vi.fn(() => Effect.succeed([])),
			getSessionLineage: () => Effect.succeed({ rows: [], count: 0 }),
			getSessionFamily: () => Effect.succeed([]),
			countPendingApprovalsBySession: vi.fn(() => Effect.succeed([])),
			getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
			// A complete OpenCode projection carries message text and backfill origin.
			readSessionTranscript: vi.fn(() =>
				Effect.succeed({ messages: [], version: 0 }),
			),
			readSessionTranscriptPage: vi.fn(
				(
					_sessionId: string,
					options: { readonly before?: string; readonly limit: number },
				) => {
					const beforeIndex =
						options.before === undefined
							? projectedRows.length
							: projectedRows.findIndex((row) => row.id === options.before);
					const older = projectedRows.slice(0, Math.max(beforeIndex, 0));
					return Effect.succeed({
						messages: older.slice(-options.limit),
						hasMore: older.length > options.limit,
						version: 0,
					});
				},
			),
			readSessionList: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
			getSessionMessagesWithParts: vi.fn(() => Effect.succeed(projectedRows)),
		} satisfies ReadQueryEffect;
	};

	for (const historyComplete of [1, 0]) {
		it.effect(
			`serves SQLite older page for OpenCode history_complete=${historyComplete}`,
			() => {
				const loadPreRenderedHistory = vi.fn(() =>
					Effect.succeed({
						messages: [
							{ id: "rest-older", role: "user" as const, text: "REST older" },
						],
						hasMore: false,
					}),
				);
				const { layer } = makeSessionMetadataLayer({
					sessionManagerService: makeMockSessionManagerService({
						loadPreRenderedHistory,
					}),
				});
				const readQueryEffect = makeOpenCodeRowsReadQuery(historyComplete, 51);
				return loadMoreHistoryForSession({
					sessionId: "session-1",
					before: "msg-projected-2",
				}).pipe(
					Effect.provide(
						Layer.merge(
							layer,
							Layer.succeed(ReadQueryEffectTag, readQueryEffect),
						),
					),
					Effect.tap((result) => {
						expect(loadPreRenderedHistory).not.toHaveBeenCalled();
						expect(result).toMatchObject({
							messages: [{ id: "msg-projected-1", isBackfilled: true }],
							hasMore: false,
						});
						expect(result).not.toHaveProperty("total");
					}),
				);
			},
		);
	}

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
					sessionId: "session-1",
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
				yield* handleViewSession("client-1", { sessionId: "session-1" });

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

	it.effect(
		"sends family before switching and replays descendant permissions",
		() => {
			const sessions = [
				{
					id: "session-1",
					title: "Root",
					status: "idle" as const,
					updatedAt: 0,
					messageCount: 0,
				},
				{
					id: "child",
					parentID: "session-1",
					title: "Child",
					status: "idle" as const,
					updatedAt: 0,
					messageCount: 0,
				},
				{
					id: "grandchild",
					parentID: "child",
					title: "Grandchild",
					status: "idle" as const,
					updatedAt: 0,
					messageCount: 0,
				},
			];
			const { wsHandler, layer } = makeSessionMetadataLayer({
				sessionManagerService: makeMockSessionManagerService({
					getSessionFamily: () =>
						Effect.succeed({
							type: "session_family",
							rootId: "session-1",
							sessions,
						}),
				}),
			});
			return Effect.gen(function* () {
				const pending = yield* PendingInteractionServiceTag;
				for (const sessionId of ["grandchild", "unrelated"]) {
					yield* pending.recordPermissionRequest({
						requestId: sessionId as PermissionId,
						sessionId,
						toolName: "Bash",
						toolInput: {},
						always: [],
					});
				}
				yield* handleViewSession("client-1", { sessionId: "session-1" });
				expect(wsHandler.sendTo).toHaveBeenCalledWith(
					"client-1",
					expect.objectContaining({
						type: "permission_request",
						sessionId: "grandchild",
					}),
				);
				expect(wsHandler.sendTo).not.toHaveBeenCalledWith(
					"client-1",
					expect.objectContaining({
						type: "permission_request",
						sessionId: "unrelated",
					}),
				);
				const messages = vi
					.mocked(wsHandler.sendTo)
					.mock.calls.map((call) => call[1].type);
				expect(messages).toContain("session_family");
			}).pipe(Effect.provide(layer));
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
			const legacySendSessionLists = vi.fn(async () => {
				throw new Error("legacy session manager sendDual should not be called");
			});
			const sessionManagerService = makeMockSessionManagerService({
				pushViewerFamilies: vi.fn(() => Effect.void),
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
					sendSessionLists: legacySendSessionLists,
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
					expect(legacySendSessionLists).not.toHaveBeenCalled();
					expect(sessionManagerService.pushViewerFamilies).toHaveBeenCalled();
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

// A switch also fires on restore, reload and reconnect, so it writes no read
// state; the browser reports a user's pick instead (ADR-0004, Scope;
// conduit-test-hk9m.3).
describe("viewing a session", () => {
	it.effect("writes no read state and sends no broad list broadcast", () => {
		const markSessionRead = vi.fn(() => Effect.void);
		const markSessionSeen = vi.fn(() => Effect.succeed(true));
		const service = makeMockSessionManagerService({
			markSessionRead,
			markSessionSeen,
		});
		const { wsHandler, layer } = makeSessionMetadataLayer({
			clientSession: "session-left",
			sessionManagerService: service,
		});
		return handleViewSession("client-1", { sessionId: "session-1" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(markSessionRead).not.toHaveBeenCalled();
				expect(markSessionSeen).not.toHaveBeenCalled();
				expect(service.pushViewerFamilies).toHaveBeenCalledOnce();
				expect(wsHandler.broadcast).not.toHaveBeenCalledWith(
					expect.objectContaining({ type: "session_list", roots: false }),
				);
			}),
		);
	});
});
