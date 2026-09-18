import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
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
	SessionManagerError,
	type SessionManagerService,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	makeOverridesStateLive,
	startProcessingTimeout,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { handleViewSession } from "../../../src/lib/handlers/session.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import type {
	PermissionId,
	RelayMessage,
} from "../../../src/lib/shared-types.js";
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

function makeEmptySessionReadQuery(provider: string): ReadQueryEffect {
	return {
		getToolContent: vi.fn(() => Effect.succeed(undefined)),
		getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
		getSession: vi.fn(() =>
			Effect.succeed({
				id: "session-1",
				provider,
				provider_sid: null,
				version: 0,
				title: "Session 1",
				status: "idle",
				parent_id: null,
				fork_point_event: null,
				last_message_at: null,
				permission_mode: null,
				created_at: 1,
				updated_at: 1,
			}),
		),
		getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
		listSessions: vi.fn(() => Effect.succeed([])),
		getSessionDetailSnapshot: vi.fn(() =>
			Effect.succeed({ messages: [], sequence: 0 }),
		),
		getSessionListEntry: vi.fn(() => Effect.succeed(undefined)),
		getStampedSessionListEntry: vi.fn(() => Effect.succeed(undefined)),
		getSessionListSnapshot: vi.fn(() =>
			Effect.succeed({ rows: [], sequence: 0 }),
		),
		getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
		getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
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
		"loads view-session SQLite history through ReadQueryEffectTag for relay-local sessions",
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
				getSession: vi.fn(() =>
					Effect.succeed({
						id: "session-1",
						provider: "claude",
						provider_sid: "provider-session-1",
						version: 0,
						title: "Child session",
						status: "idle",
						parent_id: "parent-session",
						fork_point_event: null,
						last_message_at: 11,
						permission_mode: null,
						created_at: 10,
						updated_at: 11,
					}),
				),
				getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
				listSessions: vi.fn(() => Effect.succeed([])),
				getSessionDetailSnapshot: vi.fn(() =>
					Effect.succeed({ messages: [], sequence: 0 }),
				),
				getSessionListEntry: vi.fn(() => Effect.succeed(undefined)),
				getStampedSessionListEntry: vi.fn(() => Effect.succeed(undefined)),
				getSessionListSnapshot: vi.fn(() =>
					Effect.succeed({ rows: [], sequence: 0 }),
				),
				getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
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
							context_window: null,
							version: 0,
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
									metadata: null,
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
						parentID: "parent-session",
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
											time: { start: 10, end: 11 },
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

	it.effect("falls back when OpenCode projected history is empty", () => {
		const loadPreRenderedHistory = vi.fn(() =>
			Effect.succeed({
				messages: [
					{ id: "history-1", role: "user" as const, text: "Recovered" },
				],
				hasMore: false,
			}),
		);
		const sessionManagerService = makeMockSessionManagerService({
			loadPreRenderedHistory,
		});
		const readQueryEffect = makeEmptySessionReadQuery("opencode");
		const { wsHandler, layer } = makeSessionMetadataLayer({
			sessionManagerService,
		});

		return handleViewSession(
			"client-1",
			{ sessionId: "session-1" },
			/* skipMetadata */ true,
		).pipe(
			Effect.provide(
				Layer.merge(layer, Layer.succeed(ReadQueryEffectTag, readQueryEffect)),
			),
			Effect.tap(() => {
				expect(loadPreRenderedHistory).toHaveBeenCalledWith("session-1");
				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "session_switched",
					id: "session-1",
					sessionId: "session-1",
					history: {
						messages: [{ id: "history-1", role: "user", text: "Recovered" }],
						hasMore: false,
					},
				});
			}),
		);
	});

	const makeSkeletonRowsReadQuery = () =>
		({
			getToolContent: vi.fn(() => Effect.succeed(undefined)),
			getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
			getSession: vi.fn(() =>
				Effect.succeed({
					id: "session-1",
					provider: "opencode",
					provider_sid: "provider-session-1",
					version: 0,
					title: "Skeleton session",
					status: "idle",
					parent_id: null,
					fork_point_event: null,
					last_message_at: 11,
					permission_mode: null,
					created_at: 10,
					updated_at: 11,
				}),
			),
			getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
			listSessions: vi.fn(() => Effect.succeed([])),
			getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
			// Rows exist but carry no text — the shape the OpenCode runtime
			// projection produces today (structure without content).
			getSessionDetailSnapshot: vi.fn(() =>
				Effect.succeed({ messages: [], sequence: 0 }),
			),
			getSessionListEntry: vi.fn(() => Effect.succeed(undefined)),
			getStampedSessionListEntry: vi.fn(() => Effect.succeed(undefined)),
			getSessionListSnapshot: vi.fn(() =>
				Effect.succeed({ rows: [], sequence: 0 }),
			),
			getSessionMessagesWithParts: vi.fn(() =>
				Effect.succeed([
					{
						id: "msg-skeleton-1",
						session_id: "session-1",
						turn_id: "turn-1",
						role: "assistant",
						text: "",
						cost: null,
						tokens_in: null,
						tokens_out: null,
						tokens_cache_read: null,
						tokens_cache_write: null,
						context_window: null,
						version: 0,
						is_streaming: 0,
						created_at: 10,
						updated_at: 11,
						parts: [],
					},
				]),
			),
		}) satisfies ReadQueryEffect;

	it.effect(
		"prefers provider REST history over projected rows for OpenCode sessions",
		() => {
			const loadPreRenderedHistory = vi.fn(() =>
				Effect.succeed({
					messages: [
						{ id: "history-1", role: "user" as const, text: "Real prompt" },
					],
					hasMore: false,
				}),
			);
			const sessionManagerService = makeMockSessionManagerService({
				loadPreRenderedHistory,
			});
			const readQueryEffect = makeSkeletonRowsReadQuery();
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
					expect(loadPreRenderedHistory).toHaveBeenCalledWith("session-1");
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "session_switched",
						id: "session-1",
						sessionId: "session-1",
						history: {
							messages: [
								{ id: "history-1", role: "user", text: "Real prompt" },
							],
							hasMore: false,
						},
					});
				}),
			);
		},
	);

	it.effect(
		"falls back to projected rows when REST fails for an OpenCode session",
		() => {
			const loadPreRenderedHistory = vi.fn(() =>
				Effect.fail(
					new SessionManagerError({
						operation: "loadPreRenderedHistory",
						cause: "opencode unreachable",
					}),
				),
			);
			const sessionManagerService = makeMockSessionManagerService({
				loadPreRenderedHistory,
			});
			const readQueryEffect = makeSkeletonRowsReadQuery();
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
					expect(loadPreRenderedHistory).toHaveBeenCalledWith("session-1");
					const historyCall = vi
						.mocked(wsHandler.sendTo)
						.mock.calls.find(([, msg]) => msg.type === "session_switched");
					expect(historyCall).toBeDefined();
					const sent = historyCall?.[1] as {
						history?: { messages: Array<{ id: string }> };
					};
					expect(sent.history?.messages[0]?.id).toBe("msg-skeleton-1");
				}),
			);
		},
	);

	it.effect("keeps empty projected history for a Claude session", () => {
		const loadPreRenderedHistory = vi.fn(() =>
			Effect.succeed({
				messages: [{ id: "history-1", role: "user" as const, text: "Wrong" }],
				hasMore: false,
			}),
		);
		const sessionManagerService = makeMockSessionManagerService({
			loadPreRenderedHistory,
		});
		const readQueryEffect = makeEmptySessionReadQuery("claude");
		const { wsHandler, layer } = makeSessionMetadataLayer({
			sessionManagerService,
		});

		return handleViewSession(
			"client-1",
			{ sessionId: "session-1" },
			/* skipMetadata */ true,
		).pipe(
			Effect.provide(
				Layer.merge(layer, Layer.succeed(ReadQueryEffectTag, readQueryEffect)),
			),
			Effect.tap(() => {
				expect(loadPreRenderedHistory).not.toHaveBeenCalled();
				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "session_switched",
					id: "session-1",
					sessionId: "session-1",
				});
			}),
		);
	});

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

