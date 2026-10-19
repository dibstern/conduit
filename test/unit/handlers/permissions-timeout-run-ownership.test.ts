// Failures: answering an interaction loses its run, a late timer ends a newer
// run, or a reused continuation turn changes the timer's original owner.
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Ref, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { AgentServiceTag } from "../../../src/lib/domain/relay/Services/agent-service.js";
import { InputDraftsLive } from "../../../src/lib/domain/relay/Services/input-drafts.js";
import {
	PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { makeProviderRuntimeIngestionLive } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ProviderTurnServiceTag } from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	makeOverridesStateLive,
	OverridesStateTag,
	startProcessingTimeout,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { makeFailTurn } from "../../../src/lib/domain/relay/Services/turn-failure.js";
import {
	handleAskUserResponse,
	handlePermissionResponse,
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
import { PermissionId } from "../../../src/lib/shared-types.js";
import { makeHandlerOpenCodeAPI } from "../../helpers/handler-fakes.js";
import {
	makeMockAgentService,
	makeMockConfig,
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
	PassThroughSessionInbox,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

describe("interaction timeout run ownership", () => {
	for (const action of ["answer", "reject", "permission"] as const) {
		for (const live of [false, true]) {
			for (const timing of [
				"active",
				"late-callback",
				"late-response",
			] as const) {
				it.effect(
					`${action} from ${live ? "live" : "stored"} prompt with ${timing}`,
					() => {
						const persistence = makePersistenceEffectLayer(
							":memory:",
							"test-project",
						);
						const layer = Layer.mergeAll(
							persistence,
							InputDraftsLive.pipe(Layer.provide(persistence)),
							makeProviderRuntimeIngestionLive().pipe(
								Layer.provide(persistence),
							),
							PendingInteractionServiceLive,
							makeOverridesStateLive(),
							Layer.succeed(OpenCodeAPITag)(makeHandlerOpenCodeAPI()),
							Layer.succeed(WebSocketHandlerTag)(makeMockWebSocketHandler()),
							Layer.succeed(LoggerTag)(createSilentLogger()),
							Layer.succeed(AgentServiceTag)(makeMockAgentService()),
							Layer.succeed(ConfigTag)(makeMockConfig()),
							Layer.succeed(SessionManagerServiceTag)(
								makeMockSessionManagerService(),
							),
							Layer.succeed(ProviderRegistryTag)(new ProviderRegistry()),
							Layer.succeed(ProviderTurnServiceTag)({
								holdUserTurnsForAccountSwitch: () => Effect.void,
								prepareTurnSession: (input) => Effect.succeed(input.sessionId),
								sendTurn: () =>
									Effect.die("This test only resolves live interactions"),
								interruptTurn: () => Effect.void,
							}),
							Layer.succeed(OrchestrationEngineTag)(
								withDispatchEffect({
									getProviderForSessionEffect: () =>
										Effect.succeed(
											action === "permission" ? "claude" : "opencode",
										),
								}),
							),
						);
						return Effect.gen(function* () {
							const commit = yield* makeCommitAndSignal;
							const owned = {
								provider: "claude",
								metadata: { runId: "run-a" },
							};
							yield* commit([
								canonicalEvent("session.created", "session-1", {
									sessionId: "session-1",
									title: "Interaction",
									provider: "claude",
								}),
								canonicalEvent("message.created", "session-1", {
									messageId: "input-a",
									sessionId: "session-1",
									role: "user",
									inputId: "input-a",
								}),
								canonicalEvent("run.requested", "session-1", {
									runId: "run-a",
									inputId: "input-a",
								}),
								canonicalEvent(
									"run.started",
									"session-1",
									{ inputId: "input-a", requestedRunId: "run-a" },
									owned,
								),
								action === "permission"
									? canonicalEvent(
											"permission.asked",
											"session-1",
											{
												id: "prompt-a",
												sessionId: "session-1",
												toolName: "Read",
												input: {},
											},
											owned,
										)
									: canonicalEvent(
											"question.asked",
											"session-1",
											{
												id: "prompt-a",
												sessionId: "session-1",
												questions: [{ text: "Continue?" }],
											},
											owned,
										),
							]);
							const pending = yield* PendingInteractionServiceTag;
							const permissionId =
								Schema.decodeUnknownSync(PermissionId)("prompt-a");
							if (live) {
								if (action === "permission")
									yield* pending.recordPermissionRequest({
										requestId: permissionId,
										sessionId: "session-1",
										toolName: "Read",
										toolInput: {},
									});
								else
									yield* pending.recordQuestionRequest({
										requestId: "prompt-a",
										sessionId: "session-1",
										questions: [{ question: "Continue?" }],
									});
							}
							const continueAsB = commit([
								canonicalEvent(
									"turn.completed",
									"session-1",
									{ messageId: "answer-a", userMessageId: "input-a" },
									owned,
								),
								canonicalEvent("run.requested", "session-1", {
									runId: "run-b",
									inputId: "continuation-b",
								}),
								canonicalEvent(
									"run.started",
									"session-1",
									{
										inputId: "continuation-b",
										requestedRunId: "run-b",
										userMessageId: "input-a",
									},
									{ provider: "claude", metadata: { runId: "run-b" } },
								),
							]);
							if (timing === "late-response") {
								yield* continueAsB;
								const failTurn = yield* makeFailTurn;
								yield* startProcessingTimeout("session-1", "2 minutes", () =>
									failTurn(
										"session-1",
										"Run B timed out",
										"PROCESSING_TIMEOUT",
										{ runId: "run-b" },
									),
								);
							}
							if (action === "permission")
								yield* handlePermissionResponse("client-1", {
									requestId: permissionId,
									decision: "allow",
								});
							else if (action === "answer")
								yield* handleAskUserResponse("client-1", {
									toolId: "prompt-a",
									answers: { "0": "Yes" },
								});
							else
								yield* handleQuestionReject("client-1", { toolId: "prompt-a" });
							const callback = (yield* Ref.get(
								yield* OverridesStateTag,
							)).processingTimeouts.get("session-1")?.callback;
							expect(callback).toBeDefined();
							if (!callback)
								throw new Error("No owned timeout after interaction");
							if (timing === "late-callback") yield* continueAsB;
							yield* callback();
							const sql = yield* SqlClient.SqlClient;
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
												status:
													timing === "late-response" ? "error" : "running",
											},
										]
									: [{ id: "run-a", status: "error" }],
							);
							const errors = yield* sql<{
								run_id: string | null;
							}>`SELECT json_extract(metadata, '$.runId') AS run_id FROM events WHERE type = 'turn.error'`;
							expect(
								errors.every(
									({ run_id }) =>
										run_id === (timing === "late-response" ? "run-b" : "run-a"),
								),
							).toBe(true);
						}).pipe(
							Effect.provide(PassThroughSessionInbox, { local: true }),
							Effect.provide(layer),
						);
					},
				);
			}
		}
	}
});
