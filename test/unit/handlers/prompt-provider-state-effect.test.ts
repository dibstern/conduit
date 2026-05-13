import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { PendingInteractionServiceLive } from "../../../src/lib/effect/pending-interaction-service.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeAPITag,
	OrchestrationEngineTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/effect/session-manager-service.js";
import {
	makeOverridesStateLive,
	setModel,
} from "../../../src/lib/effect/session-overrides-state.js";
import { handleMessage } from "../../../src/lib/handlers/prompt.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProviderStateEffectTag } from "../../../src/lib/persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type {
	OrchestrationEngine,
	SendTurnCommand,
} from "../../../src/lib/provider/orchestration-engine.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import { makeMockSessionManagerService } from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

function mockWsHandler(
	sessionId = "session-provider-state",
): WebSocketHandlerShape {
	return {
		broadcast: vi.fn(),
		sendTo: vi.fn(),
		setClientSession: vi.fn(),
		getClientSession: vi.fn(() => sessionId),
		getClientsForSession: vi.fn(() => ["client-1"]),
		sendToSession: vi.fn(),
		broadcastPerSessionEvent: vi.fn(),
		markClientBootstrapped: vi.fn(),
		getClientCount: vi.fn(() => 1),
		getClientIds: vi.fn(() => ["client-1"]),
		handleUpgrade: vi.fn(),
		close: vi.fn(),
		drain: vi.fn(async () => undefined),
		on: vi.fn(),
		once: vi.fn(),
	};
}

const setClaudeModel = (sessionId: string) =>
	setModel(sessionId, {
		providerID: "claude",
		modelID: "claude-sonnet-4-5",
	});

