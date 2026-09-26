import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import { EffectSessionSeeder } from "../../../src/lib/persistence/effect/session-seeder-effect.js";

const testLayer = EffectSqliteClient.layer({ filename: ":memory:" });

describe("EffectSessionSeeder", () => {
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
