import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { SessionManagerError } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import type { SessionTitleService } from "../../../src/lib/domain/relay/Services/session-title-service.js";
import { handleMessage } from "../../../src/lib/handlers/prompt.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectError,
	ClaudeEventPersistEffectTag,
} from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import type { TurnResult } from "../../../src/lib/provider/types.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
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
		getProviderForSession: vi.fn(() => providerId),
		dispatch: vi.fn(async () => completedTurn()),
	} as unknown as OrchestrationEngine);

const makePersistService = (
	persistUserMessage: ClaudeEventPersistEffect["persistUserMessage"],
): ClaudeEventPersistEffect => ({
	persistEvent: vi.fn(() => Effect.void),
	persistUserMessage,
});

const makeTitleService = (): SessionTitleService => ({
	startForFirstClaudeMessage: vi.fn(() => Effect.void),
});

const userHistoryMessage = (text: string): HistoryMessage => ({
	id: `history-${text}`,
	role: "user",
	text,
	parts: [{ id: `part-${text}`, type: "text", text }],
});

const providePromptLayer = (input: {
	readonly engine: OrchestrationEngine;
	readonly titleService: SessionTitleService;
	readonly persistService?: ClaudeEventPersistEffect;
	readonly priorMessages?: HistoryMessage[];
}) => {
	const wsHandler = makeMockWebSocketHandler({
		getClientSession: vi.fn(() => "session-1"),
		getClientsForSession: vi.fn(() => []),
	});
	const sessionManagerService = makeMockSessionManagerService({
		loadPreRenderedHistory: vi.fn(() =>
			Effect.succeed({
				messages: input.priorMessages ?? [],
				hasMore: false,
			}),
		),
	});
	const baseLayer = makeTestHandlerLayer({
		wsHandler,
		sessionManagerService,
		orchestrationEngine: input.engine,
		sessionTitleService: input.titleService,
	});

	return input.persistService
		? Layer.merge(
				baseLayer,
				Layer.succeed(ClaudeEventPersistEffectTag, input.persistService),
			)
		: baseLayer;
};

describe("Claude prompt title generation", () => {
	it.effect(
		"starts title generation after the first Claude user message is persisted",
		() => {
			const engine = makeEngine("claude");
			const events: string[] = [];
			let persisted = false;
			const persistService = makePersistService(
				vi.fn(() =>
					Effect.sync(() => {
						events.push("persist");
						persisted = true;
					}),
				),
			);
			const sessionManagerService = makeMockSessionManagerService({
				loadPreRenderedHistory: vi.fn(() =>
					Effect.sync(() => ({
						messages: persisted ? [userHistoryMessage("current prompt")] : [],
						hasMore: false,
					})),
				),
			});
			const wsHandler = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => "session-1"),
				getClientsForSession: vi.fn(() => []),
			});
			const layer = Layer.merge(
				makeTestHandlerLayer({
					wsHandler,
					sessionManagerService,
					orchestrationEngine: engine,
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
				}),
				Layer.succeed(ClaudeEventPersistEffectTag, persistService),
			);

			return Effect.gen(function* () {
				yield* handleMessage("client-1", { text: "current prompt" });

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
			yield* handleMessage("client-1", { text: "follow up" });

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
			yield* handleMessage("client-1", { text: "opencode prompt" });

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
				yield* handleMessage("client-1", { text: "first prompt" });

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
			const sessionManagerService = makeMockSessionManagerService({
				loadPreRenderedHistory: vi.fn(() =>
					Effect.fail(
						new SessionManagerError({
							operation: "loadPreRenderedHistory",
							cause: new Error("history unavailable"),
						}),
					),
				),
			});
			const wsHandler = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => "session-1"),
				getClientsForSession: vi.fn(() => []),
			});
			const layer = Layer.merge(
				makeTestHandlerLayer({
					wsHandler,
					sessionManagerService,
					orchestrationEngine: engine,
					sessionTitleService: titleService,
				}),
				Layer.succeed(ClaudeEventPersistEffectTag, persistService),
			);

			return Effect.gen(function* () {
				yield* handleMessage("client-1", { text: "maybe first prompt" });

				expect(
					sessionManagerService.loadPreRenderedHistory,
				).toHaveBeenCalledWith("session-1");
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
