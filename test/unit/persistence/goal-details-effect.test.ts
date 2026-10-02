import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import type { SessionGoalChangedPayload } from "../../../src/lib/contracts/stored-event.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const testLayer = makePersistenceEffectLayer(":memory:");
const goal = {
	condition: "All checks pass",
	iterations: 0,
	setAt: 100,
	tokensAtStart: 0,
};

const createSession = (sessionId: string) =>
	Effect.gen(function* () {
		const commit = yield* makeCommitAndSignal;
		yield* commit([
			canonicalEvent(
				"session.created",
				sessionId,
				{ sessionId, title: sessionId, provider: "claude" },
				{ provider: "claude", createdAt: 1 },
			),
		]);
	});

const changeGoal = (facts: SessionGoalChangedPayload, at: number) =>
	Effect.gen(function* () {
		const commit = yield* makeCommitAndSignal;
		yield* commit([
			canonicalEvent("session.goal_changed", facts.sessionId, facts, {
				provider: "claude",
				createdAt: at,
			}),
		]);
	});

// Failure modes: session or goal leakage, timestamp ordering instead of iteration
// ordering, duplicate resync checks, lost ended-goal checks, and token drift from
// dispatch history, including snapshots, missing usage and empty history.
describe("persisted goal details", () => {
	it.effect("excludes checks belonging to another session", () =>
		Effect.gen(function* () {
			yield* createSession("selected");
			yield* createSession("other");
			yield* changeGoal({ sessionId: "selected", goal }, 100);
			yield* changeGoal(
				{ sessionId: "other", goal: { ...goal, iterations: 1 } },
				200,
			);
			const read = yield* ReadQueryEffectTag;
			expect(yield* read.getGoalDetails("selected")).toEqual({
				checks: [],
				tokensSinceStart: 0,
			});
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("excludes checks from a previous goal with a different setAt", () =>
		Effect.gen(function* () {
			yield* createSession("selected");
			yield* changeGoal(
				{ sessionId: "selected", goal: { ...goal, iterations: 1 } },
				200,
			);
			yield* changeGoal(
				{ sessionId: "selected", goal: { ...goal, setAt: 300 } },
				300,
			);
			const read = yield* ReadQueryEffectTag;
			expect(yield* read.getGoalDetails("selected")).toEqual({
				checks: [],
				tokensSinceStart: 0,
			});
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"orders checks by iteration and maps timestamps and nullable reasons",
		() =>
			Effect.gen(function* () {
				yield* createSession("selected");
				yield* changeGoal(
					{ sessionId: "selected", goal: { ...goal, iterations: 1 } },
					400,
				);
				yield* changeGoal(
					{
						sessionId: "selected",
						goal: { ...goal, iterations: 2, lastReason: "One failure remains" },
					},
					300,
				);
				const read = yield* ReadQueryEffectTag;
				expect((yield* read.getGoalDetails("selected")).checks).toEqual([
					{ iteration: 1, at: 400, reason: null },
					{ iteration: 2, at: 300, reason: "One failure remains" },
				]);
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"does not add a check for an unchanged-iteration status resync",
		() =>
			Effect.gen(function* () {
				yield* createSession("selected");
				const checkedGoal = {
					...goal,
					iterations: 1,
					lastReason: "Still failing",
				};
				yield* changeGoal({ sessionId: "selected", goal: checkedGoal }, 200);
				yield* changeGoal(
					{
						sessionId: "selected",
						goal: checkedGoal,
						pausedReason: "Awaiting approval",
					},
					300,
				);
				const read = yield* ReadQueryEffectTag;
				expect((yield* read.getGoalDetails("selected")).checks).toEqual([
					{ iteration: 1, at: 200, reason: "Still failing" },
				]);
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect("retains met-goal checks using endedGoal.setAt", () =>
		Effect.gen(function* () {
			yield* createSession("selected");
			const endedGoal = { ...goal, iterations: 1, lastReason: "All green" };
			yield* changeGoal({ sessionId: "selected", goal: endedGoal }, 200);
			yield* changeGoal(
				{
					sessionId: "selected",
					goal: null,
					ended: "met",
					endedGoal,
					endedAt: 300,
				},
				300,
			);
			const read = yield* ReadQueryEffectTag;
			expect(yield* read.getGoalDetails("selected")).toEqual({
				checks: [{ iteration: 1, at: 200, reason: "All green" }],
				tokensSinceStart: 0,
			});
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect("returns null tokens and no stale checks without a goal", () =>
		Effect.gen(function* () {
			yield* createSession("selected");
			const read = yield* ReadQueryEffectTag;
			expect(yield* read.getGoalDetails("selected")).toEqual({
				checks: [],
				tokensSinceStart: null,
			});
			yield* changeGoal(
				{ sessionId: "selected", goal: { ...goal, iterations: 1 } },
				200,
			);
			yield* changeGoal({ sessionId: "selected", goal: null }, 300);
			expect(yield* read.getGoalDetails("selected")).toEqual({
				checks: [],
				tokensSinceStart: null,
			});
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"sums dispatch-history input, output and cache usage minus tokensAtStart",
		() =>
			Effect.gen(function* () {
				yield* createSession("selected");
				yield* createSession("other");
				yield* changeGoal(
					{ sessionId: "selected", goal: { ...goal, tokensAtStart: 100 } },
					100,
				);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO messages
				(id, session_id, role, text, tokens_in, tokens_out,
				 tokens_cache_read, tokens_cache_write, created_at, updated_at)
				VALUES
				('usage', 'selected', 'assistant', '', 110, 20, 30, 40, 1, 1),
				('missing', 'selected', 'user', '', NULL, NULL, NULL, NULL, 2, 2),
				('other-usage', 'other', 'assistant', '', 999, 999, 999, 999, 1, 1)`;
				const snapshot = JSON.stringify({
					id: "snapshot",
					role: "assistant",
					parts: [],
					tokens: { input: 11, output: 12, cache: { read: 13, write: 14 } },
				});
				yield* sql`INSERT INTO messages
				(id, session_id, role, text, tokens_in, tokens_out, rest_payload, created_at, updated_at)
				VALUES ('snapshot', 'selected', 'assistant', '', 999, 999, ${snapshot}, 3, 3)`;
				const read = yield* ReadQueryEffectTag;
				expect((yield* read.getGoalDetails("selected")).tokensSinceStart).toBe(
					150,
				);
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect("uses zero cumulative usage for empty history", () =>
		Effect.gen(function* () {
			yield* createSession("selected");
			yield* changeGoal({ sessionId: "selected", goal }, 100);
			const read = yield* ReadQueryEffectTag;
			expect((yield* read.getGoalDetails("selected")).tokensSinceStart).toBe(0);
		}).pipe(Effect.provide(testLayer)),
	);
});
