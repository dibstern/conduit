import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";
import { afterEach, expect, vi } from "vitest";
import type { DaemonConfig } from "../../../../src/lib/daemon/config-persistence.js";
import { OpenCodeAPITag } from "../../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { PendingInteractionServiceLive } from "../../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	type ProviderRuntimeIngestion,
	ProviderRuntimeIngestionTag,
} from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
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

const tempConfigDirs: string[] = [];

afterEach(() => {
	for (const configDir of tempConfigDirs.splice(0)) {
		rmSync(configDir, { recursive: true, force: true });
	}
});

const writeDaemonConfig = (config: DaemonConfig): string => {
	const configDir = mkdtempSync(join(tmpdir(), "provider-turn-routing-"));
	tempConfigDirs.push(configDir);
	writeFileSync(join(configDir, "daemon.json"), JSON.stringify(config));
	return configDir;
};

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
	context_window: null,
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

const makeIngestion = (
	overrides?: Partial<ProviderRuntimeIngestion>,
): ProviderRuntimeIngestion => ({
	ingest: vi.fn(() => Effect.succeed(1)),
	ingestBatch: vi.fn(() => Effect.succeed(1)),
	drain: vi.fn(() => Effect.void),
	...overrides,
});

const makeEngine = (input?: {
	readonly providerId?: string | undefined;
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
	readonly ingestion?: ProviderRuntimeIngestion;
	readonly providerState?: ProviderStateEffect;
	readonly titleService?: SessionTitleService;
	readonly sessionHistory?: readonly HistoryMessage[];
	readonly api?: OpenCodeAPI;
	readonly configDir?: string;
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
		Layer.succeed(
			ConfigTag,
			makeMockConfig({
				projectDir: "/test/project",
				...(input.configDir === undefined
					? {}
					: { configDir: input.configDir }),
			}),
		),
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
	if (input.ingestion) {
		baseLayer = Layer.merge(
			baseLayer,
			Layer.succeed(ProviderRuntimeIngestionTag, input.ingestion),
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
		"fails closed for Claude provider output when ProviderRuntimeIngestion is unavailable",
		() =>
			Effect.gen(function* () {
				let capturedSink: EventSink | undefined;
				const dispatchEffect = vi.fn((command) => {
					if (command.type === "send_turn") {
						capturedSink = command.input.eventSink;
						return Effect.succeed(completedTurn());
					}
					return Effect.void;
				}) as unknown as OrchestrationEngine["dispatchEffect"];
				const engine = makeEngine({
					providerId: "claude",
					dispatchEffect,
				});
				const { layer } = serviceLayer({ engine });

				yield* sendTurn().pipe(Effect.provide(layer));

				const sink = capturedSink;
				expect(sink).toBeDefined();
				if (!sink) return;

				const result = yield* Effect.either(
					sink.push(
						providerRuntimeEvent(
							"text.delta",
							"session-1",
							{
								messageId: "msg-1",
								partId: "part-1",
								text: "hello",
							},
							{ eventId: "evt-missing-ingestion", providerId: "claude" },
						),
					),
				);

				expect(result).toMatchObject({
					_tag: "Left",
					left: {
						_tag: "ProviderRuntimeIngestionRequired",
						sessionId: "session-1",
					},
				});
			}),
	);

	it.effect(
		"sends the displayed Claude model even when it came from the global default",
		() => {
			const engine = makeEngine();
			const { layer } = serviceLayer({
				engine,
				readQuery: makeReadQuery(vi.fn(() => Effect.succeed([]))),
				persist: makePersistService(vi.fn(() => Effect.void)),
				ingestion: makeIngestion(),
			});

			return Effect.gen(function* () {
				// modelUserSelected=false is the state for a session that inherited the
				// global default (or lost its per-session pick to a daemon restart).
				// Omitting `model` hands model choice to the Claude CLI's
				// settings.json, which silently runs a different model than the one
				// conduit is displaying.
				yield* sendTurn({ modelUserSelected: false });
				const command = vi.mocked(engine.dispatchEffect).mock
					.calls[0]?.[0] as SendTurnCommand;
				expect(command.input.model).toEqual({
					providerId: "claude",
					modelId: "claude-sonnet-4-5",
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"dispatches the first Claude turn after loading empty persisted history and persisting the user message",
		() => {
			const engine = makeEngine();
			const events: string[] = [];
			const readQuery = makeReadQuery(vi.fn(() => Effect.succeed([])));
			const persist = makePersistService(
				vi.fn(() => Effect.sync(() => events.push("persist"))),
			);
			const ingestion = makeIngestion();
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
				ingestion,
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
				expect(ingestion.ingest).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "text.delta",
						sessionId: "session-1",
					}),
				);
				expect(wsHandler.sendToSession).not.toHaveBeenCalledWith(
					"session-1",
					expect.objectContaining({ type: "delta", text: "hello" }),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"applies Claude turn policy to a named Claude instance binding",
		() => {
			const configDir = writeDaemonConfig({
				pid: 1234,
				port: 2633,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				dangerouslySkipPermissions: false,
				projects: [],
				instances: [
					{
						id: "work-claude",
						name: "Work Claude",
						port: 0,
						managed: false,
						driver: "claude",
						configDir: "/instances/work-claude",
					},
				],
			});
			const engine = makeEngine({ providerId: "work-claude" });
			const readQuery = makeReadQuery(vi.fn(() => Effect.succeed([])));
			const persist = makePersistService(vi.fn(() => Effect.void));
			const { layer } = serviceLayer({
				engine,
				readQuery,
				persist,
				ingestion: makeIngestion(),
				configDir,
			});

			return Effect.gen(function* () {
				yield* sendTurn();

				expect(readQuery.getSessionMessagesWithParts).toHaveBeenCalledWith(
					"session-1",
				);
				expect(persist.persistUserMessage).toHaveBeenCalledWith(
					"session-1",
					"current prompt",
				);
				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "work-claude",
						input: expect.objectContaining({
							configDir: "/instances/work-claude",
							history: [],
						}),
					}),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"surfaces SEND_FAILED without dispatch when the bound instance is unresolvable",
		() => {
			const configDir = writeDaemonConfig({
				pid: 1234,
				port: 2633,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				dangerouslySkipPermissions: false,
				projects: [],
			});
			const engine = makeEngine({ providerId: "deleted-instance" });
			const { layer, wsHandler } = serviceLayer({
				engine,
				configDir,
			});

			return Effect.gen(function* () {
				yield* sendTurn();

				expect(engine.dispatchEffect).not.toHaveBeenCalled();
				expect(wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
					type: "done",
					sessionId: "session-1",
					code: 1,
				});
				expect(wsHandler.sendTo).toHaveBeenCalledWith(
					"client-1",
					expect.objectContaining({
						type: "error",
						code: "SEND_FAILED",
						sessionId: "session-1",
						message: expect.stringContaining("deleted-instance"),
					}),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"dispatches a later Claude turn without starting title generation",
		() => {
			const configDir = writeDaemonConfig({
				pid: 1234,
				port: 2633,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				dangerouslySkipPermissions: false,
				projects: [],
			});
			const engine = makeEngine({ providerId: "claude" });
			const persist = makePersistService(vi.fn(() => Effect.void));
			const titleService = makeTitleService();
			const { layer } = serviceLayer({
				engine,
				persist,
				titleService,
				sessionHistory: [historyMessage("Earlier prompt")],
				configDir,
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
				const command = vi.mocked(engine.dispatchEffect).mock.calls[0]?.[0];
				if (command?.type !== "send_turn") {
					throw new Error("Expected a send_turn command");
				}
				expect(command.input).not.toHaveProperty("configDir");
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
		"finalizes an interrupted dispatch result by clearing the processing timeout and broadcasting done",
		() => {
			const engine = makeEngine({
				providerId: "opencode",
				result: {
					status: "interrupted",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
					error: { code: "interrupted", message: "Turn interrupted" },
				},
			});
			const { layer, wsHandler } = serviceLayer({ engine });

			return Effect.gen(function* () {
				yield* startProcessingTimeout(
					"session-1",
					"2 minutes",
					() => Effect.void,
				);
				yield* sendTurn();

				// Without finalization the browser stays "processing" until the
				// 2-minute PROCESSING_TIMEOUT: the timeout must be cleared and a
				// `done` broadcast immediately.
				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(false);
				expect(wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
					type: "done",
					sessionId: "session-1",
					code: 1,
				});
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
				const command = vi.mocked(engine.dispatchEffect).mock.calls[0]?.[0];
				if (command?.type !== "send_turn") {
					throw new Error("Expected a send_turn command");
				}
				expect(command.input).not.toHaveProperty("configDir");

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
