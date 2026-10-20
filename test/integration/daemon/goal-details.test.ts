// Failure modes: judge metadata lost in SDK normalization or persistence,
// checks confused with turns, final met checks dropped, and restart hydration
// losing the model or allowing later turns to change completed-goal totals.
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { decodeClaudeSDKMessage } from "../../../src/lib/contracts/providers/claude-agent-sdk.js";
import {
	hydrateSessionGoal,
	sessionGoals,
} from "../../../src/lib/frontend/stores/goal.svelte.js";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	ReadQueryEffectTag,
	sessionGoalState,
	sessionRowsToSessionInfoList,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { ClaudeEventTranslator } from "../../../src/lib/provider/claude/claude-event-translator.js";
import { ClaudeGoalTracker } from "../../../src/lib/provider/claude/claude-goal-tracker.js";
import type { ClaudeSessionContext } from "../../../src/lib/provider/claude/types.js";
import { translateProviderRuntimeEventToDomain } from "../../../src/lib/provider/provider-runtime-event-to-domain.js";
import type { EventSink } from "../../../src/lib/provider/types.js";
import { partialFake } from "../../helpers/partial-fake.js";

const testLayer = makePersistenceEffectLayer(":memory:", "test-project");

describe("daemon goal details data path", () => {
	it.effect(
		"projects a stuck header after three SDK checks and clears it when met",
		() =>
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				const read = yield* ReadQueryEffectTag;
				const sessionId = "synthetic-stuck-header";
				yield* commit([
					canonicalEvent(
						"session.created",
						sessionId,
						{ sessionId, title: "Synthetic goal", provider: "claude" },
						{ provider: "claude", createdAt: 1 },
					),
				]);
				let at = 100;
				const sink = partialFake<EventSink>({
					push: (event) =>
						event.type === "session.goal_changed"
							? commit(
									translateProviderRuntimeEventToDomain(event).events.map(
										(fact) => ({ ...fact, createdAt: (at += 100) }),
									),
								).pipe(Effect.asVoid)
							: Effect.void,
				});
				const ctx = partialFake<ClaudeSessionContext>({
					sessionId,
					workspaceRoot: "/tmp/synthetic-goal",
					startedAt: "2026-10-20T00:00:00Z",
					pendingApprovals: new Map(),
					pendingQuestions: new Map(),
					inFlightTools: new Map(),
					eventSink: sink,
					resumeSessionId: "synthetic-sdk-goal",
					turnCount: 0,
					stopped: false,
				});
				const translator = new ClaudeEventTranslator({ getSink: () => sink });
				for (let iterations = 1; iterations <= 3; iterations++) {
					yield* translator.translate(
						ctx,
						decodeClaudeSDKMessage({
							type: "active_goal",
							uuid: `synthetic-check-${iterations}`,
							session_id: "synthetic-sdk-goal",
							value: {
								condition: "Publish the synthetic release",
								iterations,
								set_at: 100,
								tokens_at_start: 0,
								last_reason:
									"Synthetic release review approval is missing and prevents publication.",
							},
						}),
					);
					const row = yield* read.getSession(sessionId);
					if (!row) throw new Error("Missing synthetic goal session");
					expect(sessionRowsToSessionInfoList([row])[0]?.goalStuck).toEqual(
						iterations < 3 ? undefined : { since: 200, lastAt: 400, count: 3 },
					);
				}
				yield* commit([
					canonicalEvent(
						"session.goal_changed",
						sessionId,
						{
							sessionId,
							goal: null,
							ended: "met",
							endedGoal: {
								condition: "Publish the synthetic release",
								iterations: 4,
								setAt: 100,
								tokensAtStart: 0,
								lastReason: "The synthetic release is published.",
							},
							endedAt: 500,
						},
						{ provider: "claude", createdAt: 500 },
					),
				]);
				const row = yield* read.getSession(sessionId);
				if (!row) throw new Error("Missing completed synthetic goal session");
				expect(
					sessionRowsToSessionInfoList([row])[0]?.goalStuck,
				).toBeUndefined();
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"persists the reported judge and check turn through completion and hydration",
		() =>
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				const sql = yield* SqlClient.SqlClient;
				const read = yield* ReadQueryEffectTag;
				const sessionId = "goal-metadata";
				yield* commit([
					canonicalEvent(
						"session.created",
						sessionId,
						{ sessionId, title: "Goal", provider: "claude" },
						{ provider: "claude", createdAt: 1 },
					),
				]);
				yield* sql`INSERT INTO turns (id, session_id, state, requested_at, started_at, completed_at)
				VALUES ('before', ${sessionId}, 'completed', 1, 1, 10),
				('first', ${sessionId}, 'completed', 90, 90, 150),
				('second', ${sessionId}, 'running', 160, 160, NULL),
				('queued', ${sessionId}, 'pending', 170, NULL, NULL)`;
				const sink = partialFake<EventSink>({
					push: (event) =>
						event.type === "session.goal_changed"
							? commit(
									translateProviderRuntimeEventToDomain(event).events.map(
										(fact) => ({ ...fact, createdAt: 200 }),
									),
								).pipe(Effect.asVoid)
							: Effect.void,
				});
				const ctx = partialFake<ClaudeSessionContext>({
					sessionId,
					workspaceRoot: "/tmp/goal-metadata",
					startedAt: "2026-10-16T00:00:00Z",
					pendingApprovals: new Map(),
					pendingQuestions: new Map(),
					inFlightTools: new Map(),
					eventSink: sink,
					currentTurnId: "second",
					currentModel: "working-model",
					resumeSessionId: "sdk-goal",
					turnCount: 0,
					stopped: false,
				});
				const translator = new ClaudeEventTranslator({
					getSink: () => sink,
					readGoalStatus: async () => ({
						met: true,
						condition: "Ship it",
						judgeModel: "claude-sonnet-5",
						reason: "All green",
					}),
				});
				const activeGoal = (iterations: number, uuid: string) =>
					decodeClaudeSDKMessage({
						type: "active_goal",
						uuid,
						session_id: "sdk-goal",
						value: {
							condition: "Ship it",
							iterations,
							set_at: 100,
							tokens_at_start: 0,
							judge_model: "claude-sonnet-5",
							last_reason: "Still failing",
						},
					});
				yield* translator.translate(ctx, activeGoal(1, "check-one"));
				yield* translator.translate(ctx, activeGoal(1, "resync"));
				const checked = yield* read.getGoalDetails(sessionId);
				expect(checked).toMatchObject({
					judgeModel: "claude-sonnet-5",
					setAt: 100,
					metAt: null,
					turnCount: 2,
					checks: [
						{
							iteration: 1,
							turnIndex: 3,
							judgeModel: "claude-sonnet-5",
							reason: "Still failing",
						},
					],
				});
				const row = yield* read.getSession(sessionId);
				if (!row) throw new Error("Missing goal session");
				const facts = sessionGoalState(row);
				expect(facts.goal).toMatchObject({
					judgeModel: "claude-sonnet-5",
					turnCount: 2,
				});
				hydrateSessionGoal(
					partialFake<SessionInfo>({ id: sessionId, goalState: facts }),
				);
				expect(sessionGoals.get(sessionId)?.goal).toEqual(facts.goal);
				sessionGoals.delete(sessionId);
				ctx.goalTracker = new ClaudeGoalTracker(sessionId, facts);
				// Newer SDKs clear active_goal before writing the terminal attachment.
				yield* translator.translate(
					ctx,
					decodeClaudeSDKMessage({
						type: "active_goal",
						value: null,
						uuid: "clear",
						session_id: "sdk-goal",
					}),
				);
				yield* translator.translate(
					ctx,
					decodeClaudeSDKMessage({
						type: "result",
						subtype: "success",
						is_error: false,
						result: "",
						session_id: "sdk-goal",
						uuid: "done",
						duration_ms: 1,
						duration_api_ms: 1,
						num_turns: 2,
						total_cost_usd: 0,
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
						modelUsage: {},
						permission_denials: [],
						stop_reason: "end_turn",
					}),
				);
				const met = yield* read.getGoalDetails(sessionId);
				expect(met).toMatchObject({
					judgeModel: "claude-sonnet-5",
					setAt: 100,
					turnCount: 2,
				});
				expect(met.metAt).toBeTypeOf("number");
				expect(met.checks).toEqual([
					{
						iteration: 1,
						turnIndex: 3,
						judgeModel: "claude-sonnet-5",
						at: 200,
						reason: "Still failing",
					},
					{
						iteration: 2,
						turnIndex: 3,
						judgeModel: "claude-sonnet-5",
						at: 200,
						reason: "All green",
					},
				]);
				const laterAt = (met.metAt ?? 0) + 1;
				yield* sql`INSERT INTO turns (id, session_id, state, requested_at, started_at) VALUES ('later', ${sessionId}, 'running', ${laterAt}, ${laterAt})`;
				expect(yield* read.getGoalDetails(sessionId)).toEqual(met);
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"keeps unknown judge metadata empty and isolates replaced goals even at the same timestamp",
		() =>
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				const read = yield* ReadQueryEffectTag;
				const sessionId = "unknown-judge";
				yield* commit([
					canonicalEvent(
						"session.created",
						sessionId,
						{
							sessionId,
							title: "Goal",
							provider: "claude",
						},
						{ provider: "claude", createdAt: 1 },
					),
					canonicalEvent(
						"session.model_changed",
						sessionId,
						{ sessionId, modelId: "working-model", providerId: "anthropic" },
						{ provider: "claude", createdAt: 2 },
					),
					canonicalEvent(
						"session.goal_changed",
						sessionId,
						{
							sessionId,
							goal: {
								condition: "First",
								iterations: 1,
								setAt: 100,
								tokensAtStart: 0,
							},
						},
						{ provider: "claude", createdAt: 200 },
					),
				]);
				expect(yield* read.getGoalDetails(sessionId)).toEqual({
					judgeModel: null,
					setAt: 100,
					metAt: null,
					turnCount: 0,
					tokensSinceStart: 0,
					checks: [
						{
							iteration: 1,
							at: 200,
							reason: null,
							judgeModel: null,
							turnIndex: null,
						},
					],
				});
				yield* commit([
					canonicalEvent(
						"session.goal_changed",
						sessionId,
						{
							sessionId,
							goal: {
								condition: "Replacement",
								iterations: 0,
								setAt: 100,
								tokensAtStart: 0,
							},
						},
						{ provider: "claude", createdAt: 300 },
					),
				]);
				expect((yield* read.getGoalDetails(sessionId)).checks).toEqual([]);
			}).pipe(Effect.provide(testLayer)),
	);
});
