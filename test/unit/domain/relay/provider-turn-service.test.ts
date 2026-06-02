import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { PendingInteractionServiceLive } from "../../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	ProviderTurnServiceLive,
	type ProviderTurnServiceSendInput,
	ProviderTurnServiceTag,
} from "../../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	hasActiveProcessingTimeout,
	makeOverridesStateLive,
	startProcessingTimeout,
} from "../../../../src/lib/domain/relay/Services/session-overrides-state.js";
import type { SessionTitleService } from "../../../../src/lib/domain/relay/Services/session-title-service.js";
import { SessionTitleServiceTag } from "../../../../src/lib/domain/relay/Services/session-title-service.js";
import type { OpenCodeAPI } from "../../../../src/lib/instance/opencode-api.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectError,
	ClaudeEventPersistEffectTag,
} from "../../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import {
	type ProviderStateEffect,
	ProviderStateEffectError,
	ProviderStateEffectTag,
} from "../../../../src/lib/persistence/effect/provider-state-effect.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../../src/lib/persistence/effect/read-query-effect.js";
import {
	OrchestrationEngine,
	type SendTurnCommand,
} from "../../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../../src/lib/provider/provider-registry.js";
import type {
	EventSink,
	ProviderInstance,
	TurnResult,
} from "../../../../src/lib/provider/types.js";
import type { HistoryMessage } from "../../../../src/lib/shared-types.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
} from "../../../helpers/mock-factories.js";
import { providerRuntimeEvent } from "../../../helpers/provider-runtime-event.js";

const completedTurn = (overrides?: Partial<TurnResult>): TurnResult => ({
	status: "completed",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
	...overrides,
});

const flushDispatch = () =>
	Effect.promise<void>(() => new Promise((resolve) => setImmediate(resolve)));

const defaultInput = (
	overrides?: Partial<ProviderTurnServiceSendInput>,
): ProviderTurnServiceSendInput => ({
	clientId: "client-1",
	commandId: "cmd-send-default",
	sessionId: "session-1",
	text: "current prompt",
	model:
		overrides?.model === undefined
			? {
					providerID: "claude",
					modelID: "claude-sonnet-4-5",
				}
			: overrides.model,
	modelUserSelected: overrides?.modelUserSelected ?? true,
	errorDelivery: "client",
	...overrides,
});

