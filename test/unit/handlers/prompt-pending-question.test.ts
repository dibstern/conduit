import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	type PendingInteractionService,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	type ProviderTurnService,
	ProviderTurnServiceTag,
} from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { sendMessageToSession } from "../../../src/lib/handlers/prompt.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import { makeMockSessionManagerService } from "../../helpers/mock-factories.js";

describe("sendMessageToSession with a pending question", () => {
	for (const { provider, questionCount, shouldInterrupt } of [
		{ provider: "claude", questionCount: 1, shouldInterrupt: true },
		{ provider: "claude", questionCount: 0, shouldInterrupt: false },
		{ provider: "opencode", questionCount: 1, shouldInterrupt: false },
	]) {
		it.effect(
			`${provider} with ${questionCount} pending questions ${shouldInterrupt ? "interrupts before sending" : "sends without interruption"}`,
			() => {
				const calls: string[] = [];
				const ws = {
					getClientsForSession: vi.fn(() => []),
					sendToSession: vi.fn(),
					broadcast: vi.fn(),
				} as unknown as WebSocketHandlerShape;
				const turnService = {
					prepareTurnSession: vi.fn(({ sessionId }: { sessionId: string }) =>
						Effect.succeed(sessionId),
					),
					interruptTurn: vi.fn(() =>
						Effect.sync(() => {
							calls.push("interrupt");
						}),
					),
					sendTurn: vi.fn(() =>
						Effect.sync(() => {
							calls.push("send");
						}),
					),
				} satisfies ProviderTurnService;
				const interactions = {
					listPendingQuestions: vi.fn(() =>
						Effect.succeed(
							questionCount > 0
								? [
										{
											requestId: "question-1",
											sessionId: "session-1",
											questions: [],
											timestamp: 1,
										},
									]
								: [],
						),
					),
				} as unknown as PendingInteractionService;
				const engine = {
					getProviderForSessionEffect: vi.fn(() => Effect.succeed(provider)),
				} as unknown as OrchestrationEngine;
				const sessionManager = makeMockSessionManagerService();
				const layer = Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, {} as OpenCodeAPI),
					Layer.succeed(ConfigTag, {
						projectDir: "/tmp/conduit-pending-question-test",
						slug: "pending-question-test",
						noServer: true,
					} as ProjectRelayConfig),
					Layer.succeed(WebSocketHandlerTag, ws),
					Layer.succeed(LoggerTag, createSilentLogger()),
					Layer.succeed(SessionManagerServiceTag, sessionManager),
					Layer.succeed(ProviderTurnServiceTag, turnService),
					Layer.succeed(PendingInteractionServiceTag, interactions),
					Layer.succeed(OrchestrationEngineTag, engine),
					makeOverridesStateLive(),
				);

				return Effect.gen(function* () {
					yield* sendMessageToSession({
						clientId: "client-1",
						sessionId: "session-1",
						text: "Please continue",
						commandId: "send-command-1",
					});
					expect(calls).toEqual(
						shouldInterrupt ? ["interrupt", "send"] : ["send"],
					);
					if (shouldInterrupt) {
						expect(turnService.interruptTurn).toHaveBeenCalledWith({
							clientId: "client-1",
							sessionId: "session-1",
							commandId: "send-command-1:interrupt-for-question",
						});
						expect(ws.broadcast).toHaveBeenCalledWith({
							type: "ask_user_resolved",
							sessionId: "session-1",
							toolId: "question-1",
						});
						expect(
							sessionManager.decrementPendingQuestionCount,
						).toHaveBeenCalledWith("session-1");
					} else {
						expect(turnService.interruptTurn).not.toHaveBeenCalled();
						expect(ws.broadcast).not.toHaveBeenCalledWith(
							expect.objectContaining({ type: "ask_user_resolved" }),
						);
					}
				}).pipe(Effect.provide(layer));
			},
		);
	}
});
