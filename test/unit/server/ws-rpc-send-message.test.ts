import { tmpdir } from "node:os";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { RateLimiterLive } from "../../../src/lib/domain/relay/Layers/rate-limiter-layer.js";
import { setModel } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { sessionPickEvents } from "../../../src/lib/domain/relay/Services/session-pick.js";
import { sendMessageToSession } from "../../../src/lib/handlers/prompt.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	MOCK_OPENCODE_GPT4_CATALOG,
	makeMockConfig,
	makeMockOpenCodeModelService,
	makeMockSessionManagerService,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

describe("WsRpcServerLayer input.submit", () => {
	for (const input of [
		{ sessionId: "session-1", text: "" },
		{ sessionId: undefined, text: "hello" },
	]) {
		it.effect(
			`reports no handoff for ${input.sessionId ? "empty text" : "no active session"}`,
			() =>
				sendMessageToSession({
					...input,
					clientId: "browser-tab-a",
					commandId: "cmd-no-handoff",
				}).pipe(
					Effect.tap((result) =>
						Effect.sync(() => {
							expect(result).toEqual({
								sessionId: input.sessionId,
								handedOff: false,
							});
						}),
					),
					Effect.scoped,
					Effect.provide(makeTestHandlerLayer(), { local: true }),
				),
		);
	}

	it.effect("passes the input id through to provider orchestration", () => {
		const dispatch = vi.fn(() =>
			Effect.succeed({
				status: "completed" as const,
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				providerStateUpdates: [],
			}),
		);
		const engine = withDispatchEffect({
			getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
			dispatchEffect: dispatch,
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			yield* setModel("session-1", {
				providerID: "claude",
				modelID: "sonnet",
			});

			yield* client["input.submit"]({
				sessionId: "session-1",
				text: "hello",
				originId: "browser-tab-a",
				inputId: "cmd-send-1",
				delivery: "queue",
			});

			expect(dispatch).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "send_turn",
					commandId: "cmd-send-1",
				}),
			);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							config: makeMockConfig({ projectDir: tmpdir() }),
							orchestrationEngine: engine,
							seedEvents: [
								makeSessionCreatedEvent("session-1", { provider: "claude" }),
								...sessionPickEvents("session-1", {
									harness: "claude",
									model: { providerId: "claude", modelId: "sonnet" },
									effort: "",
									contextWindow: "",
								}),
							],
							claudeEventPersistEffect: {
								persistHandoffDelivered: () => Effect.void,
								persistEvent: () => Effect.void,
								persistEvents: () => Effect.void,
								persistUserMessage: () => Effect.void,
								ensureClaudeSubagentSession: () => Effect.void,
								readClaudeSubagentTranscript: () =>
									Effect.succeed({ messages: [], parts: [] }),
							},
						}),
					),
				),
				{ local: true },
			),
		);
	});

	it.effect("sends prompts through the shared prompt path", () => {
		const dispatchEffect = vi.fn(
			(command: { onAccepted?: Effect.Effect<void> }) =>
				// The engine commits the handoff, then the turn runs on.
				Effect.andThen(command.onAccepted ?? Effect.void, Effect.never),
		);
		const engine = withDispatchEffect({ dispatchEffect });
		engine.bindSession("session-1", "opencode");
		const recordMessageActivity = vi.fn(() => Effect.void);

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client["input.submit"]({
				sessionId: "session-1",
				text: "hello",
				images: ["data:image/png;base64,abc"],
				originId: "browser-tab-a",
				inputId: "cmd-send-legacy-test",
				delivery: "queue",
			});

			expect(result).toEqual({
				ok: true,
				sessionId: "session-1",
				handedOff: true,
			});
			expect(recordMessageActivity).toHaveBeenCalledWith("session-1");
			expect(dispatchEffect).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "send_turn",
					input: expect.objectContaining({
						sessionId: "session-1",
						prompt: "hello",
						images: [
							expect.objectContaining({
								attachmentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
								mime: "image/png",
							}),
						],
					}),
				}),
			);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							config: makeMockConfig({ projectDir: tmpdir() }),
							orchestrationEngine: engine,
							openCodeModelService: makeMockOpenCodeModelService(
								MOCK_OPENCODE_GPT4_CATALOG,
							),
							seedEvents: [
								makeSessionCreatedEvent("session-1"),
								...sessionPickEvents("session-1", {
									harness: "opencode",
									model: { providerId: "openai", modelId: "gpt-4" },
									effort: "",
									contextWindow: "",
								}),
							],
							sessionManagerService: makeMockSessionManagerService({
								recordMessageActivity,
							}),
						}),
					),
				),
				{ local: true },
			),
		);
	});

	it.effect("applies the relay rate limit when a limiter is available", () => {
		const dispatchEffect = vi.fn(
			(command: { onAccepted?: Effect.Effect<void> }) =>
				// The engine commits the handoff, then the turn runs on.
				Effect.andThen(command.onAccepted ?? Effect.void, Effect.never),
		);
		const engine = withDispatchEffect({ dispatchEffect });
		engine.bindSession("session-1", "opencode");

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			yield* client["input.submit"]({
				sessionId: "session-1",
				text: "first",
				originId: "browser-tab-a",
				inputId: "cmd-rate-1",
				delivery: "queue",
			});

			const second = yield* Effect.result(
				client["input.submit"]({
					sessionId: "session-1",
					text: "second",
					originId: "browser-tab-a",
					inputId: "cmd-rate-2",
					delivery: "queue",
				}),
			);

			expect(second._tag).toBe("Failure");
			expect(dispatchEffect).toHaveBeenCalledTimes(1);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						Layer.mergeAll(
							makeTestHandlerLayer({
								config: makeMockConfig({ projectDir: tmpdir() }),
								orchestrationEngine: engine,
								openCodeModelService: makeMockOpenCodeModelService(
									MOCK_OPENCODE_GPT4_CATALOG,
								),
								seedEvents: [
									makeSessionCreatedEvent("session-1"),
									...sessionPickEvents("session-1", {
										harness: "opencode",
										model: { providerId: "openai", modelId: "gpt-4" },
										effort: "",
										contextWindow: "",
									}),
								],
							}),
							RateLimiterLive({ maxRequests: 1, windowMs: 60_000 }),
						),
					),
				),
				{ local: true },
			),
		);
	});
});