const historyRow = (text: string) => ({
	id: `message-${text}`,
	session_id: "session-1",
	turn_id: "turn-1",
	role: "user",
	text,
	cost: null,
	tokens_in: null,
	tokens_out: null,
	tokens_cache_read: null,
	tokens_cache_write: null,
	is_streaming: 0,
	created_at: 1,
	updated_at: 1,
	parts: [
		{
			id: `part-${text}`,
			message_id: `message-${text}`,
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

const historyMessage = (text: string): HistoryMessage => ({
	id: `history-${text}`,
	role: "user",
	text,
	parts: [{ id: `part-${text}`, type: "text", text }],
});

const makeReadQuery = (
	getSessionMessagesWithParts: ReadQueryEffect["getSessionMessagesWithParts"],
): ReadQueryEffect => ({
	getToolContent: vi.fn(() => Effect.succeed(undefined)),
	getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
	getSession: vi.fn(() => Effect.succeed(undefined)),
	getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
	listSessions: vi.fn(() => Effect.succeed([])),
	getSessionMessagesWithParts,
});

const makePersistService = (
	persistUserMessage: ClaudeEventPersistEffect["persistUserMessage"],
): ClaudeEventPersistEffect => ({
	persistEvent: vi.fn(() => Effect.void),
	persistEvents: vi.fn(() => Effect.void),
	persistUserMessage,
	persistClaudeSubagent: vi.fn(() => Effect.void),
	ensureClaudeSubagentSession: vi.fn(() => Effect.void),
});

const makeProviderState = (
	overrides?: Partial<ProviderStateEffect>,
): ProviderStateEffect => ({
	getState: vi.fn(() => Effect.succeed({})),
	saveUpdates: vi.fn(() => Effect.void),
	clearState: vi.fn(() => Effect.void),
	...overrides,
});

const makeTitleService = (): SessionTitleService => ({
	startForFirstClaudeMessage: vi.fn(() => Effect.void),
});

const makeEngine = (input?: {
	readonly providerId?: "claude" | "opencode" | undefined;
	readonly result?: TurnResult;
	readonly dispatchEffect?: OrchestrationEngine["dispatchEffect"];
}) => {
	const dispatchEffect =
		input?.dispatchEffect ??
		vi.fn(() => Effect.succeed(input?.result ?? completedTurn()));
	let providerId: string | undefined = input?.providerId;
	return {
		getProviderForSession: vi.fn(() => providerId),
		bindSession: vi.fn((_sessionId: string, nextProviderId: string) => {
			providerId = nextProviderId;
		}),
		unbindSession: vi.fn(() => {
			providerId = undefined;
		}),
		dispatchEffect,
	} as unknown as OrchestrationEngine;
};

const serviceLayer = (input: {
	readonly engine?: OrchestrationEngine;
	readonly readQuery?: ReadQueryEffect;
	readonly persist?: ClaudeEventPersistEffect;
	readonly providerState?: ProviderStateEffect;
	readonly titleService?: SessionTitleService;
	readonly sessionHistory?: readonly HistoryMessage[];
	readonly api?: OpenCodeAPI;
}) => {
	const wsHandler = makeMockWebSocketHandler({
		getClientsForSession: vi.fn(() => ["client-1"]),
	});
	const log = makeMockLogger();
	const sessionManagerService = makeMockSessionManagerService({
		loadPreRenderedHistory: vi.fn(() =>
			Effect.succeed({
				messages: [...(input.sessionHistory ?? [])],
				hasMore: false,
			}),
		),
	});
	let baseLayer = Layer.mergeAll(
		Layer.succeed(OpenCodeAPITag, input.api ?? makeMockOpenCodeAPI()),
		Layer.succeed(WebSocketHandlerTag, wsHandler),
		Layer.succeed(LoggerTag, log),
		Layer.succeed(ConfigTag, makeMockConfig({ projectDir: "/test/project" })),
		Layer.succeed(SessionManagerServiceTag, sessionManagerService),
		PendingInteractionServiceLive,
		makeOverridesStateLive(),
		Layer.succeed(
			SessionTitleServiceTag,
			input.titleService ?? makeTitleService(),
		),
	);
	if (input.engine) {
		baseLayer = Layer.merge(
			baseLayer,
			Layer.succeed(OrchestrationEngineTag, input.engine),
		);
	}
	if (input.readQuery) {
		baseLayer = Layer.merge(
			baseLayer,
			Layer.succeed(ReadQueryEffectTag, input.readQuery),
		);
	}
	if (input.persist) {
		baseLayer = Layer.merge(
			baseLayer,
			Layer.succeed(ClaudeEventPersistEffectTag, input.persist),
		);
	}
	if (input.providerState) {
		baseLayer = Layer.merge(
			baseLayer,
			Layer.succeed(ProviderStateEffectTag, input.providerState),
		);
	}
	return {
		layer: Layer.provideMerge(ProviderTurnServiceLive, baseLayer),
		wsHandler,
		log,
		sessionManagerService,
	};
};

const sendTurn = (input?: Partial<ProviderTurnServiceSendInput>) =>
	Effect.gen(function* () {
		const service = yield* ProviderTurnServiceTag;
		yield* service.sendTurn(defaultInput(input));
		yield* flushDispatch();
	});

const interruptTurn = () =>
	Effect.gen(function* () {
		const service = yield* ProviderTurnServiceTag;
		yield* service.interruptTurn({
			clientId: "client-1",
			commandId: "cmd-interrupt-default",
			sessionId: "session-1",
		});
	});

describe("ProviderTurnService", () => {
	it.effect(
		"dispatches the first Claude turn after loading empty persisted history and persisting the user message",
		() => {
			const engine = makeEngine();
			const events: string[] = [];
			const readQuery = makeReadQuery(vi.fn(() => Effect.succeed([])));
			const persist = makePersistService(
				vi.fn(() => Effect.sync(() => events.push("persist"))),
			);
			const titleService: SessionTitleService = {
				startForFirstClaudeMessage: vi.fn(() =>
					Effect.sync(() => events.push("title")),
				),
			};
			const providerState = makeProviderState({
				getState: vi.fn(() => Effect.succeed({ resumeSessionId: "prev" })),
			});
			const { layer, wsHandler } = serviceLayer({
				engine,
				readQuery,
				persist,
				providerState,
				titleService,
			});

			return Effect.gen(function* () {
				yield* sendTurn({
					commandId: "cmd-send-1",
				} as Partial<ProviderTurnServiceSendInput>);
				const command = vi.mocked(engine.dispatchEffect).mock
					.calls[0]?.[0] as SendTurnCommand;

				expect(readQuery.getSessionMessagesWithParts).toHaveBeenCalledWith(
					"session-1",
				);
				expect(persist.persistUserMessage).toHaveBeenCalledWith(
					"session-1",
					"current prompt",
				);
				expect(events).toEqual(["persist", "title"]);
				expect(providerState.getState).toHaveBeenCalledWith("session-1");
				expect(command).toMatchObject({
					type: "send_turn",
					commandId: "cmd-send-1",
					providerId: "claude",
					input: {
						sessionId: "session-1",
						prompt: "current prompt",
						history: [],
						providerState: { resumeSessionId: "prev" },
						workspaceRoot: "/test/project",
						model: {
							providerId: "claude",
							modelId: "claude-sonnet-4-5",
						},
					},
				});

				yield* command.input.eventSink.push(
					providerRuntimeEvent(
						"text.delta",
						"session-1",
						{
							messageId: "assistant-1",
							partId: "assistant-1-0",
							text: "hello",
						},
						{ providerId: "claude" },
					),
				);
				expect(wsHandler.sendToSession).toHaveBeenCalledWith(
					"session-1",
					expect.objectContaining({ type: "delta", text: "hello" }),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"dispatches a later Claude turn without starting title generation",
		() => {
			const engine = makeEngine({ providerId: "claude" });
			const persist = makePersistService(vi.fn(() => Effect.void));
			const titleService = makeTitleService();
			const { layer } = serviceLayer({
				engine,
				persist,
				titleService,
				sessionHistory: [historyMessage("Earlier prompt")],
			});

			return Effect.gen(function* () {
				yield* sendTurn();

				expect(persist.persistUserMessage).toHaveBeenCalledWith(
					"session-1",
					"current prompt",
				);
				expect(titleService.startForFirstClaudeMessage).not.toHaveBeenCalled();
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "claude",
						input: expect.objectContaining({
							history: [expect.objectContaining({ text: "Earlier prompt" })],
						}),
					}),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"dispatches with empty history and no title when Claude history load fails",
		() => {
			const engine = makeEngine({ providerId: "claude" });
			const readQuery = makeReadQuery(
				vi.fn(() =>
					Effect.fail(
						new ReadQueryEffectError({
							operation: "getSessionMessagesWithParts",
							cause: new Error("db unavailable"),
						}),
					),
				),
			);
			const persist = makePersistService(vi.fn(() => Effect.void));
			const titleService = makeTitleService();
			const { layer, log } = serviceLayer({
				engine,
				readQuery,
				persist,
				titleService,
			});

			return Effect.gen(function* () {
				yield* sendTurn();

				expect(log.warn).toHaveBeenCalledWith(
					expect.stringContaining("Failed to load prior Claude history"),
				);
				expect(titleService.startForFirstClaudeMessage).not.toHaveBeenCalled();
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						input: expect.objectContaining({ history: [] }),
					}),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"continues dispatch and logs a warning when Claude user-message persistence fails",
		() => {
			const engine = makeEngine({ providerId: "claude" });
			const persist = makePersistService(
				vi.fn(() =>
					Effect.fail(
						new ClaudeEventPersistEffectError({
							operation: "persistUserMessage",
							cause: new Error("sqlite unavailable"),
						}),
					),
				),
			);
			const titleService = makeTitleService();
			const { layer, log } = serviceLayer({ engine, persist, titleService });

			return Effect.gen(function* () {
				yield* sendTurn();

				expect(persist.persistUserMessage).toHaveBeenCalledWith(
					"session-1",
					"current prompt",
				);
				expect(titleService.startForFirstClaudeMessage).not.toHaveBeenCalled();
				expect(log.warn).toHaveBeenCalledWith(
					expect.stringContaining(
						"Non-fatal persistence error for Claude user message",
					),
				);
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({ type: "send_turn", providerId: "claude" }),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"logs provider-state save failures without failing the turn or sending a browser error",
		() => {
			const engine = makeEngine({
				providerId: "claude",
				result: completedTurn({
					providerStateUpdates: [{ key: "resumeSessionId", value: "next" }],
				}),
			});
			const providerState = makeProviderState({
				saveUpdates: vi.fn(() =>
					Effect.fail(
						new ProviderStateEffectError({
							operation: "saveUpdates",
							cause: new Error("database locked"),
						}),
					),
				),
			});
			const { layer, log, wsHandler } = serviceLayer({ engine, providerState });

			return Effect.gen(function* () {
				yield* sendTurn();

				expect(providerState.saveUpdates).toHaveBeenCalledWith("session-1", [
					{ key: "resumeSessionId", value: "next" },
				]);
				expect(log.warn).toHaveBeenCalledWith(
					expect.stringContaining("Non-fatal provider state persistence error"),
				);
				expect(wsHandler.sendTo).not.toHaveBeenCalledWith(
					"client-1",
					expect.objectContaining({ type: "error" }),
				);
				expect(wsHandler.sendToSession).not.toHaveBeenCalledWith(
					"session-1",
					expect.objectContaining({ type: "done", code: 1 }),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"dispatches OpenCode turns with a no-op sink and without Claude policy",
		() => {
			let eventSink: EventSink | undefined;
			const engine = makeEngine({
				providerId: "opencode",
				dispatchEffect: vi.fn((command) =>
					Effect.sync(() => {
						eventSink = (command as SendTurnCommand).input.eventSink;
						return completedTurn();
					}),
				) as unknown as OrchestrationEngine["dispatchEffect"],
			});
			const readQuery = makeReadQuery(
				vi.fn(() => Effect.succeed([historyRow("bad")])),
			);
			const persist = makePersistService(vi.fn(() => Effect.void));
			const titleService = makeTitleService();
			const { layer, wsHandler } = serviceLayer({
				engine,
				readQuery,
				persist,
				titleService,
			});

			return Effect.gen(function* () {
				yield* sendTurn({
					model: { providerID: "openai", modelID: "gpt-4.1" },
				});

				expect(readQuery.getSessionMessagesWithParts).not.toHaveBeenCalled();
				expect(persist.persistUserMessage).not.toHaveBeenCalled();
				expect(titleService.startForFirstClaudeMessage).not.toHaveBeenCalled();
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "opencode",
						input: expect.objectContaining({ history: [] }),
					}),
				);

				if (eventSink) {
					yield* eventSink.push(
						providerRuntimeEvent(
							"text.delta",
							"session-1",
							{
								messageId: "assistant-1",
								partId: "assistant-1-0",
								text: "should not emit",
							},
							{ providerId: "opencode" },
						),
					);
				}
				expect(wsHandler.sendToSession).not.toHaveBeenCalledWith(
					"session-1",
					expect.objectContaining({ type: "delta" }),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"falls back to OpenCode abort, clears processing timeout, and broadcasts done when no engine is present",
		() => {
			const api = {
				session: { abort: vi.fn(async () => undefined) },
			} as unknown as OpenCodeAPI;
			const { layer, wsHandler } = serviceLayer({ api });

			return Effect.gen(function* () {
				yield* startProcessingTimeout(
					"session-1",
					"2 minutes",
					() => Effect.void,
				);
				yield* interruptTurn();

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(false);
				expect(api.session.abort).toHaveBeenCalledWith("session-1");
				expect(wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
					type: "done",
					sessionId: "session-1",
					code: 1,
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"interrupts a first Claude turn while engine dispatch is still in flight",
		() =>
			Effect.gen(function* () {
				const sendStarted = yield* Deferred.make<void>();
				const releaseSend = yield* Deferred.make<void>();
				const interruptTurnEffect = vi.fn(() => Effect.void);
				const instance: ProviderInstance = {
					providerId: "claude",
					discoverEffect: vi.fn(() =>
						Effect.succeed({
							models: [],
							supportsTools: false,
							supportsThinking: false,
							supportsPermissions: false,
							supportsQuestions: false,
							supportsAttachments: false,
							supportsFork: false,
							supportsRevert: false,
							commands: [],
						}),
					),
					sendTurnEffect: vi.fn(() =>
						Effect.gen(function* () {
							yield* Deferred.succeed(sendStarted, undefined);
							yield* Deferred.await(releaseSend);
							return completedTurn();
						}),
					),
					interruptTurnEffect,
					resolvePermissionEffect: vi.fn(() => Effect.void),
					resolveQuestionEffect: vi.fn(() => Effect.void),
					shutdownEffect: vi.fn(() => Effect.void),
					endSessionEffect: vi.fn(() => Effect.void),
				};
				const registry = new ProviderRegistry();
				registry.registerInstance(instance);
				const engine = new OrchestrationEngine({ registry });
				const api = {
					session: { abort: vi.fn(async () => undefined) },
				} as unknown as OpenCodeAPI;
				const { layer } = serviceLayer({ engine, api });

				yield* Effect.gen(function* () {
					yield* sendTurn();
					yield* Deferred.await(sendStarted);
					yield* interruptTurn();

					expect(interruptTurnEffect).toHaveBeenCalledWith("session-1");
					expect(api.session.abort).not.toHaveBeenCalled();

					yield* Deferred.succeed(releaseSend, undefined);
					yield* flushDispatch();
				}).pipe(Effect.provide(layer));
			}),
	);

	it.effect(
		"interrupts a first Claude turn immediately after send returns before dispatch starts",
		() =>
			Effect.gen(function* () {
				let boundProviderId: string | undefined;
				const dispatchEffect = vi.fn((command) => {
					if (command.type === "interrupt_turn") return Effect.void;
					return Effect.succeed(completedTurn());
				}) as unknown as OrchestrationEngine["dispatchEffect"];
				const engine = {
					getProviderForSession: vi.fn(() => boundProviderId),
					bindSession: vi.fn((_sessionId: string, providerId: string) => {
						boundProviderId = providerId;
					}),
					unbindSession: vi.fn(() => {
						boundProviderId = undefined;
					}),
					dispatchEffect,
				} as unknown as OrchestrationEngine;
				const api = {
					session: { abort: vi.fn(async () => undefined) },
				} as unknown as OpenCodeAPI;
				const { layer } = serviceLayer({ engine, api });

				yield* Effect.gen(function* () {
					const service = yield* ProviderTurnServiceTag;
					yield* service.sendTurn(defaultInput());
					yield* service.interruptTurn({
						clientId: "client-1",
						commandId: "cmd-interrupt-1",
						sessionId: "session-1",
					});

					expect(dispatchEffect).toHaveBeenCalledWith({
						type: "interrupt_turn",
						commandId: "cmd-interrupt-1",
						sessionId: "session-1",
					});
					expect(api.session.abort).not.toHaveBeenCalled();
				}).pipe(Effect.provide(layer));
			}),
	);

	it.effect(
		"cancels pending send dispatch when the provider turn service scope closes",
		() =>
			Effect.gen(function* () {
				const sendStarted = yield* Deferred.make<void>();
				const releaseSend = yield* Deferred.make<void>();
				let boundProviderId: string | undefined;
				const dispatchEffect = vi.fn((command) => {
					if (command.type !== "send_turn") return Effect.void;
					return Effect.gen(function* () {
						yield* Deferred.succeed(sendStarted, undefined);
						yield* Deferred.await(releaseSend);
						return yield* Effect.fail(new Error("late send failure"));
					});
				}) as unknown as OrchestrationEngine["dispatchEffect"];
				const engine = {
					getProviderForSession: vi.fn(() => boundProviderId),
					bindSession: vi.fn((_sessionId: string, providerId: string) => {
						boundProviderId = providerId;
					}),
					unbindSession: vi.fn(() => {
						boundProviderId = undefined;
					}),
					dispatchEffect,
				} as unknown as OrchestrationEngine;
				const { layer, wsHandler } = serviceLayer({ engine });

				yield* Effect.gen(function* () {
					yield* sendTurn();
					yield* Deferred.await(sendStarted);
				}).pipe(Effect.provide(layer));

				yield* Deferred.succeed(releaseSend, undefined);
				yield* flushDispatch();

				expect(wsHandler.sendToSession).not.toHaveBeenCalledWith(
					"session-1",
					expect.objectContaining({ type: "done" }),
				);
				expect(wsHandler.sendTo).not.toHaveBeenCalledWith(
					"client-1",
					expect.objectContaining({ type: "error" }),
				);
			}),
	);
});
