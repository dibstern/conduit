import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient, Statement } from "effect/sql";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	CommandReadModelRepository,
	isCommandScopeTombstoned,
} from "../../../src/lib/provider/orchestration-read-model.js";

describe("CommandReadModelRepository", () => {
	it.effect(
		"bootstraps command receipts without loading UI projection tables",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO command_receipts (project_key, command_id, session_id, status, result_sequence, error, created_at)
					VALUES
						('test-project', 'cmd-1', 'session-1', 'side_effect_requested', NULL, NULL, 1000),
						('test-project', 'cmd-2', 'session-2', 'side_effect_completed', 42, NULL, 2000)`;
				yield* sql`
					INSERT INTO events (sequence, event_id, session_id, stream_version, type, data, provider, created_at)
					VALUES (42, 'evt-42', 'session-2', 0, 'session.created', '{}', 'claude', 2000)`;

				const queries: string[] = [];
				const snapshot = yield* new CommandReadModelRepository(
					sql,
					"test-project",
				)
					.bootstrap()
					.pipe(
						Effect.provideService(Statement.CurrentTransformer, (statement) =>
							Effect.sync(() => {
								queries.push(statement.compile()[0]);
								return statement;
							}),
						),
					);

				expect(snapshot.lastEventSequence).toBe(42);
				expect(snapshot.receipts.get("cmd-1")).toMatchObject({
					commandId: "cmd-1",
					sessionId: "session-1",
					status: "side_effect_requested",
				});
				expect(snapshot.receipts.get("cmd-2")).toMatchObject({
					commandId: "cmd-2",
					resultSequence: 42,
					status: "side_effect_completed",
				});
				expect(isCommandScopeTombstoned(snapshot, "session", "session-1")).toBe(
					false,
				);

				const queryText = queries.join("\n");
				expect(queryText).toContain("command_receipts");
				expect(queryText).toContain("events");
				expect(queryText).not.toMatch(
					/\b(sessions|messages|message_parts|turns|pending_approvals)\b/,
				);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
	);

	it.effect("bootstraps only its project's receipts and tombstones", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO command_receipts
				(project_key, command_id, session_id, status, created_at)
				VALUES ('project-a', 'a-command', 'a-session', 'side_effect_requested', 1000),
					('project-b', 'b-command', 'b-session', 'side_effect_requested', 1000)`;
			yield* sql`INSERT INTO provider_command_tombstones
				(project_key, scope_kind, scope_id, event_sequence, reason_code, tombstoned_at)
				VALUES ('project-a', 'session', 'a-session', 1, 'deleted', 1000),
					('project-b', 'session', 'b-session', 2, 'deleted', 1000)`;
			const snapshot = yield* new CommandReadModelRepository(
				sql,
				"project-a",
			).bootstrap();
			expect([...snapshot.receipts.keys()]).toEqual(["a-command"]);
			expect(isCommandScopeTombstoned(snapshot, "session", "a-session")).toBe(
				true,
			);
			expect(isCommandScopeTombstoned(snapshot, "session", "b-session")).toBe(
				false,
			);
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(":memory:", "project-a")),
		),
	);
});
