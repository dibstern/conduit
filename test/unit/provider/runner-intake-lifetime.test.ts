import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it } from "vitest";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { makeInProcessSessionRunner } from "../../../src/lib/provider/runner/in-process-session-runner.js";
import { runnerSinkId } from "../../../src/lib/provider/runner/runner-protocol.js";
import { recoverRunnerCommands } from "../../../src/lib/provider/runner/runner-recovery.js";
import type {
	DurableSessionTurn,
	SessionTurn,
} from "../../../src/lib/provider/runner/session-runner.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

it("keeps native activity after intake acknowledgement and waits for it before shutdown", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				let active = false;
				let ended = false;
				const runner = yield* makeInProcessSessionRunner(
					() =>
						Effect.succeed({
							sendTurn: () =>
								Effect.sync(() => {
									active = true;
									return {
										status: "accepted" as const,
										cost: 0,
										tokens: { input: 0, output: 0 },
										durationMs: 0,
										providerStateUpdates: [],
									};
								}),
							hasActiveTurnsEffect: () => Effect.sync(() => active),
							interrupt: () => Effect.void,
							applySettings: () => Effect.void,
							endSession: () =>
								Effect.sync(() => {
									ended = true;
								}),
						}),
					() => Effect.succeed({}),
				);
				const input: SessionTurn = {
					sessionId: "session",
					inputId: "input",
					runId: "run",
					prompt: "Hello",
					history: [],
					providerState: {},
					handoff: {
						included: 1,
						omitted: 0,
						firstMessageIncluded: false,
						tokens: 10,
					},
					workspaceRoot: "/tmp",
					extraFolders: [],
					configDir: configuredClaudeConfigDir("/tmp/claude"),
					folderSource: "account",
				};
				const intake = yield* runner.executeEffect({
					type: "send-turn",
					input,
					sinkId: "sink",
					aborted: false,
				});
				expect(intake.status).toBe("accepted");
				expect(intake.handoff).toEqual(input.handoff);
				yield* runner.executeEffect({
					type: "shutdown-after-turn",
					sessionId: "session",
				});
				yield* Effect.sleep("20 millis");
				expect(ended).toBe(false);
				expect(
					yield* runner.hasActiveTurnsEffect?.("session") ??
						Effect.succeed(false),
				).toBe(true);
				active = false;
				while (!ended) yield* Effect.sleep("10 millis");
				expect(
					yield* runner.hasActiveTurnsEffect?.("session") ??
						Effect.succeed(true),
				).toBe(false);
			}),
		),
	);
});

it.each([
	"claude",
	"cursor",
] as const)("reattaches an indeterminate %s reservation after restart without resubmitting its input", async (provider) => {
	const persistence = makePersistenceEffectLayer(":memory:", "test-project");
	await Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;
			const ingestion = yield* ProviderRuntimeIngestionTag;
			const input: SessionTurn = {
				sessionId: "session",
				inputId: "input",
				runId: "run",
				prompt: "Hello",
				history: [],
				providerState: {},
				workspaceRoot: "/tmp",
				extraFolders: [],
				configDir: configuredClaudeConfigDir("/tmp/claude"),
				folderSource: "account",
			};
			yield* commit([
				canonicalEvent(
					"session.created",
					"session",
					{ sessionId: "session", title: "Indeterminate", provider },
					{ provider },
				),
				canonicalEvent(
					"run.requested",
					"session",
					{ runId: "run", inputId: "input" },
					{ provider, metadata: { runId: "run" } },
				),
				canonicalEvent(
					"message.created",
					"session",
					{ sessionId: "session", messageId: "input", role: "user" },
					{ provider, metadata: { runId: "run" } },
				),
			]);
			yield* sql`INSERT INTO command_receipts (command_id, session_id, status, command_type, project_key, created_at, updated_at)
			VALUES ('command', 'session', 'side_effect_requested', 'send_turn', 'test-project', 1, 1)`;
			yield* sql`INSERT INTO provider_command_outbox
			(request_sequence, command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json, status, error_code, attempt_count, requested_at, updated_at)
			VALUES (1, 'command', 'test-project', 'session', ${provider}, 'send_turn', 'run', ${JSON.stringify(input)}, 'running', 'delivery_indeterminate', 1, 1, 1)`;
			let submitted = 0;
			for (let restart = 0; restart < 2; restart++) {
				const commands = yield* recoverRunnerCommands(
					sql,
					"session",
					provider,
					{
						driverForAccount: () => provider,
						decodeInput: (row) =>
							JSON.parse(row.payload_json) as DurableSessionTurn,
						resolveSinkId: (commandId, _inputId, attempt) =>
							runnerSinkId(commandId, attempt),
						closing: () => false,
						failTurn: () =>
							Effect.die("Indeterminate delivery is not a native failure"),
						replay: () =>
							Effect.sync(() => {
								submitted++;
								return {
									status: "accepted" as const,
									cost: 0,
									tokens: { input: 0, output: 0 },
									durationMs: 0,
									providerStateUpdates: [],
								};
							}),
					},
				);
				expect(commands).toHaveLength(1);
				for (const command of commands) yield* command.wait;
			}
			expect(submitted).toBe(0);
			expect(yield* sql`SELECT status, started_at FROM provider_runs`).toEqual([
				{ status: "pending", started_at: null },
			]);
			expect(
				yield* sql`SELECT status, error_code FROM provider_command_outbox`,
			).toEqual([{ status: "running", error_code: "delivery_indeterminate" }]);
			expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
				{ status: "side_effect_requested" },
			]);
			// Existing runner output replay still supplies the real later intake and terminal.
			yield* ingestion.ingestBatch([
				providerRuntimeEvent(
					"run.started",
					"session",
					{ inputId: "input", requestedRunId: "run" },
					{ eventId: "real-start", providerId: provider, runId: "run" },
				),
				providerRuntimeEvent(
					"turn.completed",
					"session",
					{ messageId: "", duration: 10 },
					{ eventId: "real-end", providerId: provider, runId: "run" },
				),
			]);
			expect(yield* sql`SELECT status FROM provider_runs`).toEqual([
				{ status: "completed" },
			]);
			expect(yield* sql`SELECT status FROM provider_command_outbox`).toEqual([
				{ status: "completed" },
			]);
			expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
				{ status: "side_effect_completed" },
			]);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					persistence,
					ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
				),
			),
		),
	);
});