describe("handleMessage with Effect provider state persistence", () => {
	it.effect(
		"passes existing provider state into dispatch and persists returned updates",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-provider-state-effect-"));
			const filename = join(dir, "events.db");
			const ws = mockWsHandler();
			const log = createSilentLogger();
			const client = {
				session: {
					messagesPage: vi.fn(async () => []),
				},
			} as unknown as OpenCodeAPI;
			const engine = {
				getProviderForSession: vi.fn(() => "claude"),
				dispatch: vi.fn(async () => ({
					status: "completed" as const,
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [
						{ key: "resumeSessionId", value: "sdk-session-next" },
					],
				})),
			} as unknown as OrchestrationEngine;
			const layer = Layer.mergeAll(
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
					projectDir: "/tmp/project",
					slug: "provider-state-test",
				} satisfies ProjectRelayConfig),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makePersistenceEffectLayer(filename),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* setClaudeModel("session-provider-state");
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
				INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES ('session-provider-state', 'claude', 'Provider State', 'idle', 1, 1)`;
				yield* sql`
				INSERT INTO provider_state (session_id, key, value)
				VALUES ('session-provider-state', 'resumeSessionId', 'sdk-session-prev')`;

				yield* handleMessage("client-1", { text: "continue" });
				yield* Effect.promise(
					() => new Promise((resolve) => setImmediate(resolve)),
				);

				expect(engine.dispatchEffect).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "send_turn",
						providerId: "claude",
						input: expect.objectContaining({
							providerState: {
								resumeSessionId: "sdk-session-prev",
							},
						}),
					}),
				);

				const providerState = yield* ProviderStateEffectTag;
				let updated = yield* providerState.getState("session-provider-state");
				for (let attempt = 0; attempt < 10; attempt++) {
					if (updated["resumeSessionId"] === "sdk-session-next") break;
					yield* Effect.promise(
						() => new Promise((resolve) => setTimeout(resolve, 5)),
					);
					updated = yield* providerState.getState("session-provider-state");
				}
				expect(updated).toEqual({ resumeSessionId: "sdk-session-next" });
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

	it.effect("loads prior Claude history from Effect persistence", () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-history-effect-"));
		const filename = join(dir, "events.db");
		const ws = mockWsHandler("session-history-effect");
		const log = createSilentLogger();
		const client = {
			session: {
				messagesPage: vi.fn(async () => []),
			},
		} as unknown as OpenCodeAPI;
		const engine = {
			getProviderForSession: vi.fn(() => "claude"),
			dispatch: vi.fn(async () => ({
				status: "completed" as const,
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
			})),
		} as unknown as OrchestrationEngine;
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerServiceTag, makeMockSessionManagerService()),
			Layer.succeed(ConfigTag, {
				httpServer: createServer(),
				opencodeUrl: "http://127.0.0.1:1",
				projectDir: "/tmp/project",
				slug: "history-test",
			} satisfies ProjectRelayConfig),
			PendingInteractionServiceLive,
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
			makePersistenceEffectLayer(filename),
			makeOverridesStateLive(),
		);

		return Effect.gen(function* () {
			yield* setClaudeModel("session-history-effect");
			const sql = yield* SqlClient.SqlClient;
			yield* sql`
				INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES ('session-history-effect', 'claude', 'History Session', 'idle', 1, 1)`;
			yield* sql`
				INSERT INTO messages (
					id, session_id, turn_id, role, text, cost, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, is_streaming, created_at, updated_at
				) VALUES (
					'message-prior-user', 'session-history-effect', NULL, 'user',
					'Earlier question', NULL, NULL, NULL, NULL, NULL, 0, 2, 2
				)`;
			yield* sql`
				INSERT INTO message_parts (
					id, message_id, type, text, tool_name, call_id, input, result,
					duration, status, sort_order, created_at, updated_at
				) VALUES (
					'part-prior-user', 'message-prior-user', 'text', 'Earlier question',
					NULL, NULL, NULL, NULL, NULL, NULL, 0, 2, 2
				)`;

			yield* handleMessage("client-1", { text: "continue from there" });
			yield* Effect.promise(
				() => new Promise((resolve) => setImmediate(resolve)),
			);

			expect(engine.dispatchEffect).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "send_turn",
					providerId: "claude",
					input: expect.objectContaining({
						history: [
							expect.objectContaining({
								id: "message-prior-user",
								role: "user",
								text: "Earlier question",
								parts: [
									expect.objectContaining({
										id: "part-prior-user",
										type: "text",
										text: "Earlier question",
									}),
								],
							}),
						],
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
		const client = {
			session: {
				messagesPage: vi.fn(async () => []),
			},
		} as unknown as OpenCodeAPI;
		const engine = {
			getProviderForSession: vi.fn(() => "claude"),
			dispatch: vi.fn(async () => ({
				status: "completed" as const,
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
			})),
		} as unknown as OrchestrationEngine;
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerServiceTag, makeMockSessionManagerService()),
			Layer.succeed(ConfigTag, {
				httpServer: createServer(),
				opencodeUrl: "http://127.0.0.1:1",
				projectDir: "/tmp/project",
				slug: "claude-user-effect-test",
			} satisfies ProjectRelayConfig),
			PendingInteractionServiceLive,
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
			makePersistenceEffectLayer(filename),
			makeOverridesStateLive(),
		);

		return Effect.gen(function* () {
			yield* setClaudeModel("session-claude-user-effect");
			yield* handleMessage("client-1", {
				text: "persist this through effect",
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
			const ws = mockWsHandler("session-claude-sink-effect");
			const log = createSilentLogger();
			const client = {
				session: {
					messagesPage: vi.fn(async () => []),
				},
			} as unknown as OpenCodeAPI;
			const engine = {
				getProviderForSession: vi.fn(() => "claude"),
				dispatch: vi.fn(async (command: SendTurnCommand) => {
					await Effect.runPromise(
						command.input.eventSink.push(
							canonicalEvent(
								"message.created",
								"session-claude-sink-effect",
								{
									messageId: "assistant-message-1",
									role: "assistant",
									sessionId: "session-claude-sink-effect",
								},
								{ provider: "claude", createdAt: Date.now() },
							),
						),
					);
					await Effect.runPromise(
						command.input.eventSink.push(
							canonicalEvent(
								"text.delta",
								"session-claude-sink-effect",
								{
									messageId: "assistant-message-1",
									partId: "assistant-message-1-0",
									text: "assistant through sink",
								},
								{ provider: "claude", createdAt: Date.now() },
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
			} as unknown as OrchestrationEngine;
			const layer = Layer.mergeAll(
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
					projectDir: "/tmp/project",
					slug: "claude-sink-effect-test",
				} satisfies ProjectRelayConfig),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makePersistenceEffectLayer(filename),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* setClaudeModel("session-claude-sink-effect");
				yield* handleMessage("client-1", { text: "trigger assistant" });

				const readQuery = yield* ReadQueryEffectTag;
				let messages = yield* readQuery.getSessionMessagesWithParts(
					"session-claude-sink-effect",
				);
				for (let attempt = 0; attempt < 10; attempt++) {
					if (
						messages.some((message) => message.id === "assistant-message-1")
					) {
						break;
					}
					yield* Effect.promise(
						() => new Promise((resolve) => setTimeout(resolve, 5)),
					);
					messages = yield* readQuery.getSessionMessagesWithParts(
						"session-claude-sink-effect",
					);
				}

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
