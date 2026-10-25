import { mkdirSync, writeFileSync } from "node:fs";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, expect, it } from "vitest";
import { EffectOpenCodeRuntimeIngress } from "../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { LoggerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { makeFailTurn } from "../../../src/lib/domain/relay/Services/turn-failure.js";
import type {
	Message,
	SessionStatus,
} from "../../../src/lib/instance/sdk-types.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { inboxRunStatusQuery } from "../../../src/lib/persistence/inbox-run-status-query.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { openCodeInputMessageId } from "../../../src/lib/provider/opencode/opencode-input-message-id.js";
import { ProviderSideEffectReactor } from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { runningRunnerCommands } from "../../../src/lib/provider/runner/runner-recovery.js";

const evidence: Record<string, unknown>[] = [];
afterAll(() => {
	mkdirSync("test-results/82tn10-4-round7", { recursive: true });
	writeFileSync(
		"test-results/82tn10-4-round7/opencode.json",
		JSON.stringify(evidence, null, 2),
	);
});

// A crash before intake leaves no turn or echo. Removal must not invent provider
// truth, while reattachment must settle the reservation without resending it.
it.each([
	"stopped",
	"idle",
	"completed",
	"busy-then-stopped",
	"unavailable-then-stopped",
	"never-return",
	"new-attempt",
] as const)("recovers a removed pre-intake OpenCode send: %s", async (scenario) => {
	const persistence = makePersistenceEffectLayer(":memory:", "project");
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			persistence,
			ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
			Layer.succeed(LoggerTag)(createSilentLogger()),
		),
	);
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const commit = yield* makeCommitAndSignal;
				const projectionRunner = yield* ProjectionRunnerEffectTag;
				yield* commit([
					canonicalEvent("session.created", "session", {
						sessionId: "session",
						provider: "opencode",
						title: "Retained before intake",
					}),
					canonicalEvent(
						"run.requested",
						"session",
						{ runId: "run", inputId: "input" },
						{ provider: "opencode", metadata: { runId: "run" } },
					),
				]);
				yield* sql`INSERT INTO command_receipts(command_id,project_key,session_id,status,created_at)
					VALUES('command','project','session','side_effect_requested',1)`;
				const payload = JSON.stringify({
					sessionId: "session",
					inputId: "input",
					prompt: "Send once",
					providerState: {},
					workspaceRoot: "/isolated-project",
					extraFolders: [],
				});
				yield* sql`INSERT INTO provider_command_outbox(request_sequence,command_id,project_key,session_id,provider_id,effect_type,payload_json,run_id,status,attempt_count,requested_at,updated_at)
					VALUES(1,'command','project','session','opencode','send_turn',${payload},'run','running',1,1,1)`;
				const reactor = new ProviderSideEffectReactor({
					sql,
					registry: new ProviderRegistry(),
					write: commit.write,
					ingestion,
					isProjectReady: () =>
						Effect.fail(
							new ProviderInstanceFailure({
								providerId: "conduit",
								operation: "executeCommand",
								code: "project_inactive",
								cause: "removed",
							}),
						),
				});
				for (let sweep = 0; sweep < 3; sweep++) yield* reactor.drain();
				const removed = {
					commands:
						yield* sql`SELECT status,error_code,attempt_count FROM provider_command_outbox`,
					runs: yield* sql`SELECT status,started_at FROM provider_runs`,
					owned: reactor.ownsPendingSend("session", "command", 1, 1),
					inbox: yield* inboxRunStatusQuery(sql, "session"),
				};
				expect(removed.commands).toEqual([
					{
						status: "cancelled",
						error_code: "project_inactive",
						attempt_count: 1,
					},
				]);
				expect(removed.runs).toEqual([{ status: "pending", started_at: null }]);
				expect(removed.owned).toBe(false);
				expect(removed.inbox).toMatchObject([{ status: "pending" }]);
				expect(yield* sql`SELECT id FROM messages`).toEqual([]);
				// The runner-backed path keeps its existing default eligibility.
				expect(
					yield* runningRunnerCommands(sql, "opencode", () => "opencode"),
				).toEqual([]);
				if (scenario === "never-return") {
					evidence.push({ scenario, removed, providerProbes: 0 });
					return;
				}

				const userId = openCodeInputMessageId("input");
				const history: Message[] =
					scenario === "completed"
						? [
								{
									id: userId,
									role: "user",
									sessionID: "session",
									time: { created: 10 },
									parts: [{ id: "prompt", type: "text", text: "Send once" }],
								},
								{
									id: "answer",
									role: "assistant",
									sessionID: "session",
									parentID: userId,
									time: { created: 11, completed: 12 },
									finish: "stop",
									parts: [{ id: "text", type: "text", text: "Answer" }],
								},
							]
						: [];
				const ingress = new EffectOpenCodeRuntimeIngress({
					projectId: "project",
					sql,
					projectionRunner,
					ingestion,
					log: createSilentLogger(),
					selectedInstanceId: "opencode",
					fetchSessionMessages: () => Effect.succeed(history),
				});
				const commands = yield* runningRunnerCommands(
					sql,
					"opencode",
					() => "opencode",
					undefined,
					true,
				);
				expect(commands).toHaveLength(1);
				let providerProbes = 0;
				let deferred = true;
				const readStatus = (): Effect.Effect<
					Record<string, SessionStatus> | "stopped" | undefined
				> =>
					Effect.gen(function* () {
						providerProbes++;
						if (scenario === "new-attempt")
							yield* sql`UPDATE provider_command_outbox SET status = 'running', attempt_count = 2 WHERE command_id = 'command'`;
						if (deferred && scenario === "busy-then-stopped")
							return { session: { type: "busy" as const } };
						if (deferred && scenario === "unavailable-then-stopped") return;
						return scenario === "idle" || scenario === "completed"
							? { session: { type: "idle" as const } }
							: ("stopped" as const);
					}).pipe(Effect.orDie);
				const recover = ingress
					.recoverCommands(commands, readStatus, yield* makeFailTurn)
					.pipe(
						Effect.andThen(
							ingress.recoverObservedRuns(readStatus, ["opencode"]),
						),
					);
				if (
					scenario === "busy-then-stopped" ||
					scenario === "unavailable-then-stopped"
				) {
					for (let sweep = 0; sweep < 3; sweep++) yield* recover;
					expect(yield* sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "pending" },
					]);
					deferred = false;
				}
				for (let sweep = 0; sweep < 3; sweep++) yield* recover;
				const result = {
					scenario,
					removed,
					providerProbes,
					commands:
						yield* sql`SELECT status,error_code,attempt_count FROM provider_command_outbox`,
					runs: yield* sql`SELECT status FROM provider_runs`,
					busy: yield* sql`SELECT COUNT(*) AS count FROM provider_runs WHERE session_id = 'session' AND status IN ('pending', 'running')`,
					inbox: yield* inboxRunStatusQuery(sql, "session"),
					terminals:
						yield* sql`SELECT type FROM events WHERE type IN ('turn.error', 'turn.completed')`,
				};
				evidence.push(result);
				expect(result.providerProbes).toBeGreaterThan(0);
				expect(result.runs).toEqual([
					{
						status:
							scenario === "new-attempt"
								? "pending"
								: scenario === "completed"
									? "completed"
									: "error",
					},
				]);
				expect(result.inbox).toMatchObject(result.runs);
				expect(result.busy).toEqual([
					{ count: scenario === "new-attempt" ? 1 : 0 },
				]);
				expect(result.commands).toEqual([
					{
						status: scenario === "new-attempt" ? "running" : "cancelled",
						error_code: "project_inactive",
						attempt_count: scenario === "new-attempt" ? 2 : 1,
					},
				]);
				expect(result.terminals.length).toBe(
					scenario === "new-attempt" ? 0 : scenario === "completed" ? 0 : 1,
				);
				ingress.shutdown();
			}),
		);
	} finally {
		await runtime.dispose();
	}
});

