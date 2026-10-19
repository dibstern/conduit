// A session terminal describes provider execution, not an unaccepted command
// reservation. Even a completed command can still be awaiting its user echo.
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { makeEffectOpenCodeRuntimeIngress } from "../../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import { ProviderRuntimeIngestionLive } from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { createSilentLogger } from "../../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { openCodeInputMessageId } from "../../../../src/lib/provider/opencode/opencode-input-message-id.js";
import { makeSSEEvent } from "../../../helpers/sse-factories.js";

for (const signal of ["idle", "error", "stop"] as const) {
	for (const commandStatus of [
		"pending",
		"retryable_failed",
		"running",
		"completed",
	] as const) {
		it.effect(
			`${signal} preserves an unaccepted ${commandStatus} reservation until its own intake and terminal`,
			() => {
				const persistence = makePersistenceEffectLayer(
					":memory:",
					"test-project",
				);
				return Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const ingress = yield* makeEffectOpenCodeRuntimeIngress(
						createSilentLogger(),
					);
					const commit = yield* makeCommitAndSignal;
					const messageB = openCodeInputMessageId("input-b");
					yield* commit([
						canonicalEvent("session.created", "s", {
							sessionId: "s",
							provider: "opencode",
							title: "Future reservation",
						}),
						canonicalEvent("message.created", "s", {
							messageId: "input-a",
							sessionId: "s",
							role: "user",
							inputId: "input-a",
						}),
						canonicalEvent(
							"run.started",
							"s",
							{ inputId: "input-a", requestedRunId: "run-a" },
							{ metadata: { runId: "run-a" } },
						),
						canonicalEvent("input.sent", "s", {
							sessionId: "s",
							inputId: "input-b",
						}),
						canonicalEvent("message.created", "s", {
							messageId: messageB,
							sessionId: "s",
							role: "user",
							inputId: "input-b",
						}),
						canonicalEvent(
							"run.requested",
							"s",
							{ runId: "run-b", inputId: "input-b" },
							{ metadata: { runId: "run-b" } },
						),
					]);
					yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id,
					provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at)
					VALUES (1, 'input-b', 'test-project', 's', 'opencode', 'send_turn',
					'{"inputId":"input-b","runId":"run-b"}', ${commandStatus}, 1, 1, 1)`;
					if (signal === "stop")
						yield* ingress.onInstanceStopped("opencode", () => true);
					else
						yield* ingress.onSSEEventEffect(
							signal === "idle"
								? makeSSEEvent("session.status", {
										sessionID: "s",
										status: { type: "idle" },
									})
								: makeSSEEvent("session.error", {
										sessionID: "s",
										error: {
											name: "ProviderError",
											data: { message: "Run A failed" },
										},
									}),
							"s",
							"opencode",
						);
					expect(
						yield* sql`SELECT id, status FROM provider_runs ORDER BY id`,
					).toEqual([
						{
							id: "run-a",
							status:
								signal === "idle"
									? "completed"
									: signal === "error"
										? "error"
										: "interrupted",
						},
						{ id: "run-b", status: "pending" },
					]);
					expect(
						yield* sql`SELECT state, run_id FROM turns WHERE user_message_id = ${messageB}`,
					).toEqual([{ state: "pending", run_id: null }]);
					expect(
						yield* sql`SELECT status FROM provider_command_outbox WHERE command_id = 'input-b'`,
					).toEqual([{ status: commandStatus }]);
					// The delayed echo is the provider's own intake acknowledgement.
					yield* ingress.onSSEEventEffect(
						makeSSEEvent("message.updated", {
							info: {
								id: messageB,
								sessionID: "s",
								role: "user",
								time: { created: 10 },
							},
						}),
						"s",
						"opencode",
					);
					expect(
						yield* sql`SELECT status FROM provider_runs WHERE id = 'run-b'`,
					).toEqual([{ status: "running" }]);
					const idle = makeSSEEvent("session.status", {
						sessionID: "s",
						status: { type: "idle" },
					});
					yield* ingress.onSSEEventEffect(idle, "s", "opencode");
					const ended =
						yield* sql`SELECT state, run_id, completed_at FROM turns WHERE user_message_id = ${messageB}`;
					expect(ended).toEqual([
						{
							state: "completed",
							run_id: "run-b",
							completed_at: expect.any(Number),
						},
					]);
					yield* ingress.onSSEEventEffect(idle, "s", "opencode");
					expect(
						yield* sql`SELECT state, run_id, completed_at FROM turns WHERE user_message_id = ${messageB}`,
					).toEqual(ended);
					expect(
						yield* sql`SELECT COUNT(*) AS n FROM events WHERE json_extract(metadata, '$.runId') = 'run-b'
					AND (type IN ('turn.completed', 'turn.error', 'turn.interrupted')
						OR (type = 'session.status' AND json_extract(data, '$.status') = 'idle'))`,
					).toEqual([{ n: 1 }]);
					ingress.shutdown();
				}).pipe(
					Effect.provide(
						Layer.merge(
							persistence,
							ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
						),
					),
				);
			},
		);
	}
}
