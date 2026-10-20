import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import { makeEffectOpenCodeRuntimeIngress } from "../../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import {
	makeProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
	type ProviderRuntimeRelayPublisher,
} from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	hasActiveProcessingTimeout,
	makeOverridesStateLive,
	PROCESSING_TIMEOUT_DURATION,
	startProcessingTimeout,
} from "../../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { createSilentLogger } from "../../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import {
	canonicalEvent,
	createEventId,
} from "../../../../src/lib/persistence/events.js";
import { inboxRunStatusQuery } from "../../../../src/lib/persistence/inbox-run-status-query.js";
import { openCodeInputMessageId } from "../../../../src/lib/provider/opencode/opencode-input-message-id.js";
import { OpenCodeRuntimeEventTranslator } from "../../../../src/lib/provider/opencode/opencode-runtime-event-translator.js";
import { OpenCodeProviderInstance } from "../../../../src/lib/provider/opencode-provider-instance.js";
import { ProviderSideEffectReactor } from "../../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../../src/lib/provider/provider-registry.js";
import {
	applyPipelineResultEffect,
	processEvent,
} from "../../../../src/lib/relay/event-pipeline.js";
import { makeMockOpenCodeAPI } from "../../../helpers/mock-factories.js";
import { makeBaseSendTurnInput } from "../../../helpers/mock-sdk.js";
import { makeSSEEvent } from "../../../helpers/sse-factories.js";

// Failure modes: raw A idle completes unaccepted B; B's later echo inherits
// terminal ownership; joined C never resolves; external members break the cohort;
// a finished assistant tool step completes a still-running command; a timeout
// committed outside the adapter leaves its commands and receipts running;
// retry policy is lost; a delayed join misses its already-ended run's result;
// message-level or ignored duplicate ends publish false done/error alerts.
const cases: Array<Record<string, unknown>> = [];
const artifactDirectory =
	process.env["CONDUIT_TEST_ARTIFACT_DIR"] ?? "test-results";
const recordCase = (scenario: string) => {
	cases.push({
		case: `opencode-owned-completion-${scenario}`,
		outcome: "passed",
	});
	mkdirSync(artifactDirectory, { recursive: true });
	writeFileSync(
		join(artifactDirectory, "82tn24-stage3-opencode-completion.json"),
		`${JSON.stringify({ cases }, null, 2)}\n`,
	);
};
function fixtureLayer(relayPublisher?: ProviderRuntimeRelayPublisher) {
	const persistence = makePersistenceEffectLayer(":memory:", "test-project");
	return Layer.merge(
		persistence,
		makeProviderRuntimeIngestionLive(
			relayPublisher ? { relayPublisher } : {},
		).pipe(Layer.provide(persistence)),
	);
}

function ownedEvent(
	type: "turn.completed" | "turn.error" | "session.status",
	runId: string,
	data: Record<string, unknown>,
) {
	return {
		eventId: createEventId(),
		type,
		providerId: "opencode",
		sessionId: "s",
		runId,
		providerRefs: {},
		rawSource: { kind: "test.provider-runtime" },
		createdAt: 10,
		data,
	};
}

