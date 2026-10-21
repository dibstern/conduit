import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { SessionWorkspaceLive } from "../../../src/lib/domain/relay/Layers/session-workspace-layer.js";
import { AgentServiceTag } from "../../../src/lib/domain/relay/Services/agent-service.js";
import { AlertsLive } from "../../../src/lib/domain/relay/Services/alerts.js";
import { InputDraftsLive } from "../../../src/lib/domain/relay/Services/input-drafts.js";
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
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../src/lib/provider/provider-registry.js";
import { makeHandlerOpenCodeAPI } from "../../helpers/handler-fakes.js";
import {
	makeMockAccountDirectory,
	makeMockAgentService,
	makeMockConfig,
	makeMockSessionManagerService,
	makeMockSessionTitleService,
	makeOpenCodeInstancesStub,
	NoopProviderRuntimeIngestionLive,
	PassThroughSessionInbox,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

function makeWsHandler() {
	return {
		setClientSession: vi.fn(),
		getClientSession: vi.fn(() => "session-1"),
		getClientsForSession: vi.fn(() => ["client-1"]),
		registerSessionViewer: vi.fn(() => () => {}),
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
			const persistence = makePersistenceEffectLayer(
				":memory:",
				"test-project",
			);
			const layer = Layer.provideMerge(
				Layer.provideMerge(
					ProviderTurnServiceLive,
					Layer.merge(
						SessionWorkspaceLive,
						Layer.succeed(ProviderRegistryTag)(new ProviderRegistry()),
					),
				),
				Layer.mergeAll(
					AlertsLive,
					Layer.succeed(OpenCodeAPITag)(client),
					Layer.succeed(OpenCodeInstancesTag)(
						makeOpenCodeInstancesStub({ opencode: client }),
					),
					Layer.succeed(WebSocketHandlerTag)(makeWsHandler()),
					Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
					Layer.succeed(ConfigTag)(makeMockConfig()),
					PendingInteractionServiceLive,
					Layer.succeed(LoggerTag)(createSilentLogger()),
					Layer.succeed(SessionManagerServiceTag)(
						makeMockSessionManagerService(),
					),
					makeOverridesStateLive(),
					persistence,
					InputDraftsLive.pipe(Layer.provide(persistence)),
					makeProviderRuntimeIngestionLive().pipe(Layer.provide(persistence)),
					Layer.succeed(AgentServiceTag)(makeMockAgentService()),
					Layer.succeed(SessionTitleServiceTag)(makeMockSessionTitleService()),
					Layer.succeed(OrchestrationEngineTag)(withDispatchEffect({})),
				),
			);

			return Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "session-1", {
						sessionId: "session-1",
						title: "Question session",
						provider: "opencode",
					}),
					canonicalEvent("message.created", "session-1", {
						messageId: "input-1",
						sessionId: "session-1",
						role: "user",
						inputId: "input-1",
					}),
					canonicalEvent("run.requested", "session-1", {
						runId: "run-1",
						inputId: "input-1",
					}),
					canonicalEvent(
						"run.started",
						"session-1",
						{ inputId: "input-1", requestedRunId: "run-1" },
						{ metadata: { runId: "run-1" } },
					),
					canonicalEvent(
						"question.asked",
						"session-1",
						{
							id: "que-1",
							sessionId: "session-1",
							questions: [{ text: "Continue?" }],
						},
						{ metadata: { runId: "run-1" } },
					),
				]);
				yield* handleAskUserResponse("client-1", {
					toolId: "que-1",
					answers: { "0": "Yes" },
				});

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(true);
			}).pipe(
				Effect.provide(PassThroughSessionInbox, { local: true }),
				Effect.provide(layer, { local: true }),
			);
		},
	);

	it.effect(
		"does not arm an unowned timeout after rejecting an unrecorded question",
		() => {
			const client = makeHandlerOpenCodeAPI({
				question: { reject: vi.fn(async () => undefined) },
			});
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag)(client),
				Layer.succeed(OpenCodeInstancesTag)(
					makeOpenCodeInstancesStub({ opencode: client }),
				),
				Layer.succeed(WebSocketHandlerTag)(makeWsHandler()),
				Layer.succeed(LoggerTag)(createSilentLogger()),
				Layer.succeed(SessionManagerServiceTag)(
					makeMockSessionManagerService(),
				),
				makeOverridesStateLive(),
				PendingInteractionServiceLive,
				NoopProviderRuntimeIngestionLive,
				Layer.succeed(OrchestrationEngineTag)(withDispatchEffect({})),
			);

			return Effect.gen(function* () {
				yield* handleQuestionReject("client-1", { toolId: "que-1" });

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(false);
			}).pipe(Effect.provide(layer, { local: true }));
		},
	);
});
