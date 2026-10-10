import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import { setModel } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import type { SessionTitleService } from "../../../src/lib/domain/relay/Services/session-title-service.js";
import { handleMessage } from "../../../src/lib/handlers/prompt.js";
import type { ClaudeEventPersistEffect } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectError,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import type { TurnResult } from "../../../src/lib/provider/types.js";
import {
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

const completedTurn = (): TurnResult => ({
	status: "completed",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
});

const makeEngine = (providerId: "claude" | "opencode") =>
	withDispatchEffect({
		getProviderForSessionEffect: vi.fn(() => Effect.succeed(providerId)),
		dispatch: vi.fn(async () => completedTurn()),
	});

const makePersistService = (
	persistUserMessage: ClaudeEventPersistEffect["persistUserMessage"],
): ClaudeEventPersistEffect => ({
	persistHandoffDelivered: vi.fn(() => Effect.void),
	persistEvent: vi.fn(() => Effect.void),
	persistEvents: vi.fn(() => Effect.void),
	persistUserMessage,
	persistClaudeSubagent: vi.fn(() => Effect.void),
	ensureClaudeSubagentSession: vi.fn(() => Effect.void),
});

const makeTitleService = (): SessionTitleService => ({
	startForFirstClaudeMessage: vi.fn(() => Effect.void),
});

const makeReadQuery = (
	getSessionHistoryMetadata: ReadQueryEffect["getSessionHistoryMetadata"],
): ReadQueryEffect => ({
	getToolContent: vi.fn(() => Effect.succeed(undefined)),
	getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
	getSession: vi.fn(() => Effect.succeed(undefined)),
	getGoalDetails: () => Effect.succeed({ checks: [], tokensSinceStart: null }),
	getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
	getAllSessionStatusesWithProviders: vi.fn(() => Effect.succeed([])),
	getSessionsForReconciliation: () => Effect.succeed([]),
	listSessions: vi.fn(() => Effect.succeed([])),
	listSessionInfos: vi.fn(() => Effect.succeed([])),
	readSessionList: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
	readSessionTranscript: vi.fn(() =>
		Effect.succeed({ messages: [], version: 0 }),
	),
	readPendingInputs: () => Effect.succeed({ rows: [], removed: [] }),
	readInboxState: () => Effect.succeed(undefined),
	readSessionTodos: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
	readSessionTranscriptPage: vi.fn(() =>
		Effect.succeed({ messages: [], hasMore: false, version: 0 }),
	),
	getSessionLineage: () => Effect.succeed({ rows: [], count: 0 }),
	countPendingApprovalsBySession: vi.fn(() => Effect.succeed([])),
	readPendingApprovals: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
	getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
	getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
	getSessionHistoryMetadata,
});

const providePromptLayer = (input: {
	readonly engine: OrchestrationEngine;
	readonly titleService: SessionTitleService;
	readonly persistService?: ClaudeEventPersistEffect;
	readonly priorMessageCount?: number;
}) => {
	const wsHandler = makeMockWebSocketHandler({
		getClientSession: vi.fn(() => "session-1"),
		getClientsForSession: vi.fn(() => []),
	});
	const sessionManagerService = makeMockSessionManagerService();
	const baseLayer = makeTestHandlerLayer({
		wsHandler,
		sessionManagerService,
		orchestrationEngine: input.engine,
		sessionTitleService: input.titleService,
		readQueryEffect: makeReadQuery(() =>
			Effect.succeed({
				messageCount: input.priorMessageCount ?? 0,
				cumulativeTokens: 0,
			}),
		),
		...(input.persistService
			? { claudeEventPersistEffect: input.persistService }
			: {}),
	});
	return baseLayer;
};

describe("Claude prompt title generation", () => {
	it.effect("starts title generation for the first Claude user message", () => {
		const engine = makeEngine("claude");
		const events: string[] = [];
		const persistService = makePersistService(vi.fn(() => Effect.void));
		const wsHandler = makeMockWebSocketHandler({
			getClientSession: vi.fn(() => "session-1"),
			getClientsForSession: vi.fn(() => []),
		});
		const layer = makeTestHandlerLayer({
			wsHandler,
			orchestrationEngine: engine,
			readQueryEffect: makeReadQuery(() =>
				Effect.succeed({ messageCount: 0, cumulativeTokens: 0 }),
			),
			claudeEventPersistEffect: persistService,
			sessionTitleService: {
				startForFirstClaudeMessage: vi.fn((input) =>
					Effect.sync(() => {
						events.push("title");
						expect(input).toEqual({
							sessionId: "session-1",
							firstMessage: "current prompt",
						});
					}),
				),
			},
		});

		return Effect.gen(function* () {
			yield* setModel("session-1", {
				providerID: "claude",
				modelID: "sonnet",
			});
			yield* handleMessage("client-1", {
				text: "current prompt",
				commandId: "cmd-auto-rename-current",
			});

			expect(persistService.persistUserMessage).not.toHaveBeenCalled();
			expect(events).toEqual(["title"]);
			expect(engine.dispatchEffect).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "send_turn",
					providerId: "claude",
				}),
			);
		}).pipe(Effect.provide(layer));
	});

	it.effect("does not start title generation for later Claude messages", () => {
		const engine = makeEngine("claude");
		const titleService = makeTitleService();
		const persistService = makePersistService(vi.fn(() => Effect.void));
		const layer = providePromptLayer({
			engine,
			titleService,
			persistService,
			priorMessageCount: 1,
		});

		return Effect.gen(function* () {
			yield* setModel("session-1", {
				providerID: "claude",
				modelID: "sonnet",
			});
			yield* handleMessage("client-1", {
				text: "follow up",
				commandId: "cmd-auto-rename-follow-up",
			});

			expect(persistService.persistUserMessage).not.toHaveBeenCalled();
			expect(titleService.startForFirstClaudeMessage).not.toHaveBeenCalled();
			expect(engine.dispatchEffect).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "send_turn",
					providerId: "claude",
				}),
			);
		}).pipe(Effect.provide(layer));
	});

	it.effect("does not start title generation for OpenCode messages", () => {
		const engine = makeEngine("opencode");
		const titleService = makeTitleService();
		const persistService = makePersistService(vi.fn(() => Effect.void));
		const layer = providePromptLayer({
			engine,
			titleService,
			persistService,
		});

		return Effect.gen(function* () {
			yield* handleMessage("client-1", {
				text: "opencode prompt",
				commandId: "cmd-auto-rename-opencode",
			});

			expect(persistService.persistUserMessage).not.toHaveBeenCalled();
			expect(titleService.startForFirstClaudeMessage).not.toHaveBeenCalled();
			expect(engine.dispatchEffect).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "send_turn",
					providerId: "opencode",
				}),
			);
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"does not start title generation when prior Claude history fails to load",
		() => {
			const engine = makeEngine("claude");
			const titleService = makeTitleService();
			const persistService = makePersistService(vi.fn(() => Effect.void));
			const readQuery = makeReadQuery(
				vi.fn(() =>
					Effect.fail(
						new ReadQueryEffectError({
							operation: "getSessionHistoryMetadata",
							cause: new Error("history unavailable"),
						}),
					),
				),
			);
			const wsHandler = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => "session-1"),
				getClientsForSession: vi.fn(() => []),
			});
			const layer = makeTestHandlerLayer({
				wsHandler,
				orchestrationEngine: engine,
				sessionTitleService: titleService,
				readQueryEffect: readQuery,
				claudeEventPersistEffect: persistService,
			});

			return Effect.gen(function* () {
				yield* setModel("session-1", {
					providerID: "claude",
					modelID: "sonnet",
				});
				yield* handleMessage("client-1", {
					text: "maybe first prompt",
					commandId: "cmd-auto-rename-maybe-first",
				});

				expect(readQuery.getSessionHistoryMetadata).toHaveBeenCalledWith(
					"session-1",
				);
				expect(persistService.persistUserMessage).not.toHaveBeenCalled();
				expect(titleService.startForFirstClaudeMessage).not.toHaveBeenCalled();
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "claude",
						input: expect.objectContaining({
							history: [],
						}),
					}),
				);
			}).pipe(Effect.provide(layer));
		},
	);
});