it("keeps cancelled Claude sends out of the default runner candidate snapshot", async () => {
	const runtime = ManagedRuntime.make(
		makePersistenceEffectLayer(":memory:", "project"),
	);
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* (yield* makeCommitAndSignal)([
					canonicalEvent("session.created", "session", {
						sessionId: "session",
						provider: "claude",
						title: "Retained runner",
					}),
					canonicalEvent("run.requested", "session", {
						runId: "run",
						inputId: "input",
					}),
				]);
				yield* sql`INSERT INTO provider_command_outbox(request_sequence,command_id,project_key,session_id,provider_id,effect_type,payload_json,run_id,status,error_code,attempt_count,requested_at,updated_at)
					VALUES(1,'command','project','session','claude','send_turn','{"inputId":"input"}','run','cancelled','project_inactive',1,1,1)`;
				const driverForAccount = (id: string) => id;
				const defaults = yield* runningRunnerCommands(
					sql,
					"claude",
					driverForAccount,
				);
				const openCode = yield* runningRunnerCommands(
					sql,
					"opencode",
					driverForAccount,
					undefined,
					true,
				);
				const explicitInactive = yield* runningRunnerCommands(
					sql,
					"claude",
					driverForAccount,
					undefined,
					true,
				);
				expect(defaults).toEqual([]);
				expect(openCode).toEqual([]);
				expect(explicitInactive).toHaveLength(1);
				evidence.push({
					scenario: "claude-candidate-selection",
					defaultCandidates: defaults.length,
					openCodeCandidates: openCode.length,
					explicitInactiveCandidates: explicitInactive.length,
				});
			}),
		);
	} finally {
		await runtime.dispose();
	}
});
