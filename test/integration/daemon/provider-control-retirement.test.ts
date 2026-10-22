import { Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import {
	makeProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { makeRetireReplacedProcessPrompts } from "../../../src/lib/persistence/effect/retire-pending-prompts.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { backfillLegacyControlAnswers } from "../../../src/lib/provider/legacy-control-outbox.js";
import { ProviderSideEffectReactor } from "../../../src/lib/provider/orchestration-side-effect-reactor.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type { TurnResult } from "../../../src/lib/provider/types.js";

describe("provider process control retirement", () => {
	it("borrows current project services to retire prompts after daemon control delivery finds a dead process", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				const projectContext = yield* Effect.context<never>();
				const daemonContext = Context.omit(
					EventStoreEffectTag,
					ClaudeEventPersistEffectTag,
				)(projectContext);
				let current = Option.none<Context.Context<never>>();
				yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('session', 'project', 'claude', 1, 1)`;
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, created_at, provider_process_id)
					VALUES ('permission', 'session', 'permission', 'pending', 1, 'dead-process')`;
				yield* sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, project_key)
					VALUES ('control', 'session', 'side_effect_requested', 1, 'project')`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, provider_process_id, status, requested_at, updated_at)
					VALUES (1, 'control', 'project', 'session', 'claude', 'end_session', ${JSON.stringify({ type: "end_session", sessionId: "session", providerProcessId: "dead-process" })}, 'dead-process', 'pending', 1, 1)`;
				const options = {
					sql,
					write: commit.write,
					registry: new ProviderRegistry(),
					ingestion: {
						ingest: () => Effect.die("unused"),
						ingestBatch: () => Effect.die("unused"),
					},
					projectContext: (projectId: string) =>
						projectId === "project" ? current : Option.none(),
					resolveSessionCallContext: () =>
						Effect.sync(() => {
							current = Option.some(projectContext);
						}).pipe(
							Effect.andThen(
								Effect.fail(
									new ProviderInstanceFailure({
										providerId: "claude",
										operation: "resolveControl",
										code: "provider_process_gone",
										cause: new Error("Native process ended"),
									}),
								),
							),
						),
				};
				yield* new ProviderSideEffectReactor(options)
					.runOnce()
					.pipe(Effect.setContext(daemonContext));
				expect(
					yield* sql`SELECT status FROM pending_approvals WHERE id = 'permission'`,
				).toEqual([{ status: "resolved" }]);
				expect(
					yield* sql`SELECT type FROM events WHERE type = 'permission.resolved'`,
				).toEqual([{ type: "permission.resolved" }]);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "project")),
			),
		);
	});

	it("borrows current project persistence to requeue a daemon-drained declined steer", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				const ingestion = yield* ProviderRuntimeIngestionTag;
				const projectContext = yield* Effect.context<never>();
				const daemonContext = Context.omit(
					EventStoreEffectTag,
					ClaudeEventPersistEffectTag,
				)(projectContext);
				let current = Option.none<Context.Context<never>>();
				yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('session', 'project', 'opencode', 1, 1)`;
				yield* commit([
					canonicalEvent("session.created", "session", {
						sessionId: "session",
						title: "Declined steer",
						provider: "opencode",
					}),
					canonicalEvent("input.admitted", "session", {
						sessionId: "session",
						inputId: "steer",
						delivery: "queue",
						request: { text: "Next" },
					}),
					canonicalEvent("input.sent", "session", {
						sessionId: "session",
						inputId: "steer",
						steer: true,
					}),
				]);
				yield* sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, project_key)
					VALUES ('steer', 'session', 'side_effect_requested', 1, 'project')`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at)
					VALUES (1, 'steer', 'project', 'session', 'opencode', 'send_turn', ${JSON.stringify({ sessionId: "session", inputId: "steer", prompt: "Next", history: [], providerState: {}, workspaceRoot: "/repo", extraFolders: [] })}, 'pending', 1, 1)`;
				const registry = new ProviderRegistry([
					{
						providerId: "opencode",
						generateTextEffect: () => Effect.die("unused"),
						discoverEffect: () => Effect.die("unused"),
						interruptTurnEffect: () => Effect.void,
						resolvePermissionEffect: () => Effect.void,
						resolveQuestionEffect: () => Effect.void,
						shutdownEffect: () => Effect.void,
						endSessionEffect: () => Effect.void,
						sendTurnEffect: () =>
							Effect.sync(() => {
								current = Option.some(projectContext);
								return {
									status: "steer-declined",
									cost: 0,
									tokens: { input: 0, output: 0 },
									durationMs: 0,
									providerStateUpdates: [],
								} satisfies TurnResult;
							}),
					},
				]);
				const options = {
					sql,
					write: commit.write,
					registry,
					ingestion,
					projectContext: () => current,
				};
				yield* new ProviderSideEffectReactor(options)
					.runOnce()
					.pipe(Effect.setContext(daemonContext));
				expect(
					yield* sql`SELECT state FROM pending_inputs WHERE input_id = 'steer'`,
				).toEqual([{ state: "queued" }]);
				expect(
					yield* sql`SELECT type FROM events WHERE type = 'input.requeued'`,
				).toEqual([{ type: "input.requeued" }]);
			}).pipe(
				Effect.provide(
					Layer.provideMerge(
						makeProviderRuntimeIngestionLive(),
						makePersistenceEffectLayer(":memory:", "project"),
					),
				),
			),
		);
	});

	it("atomically retires prompts and undelivered controls only for the replaced session process", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES
					('session', 'project', 'claude', 1, 1),
					('neighbor', 'project', 'claude', 1, 1),
					('foreign', 'other-project', 'claude', 1, 1)`;
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, created_at, provider_process_id, provider_request_id)
					VALUES ('old-prompt', 'session', 'permission', 'pending', 1, 'old-process', '0'),
					('live-prompt', 'session', 'question', 'pending', 1, 'current-process', '0')`;
				const cases = [
					{
						id: "pending",
						session: "session",
						project: "project",
						process: "old-process",
						status: "pending",
						type: "resolve_permission",
					},
					{
						id: "running",
						session: "session",
						project: "project",
						process: "old-process",
						status: "running",
						type: "interrupt_turn",
					},
					{
						id: "retrying",
						session: "session",
						project: "project",
						process: "old-process",
						status: "retryable_failed",
						type: "end_session",
					},
					{
						id: "live",
						session: "session",
						project: "project",
						process: "current-process",
						status: "pending",
						type: "resolve_question",
					},
					{
						id: "send",
						session: "session",
						project: "project",
						process: "old-process",
						status: "pending",
						type: "send_turn",
					},
					{
						id: "completed",
						session: "session",
						project: "project",
						process: "old-process",
						status: "completed",
						type: "end_session",
					},
					{
						id: "neighbor",
						session: "neighbor",
						project: "project",
						process: "old-process",
						status: "pending",
						type: "end_session",
					},
					{
						id: "foreign",
						session: "foreign",
						project: "other-project",
						process: "old-process",
						status: "pending",
						type: "end_session",
					},
				];
				for (const [index, item] of cases.entries()) {
					yield* sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, project_key)
						VALUES (${item.id}, ${item.session}, 'side_effect_requested', 1, ${item.project})`;
					yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, provider_process_id, status, requested_at, updated_at, next_attempt_at)
						VALUES (${index + 1}, ${item.id}, ${item.project}, ${item.session}, 'claude', ${item.type}, '{}', ${item.process}, ${item.status}, 1, 1, 5000)`;
				}
				const retire = yield* makeRetireReplacedProcessPrompts;
				expect(yield* retire("current-process", { sessionId: "session" })).toBe(
					1,
				);
				expect(
					yield* sql`SELECT command_id, status FROM provider_command_outbox ORDER BY request_sequence`,
				).toEqual(
					cases.map((item, index) => ({
						command_id: item.id,
						status: index < 3 ? "cancelled" : item.status,
					})),
				);
				expect(
					yield* sql`SELECT command_id, status, error_code, error FROM command_receipts WHERE command_id IN ('pending', 'running', 'retrying') ORDER BY command_id`,
				).toEqual(
					["pending", "retrying", "running"].map((id) => ({
						command_id: id,
						status: "side_effect_failed",
						error_code: "provider_process_gone",
						error: expect.stringContaining("provider process"),
					})),
				);
				expect(
					yield* sql`SELECT id, status FROM pending_approvals ORDER BY id`,
				).toEqual([
					{ id: "live-prompt", status: "pending" },
					{ id: "old-prompt", status: "resolved" },
				]);
				expect(yield* retire(null, { sessionId: "session" })).toBe(1);
				expect(
					yield* sql`SELECT status, error_code, next_attempt_at FROM provider_command_outbox WHERE command_id = 'live'`,
				).toEqual([
					{
						status: "cancelled",
						error_code: "provider_process_gone",
						next_attempt_at: null,
					},
				]);
				expect(yield* retire(null, { sessionId: "session" })).toBe(0);
				expect(yield* retire(null, { providerInstanceIds: ["claude"] })).toBe(
					0,
				);
				expect(
					yield* sql`SELECT command_id, status FROM provider_command_outbox WHERE command_id IN ('neighbor', 'foreign') ORDER BY command_id`,
				).toEqual([
					{ command_id: "foreign", status: "pending" },
					{ command_id: "neighbor", status: "cancelled" },
				]);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "project")),
			),
		);
	});

	it("rolls back control cancellation when the prompt retirement cannot commit", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('session', 'project', 'claude', 1, 1)`;
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, created_at, provider_process_id)
					VALUES ('prompt', 'session', 'permission', 'pending', 1, 'old-process')`;
				yield* sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, project_key) VALUES ('control', 'session', 'side_effect_requested', 1, 'project')`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, provider_process_id, status, requested_at, updated_at)
					VALUES (1, 'control', 'project', 'session', 'claude', 'end_session', '{}', 'old-process', 'pending', 1, 1)`;
				yield* sql`CREATE TRIGGER refuse_resolution BEFORE INSERT ON events WHEN NEW.type = 'permission.resolved'
					BEGIN SELECT RAISE(FAIL, 'resolution not committed'); END`;
				const retire = yield* makeRetireReplacedProcessPrompts;
				expect(
					(yield* retire(null, { sessionId: "session" }).pipe(Effect.result))
						._tag,
				).toBe("Failure");
				expect(yield* sql`SELECT status FROM provider_command_outbox`).toEqual([
					{ status: "pending" },
				]);
				expect(yield* sql`SELECT status FROM command_receipts`).toEqual([
					{ status: "side_effect_requested" },
				]);
				expect(yield* sql`SELECT status FROM pending_approvals`).toEqual([
					{ status: "pending" },
				]);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "project")),
			),
		);
	});

	it("refuses unstarted project commands and leaves started runs for recovery", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				for (const [index, status] of ["pending", "running"].entries()) {
					yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at)
						VALUES (${status}, 'project', 'claude', 1, 1)`;
					yield* commit([
						canonicalEvent(
							"run.requested",
							status,
							{ runId: `run:${status}`, inputId: `command:${status}` },
							{ metadata: { runId: `run:${status}` } },
						),
					]);
					if (status === "running")
						yield* sql`UPDATE provider_runs SET status = 'running', started_at = 2 WHERE id = ${`run:${status}`}`;
					yield* sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, project_key)
						VALUES (${`command:${status}`}, ${status}, 'side_effect_requested', 1, 'project')`;
					// A started send has a current outbox claim. A preceding run's
					// projection alone cannot claim a pending retry on its behalf.
					yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at)
						VALUES (${index + 1}, ${`command:${status}`}, 'project', ${status}, 'claude', 'send_turn', '{}', ${`run:${status}`}, ${status}, ${index}, 1, 1)`;
				}
				const reactor = new ProviderSideEffectReactor({
					sql,
					write: commit.write,
					registry: new ProviderRegistry(),
					ingestion: {
						ingest: () =>
							Effect.die(new Error("Refusal must bypass ingestion")),
						ingestBatch: () =>
							Effect.die(new Error("Refusal must bypass ingestion")),
					},
					isProjectReady: () =>
						Effect.fail(
							new ProviderInstanceFailure({
								providerId: "claude",
								operation: "executeCommand",
								code: "project_unavailable",
								cause: new Error("Project is unavailable"),
							}),
						),
				});
				expect(yield* reactor.runOnce()).toBe(1);
				expect(yield* reactor.runOnce()).toBe(0);
				expect(
					yield* sql`SELECT id, status FROM provider_runs ORDER BY id`,
				).toEqual([
					{ id: "run:pending", status: "error" },
					{ id: "run:running", status: "running" },
				]);
				expect(
					yield* sql`SELECT status, error_code FROM command_receipts ORDER BY command_id`,
				).toEqual([
					{ status: "side_effect_failed", error_code: "project_unavailable" },
					{ status: "side_effect_requested", error_code: null },
				]);
				expect(
					yield* sql`SELECT status, error_code FROM provider_command_outbox ORDER BY command_id`,
				).toEqual([
					{ status: "failed", error_code: "project_unavailable" },
					{ status: "running", error_code: null },
				]);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "project")),
			),
		);
	});

	// Claimed intake can outlive its start projection. Removal, native completion,
	// registration and unverifiable ownership can all race the refusal sweep.
	it.each([
		"live",
		"finished",
		"readded",
		"quarantined",
	] as const)("sweeps claimed intake with %s runner ownership without synthetic terminals", async (owner) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('session', 'project', 'claude', 1, 1)`;
				yield* commit([
					canonicalEvent(
						"run.requested",
						"session",
						{ runId: "run", inputId: "send" },
						{ metadata: { runId: "run" } },
					),
				]);
				yield* sql`INSERT INTO command_receipts (command_id, session_id, status, created_at, project_key) VALUES ('send', 'session', 'side_effect_requested', 1, 'project')`;
				yield* sql`INSERT INTO provider_command_outbox (request_sequence, command_id, project_key, session_id, provider_id, effect_type, payload_json, run_id, status, attempt_count, requested_at, updated_at)
				VALUES (1, 'send', 'project', 'session', 'claude', 'send_turn', '{}', 'run', 'running', 1, 1, 1)`;
				let registered = false;
				let alive = true;
				let ends = 0;
				const registry = new ProviderRegistry([
					{
						providerId: "claude",
						generateTextEffect: () => Effect.die("unused"),
						discoverEffect: () => Effect.die("unused"),
						interruptTurnEffect: () => Effect.void,
						sendTurnEffect: () =>
							Effect.die("A claimed send must not be redelivered"),
						resolvePermissionEffect: () => Effect.void,
						resolveQuestionEffect: () => Effect.void,
						shutdownEffect: () => Effect.void,
						hasLiveProcessEffect: () =>
							Effect.sync(() => {
								if (owner === "readded") registered = true;
								return alive;
							}),
						getControlProcessIdEffect: () =>
							owner === "quarantined"
								? Effect.fail(
										new ProviderInstanceFailure({
											providerId: "claude",
											operation: "getControlProcessId",
											code: "provider_process_unavailable",
											cause: "Unverified live owner",
										}),
									)
								: Effect.succeed("process"),
						endSessionEffect: () =>
							Effect.gen(function* () {
								ends++;
								alive = false;
								if (owner === "finished")
									yield* commit([
										canonicalEvent(
											"turn.completed",
											"session",
											{
												messageId: "reply",
												cost: 0,
												tokens: { input: 0, output: 0 },
											},
											{ provider: "claude", metadata: { runId: "run" } },
										),
									]);
							}).pipe(Effect.orDie),
					},
				]);
				const reactor = new ProviderSideEffectReactor({
					sql,
					write: commit.write,
					registry,
					ingestion: {
						ingest: () => Effect.die("unused"),
						ingestBatch: () => Effect.die("unused"),
					},
					isProjectReady: () =>
						registered
							? Effect.succeed(false)
							: Effect.fail(
									new ProviderInstanceFailure({
										providerId: "claude",
										operation: "executeCommand",
										code: "project_inactive",
										cause: "Removed project",
									}),
								),
				});
				yield* reactor.drain();
				expect(ends).toBe(owner === "live" || owner === "finished" ? 1 : 0);
				expect(
					yield* sql`SELECT type FROM events WHERE type IN ('turn.error', 'turn.completed', 'turn.interrupted', 'turn.cancelled')`,
				).toEqual(owner === "finished" ? [{ type: "turn.completed" }] : []);
				const outcome =
					yield* sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'send'`;
				expect(outcome).toEqual(
					owner === "readded"
						? [{ status: "running", error_code: null }]
						: owner === "finished"
							? [{ status: "completed", error_code: null }]
							: [{ status: "cancelled", error_code: "project_inactive" }],
				);
				yield* new ProviderSideEffectReactor({
					sql,
					write: commit.write,
					registry,
					ingestion: {
						ingest: () => Effect.die("unused"),
						ingestBatch: () => Effect.die("unused"),
					},
					isProjectReady: () =>
						registered
							? Effect.succeed(false)
							: Effect.fail(
									new ProviderInstanceFailure({
										providerId: "claude",
										operation: "executeCommand",
										code: "project_inactive",
										cause: "Removed project",
									}),
								),
				}).drain();
				expect(
					yield* sql`SELECT status, error_code FROM provider_command_outbox WHERE command_id = 'send'`,
				).toEqual(outcome);
				expect(ends).toBe(owner === "live" || owner === "finished" ? 1 : 0);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "project")),
			),
		);
	});

	it("backfills legacy answers for every project with their durable project owner", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				for (const projectId of ["project", "other-project"]) {
					const sessionId = `session:${projectId}`;
					const requestId = `permission:${projectId}`;
					yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at)
						VALUES (${sessionId}, ${projectId}, 'claude', 1, 1)`;
					yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, created_at, provider_process_id)
						VALUES (${requestId}, ${sessionId}, 'permission', 'resolved', 1, ${`runner:${projectId}`})`;
					yield* sql`INSERT INTO events (event_id, project_id, session_id, stream_version, type, data, metadata, provider, created_at)
						VALUES (${`resolution:${projectId}`}, ${projectId}, ${sessionId}, 1, 'permission.resolved',
							${JSON.stringify({ id: requestId, decision: "once" })},
							${JSON.stringify({ commandId: `answer:${projectId}` })}, 'claude', 1)`;
				}
				const options = { sql, write: commit.write };
				expect(yield* backfillLegacyControlAnswers(options)).toBe(2);
				expect(yield* backfillLegacyControlAnswers(options)).toBe(0);
				expect(
					yield* sql`SELECT outbox.command_id, outbox.project_key, receipt.project_key AS receipt_project
						FROM provider_command_outbox outbox JOIN command_receipts receipt ON receipt.command_id = outbox.command_id
						ORDER BY outbox.request_sequence`,
				).toEqual(
					["project", "other-project"].map((projectId) => ({
						command_id: `answer:${projectId}`,
						project_key: projectId,
						receipt_project: projectId,
					})),
				);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "project")),
			),
		);
	});

	it("backfills legacy committed answers once without resolving prompts again or losing permission updates", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('session', 'project', 'claude-account', 1, 1), ('foreign', 'other-project', 'claude', 1, 1)`;
				yield* sql`CREATE TABLE claude_runner_permission_replies (session_id TEXT, request_id TEXT, response_json TEXT, PRIMARY KEY(session_id, request_id))`;
				const response = {
					decision: "always",
					permissionUpdates: [
						{ type: "setMode", mode: "acceptEdits", destination: "session" },
					],
				};
				yield* sql`INSERT INTO claude_runner_permission_replies VALUES ('session', 'permission', ${JSON.stringify(response)})`;
				yield* sql`INSERT INTO pending_approvals (id, session_id, type, status, created_at, provider_process_id, provider_request_id) VALUES
					('permission', 'session', 'permission', 'pending', 1, 'runner-original', 'native-permission'),
					('question', 'session', 'question', 'pending', 1, 'runner-original', 'native-question'),
					('expired', 'session', 'permission', 'pending', 1, 'runner-old', 'native-expired'),
					('durable', 'session', 'permission', 'pending', 1, 'runner-original', 'native-durable'),
					('foreign', 'foreign', 'permission', 'pending', 1, 'foreign-runner', 'native-foreign')`;
				const question = canonicalEvent("question.resolved", "session", {
					id: "question",
					answers: {},
				});
				yield* commit([
					canonicalEvent(
						"permission.resolved",
						"session",
						{ id: "permission", decision: "once" },
						{
							metadata: { commandId: "earlier-legacy-command" },
							provider: "claude",
						},
					),
					canonicalEvent(
						"permission.resolved",
						"session",
						{ id: "permission", decision: "always" },
						{
							metadata: { commandId: "legacy-permission-command" },
							provider: "claude",
						},
					),
					question,
					canonicalEvent(
						"permission.resolved",
						"session",
						{ id: "expired", decision: "reject" },
						{ metadata: { source: "provider-process-expired" } },
					),
					canonicalEvent(
						"permission.resolved",
						"session",
						{ id: "durable", decision: "once" },
						{ metadata: { source: "conduit.control-outbox" } },
					),
				]);
				yield* sql`INSERT INTO events (event_id, session_id, stream_version, type, data, metadata, provider, created_at)
					VALUES ('foreign-resolution', 'foreign', 1, 'permission.resolved', '{"id":"foreign","decision":"once"}', '{}', 'claude', 1)`;
				const options = { sql, projectId: "project", write: commit.write };
				expect(yield* backfillLegacyControlAnswers(options)).toBe(2);
				expect(yield* backfillLegacyControlAnswers(options)).toBe(0);
				expect(
					yield* sql`SELECT COUNT(*) AS n FROM events WHERE type IN ('permission.resolved', 'question.resolved')`,
				).toEqual([{ n: 6 }]);
				const outbox = yield* sql<{
					command_id: string;
					provider_id: string;
					provider_process_id: string;
					payload_json: string;
				}>`SELECT command_id, provider_id, provider_process_id, payload_json FROM provider_command_outbox ORDER BY request_sequence`;
				expect(
					outbox.map((row) => ({
						...row,
						payload_json: JSON.parse(row.payload_json),
					})),
				).toEqual([
					{
						command_id: "legacy-permission-command",
						provider_id: "claude-account",
						provider_process_id: "runner-original",
						payload_json: {
							type: "resolve_permission",
							sessionId: "session",
							providerProcessId: "runner-original",
							requestId: "permission",
							nativeRequestId: "native-permission",
							decision: "always",
							response,
						},
					},
					{
						command_id: `legacy-answer:${question.eventId}`,
						provider_id: "claude-account",
						provider_process_id: "runner-original",
						payload_json: {
							type: "resolve_question",
							sessionId: "session",
							providerProcessId: "runner-original",
							requestId: "question",
							nativeRequestId: "native-question",
							answers: {},
							operation: "reject",
						},
					},
				]);
				expect(
					yield* sql`SELECT status FROM command_receipts ORDER BY command_id`,
				).toEqual([
					{ status: "side_effect_requested" },
					{ status: "side_effect_requested" },
				]);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "project")),
			),
		);
	});
});
