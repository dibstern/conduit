import { describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vitest";
import { DEFAULT_CATEGORY_SET } from "../../../src/lib/contracts/category-set.js";
import type { MessageSurfacingStatus } from "../../../src/lib/contracts/message-surfacing.js";
import { CategorySet } from "../../../src/lib/domain/daemon/Services/category-set.js";
import type { ClaudeOneShotQueryFactory } from "../../../src/lib/domain/daemon/Services/claude-one-shot.js";
import { MessageSurfacingSettings } from "../../../src/lib/domain/daemon/Services/message-surfacing-settings.js";
import {
	makeRecapServiceLive,
	RecapServiceTag,
} from "../../../src/lib/domain/relay/Services/recap-service.js";
import {
	ConfigTag,
	LoggerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	makeMockConfig,
	makeMockLogger,
} from "../../helpers/mock-factories.js";

// Failure modes: reads spend money; New repeats old messages or loses its prior
// text; citations name nonexistent/final/other-turn messages; versions overwrite;
// Off/on-request/short completion generates; stale completion makes a
// second Whole; reload loses cache; deletion races resurrect recaps; subscribers
// miss the commit; overlapping requests pay twice during input preparation or
// generation; interrupted preparation leaves the turn reserved forever.
// Jev disabled or missing/rejected keys must not block summaries. Unclassified
// text must receive the same numbers as the log, excluding trailing replies.
const target = { sessionId: "session-1", turnId: "user-1" };
const layer = (
	options: {
		when?: "turn-end" | "on-request";
		active?: boolean;
		summariesEnabled?: boolean;
		model?: "sonnet" | "opus" | "off";
		response?: string;
	} = {},
) => {
	const settings: MessageSurfacingStatus = {
		enabled: true,
		summariesEnabled: options.summariesEnabled ?? true,
		active: options.active ?? true,
		defaultLevel: "balanced",
		turnsOpen: "auto",
		recap: {
			model: options.model ?? "sonnet",
			when: options.when ?? "on-request",
		},
		tuningModel: "opus",
		key: { source: "stored", rejected: false },
	};
	let calls = 0;
	const query = vi.fn(async function* (
		_params: Parameters<ClaudeOneShotQueryFactory>[0],
	) {
		yield {
			type: "result",
			result:
				options.response ??
				`Generation ${++calls} changed [#1]. Valid [#4]. Invalid [#999] [#-1] [#NaN] [#1.5].`,
		};
	});
	const deps = Layer.mergeAll(
		makePersistenceEffectLayer(":memory:", "test-project"),
		SessionEventBusLive,
		Layer.succeed(
			ConfigTag,
			makeMockConfig({ slug: "test-project", projectDir: process.cwd() }),
		),
		Layer.succeed(LoggerTag, makeMockLogger()),
		Layer.succeed(CategorySet, {
			current: () => Effect.succeed(DEFAULT_CATEGORY_SET),
			criteriaAtVersion: () => Effect.die("unused"),
			replace: () => Effect.die("unused"),
		}),
		Layer.succeed(MessageSurfacingSettings, {
			get: Effect.sync(() => settings),
			update: () => Effect.die("unused"),
			post: () => Effect.die("unused"),
		}),
	);
	return {
		query,
		settings,
		live: makeRecapServiceLive({ queryFactory: query }).pipe(
			Layer.provideMerge(deps),
		),
	};
};
const seed = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT INTO sessions (id, project_id, provider, title, status, created_at, updated_at) VALUES ('session-1', 'test-project', 'claude', 'Test', 'idle', 1, 1)`;
	yield* sql`INSERT INTO turns (id, session_id, state, user_message_id, requested_at) VALUES ('user-1', 'session-1', 'running', 'user-1', 1)`;
	yield* sql`INSERT INTO messages (id, session_id, turn_id, role, text, created_at, updated_at) VALUES ('user-1', 'session-1', 'user-1', 'user', 'Fix the issue', 1, 1)`;
	yield* sql`INSERT INTO messages (id, session_id, turn_id, role, text, created_at, updated_at) VALUES ('assistant-1', 'session-1', 'user-1', 'assistant', 'Update 1 Update 2 Final response', 2, 2)`;
	yield* add(1, 4);
	yield* sql`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at) VALUES ('final-part', 'assistant-1', 'text', 'Final response', 100, 9, 9)`;
	const commit = yield* makeCommitAndSignal;
	const owner = { provider: "claude", metadata: { runId: "run-1" } };
	yield* commit([
		canonicalEvent(
			"run.requested",
			"session-1",
			{ runId: "run-1", inputId: "user-1" },
			owner,
		),
		canonicalEvent(
			"message.created",
			"session-1",
			{
				sessionId: "session-1",
				messageId: "user-1",
				role: "user",
				inputId: "user-1",
			},
			owner,
		),
		canonicalEvent(
			"run.started",
			"session-1",
			{ requestedRunId: "run-1", inputId: "user-1" },
			owner,
		),
	]);
});
const add = (from: number, through: number) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		for (let n = from; n <= through; n++)
			yield* sql`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at, surfacing_ordinal, surfacing_probabilities) VALUES (${`part-${n}`}, 'assistant-1', 'text', ${`Update ${n}`}, ${n}, ${n + 2}, ${n + 2}, ${n}, '{"finding":1}')`;
	});
const complete = Effect.gen(function* () {
	const commit = yield* makeCommitAndSignal;
	yield* commit([
		canonicalEvent(
			"turn.completed",
			"session-1",
			{ messageId: "assistant-1", userMessageId: "user-1" },
			{ provider: "claude", metadata: { runId: "run-1" } },
		),
	]);
});

describe("RecapService persisted versions", () => {
	for (const provider of ["claude", "opencode"]) {
		it.effect(
			`automatically recaps ${provider} only when projection completes its run`,
			() => {
				const fixture = layer({ when: "turn-end" });
				return Effect.gen(function* () {
					yield* seed;
					const commit = yield* makeCommitAndSignal;
					const sql = yield* SqlClient.SqlClient;
					const service = yield* RecapServiceTag;
					const owner = { provider, metadata: { runId: "run-1" } };
					const completion = canonicalEvent(
						"turn.completed",
						"session-1",
						{ messageId: "assistant-1" },
						owner,
					);
					expect(yield* sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "running" },
					]);
					expect(fixture.query).not.toHaveBeenCalled();
					yield* commit([
						provider === "opencode"
							? canonicalEvent(
									"session.status",
									"session-1",
									{ sessionId: "session-1", status: "idle" },
									owner,
								)
							: completion,
					]);
					expect(yield* sql`SELECT state FROM turns`).toEqual([
						{ state: "completed" },
					]);
					expect(yield* sql`SELECT status FROM provider_runs`).toEqual([
						{ status: "completed" },
					]);
					yield* Effect.tryPromise(() =>
						vi.waitFor(async () => {
							expect(fixture.query).toHaveBeenCalledTimes(1);
						}),
					);
					expect(yield* service.list(target)).toHaveLength(1);
					// Extra background log parts do not make a repeated native terminal a new run end.
					yield* add(5, 6);
					yield* commit([
						canonicalEvent(
							"turn.completed",
							"session-1",
							{ messageId: "assistant-1" },
							owner,
						),
					]);
					yield* Effect.yieldNow;
					yield* Effect.yieldNow;
					expect(fixture.query).toHaveBeenCalledTimes(1);
					expect(yield* service.list(target)).toHaveLength(1);
				}).pipe(Effect.provide(fixture.live));
			},
		);
	}
	for (const provider of ["claude", "opencode"]) {
		for (const firstFails of [false, true]) {
			it.effect(
				`recaps each ${provider} joined input once${firstFails ? " even if one summary fails" : ""}`,
				() => {
					const fixture = layer({ when: "turn-end" });
					if (firstFails)
						fixture.query.mockImplementationOnce(async function* () {
							yield { type: "result", result: "" };
							throw new Error("Summary unavailable");
						});
					return Effect.gen(function* () {
						yield* seed;
						const commit = yield* makeCommitAndSignal;
						const sql = yield* SqlClient.SqlClient;
						const owner = { provider, metadata: { runId: "run-1" } };
						yield* commit([
							canonicalEvent(
								"run.requested",
								"session-1",
								{ runId: "run-2", inputId: "user-2" },
								{ provider, metadata: { runId: "run-2" } },
							),
							canonicalEvent(
								"message.created",
								"session-1",
								{
									sessionId: "session-1",
									messageId: "user-2",
									role: "user",
									inputId: "user-2",
								},
								{ provider, metadata: { runId: "run-2" } },
							),
							canonicalEvent(
								"run.started",
								"session-1",
								{ requestedRunId: "run-2", inputId: "user-2" },
								owner,
							),
							canonicalEvent(
								"message.created",
								"session-1",
								{
									sessionId: "session-1",
									messageId: "assistant-2",
									role: "assistant",
									parentID: "user-2",
								},
								owner,
							),
						]);
						for (let n = 1; n <= 4; n++)
							yield* sql`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at, surfacing_ordinal, surfacing_probabilities) VALUES (${`joined-part-${n}`}, 'assistant-2', 'text', ${`Joined update ${n}`}, ${n}, ${n + 2}, ${n + 2}, ${n}, '{"finding":1}')`;
						yield* commit([
							provider === "opencode"
								? canonicalEvent(
										"session.status",
										"session-1",
										{ sessionId: "session-1", status: "idle" },
										owner,
									)
								: canonicalEvent(
										"turn.completed",
										"session-1",
										{ messageId: "assistant-2" },
										owner,
									),
						]);
						expect(
							yield* sql`SELECT id, state, run_id FROM turns ORDER BY id`,
						).toEqual([
							{ id: "user-1", state: "completed", run_id: "run-1" },
							{ id: "user-2", state: "completed", run_id: "run-1" },
						]);
						yield* Effect.tryPromise(() =>
							vi.waitFor(() => expect(fixture.query).toHaveBeenCalledTimes(2)),
						);
						const recaps =
							yield* sql`SELECT turn_id FROM turn_recaps ORDER BY turn_id`;
						expect(recaps).toHaveLength(firstFails ? 1 : 2);
						if (!firstFails)
							expect(recaps).toEqual([
								{ turn_id: "user-1" },
								{ turn_id: "user-2" },
							]);
					}).pipe(Effect.provide(fixture.live));
				},
			);
		}
	}
	for (const terminal of ["turn.error", "turn.interrupted"] as const) {
		it.effect(`does not automatically recap an owned ${terminal}`, () => {
			const fixture = layer({ when: "turn-end" });
			return Effect.gen(function* () {
				yield* seed;
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					terminal === "turn.error"
						? canonicalEvent(
								terminal,
								"session-1",
								{ messageId: "assistant-1", error: "failed" },
								{ provider: "claude", metadata: { runId: "run-1" } },
							)
						: canonicalEvent(
								terminal,
								"session-1",
								{ messageId: "assistant-1" },
								{ provider: "claude", metadata: { runId: "run-1" } },
							),
				]);
				expect(
					yield* (yield* SqlClient.SqlClient)`SELECT state FROM turns`,
				).toEqual([
					{ state: terminal === "turn.error" ? "error" : "interrupted" },
				]);
				yield* Effect.yieldNow;
				expect(fixture.query).not.toHaveBeenCalled();
				expect(yield* (yield* RecapServiceTag).list(target)).toEqual([]);
			}).pipe(Effect.provide(fixture.live));
		});
	}

	it.effect(
		"summarizes unclassified log messages with Jev off and no key",
		() => {
			const fixture = layer({ active: false });
			Object.assign(fixture.settings, {
				enabled: false,
				key: { source: "none", rejected: false },
			});
			return Effect.gen(function* () {
				yield* seed;
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE message_parts SET surfacing_ordinal = NULL, surfacing_probabilities = NULL`;
				yield* sql`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at) VALUES ('thinking-step', 'assistant-1', 'thinking', 'Check changes', 50, 8, 8)`;
				const recap = yield* (yield* RecapServiceTag).generate({
					...target,
					scope: "whole",
				});
				expect(recap).toMatchObject({ firstOrdinal: 1, lastOrdinal: 4 });
				expect(fixture.query.mock.calls[0]?.[0].prompt).toContain(
					'"ordinal":4',
				);
				expect(fixture.query.mock.calls[0]?.[0].prompt).not.toContain(
					'"text":"Final response"',
				);
				Object.assign(fixture.settings, {
					key: { source: "stored", rejected: true },
				});
				yield* (yield* RecapServiceTag).generate({ ...target, scope: "whole" });
				expect(fixture.query).toHaveBeenCalledTimes(2);
			}).pipe(Effect.provide(fixture.live));
		},
	);
	// Ask failures: opening spends money; another turn/project leaks into the
	// prompt; later messages change the question's meaning; invalid citations
	// survive; Off still calls Claude; an explanation overwrites a turn recap
	// or drops automatic generation when the turn completes during Explain.
	it.effect("automatically recaps a turn that completes during Explain", () => {
		const fixture = layer({ when: "turn-end" });
		let releaseExplanation = () => {};
		const held = new Promise<void>((resolve) => {
			releaseExplanation = resolve;
		});
		let explanationStarted = () => {};
		const started = new Promise<void>((resolve) => {
			explanationStarted = resolve;
		});
		fixture.query.mockImplementationOnce(async function* () {
			explanationStarted();
			await held;
			yield {
				type: "result",
				result: JSON.stringify({
					soFar: "The review is underway. [#1]",
					whatCameUp: "A choice is needed. [#2]",
					options: [],
					unanswered: "",
				}),
			};
		});
		return Effect.gen(function* () {
			yield* seed;
			const service = yield* RecapServiceTag;
			const explanation = yield* service
				.explainAsk({ ...target, partId: "part-2" })
				.pipe(Effect.forkScoped);
			yield* Effect.promise(() => started);
			const recapped = yield* service.subscribe(target).pipe(
				Stream.filter((snapshot) => snapshot.versions.length === 1),
				Stream.take(1),
				Stream.runHead,
				Effect.forkScoped,
			);
			yield* complete;
			yield* Effect.tryPromise(() =>
				vi.waitFor(() => expect(fixture.query).toHaveBeenCalledTimes(2)),
			);
			yield* Fiber.join(recapped);
			expect(yield* service.list(target)).toMatchObject([
				{ version: 1, scope: "whole", lastOrdinal: 4 },
			]);
			releaseExplanation();
			expect((yield* Fiber.join(explanation)).soFar).toContain("[#1]");
			expect(yield* service.list(target)).toHaveLength(1);
			expect(fixture.query).toHaveBeenCalledTimes(2);
		}).pipe(
			Effect.ensuring(Effect.sync(releaseExplanation)),
			Effect.provide(fixture.live),
		);
	});
	it.effect(
		"explains an Ask with the summary model and only its preceding context",
		() => {
			// Explain is a summary feature, so it works with Jev off.
			const fixture = layer({
				active: false,
				model: "opus",
				response: JSON.stringify({
					soFar: "The review is underway. [#1] [#4] [#999]",
					whatCameUp: "A choice is needed. [#2]",
					options: [
						{
							label: "Keep it",
							explanation: "Preserves the spacing.",
							recommended: true,
						},
					],
					unanswered: "The agent continues elsewhere. [#-1]",
				}),
			});
			return Effect.gen(function* () {
				yield* seed;
				const service = yield* RecapServiceTag;
				expect(fixture.query).not.toHaveBeenCalled();
				const result = yield* service.explainAsk({
					...target,
					partId: "part-2",
				});
				expect(result).toMatchObject({
					model: "opus",
					whatCameUp: "A choice is needed. [#2]",
				});
				expect(result.soFar).toContain("[#1]");
				expect(result.soFar).not.toMatch(/\[#(?:4|999)\]/);
				expect(result.unanswered).not.toContain("[#-1]");
				expect(fixture.query).toHaveBeenCalledTimes(1);
				const call = fixture.query.mock.calls[0]?.[0];
				expect(call?.options?.model).toBe("opus");
				expect(call?.prompt).toContain("Update 1");
				expect(call?.prompt).toContain("Update 2");
				expect(call?.prompt).not.toContain("Update 3");
				expect(yield* service.list(target)).toEqual([]);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE sessions SET project_id = 'other-project' WHERE id = 'session-1'`;
				expect(
					(yield* Effect.result(
						service.explainAsk({ ...target, partId: "part-2" }),
					))._tag,
				).toBe("Failure");
				expect(fixture.query).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(fixture.live));
		},
	);
	it.effect(
		"rejects disabled summaries and unknown Ask parts without a paid call",
		() => {
			return Effect.forEach(
				[
					{ model: "off", partId: "part-2" },
					{ model: "sonnet", summariesEnabled: false, partId: "part-2" },
					{ model: "sonnet", partId: "missing" },
				] as const,
				({ partId, ...options }) => {
					const fixture = layer(options);
					return Effect.gen(function* () {
						yield* seed;
						const service = yield* RecapServiceTag;
						expect(
							(yield* Effect.result(service.explainAsk({ ...target, partId })))
								._tag,
						).toBe("Failure");
						expect(fixture.query).not.toHaveBeenCalled();
					}).pipe(Effect.provide(fixture.live));
				},
				{ discard: true },
			);
		},
	);
	it.effect("rejects overlapping requests before preparing a long turn", () => {
		const fixture = layer();
		return Effect.gen(function* () {
			yield* seed;
			yield* add(5, 500);
			const service = yield* RecapServiceTag;
			const results = yield* Effect.all(
				["whole", "whole"].map(() =>
					Effect.result(service.generate({ ...target, scope: "whole" })),
				),
				{ concurrency: 2 },
			);
			expect(
				results.filter((result) => result._tag === "Success"),
			).toHaveLength(1);
			expect(results.filter((result) => result._tag === "Failure")).toEqual([
				expect.objectContaining({
					failure: expect.objectContaining({
						message: "Summary is already generating",
					}),
				}),
			]);
			expect(fixture.query).toHaveBeenCalledTimes(1);
			expect(yield* service.list(target)).toHaveLength(1);
			// A later, explicit regeneration remains a paid operation.
			yield* service.generate({ ...target, scope: "whole", sourceVersion: 1 });
			expect(fixture.query).toHaveBeenCalledTimes(2);
			expect(yield* service.list(target)).toHaveLength(2);
		}).pipe(Effect.provide(fixture.live));
	});
	it.effect(
		"releases a reservation interrupted during input preparation",
		() => {
			const fixture = layer();
			return Effect.gen(function* () {
				yield* seed;
				yield* add(5, 500);
				const service = yield* RecapServiceTag;
				const pending = yield* service
					.generate({ ...target, scope: "whole" })
					.pipe(Effect.forkScoped);
				yield* Effect.yieldNow;
				yield* Fiber.interrupt(pending);
				yield* service.generate({ ...target, scope: "whole" });
				expect(fixture.query).toHaveBeenCalledTimes(1);
				expect(yield* service.list(target)).toHaveLength(1);
			}).pipe(Effect.provide(fixture.live));
		},
	);
	it.effect(
		"lists without a call, appends Whole/New, validates citations, and regenerates an older scope",
		() => {
			const fixture = layer();
			return Effect.gen(function* () {
				yield* seed;
				const service = yield* RecapServiceTag;
				expect(yield* service.list(target)).toEqual([]);
				expect(fixture.query).not.toHaveBeenCalled();
				const whole = yield* service.generate({ ...target, scope: "whole" });
				expect(whole).toMatchObject({
					version: 1,
					firstOrdinal: 1,
					lastOrdinal: 4,
				});
				expect(whole.text).toContain("[#1]");
				expect(whole.text).not.toContain("[#999]");
				expect(whole.text).not.toMatch(/\[#(?:-1|NaN|1\.5)\]/);
				yield* add(5, 6);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE turns SET state = 'completed' WHERE id = 'user-1'`;
				const next = yield* service.generate({ ...target, scope: "new" });
				expect(next).toMatchObject({
					version: 2,
					firstOrdinal: 5,
					lastOrdinal: 6,
					scope: "new",
				});
				const prompt = fixture.query.mock.calls.at(-1)?.[0];
				expect(prompt).toBeDefined();
				expect(JSON.stringify(prompt)).toContain("Update 5");
				expect(JSON.stringify(prompt)).not.toContain("Update 1");
				expect(JSON.stringify(prompt)).toContain(whole.text);
				expect(JSON.stringify(prompt)).toContain("Final response");
				const emptyNew = yield* Effect.result(
					service.generate({ ...target, scope: "new" }),
				);
				expect(emptyNew._tag).toBe("Failure");
				yield* service.generate({ ...target, scope: "new", sourceVersion: 2 });
				yield* service.generate({ ...target, scope: "new", sourceVersion: 3 });
				expect(fixture.query.mock.calls.at(-1)?.[0].prompt).toContain(
					whole.text,
				);
				expect(fixture.query.mock.calls.at(-1)?.[0].prompt).not.toContain(
					next.text,
				);
				expect(yield* service.list(target)).toHaveLength(4);
				expect((yield* service.list(target))[0]).toEqual(whole);
				expect(fixture.query).toHaveBeenCalledTimes(4);
				yield* add(7, 8);
				const refreshedWhole = yield* service.generate({
					...target,
					scope: "whole",
					sourceVersion: 1,
				});
				expect(refreshedWhole).toMatchObject({
					firstOrdinal: 1,
					lastOrdinal: 8,
					version: 5,
				});
				const refreshedNew = yield* service.generate({
					...target,
					scope: "new",
					sourceVersion: 3,
				});
				expect(refreshedNew).toMatchObject({
					firstOrdinal: 5,
					lastOrdinal: 6,
					version: 6,
				});
				expect(fixture.query.mock.calls.at(-1)?.[0].prompt).not.toContain(
					"Update 7",
				);
			}).pipe(Effect.provide(fixture.live));
		},
	);
	for (const options of [
		{ summariesEnabled: false },
		{ model: "off" as const },
	])
		it.effect(`never calls Claude with ${JSON.stringify(options)}`, () => {
			const fixture = layer(options);
			return Effect.gen(function* () {
				yield* seed;
				const service = yield* RecapServiceTag;
				expect(
					(yield* Effect.result(
						service.generate({ ...target, scope: "whole" }),
					))._tag,
				).toBe("Failure");
				yield* complete;
				yield* Effect.yieldNow;
				expect(fixture.query).not.toHaveBeenCalled();
			}).pipe(Effect.provide(fixture.live));
		});
	it.effect(
		"on-request completion makes no call; short turns make no automatic call",
		() => {
			return Effect.forEach(
				["on-request", "turn-end"] as const,
				(when) => {
					const fixture = layer({ when });
					return Effect.gen(function* () {
						yield* seed;
						if (when === "turn-end")
							yield* (yield* SqlClient.SqlClient)`DELETE FROM message_parts WHERE surfacing_ordinal = 4`;
						yield* complete;
						yield* Effect.yieldNow;
						expect(fixture.query).not.toHaveBeenCalled();
					}).pipe(Effect.provide(fixture.live));
				},
				{ discard: true },
			);
		},
	);
	it.effect(
		"a stale live recap gets New on completion and reaches its subscriber",
		() => {
			const fixture = layer({ when: "turn-end" });
			return Effect.gen(function* () {
				yield* seed;
				const service = yield* RecapServiceTag;
				yield* service.generate({ ...target, scope: "whole" });
				yield* add(5, 6);
				const versions = yield* service.subscribe(target).pipe(
					Stream.filter(
						(snapshot) =>
							snapshot.versions.length === 2 && !snapshot.generating,
					),
					Stream.take(1),
					Stream.runCollect,
					Effect.forkScoped,
				);
				yield* Effect.yieldNow;
				yield* complete;
				const snapshots = yield* Fiber.await(versions);
				expect(snapshots._tag).toBe("Success");
				expect((yield* service.list(target)).map(({ scope }) => scope)).toEqual(
					["whole", "new"],
				);
				expect(fixture.query).toHaveBeenCalledTimes(2);
				yield* add(7, 8);
				let releaseGeneration = () => {};
				const held = new Promise<void>((resolve) => {
					releaseGeneration = resolve;
				});
				fixture.query.mockImplementationOnce(async function* () {
					await held;
					yield { type: "result", result: "" };
					throw new Error("Claude not signed in");
				});
				const generating = yield* service.subscribe(target).pipe(
					Stream.filter((snapshot) => snapshot.generating),
					Stream.take(1),
					Stream.runHead,
					Effect.forkScoped,
				);
				yield* Effect.yieldNow;
				const requested = yield* service
					.generate({ ...target, scope: "new" })
					.pipe(Effect.exit, Effect.forkScoped);
				expect((yield* Fiber.await(generating))._tag).toBe("Success");
				const failure = yield* service.subscribe(target).pipe(
					Stream.filter((snapshot) => snapshot.error !== null),
					Stream.take(1),
					Stream.runHead,
					Effect.forkScoped,
				);
				const duplicate = yield* Effect.result(
					service.generate({ ...target, scope: "whole" }),
				);
				expect(duplicate._tag).toBe("Failure");
				releaseGeneration();
				const failed = yield* Fiber.join(failure);
				yield* Fiber.join(requested);
				expect(failed._tag).toBe("Some");
				if (failed._tag === "Some")
					expect(failed.value).toMatchObject({
						generating: false,
						error: "Claude not signed in",
						retry: { scope: "new" },
					});
				expect(yield* service.list(target)).toHaveLength(2);
				expect(fixture.query).toHaveBeenCalledTimes(3);
			}).pipe(Effect.provide(fixture.live));
		},
	);
	it.effect(
		"deletes recaps with their session and rejects another project's session",
		() => {
			const fixture = layer();
			return Effect.gen(function* () {
				yield* seed;
				const service = yield* RecapServiceTag;
				yield* service.generate({ ...target, scope: "whole" });
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE sessions SET project_id = 'other-project' WHERE id = 'session-1'`;
				expect((yield* Effect.result(service.list(target)))._tag).toBe(
					"Failure",
				);
				yield* sql`DELETE FROM sessions WHERE id = 'session-1'`;
				expect(yield* sql`SELECT * FROM turn_recaps`).toEqual([]);
			}).pipe(Effect.provide(fixture.live));
		},
	);
});
