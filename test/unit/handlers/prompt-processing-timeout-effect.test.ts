import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
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
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	hasActiveProcessingTimeout,
	makeOverridesStateLive,
	startProcessingTimeout,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { SessionTitleServiceTag } from "../../../src/lib/domain/relay/Services/session-title-service.js";
import {
	cancelSessionById,
	handleMessage,
} from "../../../src/lib/handlers/prompt.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import { makeHandlerOpenCodeAPI } from "../../helpers/handler-fakes.js";
import {
	MOCK_OPENCODE_GPT4_CATALOG,
	MOCK_PROJECT_DIR,
	makeMockAccountDirectory,
	makeMockAgentService,
	makeMockOpenCodeModelService,
	makeMockSessionManagerService,
	makeMockSessionTitleService,
	makeOpenCodeInstancesStub,
	PassThroughSessionInbox,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

const config = {
	opencodeUrl: "http://127.0.0.1:1",
	projectDir: MOCK_PROJECT_DIR,
	slug: "timeout-test",
	noServer: true,
} satisfies Partial<ProjectRelayConfig>;

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

describe("prompt processing timeouts through Effect state", () => {
	it.effect("removes pending send ownership when processing times out", () => {
		const ws = makeWsHandler();
		const client = makeHandlerOpenCodeAPI({
			session: { prompt: vi.fn(async () => undefined) },
		});
		const persistence = makePersistenceEffectLayer(":memory:", "test-project");
		const layer = Layer.provideMerge(
			Layer.provideMerge(ProviderTurnServiceLive, SessionWorkspaceLive),
			Layer.mergeAll(
				AlertsLive,
				Layer.succeed(OpenCodeAPITag)(client),
				Layer.succeed(OpenCodeInstancesTag)(
					makeOpenCodeInstancesStub({ opencode: client }),
				),
				Layer.succeed(OpenCodeModelServiceTag)(
					makeMockOpenCodeModelService(MOCK_OPENCODE_GPT4_CATALOG),
				),
				Layer.succeed(WebSocketHandlerTag)(ws),
				Layer.succeed(LoggerTag)(createSilentLogger()),
				Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
				Layer.succeed(ConfigTag)(config as ProjectRelayConfig),
				Layer.succeed(SessionManagerServiceTag)(
					makeMockSessionManagerService(),
				),
				PendingInteractionServiceLive,
				makeOverridesStateLive(),
				persistence,
				InputDraftsLive.pipe(Layer.provide(persistence)),
				makeProviderRuntimeIngestionLive().pipe(Layer.provide(persistence)),
				Layer.succeed(AgentServiceTag)(makeMockAgentService()),
				Layer.succeed(SessionTitleServiceTag)(makeMockSessionTitleService()),
				Layer.succeed(OrchestrationEngineTag)(
					withDispatchEffect({
						dispatchEffect: vi.fn(
							(command: { onAccepted?: Effect.Effect<void> }) =>
								// The engine commits the handoff, then the turn runs on.
								Effect.andThen(command.onAccepted ?? Effect.void, Effect.never),
						),
					}),
				),
			),
		);

		return Effect.gen(function* () {
			(yield* OrchestrationEngineTag).bindSession("session-1", "opencode");
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions
				(id, provider, title, model_provider, model_id, variant, context_window, created_at, updated_at)
				VALUES ('session-1', 'opencode', 'Stored session', 'openai', 'gpt-4', '', '', 1, 1)`;
			yield* handleMessage("client-1", {
				text: "hello",
				commandId: "cmd-timeout-send",
			});

			expect(yield* hasActiveProcessingTimeout("session-1")).toBe(true);
			yield* TestClock.adjust("120 seconds");
			expect(yield* hasActiveProcessingTimeout("session-1")).toBe(false);
		}).pipe(
			Effect.provide(PassThroughSessionInbox, { local: true }),
			Effect.provide(layer, { local: true }),
		);
	});

	it.effect(
		"clears the processing timeout when the active prompt is cancelled",
		() => {
			const ws = makeWsHandler();
			const client = makeHandlerOpenCodeAPI({
				session: { abort: vi.fn(async () => undefined) },
			});
			const persistence = makePersistenceEffectLayer(
				":memory:",
				"test-project",
			);
			const baseLayer = Layer.mergeAll(
				AlertsLive,
				Layer.succeed(OpenCodeAPITag)(client),
				Layer.succeed(OpenCodeInstancesTag)(
					makeOpenCodeInstancesStub({ opencode: client }),
				),
				Layer.succeed(WebSocketHandlerTag)(ws),
				Layer.succeed(LoggerTag)(createSilentLogger()),
				Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
				Layer.succeed(ConfigTag)(config as ProjectRelayConfig),
				Layer.succeed(SessionManagerServiceTag)(
					makeMockSessionManagerService(),
				),
				PendingInteractionServiceLive,
				makeOverridesStateLive(),
				persistence,
				InputDraftsLive.pipe(Layer.provide(persistence)),
				makeProviderRuntimeIngestionLive().pipe(Layer.provide(persistence)),
				Layer.succeed(AgentServiceTag)(makeMockAgentService()),
				Layer.succeed(SessionTitleServiceTag)(makeMockSessionTitleService()),
				Layer.succeed(OrchestrationEngineTag)(withDispatchEffect({})),
			);
			const layer = Layer.provideMerge(
				Layer.provideMerge(ProviderTurnServiceLive, SessionWorkspaceLive),
				baseLayer,
			);

			return Effect.gen(function* () {
				yield* startProcessingTimeout(
					"session-1",
					"2 minutes",
					() => Effect.void,
				);
				yield* cancelSessionById("client-1", "session-1", "cmd-cancel-test");

				expect(yield* hasActiveProcessingTimeout("session-1")).toBe(false);
			}).pipe(Effect.provide(layer, { local: true }));
		},
	);
});
