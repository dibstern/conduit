import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { PendingInteractionServiceLive } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import type { PollerManagerShape } from "../../../src/lib/domain/relay/Services/services.js";
import {
	ConfigTag,
	LoggerTag,
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
	setDefaultModel,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	handleViewSession,
	loadMoreHistoryForSession,
	setSessionPinnedForClient,
	setSessionSettledForClient,
} from "../../../src/lib/handlers/session.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import { makeHandlerOpenCodeAPI } from "../../helpers/handler-fakes.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockSessionManagerService,
	makeMockStatusPoller,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

function makeSessionMetadataLayer(options: {
	readonly api?: OpenCodeAPI;
	readonly logger?: ReturnType<typeof makeMockLogger>;
	readonly sessionManagerService?: SessionManagerService;
	readonly clientSession?: string;
}) {
	const api =
		options.api ??
		makeHandlerOpenCodeAPI({
			session: {
				get: vi.fn(async () => {
					throw new Error("session metadata must not call session.get");
				}),
			},
			permission: { list: vi.fn(async () => []) },
			question: { list: vi.fn(async () => []) },
		});
	const wsHandler = makeMockWebSocketHandler(
		options.clientSession === undefined
			? {}
			: { getClientSession: vi.fn(() => options.clientSession) },
	);
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
		makePersistenceEffectLayer(":memory:"),
		Layer.succeed(OpenCodeAPITag, api),
		Layer.succeed(WebSocketHandlerTag, wsHandler),
		Layer.succeed(SessionManagerServiceTag, sessionManagerService),
		Layer.succeed(LoggerTag, logger),
		Layer.succeed(ConfigTag, makeMockConfig()),
		PendingInteractionServiceLive,
		Layer.succeed(StatusPollerTag, statusPoller),
		Layer.succeed(PollerManagerTag, pollerManager),
		makeOverridesStateLive(),
	);

	return {
		api,
		logger,
		layer: baseLayer,
	};
}

describe("session handler metadata", () => {
	for (const changed of [true, false]) {
		it.effect(
			`updates metadata through SessionManagerService when changed=${changed}`,
			() => {
				const service = makeMockSessionManagerService({
					setSessionSettled: vi.fn(() => Effect.succeed(changed)),
					setSessionPinned: vi.fn(() => Effect.succeed(changed)),
				});
				const { layer } = makeSessionMetadataLayer({
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
					expect(service.setSessionSettled).toHaveBeenCalledWith("s1", {
						settled: true,
					});
					expect(service.setSessionPinned).toHaveBeenCalledWith("s1", false);
				}).pipe(Effect.provide(layer));
			},
		);
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
			getGoalDetails: () =>
				Effect.succeed({ checks: [], tokensSinceStart: null }),
			getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
			getAllSessionStatusesWithProviders: vi.fn(() => Effect.succeed([])),
			getSessionsForReconciliation: () => Effect.succeed([]),
			listSessions: vi.fn(() => Effect.succeed([])),
			listSessionInfos: vi.fn(() => Effect.succeed([])),
			getSessionLineage: () => Effect.succeed({ rows: [], count: 0 }),
			countPendingApprovalsBySession: vi.fn(() => Effect.succeed([])),
			readPendingApprovals: vi.fn(() =>
				Effect.succeed({ rows: [], version: 0 }),
			),
			getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
			// A complete OpenCode projection carries message text and backfill origin.
			readSessionTranscript: vi.fn(() =>
				Effect.succeed({ messages: [], version: 0 }),
			),
			readPendingInputs: () => Effect.succeed({ rows: [], removed: [] }),
			readInboxState: () => Effect.succeed(undefined),
			readSessionTodos: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
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
			getSessionHistoryMetadata: vi.fn(() =>
				Effect.succeed({ messageCount: 0, cumulativeTokens: 0 }),
			),
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

	it.effect("views a session without querying OpenCode session models", () => {
		const { api, layer } = makeSessionMetadataLayer({});

		return handleViewSession("client-1", { sessionId: "session-1" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(api.session.get).not.toHaveBeenCalled();
			}),
		);
	});

	it.effect(
		"does not replay permission metadata when viewing a session",
		() => {
			const sessionManagerService = makeMockSessionManagerService({});
			const logger = makeMockLogger();
			const api = makeHandlerOpenCodeAPI({
				permission: {
					list: vi.fn(async () => {
						throw new Error("permission metadata unavailable");
					}),
				},
			});
			const { layer } = makeSessionMetadataLayer({
				logger,
				api,
				sessionManagerService,
			});

			return handleViewSession("client-1", { sessionId: "session-1" }).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					// Approvals come from the approvals subscription, not a replay.
					expect(api.permission.list).not.toHaveBeenCalled();
					expect(logger.warn).not.toHaveBeenCalled();
				}),
			);
		},
	);

	it.effect(
		"session selection does not query OpenCode models with a relay default",
		() => {
			const { api, layer } = makeSessionMetadataLayer({});

			return Effect.gen(function* () {
				yield* setDefaultModel({ providerID: "openai", modelID: "gpt-4" });
				yield* handleViewSession("client-1", { sessionId: "session-1" });
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(api.session.get).not.toHaveBeenCalled();
				}),
			);
		},
	);
});

// A switch also fires on restore, reload and reconnect, so it writes no read
// state; the browser reports a user's pick instead (ADR-0004, Scope;
// conduit-test-hk9m.3).
describe("viewing a session", () => {
	it.effect("writes no read state when viewing a session", () => {
		const markSessionRead = vi.fn(() => Effect.void);
		const markSessionSeen = vi.fn(() => Effect.succeed(true));
		const service = makeMockSessionManagerService({
			markSessionRead,
			markSessionSeen,
		});
		const { layer } = makeSessionMetadataLayer({
			clientSession: "session-left",
			sessionManagerService: service,
		});
		return handleViewSession("client-1", { sessionId: "session-1" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(markSessionRead).not.toHaveBeenCalled();
				expect(markSessionSeen).not.toHaveBeenCalled();
			}),
		);
	});
});