// Reconnect drops translation announcements, not a native message's durable
// input owner. Replaying A must leave B's summarize bridge available for B.
it.live(
	"a replayed compaction after reconnect retains its durable input owner",
	() => {
		let finishA = () => {};
		let finishB = () => {};
		const heldA = new Promise<void>((resolve) => {
			finishA = resolve;
		});
		const heldB = new Promise<void>((resolve) => {
			finishB = resolve;
		});
		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;
			const client = makeMockOpenCodeAPI();
			vi.mocked(client.session.summarize)
				.mockImplementationOnce(() => heldA)
				.mockImplementationOnce(() => heldB);
			const provider = new OpenCodeProviderInstance({ client });
			const ingress = yield* makeEffectOpenCodeRuntimeIngress(
				createSilentLogger(),
				undefined,
				(sessionId, messageId, compaction) =>
					provider.inputIdForUserEcho(sessionId, messageId, compaction),
			);
			yield* commit([
				canonicalEvent("session.created", "s", {
					sessionId: "s",
					provider: "opencode",
					title: "Compaction reconnect",
				}),
			]);
			const start = (inputId: string, sequence: number) =>
				Effect.gen(function* () {
					yield* commit([
						canonicalEvent(
							"run.requested",
							"s",
							{ runId: `run-${inputId}`, inputId },
							{ metadata: { runId: `run-${inputId}` } },
						),
					]);
					yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id,
					provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
					VALUES (${sequence}, ${inputId}, 'test-project', 's', 'opencode', 'send_turn',
					${`run-${inputId}`}, '{}', 'running', 1, ${sequence}, ${sequence})`;
					yield* sql`INSERT INTO command_receipts (command_id, session_id, project_key, status, created_at, updated_at)
					VALUES (${inputId}, 's', 'test-project', 'side_effect_requested', ${sequence}, ${sequence})`;
					const send = yield* Effect.forkChild(
						provider.sendTurnEffect(
							makeBaseSendTurnInput({
								sessionId: "s",
								inputId,
								runId: `run-${inputId}`,
								prompt: "/compact",
								model: { providerId: "opencode", modelId: "model" },
								awaitIntake: Effect.succeed({
									status: "accepted",
									cost: 0,
									tokens: { input: 0, output: 0 },
									durationMs: 0,
									providerStateUpdates: [],
								}),
							}),
						),
					);
					yield* Effect.tryPromise(() =>
						vi.waitFor(() =>
							expect(client.session.summarize).toHaveBeenCalledTimes(sequence),
						),
					);
					return send;
				});
			const marker = (inputId: string) =>
				ingress.onSSEEventEffect(
					makeSSEEvent("message.part.updated", {
						part: {
							id: `part-${inputId}`,
							sessionID: "s",
							messageID: `native-${inputId}`,
							type: "compaction",
							auto: false,
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
			const first = yield* start("a", 1);
			yield* marker("a");
			yield* idle();
			finishA();
			yield* Fiber.join(first);
			expect(
				provider.inputIdForUserEcho("s", "native-a", true),
			).toBeUndefined();
			const second = yield* start("b", 2);
			yield* ingress.onReconnect("opencode");
			yield* marker("a");
			expect(
				yield* sql`SELECT status, started_at FROM provider_runs WHERE id = 'run-b'`,
			).toEqual([{ status: "pending", started_at: null }]);
			expect(
				yield* sql`SELECT t.run_id, t.state, m.input_id FROM turns t
				JOIN messages m ON m.id = t.user_message_id WHERE t.id = 'native-a'`,
			).toEqual([{ run_id: "run-a", state: "completed", input_id: "a" }]);
			expect(
				yield* sql`SELECT json_extract(data, '$.inputId') AS input_id FROM events
				WHERE type = 'run.started' ORDER BY sequence`,
			).toEqual([{ input_id: "a" }]);
			yield* marker("b");
			expect(
				yield* sql`SELECT t.run_id, t.state, m.input_id FROM turns t
				JOIN messages m ON m.id = t.user_message_id WHERE t.id = 'native-b'`,
			).toEqual([{ run_id: "run-b", state: "running", input_id: "b" }]);
			expect(
				yield* sql`SELECT r.status, r.started_at IS NOT NULL AS accepted, o.status AS command_status,
				c.status AS receipt_status FROM provider_runs r
				JOIN provider_command_outbox o ON o.run_id = r.id
				JOIN command_receipts c ON c.command_id = o.command_id WHERE r.id = 'run-b'`,
			).toEqual([
				{
					status: "running",
					accepted: 1,
					command_status: "running",
					receipt_status: "side_effect_requested",
				},
			]);
			yield* idle();
			expect(
				yield* sql`SELECT t.id, t.run_id, t.state, m.input_id FROM turns t
				JOIN messages m ON m.id = t.user_message_id ORDER BY t.id`,
			).toEqual([
				{
					id: "native-a",
					run_id: "run-a",
					state: "completed",
					input_id: "a",
				},
				{
					id: "native-b",
					run_id: "run-b",
					state: "completed",
					input_id: "b",
				},
			]);
			expect(
				yield* sql`SELECT r.id, r.status, o.status AS command_status, c.status AS receipt_status
				FROM provider_runs r JOIN provider_command_outbox o ON o.run_id = r.id
				JOIN command_receipts c ON c.command_id = o.command_id ORDER BY r.id`,
			).toEqual(
				["a", "b"].map((id) => ({
					id: `run-${id}`,
					status: "completed",
					command_status: "completed",
					receipt_status: "side_effect_completed",
				})),
			);
			finishB();
			yield* Fiber.join(second);
			ingress.shutdown();
			recordCase("reconnect-compaction-durable-owner");
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					finishA();
					finishB();
				}),
			),
			Effect.provide(fixtureLayer()),
		);
	},
);

it.live("an unrelated native echo never accepts an indeterminate send", () =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		const client = makeMockOpenCodeAPI();
		vi.mocked(client.session.prompt).mockRejectedValue(
			new Error("connection lost before server receipt"),
		);
		const provider = new OpenCodeProviderInstance({ client });
		const ingress = yield* makeEffectOpenCodeRuntimeIngress(
			createSilentLogger(),
			undefined,
			(sessionId, messageId) =>
				provider.inputIdForUserEcho(sessionId, messageId),
		);
		const commit = yield* makeCommitAndSignal;
		const reactor = new ProviderSideEffectReactor({
			write: commit.write,
			projectId: "test-project",
			sql,
			ingestion,
			registry: new ProviderRegistry([provider]),
		});
		yield* commit([
			canonicalEvent("session.created", "s", {
				sessionId: "s",
				provider: "opencode",
				title: "Indeterminate local input",
			}),
			canonicalEvent(
				"run.requested",
				"s",
				{ runId: "run-a", inputId: "a" },
				{
					metadata: { runId: "run-a" },
				},
			),
		]);
		yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id,
			provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
			VALUES (1, 'a', 'test-project', 's', 'opencode', 'send_turn', 'run-a',
			${JSON.stringify({ sessionId: "s", inputId: "a", prompt: "a", history: [], providerState: {}, workspaceRoot: "/tmp/project", extraFolders: [] })},
			'pending', 0, 1, 1)`;
		yield* sql`INSERT INTO command_receipts (command_id, session_id, project_key, status, created_at, updated_at)
			VALUES ('a', 's', 'test-project', 'side_effect_requested', 1, 1)`;
		expect((yield* reactor.runCommand("a")).status).toBe("indeterminate");
		const echo = (messageId: string) =>
			ingress.onSSEEventEffect(
				makeSSEEvent("message.updated", {
					info: {
						id: messageId,
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
		yield* echo("msg_tui_unrelated");
		yield* idle();
		expect(
			yield* sql`SELECT status, started_at FROM provider_runs WHERE id = 'run-a'`,
		).toEqual([{ status: "pending", started_at: null }]);
		expect(
			yield* sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'a'`,
		).toEqual([{ status: "running", error_code: "delivery_indeterminate" }]);
		expect(
			yield* sql`SELECT status FROM command_receipts WHERE command_id = 'a'`,
		).toEqual([{ status: "side_effect_requested" }]);
		expect(
			yield* sql`SELECT type FROM events WHERE type = 'run.started' AND json_extract(data, '$.inputId') = 'a'`,
		).toEqual([]);
		expect(yield* inboxRunStatusQuery(sql, "s")).toMatchObject([
			{ status: "pending" },
		]);
		yield* echo(openCodeInputMessageId("a"));
		// Repeated translation of the exact native identity retains its owner.
		yield* echo(openCodeInputMessageId("a"));
		yield* idle();
		expect(
			yield* sql`SELECT status FROM provider_runs WHERE id = 'run-a'`,
		).toEqual([{ status: "completed" }]);
		expect(
			yield* sql`SELECT status FROM provider_command_outbox WHERE command_id = 'a'`,
		).toEqual([{ status: "completed" }]);
		expect(
			yield* sql`SELECT status FROM command_receipts WHERE command_id = 'a'`,
		).toEqual([{ status: "side_effect_completed" }]);
		expect(client.session.prompt).toHaveBeenCalledOnce();
		ingress.shutdown();
	}).pipe(Effect.provide(fixtureLayer())),
);

for (const scenario of [
	"idle",
	"observer-failure",
	"message-step",
	"timeout",
	"timeout-retryable",
	"timeout-handled",
	"late-join",
]) {
	const observerFails = scenario === "observer-failure";
	const retryable = scenario === "timeout-retryable";
	it.live(
		`owned ingress completion settles only its accepted command cohort (${scenario})`,
		() => {
			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const client = makeMockOpenCodeAPI();
				const provider = new OpenCodeProviderInstance({
					client,
				});
				const ingress = yield* makeEffectOpenCodeRuntimeIngress(
					createSilentLogger(),
					undefined,
					(sessionId, messageId) =>
						provider.inputIdForUserEcho(sessionId, messageId),
				);
				const reactor = new ProviderSideEffectReactor({
					write: (yield* makeCommitAndSignal).write,
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
				provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
				VALUES (${sequence}, ${inputId}, 'test-project', 's', 'opencode', 'send_turn',
				${runId}, ${JSON.stringify({ sessionId: "s", inputId, prompt: inputId, history: [], providerState: {}, workspaceRoot: "/tmp/project", extraFolders: [] })},
				'pending', 0, ${sequence}, ${sequence})`;
						yield* sql`INSERT INTO command_receipts (command_id, session_id, project_key, status, created_at, updated_at)
							VALUES (${inputId}, 's', 'test-project', 'side_effect_requested', ${sequence}, ${sequence})`;
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
						yield* Effect.promise(() =>
							vi.waitFor(() =>
								expect(client.session.prompt).toHaveBeenCalledTimes(sequence),
							),
						);
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
			FROM provider_command_outbox o JOIN provider_runs r ON r.id = o.run_id
			ORDER BY o.request_sequence`;
				const a = yield* start("a", 1);
				yield* echo("a");
				if (scenario === "message-step") {
					yield* ingress.onSSEEventEffect(
						makeSSEEvent("message.updated", {
							info: {
								id: "assistant-tool-step",
								sessionID: "s",
								role: "assistant",
								parentID: openCodeInputMessageId("a"),
								finish: "tool-calls",
								time: { created: 2, completed: 3 },
							},
						}),
						"s",
						"opencode",
					);
					yield* Effect.yieldNow;
					expect(yield* state()).toEqual([
						{ input: "a", command: "running", reservation: "running" },
					]);
					expect(a.pollUnsafe()).toBeUndefined();
					expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
						{ status: "side_effect_requested" },
					]);
					expect(yield* sql`SELECT state FROM turns`).toEqual([
						{ state: "running" },
					]);
				}
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
				expect((yield* Fiber.join(a)).status).toBe("completed");
				expect(b.pollUnsafe()).toBeUndefined();
				expect(yield* state()).toEqual([
					{ input: "a", command: "completed", reservation: "completed" },
					{ input: "b", command: "running", reservation: "pending" },
				]);
				if (scenario === "late-join") {
					yield* commit([
						canonicalEvent(
							"message.created",
							"s",
							{
								sessionId: "s",
								messageId: openCodeInputMessageId("b"),
								role: "user",
								inputId: "b",
							},
							{ metadata: { runId: "run-a" } },
						),
						canonicalEvent(
							"run.started",
							"s",
							{
								inputId: "b",
								requestedRunId: "run-b",
								userMessageId: openCodeInputMessageId("b"),
							},
							{ metadata: { runId: "run-a" } },
						),
					]);
					expect(yield* state()).toEqual([
						{ input: "a", command: "completed", reservation: "completed" },
						{ input: "b", command: "completed", reservation: "joined" },
					]);
					expect(
						yield* sql`SELECT status FROM command_receipts ORDER BY command_id`,
					).toEqual([
						{ status: "side_effect_completed" },
						{ status: "side_effect_completed" },
					]);
					expect(yield* sql`SELECT state FROM turns ORDER BY id`).toEqual([
						{ state: "completed" },
						{ state: "completed" },
					]);
					expect((yield* Fiber.join(b)).status).toBe("completed");
					ingress.shutdown();
					yield* Effect.sync(() => recordCase(scenario));
					return;
				}
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
				if (scenario.startsWith("timeout")) {
					const d = yield* start("d", 4);
					const endedState = [
						{ input: "a", command: "completed", reservation: "completed" },
						{
							input: "b",
							command: retryable ? "retryable_failed" : "failed",
							reservation: "error",
						},
						{
							input: "c",
							command: retryable ? "retryable_failed" : "failed",
							reservation: "joined",
						},
						{ input: "d", command: "running", reservation: "pending" },
					];
					yield* ingestion.ingestBatch(
						[
							ownedEvent("turn.error", "run-b", {
								userMessageId: openCodeInputMessageId("b"),
								error: "Processing timed out",
								code: "processing_timeout",
								retryable: scenario !== "timeout",
								...(scenario === "timeout-handled"
									? { retryHandled: true }
									: {}),
							}),
						],
						{
							beforeCommit: Effect.gen(function* () {
								expect(yield* state()).toEqual(endedState);
								expect(
									yield* sql`SELECT command_id, status FROM command_receipts ORDER BY command_id`,
								).toEqual([
									{ command_id: "a", status: "side_effect_completed" },
									{ command_id: "b", status: "side_effect_failed" },
									{ command_id: "c", status: "side_effect_failed" },
									{ command_id: "d", status: "side_effect_requested" },
								]);
							}),
						},
					);
					expect(yield* state()).toEqual(endedState);

					const failedCommands = yield* sql<{
						next_attempt_at: number | null;
						updated_at: number;
						error_code: string;
					}>`SELECT next_attempt_at, updated_at, error_code FROM provider_command_outbox WHERE command_id IN ('b', 'c')`;
					for (const command of failedCommands) {
						expect(command.error_code).toBe("processing_timeout");
						if (retryable)
							expect(command.next_attempt_at).toBeGreaterThan(
								command.updated_at,
							);
						else expect(command.next_attempt_at).toBeNull();
					}
					for (const fiber of [b, c]) {
						expect(yield* Fiber.join(fiber)).toMatchObject({
							status: "error",
							error: { code: "processing_timeout" },
						});
					}
					expect(d.pollUnsafe()).toBeUndefined();
				} else {
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
				}
				ingress.shutdown();
				yield* Effect.sync(() => recordCase(scenario));
			}).pipe(Effect.provide(fixtureLayer()));
		},
	);
}

for (const duplicate of [false, true]) {
	it.effect(
		`publishes run-end alerts only for committed run transitions (duplicate: ${duplicate})`,
		() => {
			const alerts: Array<
				Parameters<ProviderRuntimeRelayPublisher["publish"]>[0]
			> = [];
			return Effect.gen(function* () {
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "s", {
						sessionId: "s",
						title: "Alerts",
						provider: "opencode",
					}),
					canonicalEvent(
						"run.started",
						"s",
						{ inputId: "a", requestedRunId: "run-a" },
						{ metadata: { runId: "run-a" } },
					),
				]);

				if (!duplicate) {
					yield* ingestion.ingest(
						ownedEvent("turn.completed", "run-a", {
							messageId: "assistant-tool-step",
						}),
					);
					expect(alerts).toEqual([]);
				}
				yield* ingestion.ingest(
					ownedEvent("session.status", "run-a", {
						sessionId: "s",
						status: "idle",
					}),
				);
				if (duplicate) {
					const before = alerts.slice();
					yield* ingestion.ingest(
						ownedEvent("turn.error", "run-a", {
							messageId: "old-failure",
							error: "Late error",
						}),
					);
					expect(alerts).toEqual(before);
				}
				expect(alerts).toEqual([
					expect.objectContaining({ type: "done", code: 0, sessionId: "s" }),
				]);
				yield* Effect.sync(() =>
					recordCase(duplicate ? "relay-duplicate-end" : "relay-message-step"),
				);
			}).pipe(
				Effect.provide(
					fixtureLayer({
						publish: (message) =>
							Effect.sync(() => {
								alerts.push(message);
							}),
					}),
				),
			);
		},
	);
}

// Idle clears the relay timer; the executor must resolve missing intake safely.
for (const confirmedStop of [false, true]) {
	it.effect(
		`bounds a missed OpenCode intake after idle clears the processing timer (confirmed stop=${confirmedStop})`,
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const client = makeMockOpenCodeAPI();
				const provider = new OpenCodeProviderInstance({ client });
				if (confirmedStop)
					vi.mocked(client.session.messages).mockImplementation(() =>
						Effect.runPromise(Effect.never),
					);
				const ingress = yield* makeEffectOpenCodeRuntimeIngress(
					createSilentLogger(),
				);
				const commit = yield* makeCommitAndSignal;
				const reactor = new ProviderSideEffectReactor({
					write: commit.write,
					projectId: "test-project",
					sql,
					ingestion,
					registry: new ProviderRegistry([provider]),
				});
				yield* commit([
					canonicalEvent("session.created", "s", {
						sessionId: "s",
						provider: "opencode",
						title: "Missed intake",
					}),
					canonicalEvent(
						"run.requested",
						"s",
						{ runId: "run-a", inputId: "a" },
						{
							metadata: { runId: "run-a" },
						},
					),
				]);
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id,
			provider_id, effect_type, run_id, payload_json, status, attempt_count, requested_at, updated_at)
			VALUES (1, 'a', 'test-project', 's', 'opencode', 'send_turn', 'run-a',
			${JSON.stringify({ sessionId: "s", inputId: "a", prompt: "a", history: [], providerState: {}, workspaceRoot: "/tmp/project", extraFolders: [] })},
			'pending', 0, 1, 1)`;
				yield* sql`INSERT INTO command_receipts (command_id, session_id, project_key, status, created_at, updated_at)
			VALUES ('a', 's', 'test-project', 'side_effect_requested', 1, 1)`;
				const relayTimeout = vi.fn(() => Effect.void);
				yield* startProcessingTimeout(
					"s",
					PROCESSING_TIMEOUT_DURATION,
					relayTimeout,
				);
				const send = yield* Effect.forkChild(reactor.runCommand("a"));
				yield* Effect.promise(() =>
					vi.waitFor(() =>
						expect(client.session.prompt).toHaveBeenCalledOnce(),
					),
				);
				if (confirmedStop) {
					yield* ingress.onInstanceStopped("opencode", () => true);
					yield* TestClock.adjust("1 second");
					expect(yield* sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "interrupted" },
					]);
					expect(send.pollUnsafe()).toBeDefined();
					expect((yield* Fiber.join(send)).status).toBe("interrupted");
					expect(client.session.messages).not.toHaveBeenCalled();
					expect(client.session.abort).not.toHaveBeenCalled();
					const next = yield* provider.sendTurnEffect(
						makeBaseSendTurnInput({
							sessionId: "s",
							inputId: "after-stop",
							awaitIntake: Effect.succeed({
								status: "accepted",
								cost: 0,
								tokens: { input: 0, output: 0 },
								durationMs: 0,
								providerStateUpdates: [],
							}),
						}),
					);
					expect(next.status).toBe("accepted");
					expect(client.session.prompt).toHaveBeenCalledTimes(2);
					ingress.shutdown();
					return;
				}
				yield* ingress.onSSEEventEffect(
					makeSSEEvent("session.status", {
						sessionID: "s",
						status: { type: "idle" },
					}),
					"s",
					"opencode",
				);
				yield* applyPipelineResultEffect(
					processEvent(
						{ type: "done", code: 0, sessionId: "s" },
						"s",
						[],
						"sse",
					),
					"s",
					{ log: createSilentLogger() },
				);
				expect(yield* hasActiveProcessingTimeout("s")).toBe(false);
				expect(
					yield* sql`SELECT status, started_at FROM provider_runs`,
				).toEqual([{ status: "pending", started_at: null }]);
				yield* TestClock.adjust("121 seconds");
				expect(relayTimeout).not.toHaveBeenCalled();
				expect(client.session.abort).not.toHaveBeenCalled();
				expect(yield* sql`SELECT status FROM provider_runs`).toEqual([
					{ status: "pending" },
				]);
				expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
					{ status: "side_effect_requested" },
				]);
				expect((yield* Fiber.join(send)).status).toBe("indeterminate");
				expect(
					yield* sql`SELECT status, error_code FROM provider_command_outbox`,
				).toEqual([
					{ status: "running", error_code: "delivery_indeterminate" },
				]);
				expect(
					yield* sql`SELECT type FROM events WHERE type IN ('run.started', 'turn.error')`,
				).toEqual([]);

				ingress.shutdown();
			}).pipe(
				Effect.provide(Layer.merge(fixtureLayer(), makeOverridesStateLive())),
			),
	);
}
