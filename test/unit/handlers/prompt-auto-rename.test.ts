import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import { setModel } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import type { SessionTitleService } from "../../../src/lib/domain/relay/Services/session-title-service.js";
import { handleMessage } from "../../../src/lib/handlers/prompt.js";
import type { ClaudeEventPersistEffect } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import type { ReadQueryEffect } from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { SessionRow } from "../../../src/lib/persistence/read-model-types.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import type { TurnResult } from "../../../src/lib/provider/types.js";
import {
	MOCK_OPENCODE_GPT4_CATALOG,
	makeMockOpenCodeModelService,
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
	ensureClaudeSubagentSession: vi.fn(() => Effect.void),
	readClaudeSubagentTranscript: () =>
		Effect.succeed({ messages: [], parts: [] }),
});

const makeTitleService = (): SessionTitleService => ({
	titleFromMessage: vi.fn(() => Effect.void),
});

const makeSessionRow = (
	provider: "claude" | "opencode",
	title: string,
): SessionRow => ({
	id: "session-1",
	version: 1,
	provider,
	model_provider: provider === "claude" ? "claude" : "openai",
	model_id: provider === "claude" ? "sonnet" : "gpt-4",
	variant: "",
	context_window: "",
	provider_sid: null,
	title,
	status: "idle",
	parent_id: null,
	fork_point_event: null,
	last_message_at: null,
	last_turn_error_at: null,
	permission_mode: null,
	settled_at: null,
	pinned_at: null,
	snoozed_at: null,
	snoozed_until: null,
	woken_at: null,
	woken_reason: null,
	created_at: 0,
	updated_at: 0,
});

const makeReadQuery = (
	provider: "claude" | "opencode",
	title: string,
): ReadQueryEffect => ({
	listPendingClaudeQuestionTools: vi.fn(() => Effect.succeed([])),
	readToolDetails: vi.fn(() => Effect.succeed([])),
	getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
	getSessionFamilyRoot: () => Effect.succeed(undefined),
	getSession: vi.fn(() => Effect.succeed(makeSessionRow(provider, title))),
	getGoalDetails: () => Effect.succeed({ checks: [], tokensSinceStart: null }),
	getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
	getAllSessionStatusesWithProviders: vi.fn(() => Effect.succeed([])),
	getSessionsForReconciliation: () => Effect.succeed([]),
	getStrandedChildren: () => Effect.succeed([]),
	listSessions: vi.fn(() => Effect.succeed([])),
	listSessionInfos: vi.fn(() => Effect.succeed([])),
	listSessionGitRefreshTargets: vi.fn(() => Effect.succeed([])),
	getSessionSkillMessages: vi.fn(() => Effect.succeed([])),
	readSessionList: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
	readSessionTranscriptCatchUp: () =>
		Effect.succeed({ messages: [], version: 0 }),
	readSessionTranscript: vi.fn(() =>
		Effect.succeed({ messages: [], version: 0 }),
	),
	readPendingInputs: () => Effect.succeed({ rows: [], removed: [] }),
	readInboxState: () => Effect.succeed(undefined),
	readStoreIdentity: () => Effect.succeed("store"),
	readSessionTodos: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
	readSessionTranscriptPage: vi.fn(() =>
		Effect.succeed({ messages: [], hasMore: false, version: 0 }),
	),
	getSessionLineage: () => Effect.succeed({ rows: [], count: 0 }),
	countPendingApprovalsBySession: vi.fn(() => Effect.succeed([])),
	readPendingApprovals: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
	getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
	getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
	getSessionHistoryMetadata: vi.fn(() =>
		Effect.succeed({ messageCount: 0, cumulativeTokens: 0 }),
	),
});

const providePromptLayer = (input: {
	readonly engine: OrchestrationEngine;
	readonly titleService: SessionTitleService;
	readonly provider: "claude" | "opencode";
	readonly title: string;
}) => {
	const wsHandler = makeMockWebSocketHandler({
		getClientSession: vi.fn(() => "session-1"),
		getClientsForSession: vi.fn(() => []),
	});
	const sessionManagerService = makeMockSessionManagerService();
	const baseLayer = makeTestHandlerLayer({
		wsHandler,
		openCodeModelService: makeMockOpenCodeModelService(
			MOCK_OPENCODE_GPT4_CATALOG,
		),
		sessionManagerService,
		orchestrationEngine: input.engine,
		sessionTitleService: input.titleService,
		readQueryEffect: makeReadQuery(input.provider, input.title),
	});
	return baseLayer;
};

describe("prompt title generation", () => {
	it.effect(
		"starts title generation for a Claude session with a placeholder title",
		() => {
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
				readQueryEffect: makeReadQuery("claude", "Untitled"),
				claudeEventPersistEffect: persistService,
				sessionTitleService: {
					titleFromMessage: vi.fn((input) =>
						Effect.sync(() => {
							events.push("title");
							expect(input).toEqual({
								sessionId: "session-1",
								message: "current prompt",
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
			}).pipe(Effect.provide(layer, { local: true }));
		},
	);

	it.effect(
		"starts title generation for an OpenCode session with a placeholder title",
		() => {
			const engine = makeEngine("opencode");
			const titleService = makeTitleService();
			const layer = providePromptLayer({
				engine,
				titleService,
				provider: "opencode",
				title: "New session - 2026-10-12T00:00:00.000Z",
			});

			return Effect.gen(function* () {
				yield* handleMessage("client-1", {
					text: "opencode prompt",
					commandId: "cmd-auto-rename-opencode",
				});

				expect(titleService.titleFromMessage).toHaveBeenCalledWith({
					sessionId: "session-1",
					message: "opencode prompt",
				});
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "opencode",
					}),
				);
			}).pipe(Effect.provide(layer, { local: true }));
		},
	);

	it.effect(
		"does not start title generation for a session with a real title",
		() => {
			const engine = makeEngine("opencode");
			const titleService = makeTitleService();
			const layer = providePromptLayer({
				engine,
				titleService,
				provider: "opencode",
				title: "Fix Header Selector",
			});

			return Effect.gen(function* () {
				yield* handleMessage("client-1", {
					text: "follow up",
					commandId: "cmd-auto-rename-follow-up",
				});

				expect(titleService.titleFromMessage).not.toHaveBeenCalled();
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "opencode",
					}),
				);
			}).pipe(Effect.provide(layer, { local: true }));
		},
	);
});
