import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
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
// Off/inactive/on-request/short completion generates; stale completion makes a
// second Whole; reload loses cache; deletion races resurrect recaps; subscribers
// miss the commit; overlapping requests pay twice during input preparation or
// generation; interrupted preparation leaves the turn reserved forever.
const target = { sessionId: "session-1", turnId: "user-1" };
const layer = (
	options: {
		when?: "turn-end" | "on-request";
		active?: boolean;
		model?: "sonnet" | "opus" | "off";
	} = {},
) => {
	const settings: MessageSurfacingStatus = {
		enabled: true,
		active: options.active ?? true,
		defaultLevel: "balanced",
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
			result: `Generation ${++calls} changed [#1]. Valid [#4]. Invalid [#999] [#-1] [#NaN] [#1.5].`,
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
			{ provider: "claude" },
		),
	]);
});

describe("RecapService persisted versions", () => {
	it.scoped("rejects overlapping requests before preparing a long turn", () => {
		const fixture = layer();
		return Effect.gen(function* () {
			yield* seed;
			yield* add(5, 500);
			const service = yield* RecapServiceTag;
			const results = yield* Effect.all(
				["whole", "whole"].map(() =>
					Effect.either(service.generate({ ...target, scope: "whole" })),
				),
				{ concurrency: 2 },
			);
			expect(results.filter((result) => result._tag === "Right")).toHaveLength(
				1,
			);
			expect(results.filter((result) => result._tag === "Left")).toEqual([
				expect.objectContaining({
					left: expect.objectContaining({
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
	it.scoped(
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
				yield* Effect.yieldNow();
				yield* Fiber.interrupt(pending);
				yield* service.generate({ ...target, scope: "whole" });
				expect(fixture.query).toHaveBeenCalledTimes(1);
				expect(yield* service.list(target)).toHaveLength(1);
			}).pipe(Effect.provide(fixture.live));
		},
	);
	it.scoped(
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
				const emptyNew = yield* Effect.either(
					service.generate({ ...target, scope: "new" }),
				);
				expect(emptyNew._tag).toBe("Left");
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
	for (const options of [{ active: false }, { model: "off" as const }])
		it.scoped(`never calls Claude with ${JSON.stringify(options)}`, () => {
			const fixture = layer(options);
			return Effect.gen(function* () {
				yield* seed;
				const service = yield* RecapServiceTag;
				expect(
					(yield* Effect.either(
						service.generate({ ...target, scope: "whole" }),
					))._tag,
				).toBe("Left");
				yield* complete;
				yield* Effect.yieldNow();
				expect(fixture.query).not.toHaveBeenCalled();
			}).pipe(Effect.provide(fixture.live));
		});
	it.scoped(
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
						yield* Effect.yieldNow();
						expect(fixture.query).not.toHaveBeenCalled();
					}).pipe(Effect.provide(fixture.live));
				},
				{ discard: true },
			);
		},
	);
	it.scoped(
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
				yield* Effect.yieldNow();
				yield* complete;
				const snapshots = yield* versions.await;
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
				yield* Effect.yieldNow();
				yield* complete;
				expect((yield* generating.await)._tag).toBe("Success");
				const failure = yield* service.subscribe(target).pipe(
					Stream.filter((snapshot) => snapshot.error !== null),
					Stream.take(1),
					Stream.runHead,
					Effect.forkScoped,
				);
				const duplicate = yield* Effect.either(
					service.generate({ ...target, scope: "whole" }),
				);
				expect(duplicate._tag).toBe("Left");
				releaseGeneration();
				const failed = yield* Fiber.join(failure);
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
	it.scoped(
		"deletes recaps with their session and rejects another project's session",
		() => {
			const fixture = layer();
			return Effect.gen(function* () {
				yield* seed;
				const service = yield* RecapServiceTag;
				yield* service.generate({ ...target, scope: "whole" });
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE sessions SET project_id = 'other-project' WHERE id = 'session-1'`;
				expect((yield* Effect.either(service.list(target)))._tag).toBe("Left");
				yield* sql`DELETE FROM sessions WHERE id = 'session-1'`;
				expect(yield* sql`SELECT * FROM turn_recaps`).toEqual([]);
			}).pipe(Effect.provide(fixture.live));
		},
	);
});
