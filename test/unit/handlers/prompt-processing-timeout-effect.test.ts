import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Ref } from "effect";
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
import {
	ProviderTurnServiceLive,
	ProviderTurnServiceTag,
} from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
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
	OverridesStateTag,
	startProcessingTimeout,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { SessionTitleServiceTag } from "../../../src/lib/domain/relay/Services/session-title-service.js";
import { makeFailTurn } from "../../../src/lib/domain/relay/Services/turn-failure.js";
import {
	cancelSessionById,
	handleMessage,
} from "../../../src/lib/handlers/prompt.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { SendTurnCommand } from "../../../src/lib/provider/orchestration-engine.js";
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
	for (const continuation of [false, true]) {
		for (const timing of [
			"active",
			"late-callback",
			"late-ack",
			"late-failure",
		] as const) {
			it.effect(
				`${continuation ? "continuation" : "input"} timeout with ${timing}`,
				() => {
					const ws = makeWsHandler();
					const userId = continuation ? "original-input" : "cmd-timeout-send";
					let failAccepted: (() => Effect.Effect<boolean>) | undefined;
					const client = makeHandlerOpenCodeAPI({
						session: { prompt: vi.fn(async () => undefined) },
					});
					const persistence = makePersistenceEffectLayer(
						":memory:",
						"test-project",
					);
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
							makeProviderRuntimeIngestionLive().pipe(
								Layer.provide(persistence),
							),
							Layer.succeed(AgentServiceTag)(makeMockAgentService()),
							Layer.succeed(SessionTitleServiceTag)(
								makeMockSessionTitleService(),
							),
							Layer.succeed(OrchestrationEngineTag)(
								withDispatchEffect({
									dispatchEffect: vi.fn((command: SendTurnCommand) =>
										Effect.gen(function* () {
											const commit = yield* makeCommitAndSignal;
											yield* commit([
												...(command.events ?? []),
												canonicalEvent("run.requested", "session-1", {
													runId: "run-a",
													inputId: command.input.inputId,
												}),
												canonicalEvent(
													"run.started",
													"session-1",
													{
														inputId: command.input.inputId,
														requestedRunId: "run-a",
														...(continuation
															? { userMessageId: "original-input" }
															: {}),
													},
													{ provider: "claude", metadata: { runId: "run-a" } },
												),
											]);
											if (timing === "late-ack") {
												yield* commit([
													canonicalEvent(
														"turn.completed",
														"session-1",
														{ messageId: "answer-a", userMessageId: userId },
														{
															provider: "claude",
															metadata: { runId: "run-a" },
														},
													),
													canonicalEvent("run.requested", "session-1", {
														runId: "run-b",
														inputId: "next-attempt",
													}),
													canonicalEvent(
														"run.started",
														"session-1",
														{
															inputId: "next-attempt",
															requestedRunId: "run-b",
															userMessageId: userId,
														},
														{
															provider: "claude",
															metadata: { runId: "run-b" },
														},
													),
												]);
												const failTurn = yield* makeFailTurn;
												yield* startProcessingTimeout(
													"session-1",
													"2 minutes",
													() =>
														failTurn(
															"session-1",
															"Run B timed out",
															"PROCESSING_TIMEOUT",
															{ runId: "run-b" },
														),
												);
											}
											const failed = yield* Deferred.make<never, Error>();
											failAccepted = () =>
												Deferred.fail(
													failed,
													new Error("Old dispatch failed after its run ended"),
												);
											yield* command.onAccepted ?? Effect.void;
											return yield* Deferred.await(failed);
										}),
									),
								}),
							),
						),
					);

					return Effect.gen(function* () {
						(yield* OrchestrationEngineTag).bindSession(
							"session-1",
							"opencode",
						);
						const sql = yield* SqlClient.SqlClient;
						yield* sql`INSERT INTO sessions
				(id, provider, title, model_provider, model_id, variant, context_window, created_at, updated_at)
				VALUES ('session-1', 'opencode', 'Stored session', 'openai', 'gpt-4', '', '', 1, 1)`;
						const commit = yield* makeCommitAndSignal;
						yield* commit([
							canonicalEvent("message.created", "session-1", {
								messageId: userId,
								sessionId: "session-1",
								role: "user",
								inputId: userId,
							}),
						]);
						if (continuation)
							yield* (yield* ProviderTurnServiceTag).sendTurn({
								clientId: "client-1",
								sessionId: "session-1",
								commandId: "cmd-timeout-send",
								text: "continue",
								continuation: { cutOffMessageId: userId },
							});
						else
							yield* handleMessage("client-1", {
								text: "hello",
								commandId: "cmd-timeout-send",
							});

						expect(yield* hasActiveProcessingTimeout("session-1")).toBe(true);
						if (timing === "late-callback" || timing === "late-failure") {
							const callback = (yield* Ref.get(
								yield* OverridesStateTag,
							)).processingTimeouts.get("session-1")?.callback;
							if (!callback)
								throw new Error("Missing first reservation timeout");
							yield* commit([
								canonicalEvent(
									"turn.completed",
									"session-1",
									{ messageId: "answer-a", userMessageId: userId },
									{ provider: "claude", metadata: { runId: "run-a" } },
								),
								canonicalEvent("run.requested", "session-1", {
									runId: "run-b",
									inputId: "next-attempt",
								}),
								canonicalEvent(
									"run.started",
									"session-1",
									{
										inputId: "next-attempt",
										requestedRunId: "run-b",
										userMessageId: userId,
									},
									{ provider: "claude", metadata: { runId: "run-b" } },
								),
							]);
							if (timing === "late-failure") {
								if (!failAccepted)
									throw new Error("No accepted dispatch to fail");
								yield* failAccepted();
								yield* Effect.promise(() =>
									vi.waitFor(async () => {
										const [count] = await Effect.runPromise(
											sql<{
												n: number;
											}>`SELECT COUNT(*) AS n FROM events WHERE type = 'turn.error'`,
										);
										expect(count?.n).toBe(1);
									}),
								);
							} else yield* callback();
						} else {
							yield* TestClock.adjust("120 seconds");
							expect(yield* hasActiveProcessingTimeout("session-1")).toBe(
								false,
							);
						}
						expect(
							yield* sql<{
								id: string;
								status: string;
							}>`SELECT id, status FROM provider_runs ORDER BY id`,
						).toEqual(
							timing !== "active"
								? [
										{ id: "run-a", status: "completed" },
										{
											id: "run-b",
											status: timing === "late-ack" ? "error" : "running",
										},
									]
								: [{ id: "run-a", status: "error" }],
						);
						if (timing === "late-failure")
							expect(
								yield* sql<{
									run_id: string | null;
								}>`SELECT json_extract(metadata, '$.runId') AS run_id FROM events WHERE type = 'turn.error'`,
							).toEqual([{ run_id: "run-a" }]);
					}).pipe(
						Effect.provide(PassThroughSessionInbox, { local: true }),
						Effect.provide(layer, { local: true }),
					);
				},
			);
		}
	}

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