// ─── Viewing writes the read model (ni8.23) ─────────────────────────────────
// Viewing used to be announced with a `notification_event` broadcast that every
// client folded into its own badge state. The fact now lives on the row, so the
// handler writes it and the subscription carries it; the broadcast is gone.

describe("viewing a session", () => {
	const withStore = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-view-trigger-"));
		return effect.pipe(
			Effect.provide(makePersistenceEffectLayer(join(dir, "events.db"))),
			Effect.ensuring(
				Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
			),
		);
	};

	const seedSession = (id: string) =>
		Effect.flatMap(
			SqlClient.SqlClient,
			(sql) => sql`
				INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES (${id}, 'claude', ${id}, 'idle', 1, 1)`,
		);

	const lastViewedAt = (id: string) =>
		Effect.flatMap(SqlClient.SqlClient, (sql) =>
			sql<{
				last_viewed_at: number | null;
				version: number;
			}>`SELECT last_viewed_at, version FROM sessions WHERE id = ${id}`.pipe(
				Effect.map((rows) => rows[0]),
			),
		);

	it.effect("stamps the row it opens, and the row it leaves", () => {
		const { wsHandler, layer } = makeSessionMetadataLayer({
			clientSession: "session-left",
		});
		return withStore(
			Effect.gen(function* () {
				yield* seedSession("session-1");
				yield* seedSession("session-left");

				yield* handleViewSession(
					"client-1",
					{ sessionId: "session-1" },
					/* skipMetadata */ true,
				);

				// The session just opened is obviously seen.
				const opened = yield* lastViewedAt("session-1");
				expect(opened?.last_viewed_at).toBeGreaterThan(0);
				// And so is the one being left: whatever streamed in while it was on
				// screen was read there. Badging it on the way out would be a lie.
				const left = yield* lastViewedAt("session-left");
				expect(left?.last_viewed_at).toBeGreaterThan(0);
				// Both rows moved their version with the column — the only thing a
				// subscriber watches (ni8.23 C2).
				expect(opened?.version).toBeGreaterThan(0);
				expect(left?.version).toBeGreaterThan(0);
				expect(left?.version).not.toBe(opened?.version);
				expect(wsHandler.broadcast).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "session_list",
						sessions: expect.arrayContaining([
							expect.objectContaining({
								id: "session-1",
								unseenActivity: false,
							}),
						]),
					}),
				);

				// No side-channel announcement of a fact the row already carries.
				const broadcasts = wsHandler.broadcast as unknown as {
					mock: { calls: readonly (readonly RelayMessage[])[] };
				};
				expect(
					broadcasts.mock.calls.filter(
						(call) => call[0]?.type === "notification_event",
					),
				).toEqual([]);
			}).pipe(Effect.provide(layer)),
		);
	});

	it.effect("says so when the session it was told to view is not there", () => {
		const logger = makeMockLogger();
		const { layer } = makeSessionMetadataLayer({ logger });
		return withStore(
			Effect.gen(function* () {
				yield* handleViewSession(
					"client-1",
					{ sessionId: "ghost-session" },
					/* skipMetadata */ true,
				);
				// A view that writes nothing is indistinguishable from one that
				// worked, unless somebody says so.
				const warned = (
					logger.warn as unknown as {
						mock: { calls: readonly (readonly unknown[])[] };
					}
				).mock.calls.map((call) => String(call[0]));
				expect(warned.some((line) => line.includes("ghost-session"))).toBe(
					true,
				);
			}).pipe(Effect.provide(layer)),
		);
	});
});
