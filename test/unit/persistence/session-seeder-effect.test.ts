import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import { EffectSessionSeeder } from "../../../src/lib/persistence/effect/session-seeder-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const testLayer = EffectSqliteClient.layer({ filename: ":memory:" });

describe("EffectSessionSeeder", () => {
	it.effect(
		"a fresh seeder honours durable deletions, including cascaded children and absent ids",
		() =>
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", "parent", {
						sessionId: "parent",
						title: "Parent",
						provider: "opencode",
					}),
					canonicalEvent("session.created", "child", {
						sessionId: "child",
						parentId: "parent",
						title: "Child",
						provider: "opencode",
					}),
				]);
				yield* commit([
					canonicalEvent("session.deleted", "parent", { sessionId: "parent" }),
					canonicalEvent("session.deleted", "never-seeded", {
						sessionId: "never-seeded",
					}),
				]);
				const seeder = new EffectSessionSeeder();
				for (const id of ["parent", "child", "never-seeded"])
					expect(yield* seeder.ensureSession(id, "opencode")).toBe(false);
				const sql = yield* SqlClient.SqlClient;
				expect(yield* sql`SELECT id FROM sessions`).toEqual([]);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
	);

	it.effect("keeps a live child whose former sidebar row is a tombstone", () =>
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			yield* commit([
				canonicalEvent("session.created", "parent", {
					sessionId: "parent",
					title: "Parent",
					provider: "opencode",
				}),
				canonicalEvent("session.created", "child", {
					sessionId: "child",
					title: "Child",
					provider: "opencode",
				}),
				canonicalEvent("session.created", "child", {
					sessionId: "child",
					title: "Child",
					provider: "opencode",
					parentId: "parent",
				}),
			]);
			expect(
				yield* new EffectSessionSeeder().ensureSession("child", "opencode"),
			).toBe(true);
			const sql = yield* SqlClient.SqlClient;
			expect(
				yield* sql`SELECT parent_id FROM sessions WHERE id = 'child'`,
			).toEqual([{ parent_id: "parent" }]);
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
		),
	);

	it.effect("creates an idle session row with the current time", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			const sql = yield* SqlClient.SqlClient;
			const seeder = new EffectSessionSeeder();

			const before = Date.now();
			expect(yield* seeder.ensureSession("sess-1", "opencode")).toBe(true);
			const after = Date.now();

			const [row] = yield* sql<{
				id: string;
				provider: string;
				status: string;
				created_at: number;
				updated_at: number;
			}>`SELECT id, provider, status, created_at, updated_at FROM sessions WHERE id = 'sess-1'`;
			expect(row).toMatchObject({
				id: "sess-1",
				provider: "opencode",
				status: "idle",
			});
			expect(row?.created_at).toBeGreaterThanOrEqual(before);
			expect(row?.created_at).toBeLessThanOrEqual(after);
			expect(row?.updated_at).toBe(row?.created_at);
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("is idempotent and never overwrites existing session data", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			const sql = yield* SqlClient.SqlClient;
			yield* new EffectSessionSeeder().ensureSession("sess-1", "opencode");
			yield* sql`UPDATE sessions SET title = 'Custom Title' WHERE id = 'sess-1'`;

			// A fresh seeder has an empty cache, so this really reaches SQL.
			yield* new EffectSessionSeeder().ensureSession("sess-1", "claude");

			const rows = yield* sql<{
				title: string;
				provider: string;
			}>`SELECT title, provider FROM sessions WHERE id = 'sess-1'`;
			expect(rows).toEqual([{ title: "Custom Title", provider: "opencode" }]);
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("creates sessions with different providers", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			const sql = yield* SqlClient.SqlClient;
			const seeder = new EffectSessionSeeder();
			yield* seeder.ensureSession("sess-1", "opencode");
			yield* seeder.ensureSession("sess-2", "claude");

			const rows = yield* sql<{
				id: string;
				provider: string;
			}>`SELECT id, provider FROM sessions ORDER BY id`;
			expect(rows).toEqual([
				{ id: "sess-1", provider: "opencode" },
				{ id: "sess-2", provider: "claude" },
			]);
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("stores optional parent and provider session ids", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			const sql = yield* SqlClient.SqlClient;
			const seeder = new EffectSessionSeeder();
			yield* seeder.ensureSession("parent-session", "claude");
			yield* seeder.ensureSession("claude-subagent-abc", "claude", {
				parentId: "parent-session",
				providerSessionId: "sdk-subagent-1",
			});

			const rows = yield* sql<{
				parent_id: string | null;
				provider_sid: string | null;
			}>`SELECT parent_id, provider_sid FROM sessions WHERE id = 'claude-subagent-abc'`;
			expect(rows).toEqual([
				{ parent_id: "parent-session", provider_sid: "sdk-subagent-1" },
			]);
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("skips SQL for a cached session until reset()", () =>
		Effect.gen(function* () {
			yield* makeEffectSqlMigrator();
			const sql = yield* SqlClient.SqlClient;
			const seeder = new EffectSessionSeeder();
			const countRows = sql<{
				n: number;
			}>`SELECT COUNT(*) AS n FROM sessions WHERE id = 'sess-1'`;

			yield* seeder.ensureSession("sess-1", "opencode");
			yield* sql`DELETE FROM sessions WHERE id = 'sess-1'`;
			expect(yield* seeder.ensureSession("sess-1", "opencode")).toBe(false);
			expect((yield* countRows)[0]?.n).toBe(0);

			seeder.reset();
			expect(yield* seeder.ensureSession("sess-1", "opencode")).toBe(true);
			expect((yield* countRows)[0]?.n).toBe(1);
		}).pipe(Effect.provide(testLayer)),
	);
});
