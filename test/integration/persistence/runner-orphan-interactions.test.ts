import { mkdirSync, writeFileSync } from "node:fs";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import {
	makePendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	makeRunnerProviderInstance,
	type RunnerRecoveryDependencies,
} from "../../../src/lib/provider/runner/runner-provider-instance.js";

// A newer attempt can register a question after recovery snapshots the old
// command. Rejecting its stale terminal must also preserve the newer waiter.
const scenarios: unknown[] = [];

it.each([
	true,
	false,
])("guards orphan interaction cleanup when superseded=%s", async (superseded) => {
	const persistence = makePersistenceEffectLayer(":memory:", "test-project");
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			persistence,
			ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
			makePendingInteractionServiceLive(),
		),
	);
	try {
		const evidence = await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* (yield* ProjectionRunnerEffectTag).recover();
					const sql = yield* SqlClient.SqlClient;
					const pending = yield* PendingInteractionServiceTag;
					const ingestion = yield* ProviderRuntimeIngestionTag;
					const persist = yield* ClaudeEventPersistEffectTag;
					const commit = yield* makeCommitAndSignal;
					const sessionId = "orphan-session";
					const metadata = {
						provider: "claude",
						metadata: { runId: "run" },
					};
					yield* commit([
						canonicalEvent("session.created", sessionId, {
							sessionId,
							provider: "test-claude",
							title: "Orphan recovery",
						}),
						canonicalEvent(
							"run.requested",
							sessionId,
							{ runId: "run", inputId: "input" },
							metadata,
						),
						canonicalEvent(
							"message.created",
							sessionId,
							{ messageId: "input", sessionId, role: "user", inputId: "input" },
							metadata,
						),
						canonicalEvent(
							"run.started",
							sessionId,
							{ requestedRunId: "run", inputId: "input" },
							metadata,
						),
					]);
					yield* sql`INSERT INTO command_receipts
						(command_id, session_id, status, created_at, command_type, project_key, fingerprint_hash, fingerprint_version, side_effect_sequence, updated_at)
						VALUES ('send', ${sessionId}, 'side_effect_requested', 1, 'send_turn', 'test-project', 'hash', 1, 1, 1)`;
					yield* sql`INSERT INTO provider_command_outbox
						(request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at)
						VALUES (1, 'send', 'test-project', ${sessionId}, 'test-claude', 'send_turn', ${JSON.stringify({ sessionId, inputId: "input", text: "prompt" })}, 'run', 'running', 1, 1, 1)`;
					let recoveryLookups = 0;
					const recoveryForSession =
						(): Effect.Effect<RunnerRecoveryDependencies> =>
							Effect.gen(function* () {
								recoveryLookups++;
								// Prepass, then the snapshotted row, then the real failure callback.
								if (recoveryLookups === 3) {
									if (superseded)
										yield* sql`UPDATE provider_command_outbox SET attempt_count = 2 WHERE command_id = 'send'`;
									yield* pending.beginQuestionRequest({
										requestId: "new-attempt-question",
										sessionId,
										questions: [{ question: "Continue the newer attempt?" }],
									});
								}
								return {
									projectId: "test-project",
									ingestion,
									pending,
									persist,
									timeoutHooks: {},
									retirePrompts: () => Effect.succeed(0),
									resolveCallContext: () =>
										Effect.die("Recovery does not send turns"),
								};
							}).pipe(Effect.orDie);
					const instance = yield* makeRunnerProviderInstance(
						{
							projectRootForSession: () =>
								Effect.succeed("/isolated-orphan-test"),
							accounts: Effect.succeed(
								accountsStateFromInstances(
									[
										{
											id: "test-claude",
											name: "Test Claude",
											driver: "claude",
										},
									],
									configuredClaudeConfigDir("/isolated-orphan-test/.claude"),
								),
							),
						},
						{
							driverKind: "claude",
							discoverEffect: () => Effect.die("No provider discovery"),
							generateTextEffect: () => Effect.die("No provider generation"),
							prepareTurnEffect: () => Effect.die("No provider turns"),
						},
						() =>
							Effect.succeed({
								hasLiveProcessEffect: () => Effect.succeed(false),
								executeEffect: () =>
									Effect.fail({
										operation: "execute",
										message: "No runner process",
									}),
							}),
					);
					yield* instance.attachSessionsEffect([sessionId], recoveryForSession);
					return {
						recoveryLookups,
						commands:
							yield* sql`SELECT status, attempt_count FROM provider_command_outbox WHERE command_id = 'send'`,
						questions: (yield* pending.listPendingQuestions(sessionId)).map(
							({ requestId }) => requestId,
						),
						terminals:
							yield* sql`SELECT type FROM events WHERE type = 'turn.error'`,
					};
				}),
			),
		);
		scenarios.push({ superseded, ...evidence });
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn10-4-fix5-interactions.json",
			JSON.stringify({ scenarios }, null, 2),
		);
		expect(evidence.recoveryLookups).toBe(3);
		expect(evidence.commands).toEqual([
			{
				status: superseded ? "running" : "failed",
				attempt_count: superseded ? 2 : 1,
			},
		]);
		expect(evidence.terminals).toEqual(
			superseded ? [] : [{ type: "turn.error" }],
		);
		expect(evidence.questions).toEqual(
			superseded ? ["new-attempt-question"] : [],
		);
	} finally {
		await runtime.dispose();
	}
});
