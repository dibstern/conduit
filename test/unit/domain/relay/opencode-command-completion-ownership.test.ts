import { mkdirSync, writeFileSync } from "node:fs";
import { it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vitest";
import { makeEffectOpenCodeRuntimeIngress } from "../../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { createSilentLogger } from "../../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { openCodeInputMessageId } from "../../../../src/lib/provider/opencode/opencode-input-message-id.js";
import { OpenCodeRuntimeEventTranslator } from "../../../../src/lib/provider/opencode/opencode-runtime-event-translator.js";
import { OpenCodeProviderInstance } from "../../../../src/lib/provider/opencode-provider-instance.js";
import { ProviderSideEffectReactor } from "../../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../../src/lib/provider/provider-registry.js";
import { makeMockOpenCodeAPI } from "../../../helpers/mock-factories.js";
import { makeSSEEvent } from "../../../helpers/sse-factories.js";

// Failure modes: raw A idle completes unaccepted B; B's later echo inherits
// terminal ownership; joined C never resolves; external members break the cohort.
const cases: Array<Record<string, unknown>> = [];
for (const observerFails of [false, true]) {
	it.effect(
		`owned ingress completion settles only its accepted command cohort (observer failure: ${observerFails})`,
		() => {
			const persistence = makePersistenceEffectLayer(
				":memory:",
				"test-project",
			);
			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const provider = new OpenCodeProviderInstance({
					client: makeMockOpenCodeAPI(),
				});
				const ingress = yield* makeEffectOpenCodeRuntimeIngress(
					createSilentLogger(),
					undefined,
					(sessionId, messageId) =>
						provider.inputIdForUserEcho(sessionId, messageId),
					undefined,
					undefined,
					(sessionId) => provider.capturePendingTurns(sessionId),
				);
				const reactor = new ProviderSideEffectReactor({
					projectId: "test-project",
					sql,
					ingestion,
					registry: new ProviderRegistry([provider]),
				});
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "s", {
						sessionId: "s",
						provider: "opencode",
						title: "Commands",
					}),
				]);
				const start = (inputId: string, sequence: number) =>
					Effect.gen(function* () {
						const runId = `run-${inputId}`;
						yield* commit([
							canonicalEvent(
								"run.requested",
								"s",
								{ runId, inputId },
								{ metadata: { runId } },
							),
						]);
						yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id,
				provider_id, effect_type, payload_json, status, attempt_count, requested_at, updated_at)
				VALUES (${sequence}, ${inputId}, 'test-project', 's', 'opencode', 'send_turn',
				${JSON.stringify({ sessionId: "s", inputId, runId, prompt: inputId, history: [], providerState: {}, workspaceRoot: "/tmp/project", extraFolders: [] })},
				'pending', 0, ${sequence}, ${sequence})`;
						const fiber = yield* Effect.forkChild(reactor.runCommand(inputId));
						yield* Effect.repeat(
							Effect.gen(function* () {
								const [row] = yield* sql<{
									status: string;
								}>`SELECT status FROM provider_command_outbox WHERE command_id = ${inputId}`;
								return row?.status === "running";
							}),
							{ until: (running) => running },
						);
						yield* Effect.yieldNow;
						return fiber;
					});
				const echo = (inputId: string, native = false) =>
					ingress.onSSEEventEffect(
						makeSSEEvent("message.updated", {
							info: {
								id: native ? inputId : openCodeInputMessageId(inputId),
								sessionID: "s",
								role: "user",
								time: { created: 1 },
							},
						}),
						"s",
						"opencode",
					);
				const idle = () =>
					ingress.onSSEEventEffect(
						makeSSEEvent("session.status", {
							sessionID: "s",
							status: { type: "idle" },
						}),
						"s",
						"opencode",
					);
				const state = () => sql<{
					input: string;
					command: string;
					reservation: string;
				}>`
			SELECT o.command_id AS input, o.status AS command, r.status AS reservation
			FROM provider_command_outbox o JOIN provider_runs r ON r.id = json_extract(o.payload_json, '$.runId')
			ORDER BY o.request_sequence`;
				const a = yield* start("a", 1);
				yield* echo("a");
				const b = yield* start("b", 2);
				if (observerFails) {
					const observer = vi
						.spyOn(OpenCodeRuntimeEventTranslator.prototype, "commitSession")
						.mockImplementationOnce(() => {
							throw new Error("post-commit observer failed");
						});
					const result = yield* Effect.exit(idle()).pipe(
						Effect.ensuring(Effect.sync(() => observer.mockRestore())),
					);
					expect(result._tag).toBe("Failure");
				} else yield* idle();
				yield* Effect.yieldNow;
				expect(a.pollUnsafe()).toBeDefined();
				expect((yield* Fiber.join(a)).status).toBe("completed");
				expect(b.pollUnsafe()).toBeUndefined();
				expect(yield* state()).toEqual([
					{ input: "a", command: "completed", reservation: "completed" },
					{ input: "b", command: "running", reservation: "pending" },
				]);
				yield* echo("b");
				expect(
					yield* sql`SELECT status FROM provider_runs WHERE id = 'run-b'`,
				).toEqual([{ status: "running" }]);
				const c = yield* start("c", 3);
				yield* echo("c");
				yield* echo("native", true);
				expect(
					yield* sql`SELECT state, run_id FROM turns WHERE id != ${openCodeInputMessageId("a")} ORDER BY id`,
				).toEqual([
					{ state: "running", run_id: "run-b" },
					{ state: "running", run_id: "run-b" },
					{ state: "running", run_id: "run-b" },
				]);
				yield* idle();
				expect((yield* Fiber.join(b)).status).toBe("completed");
				expect((yield* Fiber.join(c)).status).toBe("completed");
				expect(yield* state()).toEqual([
					{ input: "a", command: "completed", reservation: "completed" },
					{ input: "b", command: "completed", reservation: "completed" },
					{ input: "c", command: "completed", reservation: "joined" },
				]);
				expect(yield* sql`SELECT state FROM turns ORDER BY id`).toEqual(
					Array.from({ length: 4 }, () => ({ state: "completed" })),
				);
				ingress.shutdown();
				yield* Effect.sync(() => {
					cases.push({
						case: observerFails
							? "opencode-durable-terminal-survives-observer-failure"
							: "opencode-idle-does-not-complete-unaccepted-command",
						outcome: "passed",
						aIdle: {
							a: "completed",
							bCommand: "running",
							bReservation: "pending",
						},
						bEcho: "running",
						bOwnIdle: {
							b: "completed",
							joinedC: "completed",
							native: "completed",
							commandsCompleted: 3,
						},
					});
					mkdirSync("test-results", { recursive: true });
					writeFileSync(
						"test-results/82tn24-round4-opencode-completion.json",
						`${JSON.stringify({ cases }, null, 2)}\n`,
					);
				});
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
