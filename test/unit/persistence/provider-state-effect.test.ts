import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import { makeProviderStateEffect } from "../../../src/lib/persistence/effect/provider-state-effect.js";

const testLayer = EffectSqliteClient.layer({ filename: ":memory:" });

const setup = Effect.gen(function* () {
	yield* makeEffectSqlMigrator();
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
		VALUES ('s1', 'claude', 'Test', 'idle', 1, 1), ('s2', 'claude', 'Test', 'idle', 1, 1)`;
	return yield* makeProviderStateEffect;
});

describe("ProviderStateEffect", () => {
	it.effect("is empty for an unknown session and a session with no state", () =>
		Effect.gen(function* () {
			const state = yield* setup;
			expect(yield* state.getState("nonexistent")).toEqual({});
			expect(yield* state.getState("s1")).toEqual({});
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("round-trips updates and upserts duplicate keys", () =>
		Effect.gen(function* () {
			const state = yield* setup;
			yield* state.saveUpdates("s1", [
				{ key: "resume_cursor", value: "cursor_v1" },
				{ key: "last_event_id", value: "evt_123" },
			]);
			yield* state.saveUpdates("s1", [
				{ key: "resume_cursor", value: "cursor_v2" },
			]);
			yield* state.saveUpdates("s1", []);

			expect(yield* state.getState("s1")).toEqual({
				resume_cursor: "cursor_v2",
				last_event_id: "evt_123",
			});
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("keeps state isolated between sessions", () =>
		Effect.gen(function* () {
			const state = yield* setup;
			yield* state.saveUpdates("s1", [{ key: "cursor", value: "s1_cursor" }]);
			yield* state.saveUpdates("s2", [{ key: "cursor", value: "s2_cursor" }]);

			expect(yield* state.getState("s1")).toEqual({ cursor: "s1_cursor" });
			expect(yield* state.getState("s2")).toEqual({ cursor: "s2_cursor" });
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"clearState removes one session's state and tolerates empty state",
		() =>
			Effect.gen(function* () {
				const state = yield* setup;
				yield* state.clearState("s1");
				yield* state.saveUpdates("s1", [
					{ key: "key1", value: "val1" },
					{ key: "key1b", value: "val1b" },
				]);
				yield* state.saveUpdates("s2", [{ key: "key2", value: "val2" }]);

				yield* state.clearState("s1");

				expect(yield* state.getState("s1")).toEqual({});
				expect(yield* state.getState("s2")).toEqual({ key2: "val2" });
			}).pipe(Effect.provide(testLayer)),
	);
});
