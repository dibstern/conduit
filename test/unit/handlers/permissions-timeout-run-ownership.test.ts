// Failures: silence settles accepted work, a late answer replaces a newer
// timer, or a notice for an ended run appears on the newer run's transcript.
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Ref, Schema, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { AgentServiceTag } from "../../../src/lib/domain/relay/Services/agent-service.js";
import { InputDraftsLive } from "../../../src/lib/domain/relay/Services/input-drafts.js";
import {
	PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	makeProviderRuntimeIngestionLive,
	type ProviderRuntimeIngestion,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
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
import { makeSilenceNotice } from "../../../src/lib/domain/relay/Services/turn-failure.js";
import {
	handleAskUserResponse,
	handlePermissionResponse,
	handleQuestionReject,
} from "../../../src/lib/handlers/permissions.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { OrchestrationCommand } from "../../../src/lib/provider/orchestration-engine.js";
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
				"handoff-race",
				"late-callback",
				"late-response",
			] as const) {
				it.effect(
					`${action} from ${live ? "live" : "stored"} prompt with ${timing}`,
					() => {
						let interrupts = 0;
						let advanceRun: Effect.Effect<void> = Effect.void;
						const persistence = makePersistenceEffectLayer(
							":memory:",
							"test-project",
						);
						const layer = Layer.mergeAll(
							persistence,
							InputDraftsLive.pipe(Layer.provide(persistence)),
							Layer.effect(
								ProviderRuntimeIngestionTag,
								Effect.gen(function* () {
									const ingestion = yield* ProviderRuntimeIngestionTag;
									return {
										...ingestion,
										ingestBatch: (events, options) =>
											Effect.gen(function* () {
												if (
													timing === "handoff-race" &&
													events.some((event) => event.type === "turn.notice")
												)
													yield* advanceRun;
												return yield* ingestion.ingestBatch(events, options);
											}),
									} satisfies ProviderRuntimeIngestion;
								}),
							).pipe(
								Layer.provide(
									makeProviderRuntimeIngestionLive().pipe(
										Layer.provide(persistence),
									),
								),
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
								beginStop: () => Effect.succeed(Effect.void),
								turnFences: () => ({ stopping: false, switching: false }),
								fenceLifts: Effect.succeed(Stream.empty),
							}),
							Layer.succeed(OrchestrationEngineTag)(
								withDispatchEffect({
									dispatchEffect: (command: OrchestrationCommand) =>
										Effect.gen(function* () {
											if (command.type !== "interrupt_turn") return;
											interrupts++;
											yield* advanceRun;
										}),
									getProviderForSessionEffect: () =>
										Effect.succeed(
											action === "permission" ? "claude" : "opencode",
										),
								}),
							),
						);
						return Effect.gen(function* () {
							const commit = yield* makeCommitAndSignal;
							const sql = yield* SqlClient.SqlClient;
							const seedCommand = (
								inputId: string,
								runId: string,
								sequence: number,
							) =>
								Effect.gen(function* () {
									yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key,
										session_id, provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
										VALUES (${sequence}, ${inputId}, 'test-project', 'session-1', 'claude', 'send_turn', ${runId}, '{}', 'running', 1, 1, 1)`;
									yield* sql`INSERT INTO command_receipts (command_id, session_id, project_key, status, created_at, updated_at)
										VALUES (${inputId}, 'session-1', 'test-project', 'side_effect_requested', 1, 1)`;
								});
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
								canonicalEvent("input.admitted", "session-1", {
									sessionId: "session-1",
									inputId: "queued-c",
									delivery: "queue",
									request: { text: "Charlie" },
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
							yield* seedCommand("input-a", "run-a", 1);
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
							]).pipe(
								Effect.andThen(seedCommand("continuation-b", "run-b", 2)),
							);
							advanceRun = continueAsB.pipe(Effect.orDie);
							if (timing === "late-response") {
								yield* continueAsB;
								const notice = yield* makeSilenceNotice;
								yield* startProcessingTimeout("session-1", "2 minutes", () =>
									notice("session-1", "run-b"),
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
							expect(interrupts).toBe(0);
							if (timing === "active")
								expect(
									yield* (yield* ReadQueryEffectTag).readInboxState(
										"session-1",
									),
								).toMatchObject({ paused: false });
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
												status: "running",
											},
										]
									: [
											{
												id: "run-a",
												status: "running",
											},
										],
							);
							expect(
								yield* sql`SELECT type FROM events WHERE type = 'turn.error'
									OR (type = 'session.status' AND json_extract(data, '$.status') = 'idle')`,
							).toEqual([]);
							expect(
								yield* sql`SELECT status FROM provider_command_outbox ORDER BY request_sequence`,
							).toEqual(
								timing === "active"
									? [{ status: "running" }]
									: [{ status: "completed" }, { status: "running" }],
							);
							expect(
								yield* sql`SELECT status FROM command_receipts ORDER BY command_id`,
							).toEqual(
								timing === "active"
									? [{ status: "side_effect_requested" }]
									: [
											{ status: "side_effect_requested" },
											{ status: "side_effect_completed" },
										],
							);
							const text =
								"No response for 2 minutes. The model may be unavailable or your usage quota may be used up. Stop this turn to try a different model.";
							expect(
								yield* sql`SELECT json_extract(metadata, '$.runId') AS run_id,
									json_extract(data, '$.text') AS text FROM events WHERE type = 'turn.notice'`,
							).toEqual(
								timing === "late-callback"
									? []
									: [
											{
												run_id: timing === "late-response" ? "run-b" : "run-a",
												text,
											},
										],
							);
							expect(
								yield* sql`SELECT text FROM message_parts WHERE json_extract(metadata, '$.notice') = 1`,
							).toEqual(
								timing === "active" || timing === "late-response"
									? [{ text }]
									: [],
							);
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
