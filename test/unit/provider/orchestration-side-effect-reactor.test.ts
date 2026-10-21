import { mkdirSync, writeFileSync } from "node:fs";
import { describe, it } from "@effect/vitest";
import {
	Clock,
	Deferred,
	Duration,
	Effect,
	Fiber,
	Layer,
	Option,
} from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import {
	decodeProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { makeAccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import {
	makeProviderRuntimeIngestionLive,
	type ProviderRuntimeIngestion,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import {
	ProviderSideEffectReactor,
	type ProviderSideEffectReactorOptions,
} from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type {
	EventSink,
	PermissionResponse,
	ProviderCapabilities,
	ProviderInstance,
	SendTurnInput,
	TurnResult,
} from "../../../src/lib/provider/types.js";

const retryCases: Array<{ case: string; outcome: string }> = [];

const completedTurn: TurnResult = {
	status: "completed",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 1,
	providerStateUpdates: [],
};

const emptyCapabilities: ProviderCapabilities = {
	models: [],
	supportsTools: false,
	supportsThinking: false,
	supportsPermissions: false,
	supportsQuestions: false,
	supportsAttachments: false,
	supportsFork: false,
	supportsRevert: false,
	commands: [],
};

function makeProvider(
	sendTurnEffect: ProviderInstance["sendTurnEffect"],
	providerId = "claude",
): ProviderInstance {
	return {
		providerId,
		discoverEffect: () => Effect.succeed(emptyCapabilities),
		// The fake provider emits its own completion frame. Its return value alone
		// cannot settle the command or release the next session request.
		sendTurnEffect: (input) =>
			sendTurnEffect(input).pipe(
				Effect.tap((result) =>
					result.status === "completed" && input.runId
						? Clock.currentTimeMillis.pipe(
								Effect.flatMap((createdAt) =>
									input.eventSink.push({
										eventId: `provider-end:${input.runId}:${input.commandAttempt}`,
										type: "turn.completed",
										providerId,
										sessionId: input.sessionId,
										runId: input.runId,
										providerRefs: {},
										rawSource: { kind: "test.provider" },
										createdAt,
										data: { messageId: "", duration: result.durationMs },
									}),
								),
								Effect.mapError(
									(cause) =>
										new ProviderInstanceFailure({
											providerId: "claude",
											operation: "sendTurn",
											cause,
										}),
								),
							)
						: Effect.void,
				),
			),
		interruptTurnEffect: () => Effect.void,
		resolvePermissionEffect: () => Effect.void,
		resolveQuestionEffect: () => Effect.void,
		shutdownEffect: () => Effect.void,
		endSessionEffect: () => Effect.void,
	};
}

describe("ProviderSideEffectReactor", () => {
	it.effect(
		"places a claimed input and its failure before intake atomically",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedSendTurnOutbox(sql, { providerId: "opencode" });
				yield* (yield* makeCommitAndSignal)([
					canonicalEvent("session.created", "session-1", {
						sessionId: "session-1",
						provider: "opencode",
						title: "Named failure",
					}),
				]);
				yield* sql`UPDATE provider_command_outbox SET payload_json = json_set(payload_json,
				'$.images', json_array('data:image/png;base64,aW1hZ2U='))`;
				const reactor = yield* makeReactor({
					persistUserMessage: (yield* ClaudeEventPersistEffectTag)
						.persistUserMessage,
					registry: new ProviderRegistry([
						makeProvider(
							() =>
								Effect.fail(
									new ProviderInstanceFailure({
										providerId: "opencode",
										operation: "sendTurn",
										cause: {
											code: "SEND_FAILED",
											message: "OpenCode unreachable",
										},
									}),
								),
							"opencode",
						),
					]),
				});
				expect(yield* reactor.runCommand("cmd-1")).toMatchObject({
					status: "error",
				});
				expect(yield* sql`SELECT run_id, state, started_at FROM turns`).toEqual(
					[{ run_id: "run:cmd-1", state: "error", started_at: null }],
				);
				expect(
					yield* sql`SELECT status, started_at FROM provider_runs`,
				).toEqual([{ status: "error", started_at: null }]);
				expect(
					yield* sql`SELECT status, attempt_count FROM provider_command_outbox`,
				).toEqual([{ status: "failed", attempt_count: 1 }]);
				expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
					{ status: "side_effect_failed" },
				]);
				expect(
					yield* sql`SELECT type FROM message_parts ORDER BY type`,
				).toEqual([{ type: "error" }, { type: "file" }, { type: "text" }]);
				expect(
					yield* sql`SELECT events.type, json_extract(events.metadata, '$.runId') AS run_id
					FROM sessions JOIN events ON events.session_id = sessions.id
					AND events.stream_version = sessions.last_turn_end_version`,
				).toEqual([{ type: "turn.error", run_id: "run:cmd-1" }]);
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	for (const retry of [false, true])
		it.effect(
			`places continuation membership at claim before provider intake (retry: ${retry})`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* seedSendTurnOutbox(sql, { runId: "reserved-run" });
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent(
							"run.requested",
							"session-1",
							{ runId: "old-run", inputId: "cut-off" },
							{ createdAt: 10 },
						),
						canonicalEvent(
							"message.created",
							"session-1",
							{ sessionId: "session-1", messageId: "cut-off", role: "user" },
							{ metadata: { runId: "old-run" }, createdAt: 10 },
						),
						canonicalEvent(
							"turn.completed",
							"session-1",
							{ messageId: "" },
							{
								provider: "claude",
								metadata: { runId: "old-run" },
								createdAt: 20,
							},
						),
					]);
					yield* sql`UPDATE provider_command_outbox SET payload_json = json_set(payload_json, '$.continuation', json_object('cutOffMessageId', 'cut-off'))`;
					if (retry) {
						yield* sql`UPDATE provider_runs SET status = 'error', completed_at = 1000 WHERE id = 'reserved-run'`;
						yield* sql`UPDATE provider_command_outbox SET status = 'retryable_failed', attempt_count = 1, next_attempt_at = 0`;
					}
					expect(
						yield* sql`SELECT run_id, state FROM turns WHERE id = 'cut-off'`,
					).toEqual([{ run_id: "old-run", state: "completed" }]);
					const send = vi.fn((input: SendTurnInput) =>
						Effect.gen(function* () {
							expect(
								yield* sql`SELECT run_id, state, started_at FROM turns WHERE id = 'cut-off'`,
							).toEqual([
								{ run_id: input.runId, state: "pending", started_at: null },
							]);
							expect(
								yield* sql`SELECT event_id FROM events WHERE event_id = ${`continuation-placement:${input.runId}`}`,
							).toHaveLength(1);
							expect(input.runId === "reserved-run").toBe(!retry);
							return completedTurn;
						}).pipe(Effect.orDie),
					);
					const reactor = yield* makeReactor({
						registry: new ProviderRegistry([makeProvider(send)]),
					});
					expect((yield* reactor.runCommand("cmd-1")).status).toBe("completed");
					expect(send).toHaveBeenCalledOnce();
				}).pipe(Effect.provide(reactorTestLayer)),
		);
	it.effect(
		"foreground sends wait behind an open indeterminate reservation without holding admission",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedSendTurnOutbox(sql);
				yield* sql`UPDATE provider_command_outbox SET status = 'running', attempt_count = 1, error_code = 'delivery_indeterminate'`;
				yield* sql`UPDATE command_receipts SET error_code = 'delivery_indeterminate'`;
				yield* seedSendTurnOutbox(sql, {
					commandId: "cmd-c",
					requestSequence: 11,
				});
				const sendTurn = vi.fn(() =>
					Effect.succeed({ ...completedTurn, status: "accepted" as const }),
				);
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([makeProvider(sendTurn)]),
				});
				const waiting = yield* Effect.forkChild(reactor.runCommand("cmd-c"));
				yield* TestClock.adjust("1 second");
				expect(sendTurn).not.toHaveBeenCalled();
				expect(
					yield* sql`SELECT status, attempt_count FROM provider_command_outbox WHERE command_id = 'cmd-c'`,
				).toEqual([{ status: "pending", attempt_count: 0 }]);
				expect(waiting.pollUnsafe()).toBeUndefined();
				expect(yield* reactor.runOnce()).toBe(0);
			}).pipe(Effect.provide(reactorTestLayer)),
	);
	it.effect(
		"settles a local recall returned before the executor deadline",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedSendTurnOutbox(sql);
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([
						makeProvider(() =>
							Effect.succeed({ ...completedTurn, status: "cancelled" }),
						),
					]),
				});
				const caller = yield* Effect.forkChild(reactor.runCommand("cmd-1"));
				yield* TestClock.adjust("1 second");
				expect(caller.pollUnsafe()).toBeDefined();
				expect((yield* Fiber.join(caller)).status).toBe("error");
				expect(
					yield* sql`SELECT status, started_at FROM provider_runs`,
				).toEqual([{ status: "error", started_at: null }]);
				expect(yield* sql`SELECT status FROM provider_command_outbox`).toEqual([
					{ status: "failed" },
				]);
			}).pipe(Effect.provide(reactorTestLayer)),
	);
	for (const recall of [
		"cancelled",
		"indeterminate",
		"silent",
		"interrupted",
	] as const)
		it.effect(`intake deadline is bounded after local recall (${recall})`, () =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedSendTurnOutbox(sql);
				const sent = yield* Deferred.make<SendTurnInput>();
				const sendTurn = vi.fn((input: SendTurnInput) =>
					Deferred.succeed(sent, input).pipe(
						Effect.andThen(
							Effect.callback<void>((resume) => {
								input.abortSignal.addEventListener(
									"abort",
									() => {
										if (recall !== "silent") resume(Effect.void);
									},
									{ once: true },
								);
							}),
						),
						Effect.as({
							...completedTurn,
							status: recall === "silent" ? ("indeterminate" as const) : recall,
						}),
					),
				);
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([makeProvider(sendTurn)]),
				});
				const caller = yield* Effect.forkChild(reactor.runCommand("cmd-1"));
				const input = yield* Deferred.await(sent);
				const [claimedVersion] = yield* sql<{
					version: number;
				}>`SELECT version FROM sessions WHERE id = 'session-1'`;
				yield* TestClock.adjust("122 seconds");
				expect(input.abortSignal.aborted).toBe(true);
				expect(caller.pollUnsafe()).toBeDefined();
				const result = yield* Fiber.join(caller);
				if (recall === "cancelled") {
					expect(result).toMatchObject({
						status: "error",
						error: { code: "processing_timeout" },
					});
					expect(yield* sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "error" },
					]);
					return;
				}
				expect(result.status).toBe("indeterminate");
				const [indeterminateVersion] = yield* sql<{
					version: number;
				}>`SELECT version FROM sessions WHERE id = 'session-1'`;
				expect(indeterminateVersion?.version).toBeGreaterThan(
					claimedVersion?.version ?? 0,
				);
				expect(
					yield* sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([
					{ status: "running", error_code: "delivery_indeterminate" },
				]);
				expect(
					yield* sql`SELECT status, error_code FROM command_receipts`,
				).toEqual([
					{
						status: "side_effect_requested",
						error_code: "delivery_indeterminate",
					},
				]);
				expect(
					yield* sql`SELECT status, started_at FROM provider_runs`,
				).toEqual([{ status: "pending", started_at: null }]);
				// A new reactor represents daemon restart: the unknown attempt is never delivered twice.
				const restarted = yield* makeReactor({
					registry: new ProviderRegistry([makeProvider(sendTurn)]),
				});
				expect((yield* restarted.runCommand("cmd-1")).status).toBe(
					"indeterminate",
				);
				expect(yield* restarted.runOnce()).toBe(0);
				yield* seedSendTurnOutbox(sql, {
					commandId: "cmd-c",
					requestSequence: 11,
				});
				const next = yield* Effect.forkChild(restarted.runCommand("cmd-c"));
				yield* TestClock.adjust("1 second");
				expect(sendTurn).toHaveBeenCalledOnce();
				expect(next.pollUnsafe()).toBeUndefined();
				expect(
					yield* sql`SELECT status FROM provider_command_outbox WHERE command_id = 'cmd-c'`,
				).toEqual([{ status: "pending" }]);
				// Real native acceptance, then its terminal, still owns the original reservation.
				const ingestion = yield* ProviderRuntimeIngestionTag;
				for (const type of ["run.started", "turn.completed"] as const)
					yield* ingestion.ingest({
						eventId: `late-${type}`,
						type,
						providerId: "claude",
						sessionId: input.sessionId,
						runId: input.runId,
						providerRefs: {},
						rawSource: { kind: "test.native" },
						createdAt: 130000,
						data:
							type === "run.started"
								? { inputId: "legacy-user-1", requestedRunId: input.runId }
								: { messageId: "answer" },
					});
				expect((yield* restarted.runCommand("cmd-1")).status).toBe("completed");
				expect(sendTurn).toHaveBeenCalledOnce();
			}).pipe(Effect.provide(reactorTestLayer)),
		);
	it.effect(
		"acknowledges an adapter's committed failure without emitting a second terminal",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedSendTurnOutbox(sql, { runId: "failed-intake" });
				const failure = new ProviderInstanceFailure({
					providerId: "claude",
					operation: "sendTurn",
					cause: new Error("Runner refused intake"),
				});
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([
						makeProvider((input) =>
							input.eventSink
								.push({
									eventId: "native-failure",
									type: "turn.error",
									providerId: "claude",
									sessionId: input.sessionId,
									runId: input.runId,
									providerRefs: {},
									rawSource: { kind: "test.provider" },
									createdAt: 2,
									data: {
										messageId: "",
										error: "Runner refused intake",
										code: "runner_refused",
									},
								})
								.pipe(
									Effect.mapError(() => failure),
									Effect.andThen(Effect.fail(failure)),
								),
						),
					]),
				});
				yield* reactor.drain();
				expect(
					yield* sql`SELECT type FROM events WHERE type = 'turn.error'`,
				).toEqual([{ type: "turn.error" }]);
				expect(
					yield* sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([{ status: "failed", error_code: "runner_refused" }]);
			}).pipe(Effect.provide(reactorTestLayer)),
	);
	it.effect(
		"a projected failure bounds local recall without a runner acknowledgement",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedSendTurnOutbox(sql);
				const dispatched = yield* Deferred.make<{
					runId: string;
					signal: AbortSignal;
				}>();
				const acknowledged = yield* Deferred.make<void>();
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([
						makeProvider((input) =>
							Deferred.succeed(dispatched, {
								runId: input.runId ?? "",
								signal: input.abortSignal,
							}).pipe(
								Effect.andThen(Deferred.await(acknowledged)),
								Effect.as({ ...completedTurn, status: "cancelled" as const }),
							),
						),
					]),
					outcomePollInterval: "10 millis",
				});
				const caller = yield* Effect.forkChild(reactor.runCommand("cmd-1"));
				const { runId, signal } = yield* Deferred.await(dispatched);
				const ingestion = yield* ProviderRuntimeIngestionTag;
				yield* ingestion.ingest({
					eventId: "pre-intake-timeout",
					type: "turn.error",
					providerId: "claude",
					sessionId: "session-1",
					runId,
					providerRefs: {},
					rawSource: { kind: "test.timeout" },
					createdAt: 3,
					data: {
						messageId: "",
						error: "No intake",
						code: "PROCESSING_TIMEOUT",
					},
				});
				yield* TestClock.adjust("10 millis");
				expect(signal.aborted).toBe(true);
				yield* TestClock.adjust("1 second");
				expect(caller.pollUnsafe()).toBeDefined();
				expect(yield* Fiber.join(caller)).toMatchObject({
					status: "error",
					error: { code: "PROCESSING_TIMEOUT" },
				});
				expect(signal.aborted).toBe(true);
				expect(yield* sql`SELECT status FROM provider_command_outbox`).toEqual([
					{ status: "failed" },
				]);
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect("a projected failure bounds background local recall", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* seedSendTurnOutbox(sql);
			const dispatched = yield* Deferred.make<SendTurnInput>();
			const acknowledged = yield* Deferred.make<void>();
			const reactor = yield* makeReactor({
				registry: new ProviderRegistry([
					makeProvider((input) =>
						Deferred.succeed(dispatched, input).pipe(
							Effect.andThen(Deferred.await(acknowledged)),
							Effect.as({ ...completedTurn, status: "cancelled" as const }),
						),
					),
				]),
				outcomePollInterval: "10 millis",
			});
			const drain = yield* Effect.forkChild(reactor.runOnce());
			const input = yield* Deferred.await(dispatched);
			const ingestion = yield* ProviderRuntimeIngestionTag;
			yield* ingestion.ingest({
				eventId: "background-intake-timeout",
				type: "turn.error",
				providerId: "claude",
				sessionId: input.sessionId,
				runId: input.runId,
				providerRefs: {},
				rawSource: { kind: "test.timeout" },
				createdAt: 3,
				data: {
					messageId: "",
					error: "No intake",
					code: "PROCESSING_TIMEOUT",
				},
			});
			yield* TestClock.adjust("10 millis");
			expect(input.abortSignal.aborted).toBe(true);
			yield* TestClock.adjust("1 second");
			expect(yield* Fiber.join(drain)).toBe(1);
			expect(yield* sql`SELECT status FROM provider_command_outbox`).toEqual([
				{ status: "failed" },
			]);
		}).pipe(Effect.provide(reactorTestLayer)),
	);

	for (const terminal of ["turn.completed", "turn.error"] as const)
		it.effect(
			`a foreground intake acknowledgement waits for ${terminal} without aborting retained native work`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* seedSendTurnOutbox(sql);
					const intake = yield* Deferred.make<{
						runId: string;
						signal: AbortSignal;
					}>();
					const reactor = yield* makeReactor({
						registry: new ProviderRegistry([
							makeProvider((input) =>
								input.eventSink
									.push({
										eventId: "intake",
										type: "run.started",
										providerId: "claude",
										sessionId: input.sessionId,
										runId: input.runId,
										providerRefs: {},
										rawSource: { kind: "test.provider" },
										createdAt: 2,
										data: {
											inputId: input.inputId,
											requestedRunId: input.runId,
										},
									})
									.pipe(
										Effect.andThen(
											Deferred.succeed(intake, {
												runId: input.runId ?? "",
												signal: input.abortSignal,
											}),
										),
										Effect.as<TurnResult>({
											...completedTurn,
											status: "accepted",
										}),
										Effect.mapError(
											(cause) =>
												new ProviderInstanceFailure({
													providerId: "claude",
													operation: "sendTurn",
													cause,
												}),
										),
									),
							),
						]),
						outcomePollInterval: "10 millis",
						outcomePollTimeout: "1 second",
					});
					const caller = yield* Effect.forkChild(reactor.runCommand("cmd-1"));
					const { runId, signal } = yield* Deferred.await(intake);
					yield* TestClock.adjust("100 millis");
					expect(caller.pollUnsafe()).toBeUndefined();
					expect(
						yield* sql`SELECT status FROM provider_command_outbox`,
					).toEqual([{ status: "running" }]);
					const ingestion = yield* ProviderRuntimeIngestionTag;
					yield* ingestion.ingest({
						eventId: "own-end",
						type: terminal,
						providerId: "claude",
						sessionId: "session-1",
						runId,
						providerRefs: {},
						rawSource: { kind: "test.provider" },
						createdAt: 3,
						data: { messageId: "", error: "Native failure" },
					});
					yield* TestClock.adjust("10 millis");
					expect((yield* Fiber.join(caller)).status).toBe(
						terminal === "turn.completed" ? "completed" : "error",
					);
					expect(signal.aborted).toBe(false);
					expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
						{
							status:
								terminal === "turn.completed"
									? "side_effect_completed"
									: "side_effect_failed",
						},
					]);
				}).pipe(Effect.provide(reactorTestLayer)),
		);

	it.effect("handoff intake does not end native work", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* seedSendTurnOutbox(sql);
			const reactor = yield* makeReactor({
				registry: new ProviderRegistry([
					makeProvider((input) =>
						input.eventSink
							.push({
								eventId: "accepted-before-bookkeeping",
								type: "run.started",
								providerId: "claude",
								sessionId: input.sessionId,
								runId: input.runId,
								providerRefs: {},
								rawSource: { kind: "test.provider" },
								createdAt: 2,
								data: { inputId: input.inputId, requestedRunId: input.runId },
							})
							.pipe(
								Effect.as<TurnResult>({
									...completedTurn,
									status: "accepted",
									handoff: { included: 1, omitted: 0, tokens: 1 },
								}),
								Effect.mapError(
									(cause) =>
										new ProviderInstanceFailure({
											providerId: "claude",
											operation: "sendTurn",
											cause,
										}),
								),
							),
					),
				]),
			});
			yield* reactor.drain();
			expect(yield* sql`SELECT status FROM provider_runs`).toEqual([
				{ status: "running" },
			]);
			expect(yield* sql`SELECT status FROM provider_command_outbox`).toEqual([
				{ status: "running" },
			]);
			expect(
				yield* sql`SELECT type FROM events WHERE type = 'turn.error'`,
			).toEqual([]);
			const ingestion = yield* ProviderRuntimeIngestionTag;
			yield* ingestion.ingest({
				eventId: "own-native-end",
				type: "turn.completed",
				providerId: "claude",
				sessionId: "session-1",
				runId: "run:cmd-1",
				providerRefs: {},
				rawSource: { kind: "test.provider" },
				createdAt: 3,
				data: { messageId: "" },
			});
			expect(yield* sql`SELECT status FROM provider_command_outbox`).toEqual([
				{ status: "completed" },
			]);
		}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect(
		"preserves the declined delivery code through owned interruption settlement",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedSendTurnOutbox(sql);
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("input.admitted", "session-1", {
						sessionId: "session-1",
						inputId: "queued",
						delivery: "queue",
						request: { text: "next" },
					}),
					canonicalEvent(
						"run.requested",
						"session-1",
						{ runId: "active", inputId: "first" },
						{ createdAt: 100 },
					),
					canonicalEvent(
						"run.started",
						"session-1",
						{ requestedRunId: "active", inputId: "first" },
						{ createdAt: 100, metadata: { runId: "active" } },
					),
				]);

				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([
						makeProvider(() =>
							Effect.succeed<TurnResult>({
								...completedTurn,
								status: "steer-declined",
							}),
						),
					]),
				});
				expect((yield* reactor.runCommand("cmd-1")).status).toBe(
					"steer-declined",
				);
				expect(
					yield* sql`SELECT outbox.status AS outbox_status, outbox.error_code,
				receipt.status AS receipt_status, receipt.error_code AS receipt_error_code
				FROM provider_command_outbox outbox JOIN command_receipts receipt ON receipt.command_id = outbox.command_id`,
				).toEqual([
					{
						outbox_status: "failed",
						error_code: "steer-declined",
						receipt_status: "side_effect_failed",
						receipt_error_code: "steer-declined",
					},
				]);
				const read = yield* ReadQueryEffectTag;
				expect(yield* read.readInboxState("session-1")).toMatchObject({
					paused: false,
				});
				yield* commit([
					canonicalEvent(
						"turn.completed",
						"session-1",
						{ messageId: "" },
						{ provider: "claude", metadata: { runId: "active" } },
					),
				]);
				expect(yield* read.readInboxState("session-1")).toMatchObject({
					paused: false,
				});
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	// Separate sessions must make progress while a turn is held; overlapping
	// drains must neither overtake that session's head nor duplicate any call.
	it.effect(
		"drains sessions concurrently and preserves each session's request order",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const started = yield* Deferred.make<void>();
				const finish = yield* Deferred.make<void>();
				const calls: string[] = [];
				for (const [commandId, requestSequence, sessionId] of [
					["first", 10, "session-a"],
					["second", 20, "session-a"],
					["other", 30, "session-b"],
				] as const) {
					yield* seedSendTurnOutbox(sql, { commandId, requestSequence });
					yield* sql`UPDATE provider_command_outbox SET session_id = ${sessionId},
					payload_json = json_set(payload_json, '$.sessionId', ${sessionId}, '$.prompt', ${commandId})
					WHERE command_id = ${commandId}`;
					yield* sql`INSERT OR IGNORE INTO sessions (id, project_id, provider, created_at, updated_at)
						VALUES (${sessionId}, 'test-project', 'claude', 1, 1)`;
					yield* sql`UPDATE provider_runs SET session_id = ${sessionId} WHERE id = ${`run:${commandId}`}`;
				}
				yield* sql`UPDATE provider_command_outbox SET status = 'retryable_failed',
				attempt_count = 1, next_attempt_at = 1000 WHERE command_id = 'other'`;
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([
						makeProvider((input) =>
							Effect.gen(function* () {
								calls.push(input.prompt);
								if (input.prompt === "first") {
									yield* Deferred.succeed(started, undefined);
									yield* Deferred.await(finish);
								}
								return completedTurn;
							}),
						),
					]),
				});
				const firstDrain = yield* Effect.forkChild(reactor.drain());
				yield* Deferred.await(started);
				yield* TestClock.adjust("1 second");
				yield* Effect.all([reactor.drain(), reactor.drain()]);
				expect(calls).toEqual(["first", "other"]);
				yield* Deferred.succeed(finish, undefined);
				yield* Fiber.join(firstDrain);
				expect(calls).toEqual(["first", "other", "second"]);
				expect(yield* readOutboxRetryState(sql, 30)).toMatchObject({
					status: "completed",
					attempt_count: 2,
				});
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect("does not overtake an earlier retry that is not due", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* seedSendTurnOutbox(sql, {
				commandId: "first",
				requestSequence: 10,
			});
			yield* seedSendTurnOutbox(sql, {
				commandId: "second",
				requestSequence: 20,
			});
			yield* sql`UPDATE provider_command_outbox SET status = 'retryable_failed',
				attempt_count = 1, next_attempt_at = 1000 WHERE command_id = 'first'`;
			const sendTurn = vi.fn((_input: SendTurnInput) =>
				Effect.succeed(completedTurn),
			);
			const reactor = yield* makeReactor({
				registry: new ProviderRegistry([makeProvider(sendTurn)]),
			});
			yield* reactor.drain();
			expect(sendTurn).not.toHaveBeenCalled();
			yield* TestClock.adjust("1 second");
			yield* reactor.drain();
			expect(sendTurn).toHaveBeenCalledTimes(2);
		}).pipe(Effect.provide(reactorTestLayer)),
	);

	// Replay must retain the admitted account snapshot when its old binding no
	// longer resolves, and preparation/receipts must use the resolved account id.
	it.effect(
		"replays the carried account without resolving its historical binding",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const account = {
					id: AccountIdSchema.make("current-account"),
					name: "Current account",
					driver: "claude" as const,
					folder: configuredClaudeConfigDir("/tmp/test-claude-account"),
					usageEligible: true,
				};
				yield* seedSendTurnOutbox(sql, {
					providerId: "removed-account",
					payloadJson: JSON.stringify({
						sessionId: "session-1",
						inputId: "turn-1",
						prompt: "hello",
						providerState: {},
						workspaceRoot: "/tmp/test-project",
						extraFolders: [],
						account,
						instanceId: account.id,
						configDir: account.folder,
						folderSource: "account",
					}),
				});
				const sendTurn = vi.fn((_input: SendTurnInput) =>
					Effect.succeed(completedTurn),
				);
				const accountDirectory = makeAccountDirectory(
					Effect.succeed(
						accountsStateFromInstances(
							[],
							configuredClaudeConfigDir("/tmp/g4zp-test-default"),
						),
					),
				);
				const resolveAccount = vi.spyOn(accountDirectory, "resolve");
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([makeProvider(sendTurn)]),
					accountDirectory,
				});

				yield* reactor.drain();

				expect(sendTurn).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({
						account,
						instanceId: account.id,
						configDir: account.folder,
						folderSource: "account",
					}),
				);
				expect(resolveAccount).not.toHaveBeenCalled();
				expect(
					(yield* sql<{
						provider_id: string;
					}>`SELECT provider_id FROM provider_command_outbox WHERE command_id = 'cmd-1'`)[0]
						?.provider_id,
				).toBe("removed-account");
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect("executes committed side effects once after commit", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const sendTurn = vi.fn((_input: SendTurnInput) =>
				Effect.succeed(completedTurn),
			);
			const getNativeSession = vi.fn((_sessionId: string) =>
				Effect.succeed({
					instanceId: "claude",
					resumeSessionId: "live-interrupted-cursor",
				}),
			);
			yield* seedSendTurnOutbox(sql);
			const reactor = yield* makeReactor({
				registry: new ProviderRegistry([
					{
						...makeProvider(sendTurn),
						getNativeSessionEffect: getNativeSession,
					},
				]),
			});

			expect(sendTurn).not.toHaveBeenCalled();
			yield* reactor.drain();
			yield* reactor.drain();

			expect(sendTurn).toHaveBeenCalledTimes(1);
			expect(getNativeSession).toHaveBeenCalledExactlyOnceWith("session-1");
			expect(sendTurn.mock.calls[0]?.[0]).toMatchObject({
				sessionId: "session-1",
				inputId: "legacy-user-1",
				prompt: "hello",
				workspaceRoot: "/repo",
				resumeSessionId: "live-interrupted-cursor",
				startFreshNativeSession: false,
			});
			expect(
				(yield* sql.unsafe<{ status: string; attempt_count: number }>(
					"SELECT status, attempt_count FROM provider_command_outbox WHERE request_sequence = ?",
					[10],
				))[0],
			).toEqual({ status: "completed", attempt_count: 1 });
			expect(
				(yield* sql.unsafe<{ status: string }>(
					"SELECT status FROM command_receipts WHERE command_id = ?",
					["cmd-1"],
				))[0],
			).toEqual({ status: "side_effect_completed" });
		}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect(
		"routes a durable named-instance command through its driver runtime",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const config: DaemonConfig = {
					pid: 1234,
					port: 2633,
					pinHash: null,
					tls: false,
					debug: false,
					keepAwake: false,
					projects: [],
					instances: [
						{
							id: "work-claude",
							name: "Work Claude",
							port: 0,
							managed: false,
							driver: "claude",
						},
					],
				};
				const sendTurn = vi.fn((_input: SendTurnInput) =>
					Effect.succeed(completedTurn),
				);
				yield* seedSendTurnOutbox(sql, { providerId: "work-claude" });
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([makeProvider(sendTurn)]),
					accountDirectory: makeAccountDirectory(
						Effect.succeed(
							accountsStateFromInstances(
								(config.instances ?? []).map((instance) => ({
									...instance,
									driver: instance.driver ?? "opencode",
								})),
								configuredClaudeConfigDir("/tmp/g4zp-test-default"),
							),
						),
					),
				});

				yield* reactor.drain();

				expect(sendTurn).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect(
		"resumes an old-format durable named-instance turn with its migrated native thread",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const events = yield* EventStoreEffectTag;
				yield* sql`
					INSERT INTO sessions (id, project_id, provider, title, status, created_at, updated_at)
					VALUES ('session-1', 'test-project', 'work-claude', 'Work', 'idle', 1, 1),
						('session-2', 'test-project', 'personal', 'Other', 'idle', 1, 1)`;
				yield* events.appendBatch([
					canonicalEvent("session.created", "session-2", {
						sessionId: "session-2",
						title: "Other",
						provider: "personal",
					}),
					canonicalEvent("session.created", "session-1", {
						sessionId: "session-1",
						title: "Work",
						provider: "work-claude",
					}),
					canonicalEvent("session.renamed", "session-2", {
						sessionId: "session-2",
						title: "Other renamed",
					}),
					canonicalEvent("session.renamed", "session-1", {
						sessionId: "session-1",
						title: "Work renamed",
					}),
				]);
				yield* sql`
					INSERT INTO provider_state (session_id, key, value) VALUES
						('session-1', 'resumeSessionId', 'legacy-work-sdk-session'),
						('session-1', 'claudeConfigDir', '/accounts/work')`;
				yield* seedSendTurnOutbox(sql, { providerId: "work-claude" });
				yield* sql`UPDATE provider_command_outbox SET payload_json = json_set(
					payload_json, '$.providerState', json(${JSON.stringify({
						resumeSessionId: "legacy-work-sdk-session",
						claudeConfigDir: "/accounts/work",
					})})) WHERE command_id = 'cmd-1'`;
				const sendTurn = vi.fn((_input: SendTurnInput) =>
					Effect.succeed(completedTurn),
				);
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([makeProvider(sendTurn)]),
					accountDirectory: makeAccountDirectory(
						Effect.succeed(
							accountsStateFromInstances(
								[
									{
										id: "work-claude",
										name: "Work",
										driver: "claude",
									},
								],
								configuredClaudeConfigDir("/tmp/g4zp-test-default"),
							),
						),
					),
				});

				yield* reactor.drain();

				expect(sendTurn).toHaveBeenCalledOnce();
				expect(sendTurn.mock.calls[0]?.[0]).toMatchObject({
					instanceId: "work-claude",
					nativeThread: {
						configDir: configuredClaudeConfigDir("/accounts/work"),
						resumeSessionId: "legacy-work-sdk-session",
						firstSequence: 2,
						deliveredThrough: 4,
					},
				});
			}).pipe(
				Effect.provide(
					Layer.provideMerge(
						makeProviderRuntimeIngestionLive(),
						makePersistenceEffectLayer(":memory:", "test-project"),
					),
				),
			),
	);

	it.effect("hands provider output to provider runtime ingestion", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const runtimeEvent = decodeProviderRuntimeEvent({
				eventId: "runtime-text-1",
				type: "text.delta",
				providerId: "claude",
				sessionId: "session-1",
				turnId: "turn-1",
				providerRefs: {},
				rawSource: { kind: "test.provider-runtime" },
				createdAt: 1000,
				data: {
					messageId: "message-1",
					partId: "text-1",
					text: "streamed",
				},
			});
			const ingest = vi.fn((_event: ProviderRuntimeEvent) => Effect.succeed(1));
			const sendTurn = vi.fn(
				(
					input: SendTurnInput,
				): Effect.Effect<TurnResult, ProviderInstanceFailure> =>
					input.eventSink.push(runtimeEvent).pipe(
						Effect.as(completedTurn),
						Effect.mapError(
							(cause) =>
								new ProviderInstanceFailure({
									providerId: "claude",
									operation: "sendTurn",
									cause,
								}),
						),
					),
			);
			yield* seedSendTurnOutbox(sql);
			const reactor = yield* makeReactor({
				registry: new ProviderRegistry([makeProvider(sendTurn)]),
				observe: ingest,
			});

			yield* reactor.drain();

			expect(ingest).toHaveBeenCalledWith(runtimeEvent);
		}).pipe(Effect.provide(reactorTestLayer)),
	);

	// Regression: streamed provider output must mark the session as alive on the
	// same-process dispatch path. The reactor sink used to push straight to
	// ingestion, so the relay's 120s processing timeout was only ever reset by a
	// permission request — any longer Claude turn without one emitted a false
	// "No response received" PROCESSING_TIMEOUT error mid-turn.
	it.effect("notes relay activity for streamed provider output", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const runtimeEvent = decodeProviderRuntimeEvent({
				eventId: "runtime-text-2",
				type: "text.delta",
				providerId: "claude",
				sessionId: "session-1",
				turnId: "turn-1",
				providerRefs: {},
				rawSource: { kind: "test.provider-runtime" },
				createdAt: 1000,
				data: { messageId: "message-1", partId: "text-1", text: "streamed" },
			});
			const interactions = {
				push: vi.fn(() => Effect.void),
				requestPermission: vi.fn(() =>
					Effect.succeed<PermissionResponse>({ decision: "once" }),
				),
				requestQuestion: vi.fn(() => Effect.succeed({})),
				resolvePermission: vi.fn(() => Effect.void),
				resolveQuestion: vi.fn(() => Effect.void),
				noteActivity: vi.fn(),
			} satisfies EventSink & {
				noteActivity: (event: ProviderRuntimeEvent) => void;
			};
			const sendTurn = vi.fn(
				(
					input: SendTurnInput,
				): Effect.Effect<TurnResult, ProviderInstanceFailure> =>
					input.eventSink.push(runtimeEvent).pipe(
						Effect.as(completedTurn),
						Effect.mapError(
							(cause) =>
								new ProviderInstanceFailure({
									providerId: "claude",
									operation: "sendTurn",
									cause,
								}),
						),
					),
			);
			const ingest = vi.fn((_event: ProviderRuntimeEvent) => Effect.succeed(1));
			yield* seedSendTurnOutbox(sql);
			const reactor = yield* makeReactor({
				registry: new ProviderRegistry([makeProvider(sendTurn)]),
				observe: ingest,
			});

			yield* reactor.runCommand("cmd-1", interactions);

			expect(interactions.noteActivity).toHaveBeenCalledWith(runtimeEvent);
			// Output still streams only through the durable ingestion seam.
			expect(ingest).toHaveBeenCalledWith(runtimeEvent);
			expect(interactions.push).not.toHaveBeenCalled();
		}).pipe(Effect.provide(reactorTestLayer)),
	);

	// A direct waiter must not bypass backoff, and a failed claim must escape
	// the drain so its scheduler can log and delay instead of hot-looping.
	it.effect("does not let runCommand claim a retry before its deadline", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* seedSendTurnOutbox(sql);
			yield* sql`UPDATE provider_command_outbox SET status = 'retryable_failed',
				attempt_count = 1, next_attempt_at = 1000`;
			const sendTurn = vi.fn((_input: SendTurnInput) =>
				Effect.succeed(completedTurn),
			);
			const reactor = yield* makeReactor({
				registry: new ProviderRegistry([makeProvider(sendTurn)]),
				outcomePollTimeout: 0,
			});
			const result = yield* Effect.result(reactor.runCommand("cmd-1"));
			expect(result._tag).toBe("Failure");
			expect(sendTurn).not.toHaveBeenCalled();
			expect(yield* readOutboxRetryState(sql, 10)).toMatchObject({
				status: "retryable_failed",
				attempt_count: 1,
				next_attempt_at: 1000,
			});
		}).pipe(Effect.provide(reactorTestLayer)),
	);

	// Intake belongs to the provider: several foreground steer calls can be
	// pending together before any of them acknowledges delivery.
	it.live(
		"dispatches back-to-back foreground steers before the provider accepts either",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				for (const [commandId, requestSequence] of [
					["old", 10],
					["first-steer", 20],
					["second-steer", 30],
				] as const)
					yield* seedSendTurnOutbox(sql, { commandId, requestSequence });
				yield* sql`UPDATE provider_command_outbox SET payload_json = json_set(payload_json, '$.inputId', command_id)`;
				yield* sql`UPDATE provider_command_outbox SET status = 'running' WHERE command_id = 'old'`;
				const release = yield* Deferred.make<void>();
				const sendTurn = vi.fn((_input: SendTurnInput) =>
					Deferred.await(release).pipe(Effect.as(completedTurn)),
				);
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([makeProvider(sendTurn)]),
					outcomePollInterval: "1 millis",
					outcomePollTimeout: "1 second",
				});
				const calls = yield* Effect.forEach(
					["first-steer", "second-steer"],
					(commandId) =>
						Effect.forkChild(
							Effect.result(
								reactor.withLiveCommand(
									commandId,
									reactor.runCommand(commandId),
								),
							),
						),
				);
				yield* Effect.promise(() =>
					vi.waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2)),
				);
				expect(sendTurn).toHaveBeenCalledTimes(2);
				expect(sendTurn.mock.calls.map(([input]) => input.inputId)).toEqual([
					"first-steer",
					"second-steer",
				]);
				expect(
					yield* sql`SELECT status, attempt_count FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual([
					{ status: "running", attempt_count: 0 },
					{ status: "running", attempt_count: 1 },
					{ status: "running", attempt_count: 1 },
				]);
				yield* Deferred.succeed(release, undefined);
				for (const call of calls)
					expect((yield* Fiber.join(call))._tag).toBe("Success");
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect(
		"keeps the background drain out of a live caller's pending command",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedSendTurnOutbox(sql);
				const held = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const sendTurn = vi.fn((_input: SendTurnInput) =>
					Effect.succeed(completedTurn),
				);
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([makeProvider(sendTurn)]),
				});
				const owner = yield* Effect.forkChild(
					reactor.withLiveCommand(
						"cmd-1",
						Deferred.succeed(held, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
					),
				);
				yield* Deferred.await(held);
				expect(yield* reactor.runOnce()).toBe(0);
				expect(sendTurn).not.toHaveBeenCalled();
				expect(yield* readOutboxRetryState(sql, 10)).toMatchObject({
					status: "pending",
					attempt_count: 0,
				});
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(owner);
				expect(yield* reactor.runOnce()).toBe(1);
				expect(sendTurn).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect("surfaces a store failure while claiming an outbox row", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* seedSendTurnOutbox(sql);
			yield* sql.unsafe(`CREATE TRIGGER fail_claim BEFORE UPDATE OF status
				ON provider_command_outbox WHEN NEW.status = 'running'
				BEGIN SELECT RAISE(FAIL, 'claim failed'); END`);
			const sendTurn = vi.fn((_input: SendTurnInput) =>
				Effect.succeed(completedTurn),
			);
			const reactor = yield* makeReactor({
				registry: new ProviderRegistry([makeProvider(sendTurn)]),
			});
			const result = yield* Effect.result(reactor.runOnce());
			expect(result).toMatchObject({
				_tag: "Failure",
				failure: {
					_tag: "ProviderCommandStoreFailure",
					operation: "markRunning",
				},
			});
			expect(sendTurn).not.toHaveBeenCalled();
		}).pipe(Effect.provide(reactorTestLayer)),
	);

	// A retry must not reuse the ended reservation, lose busy, keep the turn on
	// its first owner, or let a duplicate first end settle the second attempt.
	for (const providerId of ["cursor", "claude"]) {
		it.effect(
			`keeps the second ${providerId} attempt owned until its own end`,
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const firstEnded = yield* Deferred.make<void>();
					const rejectFirst = yield* Deferred.make<void>();
					const started = yield* Deferred.make<void>();
					const finish = yield* Deferred.make<void>();
					const runs: string[] = [];
					const provider = makeProvider(
						(input) =>
							Effect.gen(function* () {
								const runId = input.runId;
								if (!runId) return yield* Effect.die("Missing attempt run id");
								runs.push(runId);
								const emit = (
									type: ProviderRuntimeEvent["type"],
									data: Record<string, unknown>,
								) =>
									input.eventSink.push(
										decodeProviderRuntimeEvent({
											eventId: `${runId}:${type}`,
											type,
											providerId,
											sessionId: input.sessionId,
											runId,
											providerRefs: {},
											rawSource: { kind: "test.provider" },
											createdAt: 10,
											data,
										}),
									);
								yield* emit("message.created", {
									messageId: "legacy-user-1",
									inputId: input.inputId,
									role: "user",
									text: input.prompt,
								});
								yield* emit("run.started", {
									inputId: input.inputId,
									requestedRunId: runId,
								});
								if (runs.length === 1) {
									yield* emit("turn.error", {
										messageId: "",
										error: "rate limit",
										code: "rate_limit",
										retryable: true,
									});
									yield* Deferred.succeed(firstEnded, undefined);
									yield* Deferred.await(rejectFirst);
									return yield* Effect.fail(
										new ProviderInstanceFailure({
											providerId,
											operation: "sendTurn",
											cause: { code: "rate_limit", retryable: true },
										}),
									);
								}
								yield* Deferred.succeed(started, undefined);
								yield* Deferred.await(finish);
								return completedTurn;
							}).pipe(
								Effect.mapError((cause) =>
									cause instanceof ProviderInstanceFailure
										? cause
										: new ProviderInstanceFailure({
												providerId,
												operation: "sendTurn",
												cause,
											}),
								),
							),
						providerId,
					);
					yield* seedSendTurnOutbox(sql, { providerId });
					const reactor = yield* makeReactor({
						registry: new ProviderRegistry([provider]),
					});
					const firstDrain = yield* Effect.forkChild(reactor.runOnce());
					yield* Deferred.await(firstEnded);
					expect(yield* readOutboxRetryState(sql, 10)).toMatchObject({
						status: "retryable_failed",
						attempt_count: 1,
					});
					yield* TestClock.adjust("2 seconds");
					const otherExecutor = yield* makeReactor({
						registry: new ProviderRegistry([provider]),
					});
					const retry = yield* Effect.forkChild(otherExecutor.drain());
					yield* Effect.promise(() =>
						vi.waitFor(() => expect(runs).toHaveLength(2)),
					);
					expect(runs[1]).not.toBe(runs[0]);
					yield* Deferred.await(started);
					expect(
						yield* sql`SELECT status, error_code FROM command_receipts WHERE command_id = 'cmd-1'`,
					).toEqual([{ status: "side_effect_requested", error_code: null }]);
					expect(
						yield* sql`SELECT run_id FROM provider_command_outbox WHERE request_sequence = 10`,
					).toEqual([{ run_id: runs[1] }]);
					expect(
						yield* sql`SELECT status FROM provider_runs WHERE id = ${runs[0]}`,
					).toEqual([{ status: "error" }]);
					expect(
						yield* sql`SELECT state, run_id FROM turns WHERE user_message_id = 'legacy-user-1'`,
					).toEqual([{ state: "running", run_id: runs[1] }]);
					expect(
						yield* sql`SELECT status FROM provider_runs WHERE id = ${runs[1]}`,
					).toEqual([{ status: "running" }]);
					yield* (yield* ProviderRuntimeIngestionTag).ingest(
						decodeProviderRuntimeEvent({
							eventId: "late-first-end",
							type: "turn.completed",
							providerId,
							sessionId: "session-1",
							runId: runs[0],
							providerRefs: {},
							rawSource: { kind: "test.provider" },
							createdAt: 20,
							data: { messageId: "" },
						}),
					);
					expect(yield* readOutboxRetryState(sql, 10)).toMatchObject({
						status: "running",
						attempt_count: 2,
					});
					yield* Deferred.succeed(rejectFirst, undefined);
					yield* Fiber.join(firstDrain);
					expect(yield* readOutboxRetryState(sql, 10)).toMatchObject({
						status: "running",
						attempt_count: 2,
					});
					yield* Deferred.succeed(finish, undefined);
					yield* Fiber.join(retry);
					expect(yield* readOutboxRetryState(sql, 10)).toMatchObject({
						status: "completed",
						attempt_count: 2,
					});
					expect(
						yield* sql`SELECT state, run_id FROM turns WHERE user_message_id = 'legacy-user-1'`,
					).toEqual([{ state: "completed", run_id: runs[1] }]);
					retryCases.push({
						case: `${providerId}-two-attempts`,
						outcome: "passed",
					});
					mkdirSync("test-results", { recursive: true });
					writeFileSync(
						"test-results/82tn24-stage2-retries.json",
						`${JSON.stringify({ cases: retryCases }, null, 2)}\n`,
					);
				}).pipe(Effect.provide(reactorTestLayer)),
		);
	}

	it.effect(
		"keeps non-send retry backoff tied to the claimed attempt count",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedSendTurnOutbox(sql);
				yield* sql`UPDATE provider_command_outbox SET effect_type = 'interrupt_turn'`;
				const provider = makeProvider(() => Effect.succeed(completedTurn));
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([
						{
							...provider,
							interruptTurnEffect: () =>
								Effect.fail(
									new ProviderInstanceFailure({
										providerId: "claude",
										operation: "interruptTurn",
										cause: { code: "rate_limit", retryable: true },
									}),
								),
						},
					]),
					retryBackoff: (attempt) => Duration.millis(100 * 2 ** (attempt - 1)),
				});
				yield* reactor.drain();
				expect(yield* readOutboxRetryState(sql, 10)).toEqual({
					status: "retryable_failed",
					attempt_count: 1,
					error_code: "rate_limit",
					next_attempt_at: 100,
				});
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect("backs off retryable provider failures without hot looping", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			let providerCalls = 0;
			const sendTurn = vi.fn(
				(
					_input: SendTurnInput,
				): Effect.Effect<TurnResult, ProviderInstanceFailure> =>
					Effect.suspend(() => {
						providerCalls += 1;
						if (providerCalls === 5) return Effect.succeed(completedTurn);
						return Effect.fail(
							new ProviderInstanceFailure({
								providerId: "claude",
								operation: "sendTurn",
								cause: { code: "rate_limit", retryable: true },
							}),
						);
					}),
			);
			yield* seedSendTurnOutbox(sql);
			const reactor = yield* makeReactor({
				registry: new ProviderRegistry([makeProvider(sendTurn)]),
				retryBackoff: (failureCount) =>
					Duration.millis(Math.min(100 * 2 ** (failureCount - 1), 400)),
			});

			yield* reactor.drain();
			yield* reactor.drain();

			expect(sendTurn).toHaveBeenCalledTimes(1);
			expect(yield* readOutboxRetryState(sql, 10)).toEqual({
				status: "retryable_failed",
				attempt_count: 1,
				error_code: "rate_limit",
				next_attempt_at: 100,
			});

			yield* TestClock.adjust("99 millis");
			yield* reactor.drain();
			expect(sendTurn).toHaveBeenCalledTimes(1);

			yield* TestClock.adjust("1 millis");
			yield* reactor.drain();
			expect(sendTurn).toHaveBeenCalledTimes(2);
			expect(yield* readOutboxRetryState(sql, 10)).toMatchObject({
				attempt_count: 2,
				next_attempt_at: 300,
			});

			yield* TestClock.adjust("200 millis");
			yield* reactor.drain();
			expect(sendTurn).toHaveBeenCalledTimes(3);
			expect(yield* readOutboxRetryState(sql, 10)).toMatchObject({
				attempt_count: 3,
				next_attempt_at: 700,
			});

			yield* TestClock.adjust("400 millis");
			yield* reactor.drain();
			expect(sendTurn).toHaveBeenCalledTimes(4);
			expect(yield* readOutboxRetryState(sql, 10)).toMatchObject({
				attempt_count: 4,
				next_attempt_at: 1100,
			});

			yield* TestClock.adjust("400 millis");
			yield* reactor.drain();
			expect(sendTurn).toHaveBeenCalledTimes(5);
			expect(yield* readOutboxRetryState(sql, 10)).toMatchObject({
				status: "completed",
				attempt_count: 5,
			});

			yield* seedSendTurnOutbox(sql, {
				commandId: "cmd-2",
				requestSequence: 20,
			});
			yield* reactor.drain();

			expect(sendTurn).toHaveBeenCalledTimes(6);
			expect(yield* readOutboxRetryState(sql, 20)).toMatchObject({
				status: "retryable_failed",
				attempt_count: 1,
				next_attempt_at: 1200,
			});
		}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect(
		"does not run the provider when the exclusive markRunning claim is lost (finding #1)",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const sendTurn = vi.fn((_input: SendTurnInput) =>
					Effect.succeed(completedTurn),
				);
				yield* seedSendTurnOutbox(sql);
				// Simulate a concurrent executor that already claimed the row and
				// completed the command between this fiber's SELECT and markRunning.
				yield* sql.unsafe(
					"UPDATE provider_command_outbox SET status = 'running' WHERE request_sequence = ?",
					[10],
				);
				yield* sql.unsafe(
					"UPDATE command_receipts SET status = 'side_effect_completed' WHERE command_id = ?",
					["cmd-1"],
				);
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([makeProvider(sendTurn)]),
				});

				// The row this fiber selected while it was still pending.
				const row = {
					request_sequence: 10,
					command_id: "cmd-1",
					project_key: "test-project",
					session_id: "session-1",
					provider_id: "claude",
					effect_type: "send_turn",
					payload_json: JSON.stringify({
						sessionId: "session-1",
						turnId: "turn-1",
						prompt: "hello",
						history: [],
						providerState: {},
						workspaceRoot: "/repo",
						extraFolders: [],
						configDir: configuredClaudeConfigDir("/tmp/g4zp-test-claude"),
						folderSource: "account",
					}),
					attempt_count: 0,
				};
				const result = yield* (
					reactor as unknown as {
						executeRow(r: typeof row): Effect.Effect<TurnResult, unknown>;
					}
				).executeRow(row);

				expect(sendTurn).not.toHaveBeenCalled();
				expect(result.status).toBe("completed");
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect(
		"claim loser blocks while the winner runs, then resolves with the winner's completed outcome",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedSendTurnOutbox(sql);
				yield* sql.unsafe(
					"UPDATE provider_command_outbox SET status = 'running' WHERE request_sequence = ?",
					[10],
				);
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry(),
					outcomePollInterval: "100 millis",
					outcomePollTimeout: "500 millis",
				});

				const loser = yield* Effect.forkChild(reactor.runCommand("cmd-1"));
				yield* Effect.yieldNow;
				expect(
					Option.isNone(
						yield* Effect.sync(() =>
							Option.fromUndefinedOr(loser.pollUnsafe()),
						),
					),
				).toBe(true);

				yield* TestClock.adjust("100 millis");
				expect(
					Option.isNone(
						yield* Effect.sync(() =>
							Option.fromUndefinedOr(loser.pollUnsafe()),
						),
					),
				).toBe(true);

				yield* sql.unsafe(
					"UPDATE command_receipts SET status = 'side_effect_completed' WHERE command_id = ?",
					["cmd-1"],
				);
				yield* TestClock.adjust("100 millis");

				const result = yield* Fiber.join(loser);
				expect(result).toEqual({
					status: "completed",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				});
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect(
		"claim loser acknowledges the winner's failed durable outcome",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry(),
					outcomePollInterval: "100 millis",
					outcomePollTimeout: "100 millis",
				});
				const terminalOutboxStates = ["failed", "retryable_failed"] as const;

				for (const [index, outboxStatus] of terminalOutboxStates.entries()) {
					const commandId = `cmd-${index + 1}`;
					const requestSequence = (index + 1) * 10;
					const errorCode = `winner_${outboxStatus}`;
					yield* seedSendTurnOutbox(sql, { commandId, requestSequence });
					yield* sql.unsafe(
						"UPDATE provider_command_outbox SET status = 'running' WHERE request_sequence = ?",
						[requestSequence],
					);

					const loser = yield* Effect.forkChild(reactor.runCommand(commandId));
					yield* Effect.yieldNow;
					expect(
						Option.isNone(
							yield* Effect.sync(() =>
								Option.fromUndefinedOr(loser.pollUnsafe()),
							),
						),
					).toBe(true);

					yield* sql.withTransaction(
						Effect.all([
							sql.unsafe(
								"UPDATE provider_command_outbox SET status = ?, error_code = ? WHERE request_sequence = ?",
								[outboxStatus, errorCode, requestSequence],
							),
							sql.unsafe(
								"UPDATE command_receipts SET status = 'side_effect_failed', error_code = ? WHERE command_id = ?",
								[errorCode, commandId],
							),
						]),
					);
					yield* TestClock.adjust("100 millis");

					expect(yield* Fiber.join(loser)).toMatchObject({
						status: "error",
						error: { code: errorCode },
					});
				}
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect(
		"claim loser fails with ProviderCommandNotExecutable when the poll cap expires",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedSendTurnOutbox(sql);
				yield* sql.unsafe(
					"UPDATE provider_command_outbox SET status = 'running' WHERE request_sequence = ?",
					[10],
				);
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry(),
					outcomePollInterval: "100 millis",
					outcomePollTimeout: "250 millis",
				});
				const missingReceiptError = yield* Effect.flip(
					reactor.runCommand("missing-command"),
				);
				expect(missingReceiptError).toMatchObject({
					_tag: "ProviderCommandNotExecutable",
					commandId: "missing-command",
					errorCode: null,
				});

				const loser = yield* Effect.forkChild(reactor.runCommand("cmd-1"));
				yield* Effect.yieldNow;
				yield* TestClock.adjust("200 millis");
				expect(
					Option.isNone(
						yield* Effect.sync(() =>
							Option.fromUndefinedOr(loser.pollUnsafe()),
						),
					),
				).toBe(true);

				yield* TestClock.adjust("100 millis");
				const error = yield* Effect.flip(Fiber.join(loser));
				expect(error).toMatchObject({
					_tag: "ProviderCommandNotExecutable",
					commandId: "cmd-1",
					errorCode: null,
				});
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect(
		"clamps a zero outcome poll interval so poll cap expiry remains bounded",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedSendTurnOutbox(sql);
				yield* sql.unsafe(
					"UPDATE provider_command_outbox SET status = 'running' WHERE request_sequence = ?",
					[10],
				);
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry(),
					outcomePollInterval: 0,
					outcomePollTimeout: "100 millis",
				});

				const loser = yield* Effect.forkChild(reactor.runCommand("cmd-1"));
				yield* Effect.yieldNow;
				expect(
					Option.isNone(
						yield* Effect.sync(() =>
							Option.fromUndefinedOr(loser.pollUnsafe()),
						),
					),
				).toBe(true);

				yield* TestClock.adjust("100 millis");
				const error = yield* Effect.flip(Fiber.join(loser));
				expect(error).toMatchObject({
					_tag: "ProviderCommandNotExecutable",
					commandId: "cmd-1",
					errorCode: null,
				});
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect(
		"two executors racing one row: the loser awaits the winner rather than throwing",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const winnerStarted = yield* Deferred.make<void>();
				const releaseWinner = yield* Deferred.make<void>();
				const sendTurn = vi.fn((_input: SendTurnInput) =>
					Effect.gen(function* () {
						yield* Deferred.succeed(winnerStarted, undefined);
						yield* Deferred.await(releaseWinner);
						return completedTurn;
					}),
				);
				yield* seedSendTurnOutbox(sql);
				const registry = new ProviderRegistry([makeProvider(sendTurn)]);
				const winnerReactor = yield* makeReactor({
					registry,
					outcomePollInterval: "100 millis",
					outcomePollTimeout: "500 millis",
				});
				const loserReactor = yield* makeReactor({
					registry,
					outcomePollInterval: "100 millis",
					outcomePollTimeout: "500 millis",
				});

				const winner = yield* Effect.forkChild(
					winnerReactor.runCommand("cmd-1"),
				);
				yield* Deferred.await(winnerStarted);
				const loser = yield* Effect.forkChild(loserReactor.runCommand("cmd-1"));
				yield* Effect.yieldNow;

				expect(
					Option.isNone(
						yield* Effect.sync(() =>
							Option.fromUndefinedOr(loser.pollUnsafe()),
						),
					),
				).toBe(true);
				yield* Deferred.succeed(releaseWinner, undefined);
				expect((yield* Fiber.join(winner)).status).toBe("completed");
				expect(
					Option.isNone(
						yield* Effect.sync(() =>
							Option.fromUndefinedOr(loser.pollUnsafe()),
						),
					),
				).toBe(true);

				yield* TestClock.adjust("100 millis");
				expect((yield* Fiber.join(loser)).status).toBe("completed");
				expect(sendTurn).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	// Terminal append, run projection, and receipt writes can each fail. A failed
	// transaction must retain the running claim for recovery, with no half-ended run.
	for (const failureAt of [
		"terminal",
		"projection",
		"receipt",
		"none",
	] as const) {
		it.effect(`settles a failed run atomically when ${failureAt} fails`, () =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedSendTurnOutbox(sql, { runId: "reserved-run" });
				yield* sql`INSERT OR IGNORE INTO sessions (id, project_id, provider, created_at, updated_at)
					VALUES ('session-1', 'test-project', 'claude', 1, 1)`;
				yield* sql`UPDATE provider_command_outbox SET payload_json = json_set(payload_json, '$.runId', 'reserved-run')`;

				if (failureAt === "terminal")
					yield* sql`CREATE TRIGGER fail_terminal BEFORE INSERT ON events
						WHEN NEW.type = 'turn.error' BEGIN SELECT RAISE(ABORT, 'terminal failed'); END`;
				if (failureAt === "projection")
					yield* sql`CREATE TRIGGER fail_projection BEFORE UPDATE OF status ON provider_runs
						WHEN NEW.status = 'error' BEGIN SELECT RAISE(ABORT, 'projection failed'); END`;
				if (failureAt === "receipt")
					yield* sql`CREATE TRIGGER fail_receipt BEFORE UPDATE OF status ON command_receipts
						WHEN NEW.status = 'side_effect_failed' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END`;
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry(),
				});
				const result = yield* Effect.result(reactor.runOnce());
				const committed = failureAt === "none";
				expect(result._tag).toBe(committed ? "Success" : "Failure");
				expect(yield* sql`SELECT status FROM provider_command_outbox`).toEqual([
					{ status: committed ? "failed" : "running" },
				]);
				expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
					{
						status: committed ? "side_effect_failed" : "side_effect_requested",
					},
				]);
				expect(yield* sql`SELECT status FROM provider_runs`).toEqual([
					{ status: committed ? "error" : "pending" },
				]);
				expect(
					yield* sql`SELECT json_extract(metadata, '$.runId') AS run_id FROM events WHERE type = 'turn.error'`,
				).toEqual(committed ? [{ run_id: "reserved-run" }] : []);
			}).pipe(
				Effect.provide(
					Layer.provideMerge(
						makeProviderRuntimeIngestionLive(),
						makePersistenceEffectLayer(":memory:", "test-project"),
					),
				),
			),
		);
	}

	it.effect(
		"marks provider lookup failures instead of leaving outbox rows running",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seedSendTurnOutbox(sql, { runId: "reserved-run" });

				const ingest = vi.fn(() => Effect.succeed(1));
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry(),
					observe: ingest,
				});

				yield* reactor.runOnce();

				expect(
					(yield* sql.unsafe<{
						status: string;
						attempt_count: number;
						error_code: string | null;
					}>(
						`SELECT status, attempt_count, error_code
				 FROM provider_command_outbox WHERE request_sequence = ?`,
						[10],
					))[0],
				).toEqual({
					status: "failed",
					attempt_count: 1,
					error_code: "provider_not_registered",
				});
				expect(ingest).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "turn.error",
						runId: "reserved-run",
						sessionId: "session-1",
						data: expect.objectContaining({ code: "provider_not_registered" }),
					}),
				);
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect(
		"settles malformed outbox payloads through the owned failure receipt",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const sendTurn = vi.fn((_input: SendTurnInput) =>
					Effect.succeed(completedTurn),
				);
				yield* seedSendTurnOutbox(sql, { payloadJson: "{not json" });
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([makeProvider(sendTurn)]),
				});

				expect(yield* reactor.runCommand("cmd-1")).toMatchObject({
					status: "error",
					error: { code: "provider_command_payload_parse_failed" },
				});

				expect(sendTurn).not.toHaveBeenCalled();
				expect(
					(yield* sql.unsafe<{ status: string; error_code: string | null }>(
						`SELECT status, error_code
				 FROM provider_command_outbox WHERE request_sequence = ?`,
						[10],
					))[0],
				).toEqual({
					status: "failed",
					error_code: "provider_command_payload_parse_failed",
				});
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect(
		"marks structurally invalid outbox payloads as typed failures",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const sendTurn = vi.fn((_input: SendTurnInput) =>
					Effect.succeed(completedTurn),
				);
				yield* seedSendTurnOutbox(sql, {
					payloadJson: JSON.stringify({ sessionId: "session-1" }),
				});
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([makeProvider(sendTurn)]),
				});

				yield* reactor.runOnce();

				expect(sendTurn).not.toHaveBeenCalled();
				expect(
					(yield* sql.unsafe<{ status: string; error_code: string | null }>(
						`SELECT status, error_code
				 FROM provider_command_outbox WHERE request_sequence = ?`,
						[10],
					))[0],
				).toEqual({
					status: "failed",
					error_code: "provider_command_payload_parse_failed",
				});
			}).pipe(Effect.provide(reactorTestLayer)),
	);

	it.effect(
		"returns typed unsupported interaction failures from the reactor event sink",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const sendTurn = vi.fn((input: SendTurnInput) =>
					input.eventSink
						.requestPermission({
							requestId: "req-1",
							toolName: "Bash",
							toolInput: { command: "whoami" },
							sessionId: "session-1",
							turnId: "turn-1",
							providerItemId: "tool-1",
						})
						.pipe(
							Effect.as(completedTurn),
							Effect.mapError(
								(cause) =>
									new ProviderInstanceFailure({
										providerId: "claude",
										operation: "sendTurn",
										cause,
									}),
							),
						),
				);
				yield* seedSendTurnOutbox(sql);
				const reactor = yield* makeReactor({
					registry: new ProviderRegistry([makeProvider(sendTurn)]),
				});

				yield* reactor.runOnce();

				expect(
					(yield* sql.unsafe<{ status: string; error_code: string | null }>(
						`SELECT status, error_code
				 FROM provider_command_outbox WHERE request_sequence = ?`,
						[10],
					))[0],
				).toEqual({
					status: "failed",
					error_code: "provider_side_effect_interaction_unsupported",
				});
			}).pipe(Effect.provide(reactorTestLayer)),
	);
});

const reactorTestLayer = Layer.provideMerge(
	makeProviderRuntimeIngestionLive(),
	makePersistenceEffectLayer(":memory:", "test-project"),
);

function makeReactor({
	observe,
	...options
}: Omit<
	ProviderSideEffectReactorOptions,
	"projectId" | "sql" | "ingestion" | "write"
> & {
	readonly observe?: ProviderRuntimeIngestion["ingest"];
}) {
	return Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const actual = yield* ProviderRuntimeIngestionTag;
		return new ProviderSideEffectReactor({
			projectId: "test-project",
			sql,
			write: (yield* makeCommitAndSignal).write,
			...options,
			ingestion: {
				ingest: (event) =>
					(observe?.(event) ?? Effect.void).pipe(
						Effect.andThen(actual.ingest(event)),
					),
				ingestBatch: actual.ingestBatch,
			},
		});
	});
}

function seedSendTurnOutbox(
	sql: SqlClient.SqlClient,
	options: {
		readonly commandId?: string;
		readonly payloadJson?: string;
		readonly providerId?: string;
		readonly requestSequence?: number;
		readonly runId?: string;
	} = {},
) {
	const commandId = options.commandId ?? "cmd-1";
	const requestSequence = options.requestSequence ?? 10;
	const runId = options.runId ?? `run:${commandId}`;
	return Effect.all([
		sql`INSERT OR IGNORE INTO sessions (id, project_id, provider, created_at, updated_at)
			VALUES ('session-1', 'test-project', ${options.providerId ?? "claude"}, 1, 1)`,
		sql`INSERT INTO provider_runs (id, session_id, status, requested_at) VALUES (${runId}, 'session-1', 'pending', 1000)`,
		sql.unsafe(
			`INSERT INTO command_receipts (
			command_id, session_id, status, created_at, command_type, project_key,
			fingerprint_hash, fingerprint_version, side_effect_sequence, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				commandId,
				"session-1",
				"side_effect_requested",
				1000,
				"send_turn",
				"test-project",
				"sha256:abc",
				1,
				requestSequence,
				1000,
			],
		),
		sql.unsafe(
			`INSERT INTO provider_command_outbox (
			request_sequence, command_id, project_key, session_id, provider_id,
			effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
			[
				requestSequence,
				commandId,
				"test-project",
				"session-1",
				options.providerId ?? "claude",
				"send_turn",
				options.payloadJson === undefined
					? JSON.stringify({
							runId,
							sessionId: "session-1",
							turnId: "turn-1",
							userMessageId: "legacy-user-1",
							prompt: "hello",
							history: [],
							providerState: {},
							workspaceRoot: "/repo",
							extraFolders: [],
							configDir: configuredClaudeConfigDir("/tmp/g4zp-test-claude"),
							folderSource: "account",
						})
					: (() => {
							try {
								return JSON.stringify({
									...JSON.parse(options.payloadJson),
									runId,
								});
							} catch {
								return options.payloadJson;
							}
						})(),
				runId,
				1000,
				1000,
			],
		),
	]);
}

function readOutboxRetryState(
	sql: SqlClient.SqlClient,
	requestSequence: number,
) {
	return sql
		.unsafe<{
			status: string;
			attempt_count: number;
			error_code: string | null;
			next_attempt_at: number | null;
		}>(
			`SELECT status, attempt_count, error_code, next_attempt_at
		 FROM provider_command_outbox WHERE request_sequence = ?`,
			[requestSequence],
		)
		.pipe(Effect.map((rows) => rows[0]));
}
