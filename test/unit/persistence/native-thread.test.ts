import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { makeEventStoreEffect } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import { makeProviderStateEffect } from "../../../src/lib/persistence/effect/provider-state-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const testLayer = SqliteClient.layer({ filename: ":memory:" });

const setup = Effect.gen(function* () {
	yield* makeEffectSqlMigrator();
	const sql = yield* SqlClient.SqlClient;
	yield* sql`
		INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
		VALUES ('s1', 'personal', 'Test', 'idle', 1, 1), ('s2', 'work', 'Other', 'idle', 1, 1)`;
	const events = yield* makeEventStoreEffect;
	yield* events.appendBatch([
		canonicalEvent("session.created", "s2", {
			sessionId: "s2",
			title: "Other",
			provider: "work",
		}),
		canonicalEvent("session.created", "s1", {
			sessionId: "s1",
			title: "Test",
			provider: "personal",
		}),
		canonicalEvent("session.renamed", "s2", {
			sessionId: "s2",
			title: "Other renamed",
		}),
		canonicalEvent("session.renamed", "s1", {
			sessionId: "s1",
			title: "Test renamed",
		}),
	]);
	return { state: yield* makeProviderStateEffect, events };
});

describe("nativeThread", () => {
	it.effect(
		"upgrades legacy state for the current account covering the session history",
		() =>
			Effect.gen(function* () {
				const { state } = yield* setup;
				yield* state.saveUpdates("s1", [
					{ key: "resumeSessionId", value: "legacy-sdk-session" },
					{ key: "claudeConfigDir", value: "/accounts/personal" },
				]);

				expect(yield* state.nativeThread("s1", "personal")).toEqual({
					configDir: "/accounts/personal",
					resumeSessionId: "legacy-sdk-session",
					firstSequence: 2,
					deliveredThrough: 4,
				});
				expect(yield* state.nativeThread("s1", "work")).toBeUndefined();
				expect(yield* state.nativeThread("s2", "personal")).toBeUndefined();
				expect(
					yield* state.nativeThread("unknown", "personal"),
				).toBeUndefined();
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"keeps each account's native thread and replaces legacy keys on write",
		() =>
			Effect.gen(function* () {
				const { state } = yield* setup;
				yield* state.saveUpdates("s1", [
					{ key: "resumeSessionId", value: "legacy-sdk-session" },
					{ key: "claudeConfigDir", value: "/accounts/legacy" },
					{ key: "turnCount", value: "3" },
				]);
				const personal = {
					configDir: "/accounts/personal",
					resumeSessionId: "personal-sdk-session",
					firstSequence: 2,
					deliveredThrough: 4,
				};
				const work = {
					configDir: "/accounts/work",
					resumeSessionId: "work-sdk-session",
					firstSequence: 4,
					deliveredThrough: 4,
				};
				yield* state.saveUpdates("s1", [
					{ key: "nativeThread:personal", value: JSON.stringify(personal) },
					{ key: "nativeThread:work", value: JSON.stringify(work) },
				]);

				expect(yield* state.nativeThread("s1", "personal")).toEqual(personal);
				expect(yield* state.nativeThread("s1", "work")).toEqual(work);
				expect(yield* state.nativeThread("s2", "work")).toBeUndefined();
				const stored = yield* state.getState("s1");
				expect(stored["resumeSessionId"]).toBeUndefined();
				expect(stored["claudeConfigDir"]).toBeUndefined();
				expect(stored["turnCount"]).toBe("3");
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"records the completed delivery boundary and advances only the receiving account",
		() =>
			Effect.gen(function* () {
				const { state, events } = yield* setup;
				yield* state.saveUpdates("s1", [
					{
						key: "nativeThread:personal",
						value: JSON.stringify({
							configDir: "/accounts/personal",
							resumeSessionId: "personal-sdk-session",
							firstSequence: 0,
							deliveredThrough: 0,
						}),
					},
				]);
				expect(yield* state.nativeThread("s1", "personal")).toEqual({
					configDir: "/accounts/personal",
					resumeSessionId: "personal-sdk-session",
					firstSequence: 2,
					deliveredThrough: 4,
				});

				yield* events.appendBatch([
					canonicalEvent("session.renamed", "s1", {
						sessionId: "s1",
						title: "Next turn",
					}),
					canonicalEvent("session.renamed", "s2", {
						sessionId: "s2",
						title: "Unrelated turn",
					}),
				]);
				yield* state.saveUpdates("s1", [
					{
						key: "nativeThread:work",
						value: JSON.stringify({
							configDir: "/accounts/work",
							resumeSessionId: "work-sdk-session",
							firstSequence: 5,
							deliveredThrough: 0,
						}),
					},
				]);
				expect(yield* state.nativeThread("s1", "work")).toEqual({
					configDir: "/accounts/work",
					resumeSessionId: "work-sdk-session",
					firstSequence: 5,
					deliveredThrough: 5,
				});
				expect(
					(yield* state.nativeThread("s1", "personal"))?.deliveredThrough,
				).toBe(4);

				yield* state.saveUpdates("s1", [
					{
						key: "nativeThread:personal",
						value: JSON.stringify({
							configDir: "/accounts/personal",
							resumeSessionId: "personal-sdk-session",
							firstSequence: 2,
							deliveredThrough: 4,
						}),
					},
				]);
				expect(
					(yield* state.nativeThread("s1", "personal"))?.deliveredThrough,
				).toBe(5);
			}).pipe(Effect.provide(testLayer)),
	);
});
