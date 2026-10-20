import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import type { SessionGoalChangedPayload } from "../../../src/lib/contracts/stored-event.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	ReadQueryEffectTag,
	sessionRowsToSessionInfoList,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const testLayer = makePersistenceEffectLayer(":memory:", "test-project");
const goal = {
	condition: "Publish the synthetic release",
	iterations: 0,
	setAt: 100,
	tokensAtStart: 0,
};
const reason =
	"Synthetic release approval is missing; the review board must approve the release.";
const createSession = (sessionId = "selected") =>
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
const repeat = (sessionId = "selected", selectedGoal = goal) =>
	Effect.gen(function* () {
		for (let iteration = 1; iteration <= 3; iteration++) {
			yield* changeGoal(
				{
					sessionId,
					goal: { ...selectedGoal, iterations: iteration, lastReason: reason },
				},
				100 + iteration * 100,
			);
		}
	});
const header = (sessionId = "selected") =>
	Effect.gen(function* () {
		const row = yield* (yield* ReadQueryEffectTag).getSession(sessionId);
		if (!row) throw new Error("Missing synthetic session");
		return sessionRowsToSessionInfoList([row])[0]?.goalStuck;
	});

describe("persisted goal stuck header", () => {
	it.effect(
		"publishes goalStuck with the third repeated check and clears it on progress",
		() =>
			Effect.gen(function* () {
				yield* createSession();
				for (let iteration = 1; iteration <= 3; iteration++) {
					yield* changeGoal(
						{
							sessionId: "selected",
							goal: { ...goal, iterations: iteration, lastReason: reason },
						},
						100 + iteration * 100,
					);
					expect(yield* header()).toEqual(
						iteration < 3 ? undefined : { since: 200, lastAt: 400, count: 3 },
					);
				}
				yield* changeGoal(
					{
						sessionId: "selected",
						goal: {
							...goal,
							iterations: 4,
							lastReason:
								"Documentation preview is complete; uploading the deployment manifest.",
						},
					},
					500,
				);
				expect(yield* header()).toBeUndefined();
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"keeps goalStuck while paused and clears met, cleared and replaced goals",
		() =>
			Effect.gen(function* () {
				const checked = { ...goal, iterations: 3, lastReason: reason };
				for (const transition of ["met", "cleared", "replaced"] as const) {
					const sessionId = `selected-${transition}`;
					yield* createSession(sessionId);
					yield* repeat(sessionId);
					yield* changeGoal(
						{
							sessionId,
							goal: checked,
							pausedReason: "Synthetic approval is required",
						},
						500,
					);
					expect(yield* header(sessionId)).toEqual({
						since: 200,
						lastAt: 400,
						count: 3,
					});
					yield* changeGoal(
						transition === "replaced"
							? {
									sessionId,
									goal: { ...goal, condition: "Publish another release" },
								}
							: {
									sessionId,
									goal: null,
									ended: transition,
									endedGoal: checked,
									endedAt: 600,
								},
						600,
					);
					expect(yield* header(sessionId)).toBeUndefined();
				}
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"isolates checks by session, setAt and condition and ignores duplicate resyncs",
		() =>
			Effect.gen(function* () {
				yield* createSession();
				yield* createSession("other");
				yield* repeat("other");
				expect(yield* header()).toBeUndefined();
				yield* repeat();
				yield* changeGoal(
					{
						sessionId: "selected",
						goal: { ...goal, iterations: 3, lastReason: reason },
					},
					500,
				);
				expect(yield* header()).toEqual({ since: 200, lastAt: 400, count: 3 });
				yield* changeGoal(
					{
						sessionId: "selected",
						goal: { ...goal, setAt: 600, iterations: 1, lastReason: reason },
					},
					700,
				);
				expect(yield* header()).toBeUndefined();
				yield* changeGoal(
					{
						sessionId: "selected",
						goal: {
							...goal,
							condition: "Another goal",
							iterations: 1,
							lastReason: reason,
						},
					},
					800,
				);
				expect(yield* header()).toBeUndefined();
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect("a projection rebuild produces the same goalStuck", () =>
		Effect.gen(function* () {
			yield* createSession();
			yield* repeat();
			const before = yield* header();
			expect(before).toEqual({ since: 200, lastAt: 400, count: 3 });
			const runner = yield* ProjectionRunnerEffectTag;
			const events = yield* (yield* EventStoreEffectTag).readBySession(
				"selected",
			);
			const sql = yield* SqlClient.SqlClient;
			yield* sql`DELETE FROM sessions WHERE id = 'selected'`;
			yield* runner.projectBatch(events);
			expect(yield* header()).toEqual(before);
		}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"repeated checks match full replay after wording changes and iteration gaps",
		() =>
			Effect.gen(function* () {
				yield* createSession();
				yield* repeat();
				for (let iterations = 4; iterations <= 6; iterations++) {
					yield* changeGoal(
						{
							sessionId: "selected",
							goal: { ...goal, iterations, lastReason: reason },
						},
						100 + iterations * 100,
					);
				}
				expect(yield* header()).toEqual({ since: 200, lastAt: 700, count: 6 });
				yield* changeGoal(
					{
						sessionId: "selected",
						goal: {
							...goal,
							iterations: 7,
							lastReason:
								"The synthetic review board approval is missing, so release publication is blocked.",
						},
					},
					800,
				);
				expect(yield* header()).toEqual({ since: 200, lastAt: 800, count: 7 });
				const before = yield* header();
				const events = yield* (yield* EventStoreEffectTag).readBySession(
					"selected",
				);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`DELETE FROM sessions WHERE id = 'selected'`;
				yield* (yield* ProjectionRunnerEffectTag).projectBatch(events);
				expect(yield* header()).toEqual(before);
				yield* changeGoal(
					{
						sessionId: "selected",
						goal: { ...goal, iterations: 9, lastReason: reason },
					},
					1000,
				);
				expect(yield* header()).toBeUndefined();
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"upgrades existing sessions with a nullable goal_stuck column",
		() =>
			Effect.gen(function* () {
				yield* createSession();
				const sql = yield* SqlClient.SqlClient;
				const rows = yield* sql<{
					goal_stuck: string | null;
				}>`SELECT goal_stuck FROM sessions WHERE id = 'selected'`;
				expect(rows).toEqual([{ goal_stuck: null }]);
			}).pipe(Effect.provide(testLayer)),
	);

	if (process.env["GOAL_STUCK_BENCHMARK"] === "1") {
		it.effect(
			"reports the per-check projection cost with 2500 synthetic checks",
			() =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const commit = yield* makeCommitAndSignal;
					const syntheticReason =
						"The synthetic release cannot be published until the review board approves the deployment manifest. Validation of the staging package and documentation preview is complete, but the review approval is missing. The deployment manifest records the required checks and the package build passed; publication still requires an explicit approval from the synthetic review board. Waiting for approval is the remaining blocker before the release can be published.";
					const scenarios = [
						{
							name: "identical",
							reasons: [syntheticReason, syntheticReason, syntheticReason],
							next: syntheticReason,
						},
						{
							name: "drifting",
							reasons: [
								syntheticReason,
								syntheticReason.replace(
									"cannot be published",
									"remains blocked",
								),
								syntheticReason.replace(
									"review approval is missing",
									"review approval remains outstanding",
								),
							],
							next: syntheticReason.replace(
								"The synthetic release cannot be published",
								"Publication of the synthetic release remains blocked",
							),
						},
					];
					const measurements = [];
					for (const scenario of scenarios) {
						const sessionId = `benchmark-${scenario.name}`;
						yield* createSession(sessionId);
						yield* sql`WITH RECURSIVE checks(iteration) AS (SELECT 1 UNION ALL SELECT iteration + 1 FROM checks WHERE iteration < 2499)
						INSERT INTO session_goal_checks (event_id, session_id, condition, set_at, iterations, reason, created_at)
						SELECT ${sessionId} || iteration, ${sessionId}, ${goal.condition}, ${goal.setAt}, iteration,
						CASE iteration % 3 WHEN 0 THEN ${scenario.reasons[0]} WHEN 1 THEN ${scenario.reasons[1]} ELSE ${scenario.reasons[2]} END,
						100 + iteration FROM checks`;
						const timings: number[] = [];
						const cpuTimings: number[] = [];
						for (let sample = 0; sample < 45; sample++) {
							yield* sql`UPDATE sessions SET goal_state = ${JSON.stringify({ sessionId, goal: { ...goal, iterations: 2499 } })}, goal_stuck = ${JSON.stringify({ since: 101, lastAt: 2599, count: 2499 })} WHERE id = ${sessionId}`;
							yield* sql`DELETE FROM session_goal_checks WHERE session_id = ${sessionId} AND iterations = 2500`;
							const start = performance.now();
							const cpuStart = process.cpuUsage();
							yield* commit([
								canonicalEvent(
									"session.goal_changed",
									sessionId,
									{
										sessionId,
										goal: {
											...goal,
											iterations: 2500,
											lastReason: scenario.next,
										},
									},
									{ provider: "claude", createdAt: 2600 },
								),
							]);
							const cpu = process.cpuUsage(cpuStart);
							if (sample >= 5) {
								timings.push(performance.now() - start);
								cpuTimings.push((cpu.user + cpu.system) / 1000);
							}
						}
						expect(yield* header(sessionId)).toEqual({
							since: 101,
							lastAt: 2600,
							count: 2500,
						});
						const sorted = [...timings].sort((a, b) => a - b);
						const cpuSorted = [...cpuTimings].sort((a, b) => a - b);
						measurements.push({
							name: scenario.name,
							medianMs: sorted[Math.floor(sorted.length / 2)],
							p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
							maxMs: sorted.at(-1),
							cpuMedianMs: cpuSorted[Math.floor(cpuSorted.length / 2)],
							cpuP95Ms: cpuSorted[Math.ceil(cpuSorted.length * 0.95) - 1],
							cpuMaxMs: cpuSorted.at(-1),
							samplesMs: timings,
							cpuSamplesMs: cpuTimings,
						});
					}
					const artifact = {
						checks: 2500,
						reasonCharacters: syntheticReason.length,
						samples: 40,
						warmups: 5,
						node: process.version,
						platform: `${process.platform}/${process.arch}`,
						measurements,
					};
					mkdirSync("test-results", { recursive: true });
					writeFileSync(
						join("test-results", "goal-stuck-projection.json"),
						`${JSON.stringify(artifact, null, 2)}\n`,
					);
					// CPU time isolates projection work from other sessions sharing
					// the host; retain every wall-clock sample in the artifact too.
					for (const measurement of measurements)
						expect(measurement.cpuP95Ms).toBeLessThanOrEqual(30);
				}).pipe(Effect.provide(testLayer)),
		);
	}
});
