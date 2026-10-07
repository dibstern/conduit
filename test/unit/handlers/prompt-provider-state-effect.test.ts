import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { AgentServiceTag } from "../../../src/lib/domain/relay/Services/agent-service.js";
import { AlertsLive } from "../../../src/lib/domain/relay/Services/alerts.js";
import { PendingInteractionServiceLive } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { PendingSendOwnershipLive } from "../../../src/lib/domain/relay/Services/pending-send-ownership.js";
import { makeProviderRuntimeIngestionLive } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ProviderTurnServiceLive } from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	makeOverridesStateLive,
	setModel,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { SessionTitleServiceTag } from "../../../src/lib/domain/relay/Services/session-title-service.js";
import { handleMessage } from "../../../src/lib/handlers/prompt.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ProviderStateEffectTag } from "../../../src/lib/persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { SendTurnCommand } from "../../../src/lib/provider/orchestration-engine.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import { makeHandlerOpenCodeAPI } from "../../helpers/handler-fakes.js";
import {
	MOCK_PROJECT_DIR,
	makeMockAgentService,
	makeMockSessionManagerService,
	makeMockSessionTitleService,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

function mockWsHandler(
	sessionId = "session-provider-state",
): WebSocketHandlerShape {
	return {
		setClientSession: vi.fn(),
		getClientSession: vi.fn(() => sessionId),
		getClientsForSession: vi.fn(() => ["client-1"]),
		registerSessionViewer: vi.fn(() => () => {}),
		close: vi.fn(),
		drain: vi.fn(async () => undefined),
	};
}

const setClaudeModel = (sessionId: string) =>
	setModel(sessionId, {
		providerID: "claude",
		modelID: "claude-sonnet-4-5",
	});

const establishClaudeSession = (sessionId: string) =>
	Effect.gen(function* () {
		const eventStore = yield* EventStoreEffectTag;
		const runner = yield* ProjectionRunnerEffectTag;
		if (!(yield* runner.isRecovered())) yield* runner.recover();
		const creation = yield* eventStore.append(
			canonicalEvent(
				"session.created",
				sessionId,
				{ sessionId, title: "Claude Session", provider: "claude" },
				{ provider: "claude" },
			),
		);
		yield* runner.projectEvent(creation);
	});

// Mirror relay-stack production wiring: cev.3 makes ProviderRuntimeIngestion the
// mandatory Claude provider-output seam. Provider events pushed through the sink
// are persisted and republished via this ingestion path, exactly as production
// builds it from the daemon's always-present persistence DB.
const makeIngestionLayer = (
	persistence: ReturnType<typeof makePersistenceEffectLayer>,
) =>
	makeProviderRuntimeIngestionLive({
		relayPublisher: { publish: () => Effect.void },
	}).pipe(Layer.provide(persistence));

describe("handleMessage with Effect provider state persistence", () => {
	it.effect(
		"passes existing provider state into dispatch and persists returned updates",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-provider-state-effect-"));
			const filename = join(dir, "events.db");
			const ws = mockWsHandler();
			const log = createSilentLogger();
			const client = makeHandlerOpenCodeAPI({
				session: {
					messagesPage: vi.fn(async () => []),
				},
			});
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
				dispatch: vi.fn(async () => ({
					status: "completed" as const,
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [
						{
							key: "nativeThread:claude",
							value: JSON.stringify({
								resumeSessionId: "sdk-session-next",
								firstSequence: 0,
								deliveredThrough: 0,
							}),
						},
					],
				})),
			});
			const persistence = makePersistenceEffectLayer(filename);
			const layer = Layer.provideMerge(
				ProviderTurnServiceLive,
				Layer.mergeAll(
					AlertsLive,
					Layer.succeed(OpenCodeAPITag, client),
					Layer.succeed(WebSocketHandlerTag, ws),
					Layer.succeed(LoggerTag, log),
					Layer.succeed(
						SessionManagerServiceTag,
						makeMockSessionManagerService(),
					),
					Layer.succeed(ConfigTag, {
						httpServer: createServer(),
						opencodeUrl: "http://127.0.0.1:1",
						projectDir: MOCK_PROJECT_DIR,
						slug: "provider-state-test",
						persistenceDbPath: filename,
						publishGlobalSetting: () => Effect.void,
					} satisfies ProjectRelayConfig),
					PendingInteractionServiceLive,
					PendingSendOwnershipLive,
					Layer.succeed(AgentServiceTag, makeMockAgentService()),
					Layer.succeed(SessionTitleServiceTag, makeMockSessionTitleService()),
					Layer.succeed(OrchestrationEngineTag, engine),
					persistence,
					makeIngestionLayer(persistence),
					makeOverridesStateLive(),
				),
			);

			return Effect.gen(function* () {
				yield* establishClaudeSession("session-provider-state");
				yield* setClaudeModel("session-provider-state");
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
				INSERT INTO provider_state (session_id, key, value)
				VALUES ('session-provider-state', 'resumeSessionId', 'sdk-session-prev')`;

				yield* handleMessage("client-1", {
					text: "continue",
					commandId: "cmd-provider-state-continue",
				});
				yield* Effect.promise(
					() => new Promise((resolve) => setImmediate(resolve)),
				);

				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "claude",
						input: expect.objectContaining({
							instanceId: "claude",
							providerState: { resumeSessionId: "sdk-session-prev" },
						}),
					}),
				);

				const providerState = yield* ProviderStateEffectTag;
				const updated = yield* Effect.promise(() =>
					vi.waitFor(async () => {
						const state = await Effect.runPromise(
							providerState.nativeThread("session-provider-state", "claude"),
						);
						expect(state?.resumeSessionId).toBe("sdk-session-next");
						return state;
					}),
				);
				expect(updated).toEqual({
					resumeSessionId: "sdk-session-next",
					firstSequence: expect.any(Number),
					deliveredThrough: expect.any(Number),
				});
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => {
						rmSync(dir, { recursive: true, force: true });
					}),
				),
			);
		},
	);

	it.effect("loads Claude history metadata from Effect persistence", () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-history-effect-"));
		const filename = join(dir, "events.db");
		const ws = mockWsHandler("session-history-effect");
		const log = createSilentLogger();
		const client = makeHandlerOpenCodeAPI({
			session: {
				messagesPage: vi.fn(async () => []),
			},
		});
		const engine = withDispatchEffect({
			getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
			dispatch: vi.fn(async () => ({
				status: "completed" as const,
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
			})),
		});
		const persistence = makePersistenceEffectLayer(filename);
		const layer = Layer.provideMerge(
			ProviderTurnServiceLive,
			Layer.mergeAll(
				AlertsLive,
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(
					SessionManagerServiceTag,
					makeMockSessionManagerService(),
				),
				Layer.succeed(ConfigTag, {
					httpServer: createServer(),
					opencodeUrl: "http://127.0.0.1:1",
					projectDir: MOCK_PROJECT_DIR,
					slug: "history-test",
					persistenceDbPath: filename,
					publishGlobalSetting: () => Effect.void,
				} satisfies ProjectRelayConfig),
				PendingInteractionServiceLive,
				PendingSendOwnershipLive,
				Layer.succeed(AgentServiceTag, makeMockAgentService()),
				Layer.succeed(SessionTitleServiceTag, makeMockSessionTitleService()),
				Layer.succeed(OrchestrationEngineTag, engine),
				persistence,
				makeIngestionLayer(persistence),
				makeOverridesStateLive(),
			),
		);

		return Effect.gen(function* () {
			yield* establishClaudeSession("session-history-effect");
			yield* setClaudeModel("session-history-effect");
			const sql = yield* SqlClient.SqlClient;
			yield* sql`
				INSERT INTO messages (
					id, session_id, turn_id, role, text, cost, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, is_streaming, created_at, updated_at
				) VALUES (
					'message-prior-user', 'session-history-effect', NULL, 'user',
					'Earlier question', NULL, NULL, NULL, NULL, NULL, 0, 2, 2
				)`;
			yield* sql`
					INSERT INTO messages (
						id, session_id, turn_id, role, text, cost, tokens_in, tokens_out,
						tokens_cache_read, tokens_cache_write, is_streaming, created_at, updated_at
					) VALUES (
						'message-prior-assistant', 'session-history-effect', NULL, 'assistant',
						'Earlier reply', NULL, 3, 4, 5, 6, 0, 3, 3
					)`;
			const readQuery = yield* ReadQueryEffectTag;
			expect(
				yield* readQuery.getSessionHistoryMetadata("session-history-effect"),
			).toEqual({ messageCount: 2, cumulativeTokens: 18 });

			yield* handleMessage("client-1", {
				text: "continue from there",
				commandId: "cmd-provider-state-continue-from-there",
			});
			yield* Effect.promise(
				() => new Promise((resolve) => setImmediate(resolve)),
			);

			expect(engine.dispatchEffect).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "send_turn",
					providerId: "claude",
					input: expect.objectContaining({
						history: [],
						cumulativeTokens: 18,
					}),
				}),
			);
		}).pipe(
			Effect.provide(layer),
			Effect.ensuring(
				Effect.sync(() => {
					rmSync(dir, { recursive: true, force: true });
				}),
			),
		);
	});

	it.effect("persists Claude user messages through Effect persistence", () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-claude-user-effect-"));
		const filename = join(dir, "events.db");
		const ws = mockWsHandler("session-claude-user-effect");
		const log = createSilentLogger();
		const client = makeHandlerOpenCodeAPI({
			session: {
				messagesPage: vi.fn(async () => []),
			},
		});
		const engine = withDispatchEffect({
			getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
			dispatch: vi.fn(async () => ({
				status: "completed" as const,
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
			})),
		});
		const persistence = makePersistenceEffectLayer(filename);
		const layer = Layer.provideMerge(
			ProviderTurnServiceLive,
			Layer.mergeAll(
				AlertsLive,
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(
					SessionManagerServiceTag,
					makeMockSessionManagerService(),
				),
				Layer.succeed(ConfigTag, {
					httpServer: createServer(),
					opencodeUrl: "http://127.0.0.1:1",
					projectDir: MOCK_PROJECT_DIR,
					slug: "claude-user-effect-test",
					persistenceDbPath: filename,
					publishGlobalSetting: () => Effect.void,
				} satisfies ProjectRelayConfig),
				PendingInteractionServiceLive,
				PendingSendOwnershipLive,
				Layer.succeed(AgentServiceTag, makeMockAgentService()),
				Layer.succeed(SessionTitleServiceTag, makeMockSessionTitleService()),
				Layer.succeed(OrchestrationEngineTag, engine),
				persistence,
				makeIngestionLayer(persistence),
				makeOverridesStateLive(),
			),
		);

		return Effect.gen(function* () {
			yield* establishClaudeSession("session-claude-user-effect");
			yield* setClaudeModel("session-claude-user-effect");
			yield* handleMessage("client-1", {
				text: "persist this through effect",
				commandId: "cmd-provider-state-persist-effect",
			});

			const readQuery = yield* ReadQueryEffectTag;
			const messages = yield* readQuery.getSessionMessagesWithParts(
				"session-claude-user-effect",
			);

			expect(messages).toHaveLength(1);
			expect(messages[0]).toMatchObject({
				session_id: "session-claude-user-effect",
				role: "user",
				text: "persist this through effect",
			});
			expect(messages[0]?.parts).toEqual([
				expect.objectContaining({
					type: "text",
					text: "persist this through effect",
				}),
			]);
		}).pipe(
			Effect.provide(layer),
			Effect.ensuring(
				Effect.sync(() => {
					rmSync(dir, { recursive: true, force: true });
				}),
			),
		);
	});

	it.effect(
		"persists Claude event sink messages through Effect persistence",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-claude-sink-effect-"));
			const filename = join(dir, "events.db");
			const persistence = makePersistenceEffectLayer(filename);
			const ws = mockWsHandler("session-claude-sink-effect");
			const log = createSilentLogger();
			const client = makeHandlerOpenCodeAPI({
				session: {
					messagesPage: vi.fn(async () => []),
				},
			});
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
				dispatch: vi.fn(async (command: SendTurnCommand) => {
					await Effect.runPromise(
						command.input.eventSink.push(
							providerRuntimeEvent(
								"message.created",
								"session-claude-sink-effect",
								{
									messageId: "assistant-message-1",
									role: "assistant",
									sessionId: "session-claude-sink-effect",
								},
								{ providerId: "claude", createdAt: Date.now() },
							),
						),
					);
					await Effect.runPromise(
						command.input.eventSink.push(
							providerRuntimeEvent(
								"text.delta",
								"session-claude-sink-effect",
								{
									messageId: "assistant-message-1",
									partId: "assistant-message-1-0",
									text: "assistant through sink",
								},
								{ providerId: "claude", createdAt: Date.now() },
							),
						),
					);
					return {
						status: "completed" as const,
						cost: 0,
						tokens: { input: 0, output: 0 },
						durationMs: 0,
					};
				}),
			});
			const layer = Layer.provideMerge(
				ProviderTurnServiceLive,
				Layer.mergeAll(
					AlertsLive,
					Layer.succeed(OpenCodeAPITag, client),
					Layer.succeed(WebSocketHandlerTag, ws),
					Layer.succeed(LoggerTag, log),
					Layer.succeed(
						SessionManagerServiceTag,
						makeMockSessionManagerService(),
					),
					Layer.succeed(ConfigTag, {
						httpServer: createServer(),
						opencodeUrl: "http://127.0.0.1:1",
						projectDir: MOCK_PROJECT_DIR,
						slug: "claude-sink-effect-test",
						persistenceDbPath: filename,
						publishGlobalSetting: () => Effect.void,
					} satisfies ProjectRelayConfig),
					PendingInteractionServiceLive,
					PendingSendOwnershipLive,
					Layer.succeed(AgentServiceTag, makeMockAgentService()),
					Layer.succeed(SessionTitleServiceTag, makeMockSessionTitleService()),
					Layer.succeed(OrchestrationEngineTag, engine),
					persistence,
					makeIngestionLayer(persistence),
					makeOverridesStateLive(),
				),
			);

			return Effect.gen(function* () {
				yield* establishClaudeSession("session-claude-sink-effect");
				yield* setClaudeModel("session-claude-sink-effect");
				yield* handleMessage("client-1", {
					text: "trigger assistant",
					commandId: "cmd-provider-state-trigger-assistant",
				});

				const readQuery = yield* ReadQueryEffectTag;
				const messages = yield* Effect.promise(() =>
					vi.waitFor(async () => {
						const result = await Effect.runPromise(
							readQuery.getSessionMessagesWithParts(
								"session-claude-sink-effect",
							),
						);
						expect(
							result.find((message) => message.id === "assistant-message-1"),
						).toMatchObject({
							role: "assistant",
							text: "assistant through sink",
						});
						return result;
					}),
				);

				const assistant = messages.find(
					(message) => message.id === "assistant-message-1",
				);
				expect(assistant).toMatchObject({
					role: "assistant",
					text: "assistant through sink",
				});
				expect(assistant?.parts).toEqual([
					expect.objectContaining({
						type: "text",
						text: "assistant through sink",
					}),
				]);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => {
						rmSync(dir, { recursive: true, force: true });
					}),
				),
			);
		},
	);
});
