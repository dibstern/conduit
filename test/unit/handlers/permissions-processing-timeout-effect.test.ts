import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { AgentServiceTag } from "../../../src/lib/domain/relay/Services/agent-service.js";
import { PendingInteractionServiceLive } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { makeProviderRuntimeIngestionLive } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ProviderTurnServiceLive } from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	hasActiveProcessingTimeout,
	makeOverridesStateLive,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { SessionTitleServiceTag } from "../../../src/lib/domain/relay/Services/session-title-service.js";
import {
	handleAskUserResponse,
	handleQuestionReject,
} from "../../../src/lib/handlers/permissions.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import { makeHandlerOpenCodeAPI } from "../../helpers/handler-fakes.js";
import {
	makeMockAgentService,
	makeMockSessionManagerService,
	makeMockSessionTitleService,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

function makeWsHandler() {
	return {
		broadcast: vi.fn(),
		sendTo: vi.fn(),
		setClientSession: vi.fn(),
		getClientSession: vi.fn(() => "session-1"),
		getClientsForSession: vi.fn(() => ["client-1"]),
		sendToSession: vi.fn(),
		broadcastPerSessionEvent: vi.fn(),
		markClientBootstrapped: vi.fn(),
		getClientCount: vi.fn(() => 1),
		getClientIds: vi.fn(() => ["client-1"]),
		attach: vi.fn(() => () => {}),
		close: vi.fn(),
		drain: vi.fn(async () => undefined),
		on: vi.fn(),
		once: vi.fn(),
	};
}

describe("permission/question processing timeouts through Effect state", () => {
	it.effect(
		"restarts the processing timeout after answering a question",
		() => {
			const client = makeHandlerOpenCodeAPI({
				question: { reply: vi.fn(async () => undefined) },
			});
			const persistence = makePersistenceEffectLayer(":memory:");
			const layer = Layer.provideMerge(
				ProviderTurnServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, client),
					Layer.succeed(WebSocketHandlerTag, makeWsHandler()),
					Layer.succeed(ConfigTag, {} as ProjectRelayConfig),
					PendingInteractionServiceLive,
					Layer.succeed(LoggerTag, createSilentLogger()),
					Layer.succeed(
						SessionManagerServiceTag,
						makeMockSessionManagerService(),
					),
					makeOverridesStateLive(),
					persistence,
					makeProviderRuntimeIngestionLive().pipe(Layer.provide(persistence)),
					Layer.succeed(AgentServiceTag, makeMockAgentService()),
					Layer.succeed(SessionTitleServiceTag, makeMockSessionTitleService()),
					Layer.succeed(OrchestrationEngineTag, withDispatchEffect({})),
				),
			);

			return Effect.gen(function* () {
				yield* handleAskUserResponse("client-1", {
					toolId: "que-1",
					answers: { "0": "Yes" },
				});

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(true);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"restarts the processing timeout after rejecting a question",
		() => {
			const client = makeHandlerOpenCodeAPI({
				question: { reject: vi.fn(async () => undefined) },
			});
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, client),
				Layer.succeed(WebSocketHandlerTag, makeWsHandler()),
				Layer.succeed(LoggerTag, createSilentLogger()),
				Layer.succeed(
					SessionManagerServiceTag,
					makeMockSessionManagerService(),
				),
				makeOverridesStateLive(),
				PendingInteractionServiceLive,
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect({})),
			);

			return Effect.gen(function* () {
				yield* handleQuestionReject("client-1", { toolId: "que-1" });

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(true);
			}).pipe(Effect.provide(layer));
		},
	);
});
