import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { PermissionBridge } from "../../../src/lib/bridges/permission-bridge.js";
import { QuestionBridge } from "../../../src/lib/bridges/question-bridge.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeAPITag,
	OrchestrationEngineTag,
	PermissionBridgeTag,
	QuestionBridgeTag,
	SessionManagerTag,
	SessionOverridesTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import { handleMessage } from "../../../src/lib/handlers/prompt.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProviderStateEffectTag } from "../../../src/lib/persistence/effect/provider-state-effect.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { SessionManager } from "../../../src/lib/session/session-manager.js";
import { SessionOverrides } from "../../../src/lib/session/session-overrides.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";

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

describe("handleMessage with Effect provider state persistence", () => {
	it.effect(
		"passes existing provider state into dispatch and persists returned updates",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-provider-state-effect-"));
			const filename = join(dir, "events.db");
			const ws = mockWsHandler();
			const overrides = new SessionOverrides();
			overrides.setModel("session-provider-state", {
				providerID: "claude",
				modelID: "claude-sonnet-4-5",
			});
			const log = createSilentLogger();
			const client = {
				session: {
					messagesPage: vi.fn(async () => []),
				},
			} as unknown as OpenCodeAPI;
			const sessionMgr = new SessionManager({ client, log });
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
				Layer.succeed(SessionOverridesTag, overrides),
				Layer.succeed(LoggerTag, log),
				Layer.succeed(SessionManagerTag, sessionMgr),
				Layer.succeed(ConfigTag, {
					httpServer: createServer(),
					opencodeUrl: "http://127.0.0.1:1",
					projectDir: "/tmp/project",
					slug: "provider-state-test",
				} satisfies ProjectRelayConfig),
				Layer.succeed(PermissionBridgeTag, new PermissionBridge()),
				Layer.succeed(QuestionBridgeTag, new QuestionBridge()),
				Layer.succeed(OrchestrationEngineTag, engine),
				makePersistenceEffectLayer(filename),
			);

			return Effect.gen(function* () {
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

				expect(engine.dispatch).toHaveBeenCalledWith(
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
						overrides.dispose();
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
		const overrides = new SessionOverrides();
		overrides.setModel("session-history-effect", {
			providerID: "claude",
			modelID: "claude-sonnet-4-5",
		});
		const log = createSilentLogger();
		const client = {
			session: {
				messagesPage: vi.fn(async () => []),
			},
		} as unknown as OpenCodeAPI;
		const sessionMgr = new SessionManager({ client, log });
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
			Layer.succeed(SessionOverridesTag, overrides),
			Layer.succeed(LoggerTag, log),
			Layer.succeed(SessionManagerTag, sessionMgr),
			Layer.succeed(ConfigTag, {
				httpServer: createServer(),
				opencodeUrl: "http://127.0.0.1:1",
				projectDir: "/tmp/project",
				slug: "history-test",
			} satisfies ProjectRelayConfig),
			Layer.succeed(PermissionBridgeTag, new PermissionBridge()),
			Layer.succeed(QuestionBridgeTag, new QuestionBridge()),
			Layer.succeed(OrchestrationEngineTag, engine),
			makePersistenceEffectLayer(filename),
		);

		return Effect.gen(function* () {
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

			expect(engine.dispatch).toHaveBeenCalledWith(
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
					overrides.dispose();
					rmSync(dir, { recursive: true, force: true });
				}),
			),
		);
	});
});
