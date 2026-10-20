import { describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, TestClock } from "effect";
import { expect, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/account.js";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../src/lib/contracts/message-surfacing.js";
import type { SessionGoalChangedPayload } from "../../../src/lib/contracts/stored-event.js";
import {
	defaultDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import type { ClaudeOneShotQueryFactory } from "../../../src/lib/domain/daemon/Services/claude-one-shot.js";
import { MessageSurfacingSettings } from "../../../src/lib/domain/daemon/Services/message-surfacing-settings.js";
import {
	GoalSummaryServiceTag,
	makeGoalSummaryServiceLive,
} from "../../../src/lib/domain/relay/Services/goal-summary-service.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { makeMockConfig } from "../../helpers/mock-factories.js";

const reason =
	"The package upload is blocked because the release credential is missing.";
const progress =
	"The package upload succeeded. A design review is still outstanding.";
const goal = {
	condition: "Publish the sample package",
	setAt: 100,
	iterations: 0,
	tokensAtStart: 0,
};
const fixture = (
	response = "The package is built. Upload needs the release credential.",
) => {
	const preferences = {
		...DEFAULT_MESSAGE_SURFACING_SETTINGS,
		recap: { ...DEFAULT_MESSAGE_SURFACING_SETTINGS.recap },
	};
	const config = makeMockConfig({ projectDir: process.cwd() });
	let hold: Promise<void> | undefined;
	let fail = false;
	let text = response;
	const query = vi.fn(async function* (
		_params: Parameters<ClaudeOneShotQueryFactory>[0],
	) {
		const captured = text;
		const capturedFailure = fail;
		if (hold) await hold;
		if (capturedFailure)
			throw new Error("private provider internals must not reach clients");
		yield { type: "result", result: captured };
	});
	const deps = Layer.mergeAll(
		makePersistenceEffectLayer(":memory:", "test-project"),
		Layer.succeed(ConfigTag, config),
		Layer.succeed(MessageSurfacingSettings, {
			get: Effect.sync(() => ({
				...preferences,
				active: false,
				key: { source: "none" as const, rejected: false },
			})),
			update: () => Effect.die("unused"),
			post: () => Effect.die("unused"),
		}),
	);
	return {
		preferences,
		config,
		query,
		setText: (value: string) => {
			text = value;
		},
		setFailure: (value: boolean) => {
			fail = value;
		},
		hold: () => {
			let release = () => {};
			hold = new Promise<void>((resolve) => {
				release = resolve;
			});
			return release;
		},
		unhold: () => {
			hold = undefined;
		},
		live: makeGoalSummaryServiceLive({ queryFactory: query }).pipe(
			Layer.provideMerge(deps),
		),
	};
};
const seed = (sessionId = "summary-goal", count = 3) =>
	Effect.gen(function* () {
		const commit = yield* makeCommitAndSignal;
		yield* commit([
			canonicalEvent(
				"session.created",
				sessionId,
				{ sessionId, title: "Synthetic goal", provider: "claude" },
				{ provider: "claude", createdAt: 1 },
			),
		]);
		for (let iteration = 0; iteration <= count; iteration++)
			yield* check(iteration, reason, sessionId);
	});
const change = (facts: SessionGoalChangedPayload, at = 200) =>
	Effect.gen(function* () {
		const commit = yield* makeCommitAndSignal;
		yield* commit([
			canonicalEvent("session.goal_changed", facts.sessionId, facts, {
				provider: "claude",
				createdAt: at,
			}),
		]);
	});
const check = (
	iterations: number,
	lastReason = reason,
	sessionId = "summary-goal",
) =>
	change(
		{ sessionId, goal: { ...goal, iterations, lastReason } },
		100 + iterations,
	);
const waitForCalls = (
	query: ReturnType<typeof fixture>["query"],
	calls: number,
) =>
	Effect.gen(function* () {
		while (query.mock.calls.length < calls) yield* Effect.yieldNow();
	});
const expectError = (
	effect: Effect.Effect<unknown, unknown>,
	message: string,
) =>
	Effect.gen(function* () {
		expect(yield* Effect.either(effect)).toMatchObject({
			_tag: "Left",
			left: { _tag: "WsRpcError", message },
		});
	});

describe("GoalSummaryService", () => {
	it.scoped(
		"reads never generate and reopening the same blocker makes zero additional calls",
		() => {
			const f = fixture();
			return Effect.gen(function* () {
				yield* seed();
				const service = yield* GoalSummaryServiceTag;
				expect(yield* service.metadata("summary-goal")).toEqual({
					summary: null,
					summaryEnabled: true,
				});
				expect(f.query).toHaveBeenCalledTimes(0);
				const first = yield* service.generate("summary-goal");
				yield* check(4);
				expect(yield* service.generate("summary-goal")).toEqual(first);
				expect((yield* service.metadata("summary-goal")).summary).toEqual(
					first,
				);
				expect(f.query).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(f.live));
		},
	);
	it.scoped(
		"a changed blocker generates once and model changes invalidate the cache",
		() => {
			const f = fixture();
			return Effect.gen(function* () {
				yield* seed();
				const service = yield* GoalSummaryServiceTag;
				yield* service.generate("summary-goal");
				yield* check(4, progress);
				expect((yield* service.metadata("summary-goal")).summary?.stale).toBe(
					true,
				);
				yield* service.generate("summary-goal");
				expect(f.query).toHaveBeenCalledTimes(2);
				f.preferences.recap.model = "opus";
				expect((yield* service.metadata("summary-goal")).summary?.stale).toBe(
					true,
				);
				yield* service.generate("summary-goal");
				expect(f.query).toHaveBeenCalledTimes(3);
				expect(f.query.mock.calls[2]?.[0].options?.model).toBe("opus");
			}).pipe(Effect.provide(f.live));
		},
	);
	it.scoped("two concurrent opens share one model call", () => {
		const f = fixture();
		const release = f.hold();
		return Effect.gen(function* () {
			yield* seed();
			const service = yield* GoalSummaryServiceTag;
			const first = yield* Effect.fork(service.generate("summary-goal"));
			yield* waitForCalls(f.query, 1);
			const second = yield* Effect.fork(service.generate("summary-goal"));
			yield* Effect.yieldNow();
			release();
			expect(yield* Fiber.join(second)).toEqual(yield* Fiber.join(first));
			expect(f.query).toHaveBeenCalledTimes(1);
		}).pipe(Effect.provide(f.live));
	});
	for (const [name, nextReason, stale] of [
		[
			"a progress check during generation returns a stale summary under its captured key",
			progress,
			true,
		],
		[
			"more checks on the same blocker during generation keep the result current",
			reason,
			false,
		],
	] as const)
		it.scoped(name, () => {
			const f = fixture();
			const release = f.hold();
			return Effect.gen(function* () {
				yield* seed();
				const service = yield* GoalSummaryServiceTag;
				const pending = yield* Effect.fork(service.generate("summary-goal"));
				yield* waitForCalls(f.query, 1);
				yield* check(4, nextReason);
				release();
				expect((yield* Fiber.join(pending)).stale).toBe(stale);
				expect((yield* service.metadata("summary-goal")).summary?.stale).toBe(
					stale,
				);
			}).pipe(Effect.provide(f.live));
		});
	it.scoped("an older generation cannot overwrite a newer goal summary", () => {
		const f = fixture("Old evidence");
		const release = f.hold();
		return Effect.gen(function* () {
			yield* seed();
			const service = yield* GoalSummaryServiceTag;
			const old = yield* Effect.fork(service.generate("summary-goal"));
			yield* waitForCalls(f.query, 1);
			yield* check(4, progress);
			f.unhold();
			f.setText("New evidence");
			const latest = yield* service.generate("summary-goal");
			release();
			yield* Fiber.join(old);
			expect((yield* service.metadata("summary-goal")).summary).toEqual(latest);
		}).pipe(Effect.provide(f.live));
	});
	for (const mode of ["off", "disabled"] as const)
		it.scoped(
			`summaries off reject without calling Claude and report summaryEnabled false (${mode})`,
			() => {
				const f = fixture();
				if (mode === "off") f.preferences.recap.model = "off";
				else f.preferences.summariesEnabled = false;
				return Effect.gen(function* () {
					yield* seed();
					const service = yield* GoalSummaryServiceTag;
					expect((yield* service.metadata("summary-goal")).summaryEnabled).toBe(
						false,
					);
					yield* expectError(
						service.generate("summary-goal"),
						"Goal summaries are off",
					);
					expect(f.query).toHaveBeenCalledTimes(0);
				}).pipe(Effect.provide(f.live));
			},
		);
	it.scoped("no checks reject without calling Claude", () => {
		const f = fixture();
		return Effect.gen(function* () {
			yield* seed("summary-goal", 0);
			const service = yield* GoalSummaryServiceTag;
			yield* expectError(
				service.generate("summary-goal"),
				"No checks to summarise yet",
			);
			expect(f.query).toHaveBeenCalledTimes(0);
		}).pipe(Effect.provide(f.live));
	});
	it.scoped(
		"query and empty failures return short plain RPC errors and allow retry",
		() => {
			const f = fixture();
			return Effect.gen(function* () {
				yield* seed();
				const service = yield* GoalSummaryServiceTag;
				f.setFailure(true);
				yield* expectError(
					service.generate("summary-goal"),
					"Could not generate goal summary",
				);
				f.setFailure(false);
				f.setText("");
				yield* expectError(
					service.generate("summary-goal"),
					"Claude returned no summary text",
				);
				f.setText("The release credential is missing.");
				expect((yield* service.generate("summary-goal")).stale).toBe(false);
				expect(f.query).toHaveBeenCalledTimes(3);
			}).pipe(Effect.provide(f.live));
		},
	);
	it.scoped(
		"a timed out query is aborted after sixty seconds and allows retry",
		() => {
			const f = fixture();
			const release = f.hold();
			return Effect.gen(function* () {
				yield* seed();
				const service = yield* GoalSummaryServiceTag;
				const pending = yield* Effect.fork(
					Effect.either(service.generate("summary-goal")),
				);
				yield* waitForCalls(f.query, 1);
				yield* TestClock.adjust("60 seconds");
				expect(yield* Fiber.join(pending)).toMatchObject({
					_tag: "Left",
					left: { message: "Timed out waiting for goal summary" },
				});
				expect(
					f.query.mock.calls[0]?.[0].options?.abortController?.signal.aborted,
				).toBe(true);
				release();
				f.unhold();
				expect((yield* service.generate("summary-goal")).stale).toBe(false);
			}).pipe(Effect.provide(f.live));
		},
	);
	it.scoped(
		"cancelling one opener does not cancel another opener's shared generation",
		() => {
			const f = fixture();
			const release = f.hold();
			return Effect.gen(function* () {
				yield* seed();
				const service = yield* GoalSummaryServiceTag;
				const first = yield* Effect.fork(service.generate("summary-goal"));
				yield* waitForCalls(f.query, 1);
				const second = yield* Effect.fork(service.generate("summary-goal"));
				yield* Effect.yieldNow();
				yield* Fiber.interrupt(first);
				release();
				expect((yield* Fiber.join(second)).stale).toBe(false);
				expect(f.query).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(f.live));
		},
	);
	it.scoped(
		"pause, resume, completion, clearing and replacement invalidate the cached summary",
		() => {
			const f = fixture();
			return Effect.gen(function* () {
				yield* seed();
				const service = yield* GoalSummaryServiceTag;
				yield* service.generate("summary-goal");
				for (const facts of [
					{
						sessionId: "summary-goal",
						goal: { ...goal, iterations: 3, lastReason: reason },
						pausedReason: "Awaiting a release credential",
					},
					{
						sessionId: "summary-goal",
						goal: { ...goal, iterations: 3, lastReason: reason },
					},
					{
						sessionId: "summary-goal",
						goal: null,
						ended: "met" as const,
						endedGoal: { ...goal, iterations: 3, lastReason: reason },
						endedAt: 500,
					},
					{
						sessionId: "summary-goal",
						goal: null,
						ended: "cleared" as const,
						endedGoal: { ...goal, iterations: 3, lastReason: reason },
						endedAt: 501,
					},
				]) {
					yield* change(facts);
					expect((yield* service.metadata("summary-goal")).summary?.stale).toBe(
						true,
					);
					yield* service.generate("summary-goal");
				}
				yield* change(
					{ sessionId: "summary-goal", goal: { ...goal, setAt: 600 } },
					600,
				);
				expect((yield* service.metadata("summary-goal")).summary).toBeNull();
				expect(f.query).toHaveBeenCalledTimes(5);
			}).pipe(Effect.provide(f.live));
		},
	);
	it.scoped(
		"pause and resume between opens invalidate an otherwise unchanged active goal",
		() => {
			const f = fixture();
			return Effect.gen(function* () {
				yield* seed();
				const service = yield* GoalSummaryServiceTag;
				yield* service.generate("summary-goal");
				yield* change({
					sessionId: "summary-goal",
					goal: { ...goal, iterations: 3, lastReason: reason },
					pausedReason: "Waiting for review",
				});
				yield* check(3);
				expect((yield* service.metadata("summary-goal")).summary?.stale).toBe(
					true,
				);
				yield* service.generate("summary-goal");
				expect(f.query).toHaveBeenCalledTimes(2);
			}).pipe(Effect.provide(f.live));
		},
	);
	it.scoped(
		"least recently used goal summaries are evicted after two hundred identities",
		() => {
			const f = fixture();
			return Effect.gen(function* () {
				const service = yield* GoalSummaryServiceTag;
				for (let n = 0; n < 200; n++) {
					yield* seed(`goal-${n}`);
					yield* service.generate(`goal-${n}`);
				}
				yield* service.metadata("goal-0");
				yield* seed("goal-200");
				yield* service.generate("goal-200");
				expect((yield* service.metadata("goal-1")).summary).toBeNull();
				expect((yield* service.metadata("goal-0")).summary?.stale).toBe(false);
			}).pipe(Effect.provide(f.live));
		},
	);
	it.scoped(
		"summaries use the recap model and daemon default Claude login",
		() => {
			const f = fixture();
			return Effect.gen(function* () {
				const config = {
					...defaultDaemonConfig(),
					instances: [
						{
							id: "summary-default",
							name: "Synthetic default",
							driver: "claude" as const,
							port: 0,
							managed: false,
							configDir: "/synthetic/default-claude",
						},
					],
					accountDefaults: { claude: AccountIdSchema.make("summary-default") },
				};
				yield* Effect.tryPromise(() =>
					saveDaemonConfig(config, f.config.configDir),
				);
				yield* seed();
				yield* (yield* GoalSummaryServiceTag).generate("summary-goal");
				const options = f.query.mock.calls[0]?.[0].options;
				expect(options?.model).toBe("sonnet");
				expect(options?.cwd).toBe(process.cwd());
				expect(options?.env?.["CLAUDE_CONFIG_DIR"]).toBe(
					"/synthetic/default-claude",
				);
				expect(options?.tools).toEqual([]);
				expect(options?.persistSession).toBe(false);
			}).pipe(Effect.provide(f.live));
		},
	);
});
