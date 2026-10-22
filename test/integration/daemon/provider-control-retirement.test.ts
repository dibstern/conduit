import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { makeRetireReplacedProcessPrompts } from "../../../src/lib/persistence/effect/retire-pending-prompts.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { backfillLegacyControlAnswers } from "../../../src/lib/provider/legacy-control-outbox.js";

describe("provider process control retirement", () => {
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
