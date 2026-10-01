import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import { SessionManagerError } from "../../../src/lib/domain/relay/Services/session-manager-error.js";
import { setModel } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import type { SessionTitleService } from "../../../src/lib/domain/relay/Services/session-title-service.js";
import { handleMessage } from "../../../src/lib/handlers/prompt.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectError,
} from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectError,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { MessageWithParts } from "../../../src/lib/persistence/read-model-types.js";
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
	} as unknown as OrchestrationEngine);

const makePersistService = (
	persistUserMessage: ClaudeEventPersistEffect["persistUserMessage"],
): ClaudeEventPersistEffect => ({
	persistEvent: vi.fn(() => Effect.void),
	persistEvents: vi.fn(() => Effect.void),
	persistUserMessage,
	persistClaudeSubagent: vi.fn(() => Effect.void),
	ensureClaudeSubagentSession: vi.fn(() => Effect.void),
});

const makeTitleService = (): SessionTitleService => ({
	startForFirstClaudeMessage: vi.fn(() => Effect.void),
});

const userHistoryMessage = (text: string): MessageWithParts => ({
	id: `history-${text}`,
	session_id: "session-1",
	turn_id: "turn-1",
	role: "user",
	text,
	cost: null,
	tokens_in: null,
	tokens_out: null,
	tokens_cache_read: null,
	tokens_cache_write: null,
	context_window: null,
	version: 0,
	is_streaming: 0,
	is_backfilled: 0,
	created_at: 1,
	updated_at: 1,
	parts: [
		{
			id: `part-${text}`,
			message_id: `history-${text}`,
			type: "text",
			text,
			tool_name: null,
			call_id: null,
			input: null,
			result: null,
			metadata: null,
			duration: null,
			status: null,
			sort_order: 0,
			created_at: 1,
			updated_at: 1,
		},
	],
});

const makeReadQuery = (
	getSessionMessagesWithParts: ReadQueryEffect["getSessionMessagesWithParts"],
): ReadQueryEffect => ({
	getToolContent: vi.fn(() => Effect.succeed(undefined)),
	getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
	getSession: vi.fn(() => Effect.succeed(undefined)),
	getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
	getSessionsForReconciliation: () => Effect.succeed([]),
	listSessions: vi.fn(() => Effect.succeed([])),
	listSessionInfos: vi.fn(() => Effect.succeed([])),
	readSessionList: vi.fn(() => Effect.succeed({ rows: [], version: 0 })),
	readSessionTranscript: vi.fn(() =>
		Effect.succeed({ messages: [], version: 0 }),
	),
	readSessionTranscriptPage: vi.fn(() =>
		Effect.succeed({ messages: [], hasMore: false, version: 0 }),
	),
	getSessionLineage: () => Effect.succeed({ rows: [], count: 0 }),
	getSessionFamily: () => Effect.succeed([]),
	countPendingApprovalsBySession: vi.fn(() => Effect.succeed([])),
	getLatestTurnModelExecution: vi.fn(() => Effect.succeed(undefined)),
	getSessionMessagesWithParts,
});

const providePromptLayer = (input: {
	readonly engine: OrchestrationEngine;
	readonly titleService: SessionTitleService;
	readonly persistService?: ClaudeEventPersistEffect;
	readonly priorMessages?: MessageWithParts[];
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
			Effect.succeed(input.priorMessages ?? []),
		),
		...(input.persistService
			? { claudeEventPersistEffect: input.persistService }
			: {}),
	});
	return baseLayer;
};

describe("Claude prompt title generation", () => {
	it.effect(
		"starts title generation after the first Claude user message is persisted",
		() => {
			const engine = makeEngine("claude");
			const events: string[] = [];
			const persistService = makePersistService(
				vi.fn(() =>
					Effect.sync(() => {
						events.push("persist");
					}),
				),
			);
			const wsHandler = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => "session-1"),
				getClientsForSession: vi.fn(() => []),
			});
			const layer = makeTestHandlerLayer({
				wsHandler,
				orchestrationEngine: engine,
				readQueryEffect: makeReadQuery(() => Effect.succeed([])),
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

				expect(persistService.persistUserMessage).toHaveBeenCalledWith(
					"session-1",
					"current prompt",
				);
				expect(events).toEqual(["persist", "title"]);
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "claude",
					}),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("does not start title generation for later Claude messages", () => {
		const engine = makeEngine("claude");
		const titleService = makeTitleService();
		const persistService = makePersistService(vi.fn(() => Effect.void));
		const layer = providePromptLayer({
			engine,
			titleService,
			persistService,
			priorMessages: [userHistoryMessage("Earlier prompt")],
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

			expect(persistService.persistUserMessage).toHaveBeenCalledWith(
				"session-1",
				"follow up",
			);
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
		"does not start title generation when Claude user-message persistence fails",
		() => {
			const engine = makeEngine("claude");
			const titleService = makeTitleService();
			const persistService = makePersistService(
				vi.fn(() =>
					Effect.fail(
						new ClaudeEventPersistEffectError({
							operation: "persistUserMessage",
							cause: new Error("sqlite unavailable"),
						}),
					),
				),
			);
			const layer = providePromptLayer({
				engine,
				titleService,
				persistService,
			});

			return Effect.gen(function* () {
				yield* setModel("session-1", {
					providerID: "claude",
					modelID: "sonnet",
				});
				yield* handleMessage("client-1", {
					text: "first prompt",
					commandId: "cmd-auto-rename-first",
				});

				expect(persistService.persistUserMessage).toHaveBeenCalledWith(
					"session-1",
					"first prompt",
				);
				expect(titleService.startForFirstClaudeMessage).not.toHaveBeenCalled();
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "claude",
					}),
				);
			}).pipe(Effect.provide(layer));
		},
	);

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
							operation: "getSessionMessagesWithParts",
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

				expect(readQuery.getSessionMessagesWithParts).toHaveBeenCalledWith(
					"session-1",
				);
				expect(persistService.persistUserMessage).toHaveBeenCalledWith(
					"session-1",
					"maybe first prompt",
				);
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
