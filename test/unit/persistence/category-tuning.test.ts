// Failure modes: reads or weights spend calls; criteria reuse a stale verdict;
// saved definitions reuse old verdicts or charge for new ones; weight-only saves
// lose verdict provenance across restarts; concurrent previews pay twice; samples drift; null verdicts are
// reported as agreement; inactive/no-key scoring spends; malformed Jev/Opus
// responses become trusted output; proposals mutate settings or ignore avoid;
// fewer than five marks call Claude. Exercise the real SQLite and client seams.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vitest";
import {
	type Category,
	type CategorySetContents,
	categoryCriteriaKey,
	DEFAULT_CATEGORY_SET,
} from "../../../src/lib/contracts/category-set.js";
import type { MessageSurfacingStatus } from "../../../src/lib/contracts/message-surfacing.js";
import { CategorySetLive } from "../../../src/lib/domain/daemon/Layers/category-set-layer.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { CategorySet } from "../../../src/lib/domain/daemon/Services/category-set.js";
import type { ClaudeOneShotQueryFactory } from "../../../src/lib/domain/daemon/Services/claude-one-shot.js";
import { MessageSurfacingSettings } from "../../../src/lib/domain/daemon/Services/message-surfacing-settings.js";
import { makeCategoryTuning } from "../../../src/lib/domain/relay/Services/category-tuning.js";
import { readSurfacingFeedback } from "../../../src/lib/domain/relay/Services/surfacing-feedback.js";
import {
	hunkDependencies,
	withTuningHunks,
} from "../../../src/lib/frontend/utils/category-tuning.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { makeMockAccountDirectory } from "../../helpers/mock-factories.js";

const current = DEFAULT_CATEGORY_SET;
const draft: CategorySetContents = {
	categories: current.categories.map((category) =>
		category.id === "finding" ? { ...category, weight: 80 } : category,
	),
};
const criteriaDraft: CategorySetContents = {
	categories: draft.categories.map((category) =>
		category.id === "finding"
			? { ...category, criteria: { what: "establishes a measured root cause" } }
			: category,
	),
};
const hunk = {
	id: "finding-weight",
	categoryId: "finding",
	before: current.categories.find(({ id }) => id === "finding"),
	after: draft.categories.find(({ id }) => id === "finding"),
	rationale: "Your marks consistently raise findings.",
};
const fixture = (
	active = true,
	saved: () => typeof current = () => current,
) => {
	const preferences: MessageSurfacingStatus = {
		enabled: true,
		summariesEnabled: true,
		active,
		defaultLevel: "balanced",
		turnsOpen: "auto",
		recap: { model: "sonnet", when: "on-request" },
		tuningModel: "opus",
		key: { source: active ? "stored" : "none", rejected: false },
	};
	const post = vi.fn(() =>
		Effect.succeed(
			Response.json({
				answers: {
					category: {
						probabilities: {
							...Object.fromEntries(
								current.categories.map(({ id }) => [
									id,
									id === "finding" ? 1 : 0,
								]),
							),
							routine: 0,
						},
					},
				},
			}),
		),
	);
	const query = vi.fn(async function* (
		_input: Parameters<ClaudeOneShotQueryFactory>[0],
	) {
		yield {
			type: "result",
			result: JSON.stringify({ hunks: [hunk], rationale: "Raise findings." }),
		};
	});
	const replace = vi.fn(() =>
		Effect.die("Proposals must never write categories"),
	);
	const criteriaByVersion = new Map([
		[saved().version, categoryCriteriaKey(saved())],
	]);
	return {
		post,
		query,
		replace,
		layer: Layer.mergeAll(
			Layer.succeed(AccountDirectory, makeMockAccountDirectory()),
			makePersistenceEffectLayer(":memory:", "test-project"),
			Layer.succeed(CategorySet, {
				current: () =>
					Effect.sync(() => {
						const current = saved();
						criteriaByVersion.set(
							current.version,
							categoryCriteriaKey(current),
						);
						return current;
					}),
				criteriaAtVersion: (version) =>
					Effect.sync(() => criteriaByVersion.get(version)),
				replace,
			}),
			Layer.succeed(MessageSurfacingSettings, {
				get: Effect.succeed(preferences),
				post,
				update: () => Effect.die("unused"),
			}),
		),
	};
};
const seed = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT INTO sessions (id, project_id, provider, title, status, created_at, updated_at) VALUES ('s', 'test-project', 'claude', 'Find the regression', 'idle', 1, 1)`;
	yield* sql`INSERT INTO turns (id, session_id, state, user_message_id, requested_at) VALUES ('t', 's', 'completed', 'u', 1)`;
	yield* sql`INSERT INTO messages (id, session_id, turn_id, role, text, created_at, updated_at) VALUES ('u', 's', 't', 'user', 'Find the latency regression', 1, 1), ('m', 's', 't', 'assistant', 'The queue causes the delay', 2, 2)`;
	for (let n = 1; n <= 56; n++) {
		yield* sql`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at, surfacing_ordinal, surfacing_probabilities, surfacing_set_version) VALUES (${`p${n}`}, 'm', 'text', ${`The queue causes delay ${n}`}, ${n}, ${n}, ${n}, ${n}, '{"finding":1,"routine":0}', 1)`;
		if (n <= 5)
			yield* sql`INSERT INTO surfacing_marks (part_id, session_id, message_id, level, direction, created_at) VALUES (${`p${n}`}, 's', 'm', 'key', 'raise', ${n})`;
	}
});

it("reuses persisted verdict criteria after weight-only saves and full service restarts", async () => {
	const directory = mkdtempSync("/tmp/category-tuning-restart-");
	const f = fixture();
	const open = () =>
		ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(AccountDirectory, makeMockAccountDirectory()),
				makePersistenceEffectLayer(
					join(directory, "events.db"),
					"test-project",
				),
				CategorySetLive(directory),
				Layer.succeed(MessageSurfacingSettings, {
					get: Effect.succeed<MessageSurfacingStatus>({
						enabled: true,
						summariesEnabled: true,
						active: true,
						defaultLevel: "balanced",
						turnsOpen: "auto",
						recap: { model: "sonnet", when: "on-request" },
						tuningModel: "opus",
						key: { source: "stored", rejected: false },
					}),
					post: f.post,
					update: () => Effect.die("unused"),
				}),
			),
		);
	let runtime = open();
	const scoring = Effect.gen(function* () {
		const categories = yield* CategorySet;
		const saved = yield* categories.current();
		const tuning = yield* makeCategoryTuning({
			configDir: directory,
			cwd: process.cwd(),
		});
		for (const estimateOnly of [true, false]) {
			const result = yield* tuning.score(saved, estimateOnly);
			expect(result).toMatchObject({
				complete: true,
				agree: 5,
				total: 5,
				requiredCalls: 0,
				jevCalls: 0,
			});
			expect(result.levels).toHaveLength(55);
			expect(result.levels.every(({ level }) => level === "key")).toBe(true);
		}
	});
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* seed;
				const categories = yield* CategorySet;
				yield* categories.replace(1, draft);
			}),
		);
		await runtime.dispose();
		runtime = open();
		await runtime.runPromise(scoring);
		await runtime.runPromise(
			Effect.gen(function* () {
				const categories = yield* CategorySet;
				yield* categories.replace(2, criteriaDraft);
				const sql = yield* SqlClient.SqlClient;
				// These verdicts were judged with the newly saved definitions.
				yield* sql`UPDATE message_parts SET surfacing_set_version = 3`;
				yield* categories.replace(3, {
					categories: criteriaDraft.categories.map((category) => ({
						...category,
						weight: 90,
					})),
				});
			}),
		);
		await runtime.dispose();
		runtime = open();
		await runtime.runPromise(scoring);
		await runtime.runPromise(
			Effect.gen(function* () {
				const tuning = yield* makeCategoryTuning({
					configDir: directory,
					cwd: process.cwd(),
				});
				expect(yield* tuning.score(draft, true)).toMatchObject({
					complete: false,
					requiredCalls: 55,
				});
			}),
		);
		expect(f.post).not.toHaveBeenCalled();
	} finally {
		await runtime.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});

it.effect("reads title and request in the newest-first ledger", () => {
	const f = fixture();
	return Effect.gen(function* () {
		yield* seed;
		const ledger = yield* readSurfacingFeedback();
		expect(ledger).toHaveLength(5);
		expect(ledger[0]).toMatchObject({
			partId: "p5",
			sessionTitle: "Find the regression",
			requestExcerpt: "Find the latency regression",
			ordinal: 5,
		});
	}).pipe(Effect.provide(f.layer));
});

it.effect(
	"scores persisted verdicts and weights for free; estimates and caches criteria on one stable sample",
	() => {
		const f = fixture();
		return Effect.gen(function* () {
			yield* seed;
			const tuning = yield* makeCategoryTuning({
				configDir: "/tmp/category-tuning-test",
				cwd: process.cwd(),
				queryFactory: f.query,
			});
			const before = yield* tuning.score(current);
			expect(before).toMatchObject({
				agree: 0,
				total: 5,
				requiredCalls: 0,
				jevCalls: 0,
				complete: true,
			});
			expect(before.levels).toHaveLength(55);
			expect(before.levels.some(({ partId }) => partId === "p6")).toBe(false);
			const weights = yield* tuning.score(draft);
			expect(weights).toMatchObject({
				agree: 5,
				total: 5,
				jevCalls: 0,
				complete: true,
			});
			expect(f.post).not.toHaveBeenCalled();
			const retired = yield* tuning.score({
				categories: draft.categories.map((category) =>
					category.id === "finding" ? { ...category, retired: true } : category,
				),
			});
			expect(retired).toMatchObject({
				agree: 0,
				requiredCalls: 0,
				jevCalls: 0,
				complete: true,
			});
			expect(f.post).not.toHaveBeenCalled();
			const estimate = yield* tuning.score(criteriaDraft, true);
			expect(estimate).toMatchObject({
				requiredCalls: 55,
				jevCalls: 0,
				complete: false,
			});
			expect(estimate.levels.every(({ level }) => level === null)).toBe(true);
			expect(estimate.unavailableReason).toBeUndefined();
			expect(f.post).not.toHaveBeenCalled();
			const results = yield* Effect.all(
				[tuning.score(criteriaDraft), tuning.score(criteriaDraft)],
				{ concurrency: 2 },
			);
			expect(results[0]).toMatchObject({ agree: 5, total: 5, complete: true });
			expect(f.post).toHaveBeenCalledTimes(55);
			expect(results[0]?.levels.map(({ partId }) => partId)).toEqual(
				before.levels.map(({ partId }) => partId),
			);
			const cached = yield* tuning.score(criteriaDraft);
			expect(cached).toMatchObject({
				requiredCalls: 0,
				jevCalls: 0,
				complete: true,
			});
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at, surfacing_ordinal, surfacing_probabilities, surfacing_set_version) VALUES ('new', 'm', 'text', 'new arrival', 100, 100, 100, 100, '{"finding":1}', 1)`;
			expect(
				(yield* tuning.score(draft)).levels.map(({ partId }) => partId),
			).toEqual(before.levels.map(({ partId }) => partId));
		}).pipe(Effect.provide(f.layer));
	},
);

it.effect(
	"scores the saved set from persisted verdicts after a definition edit",
	() => {
		let saved = current;
		const f = fixture(true, () => saved);
		return Effect.gen(function* () {
			yield* seed;
			const tuning = yield* makeCategoryTuning({
				configDir: "/tmp/category-tuning-test",
				cwd: process.cwd(),
				queryFactory: f.query,
			});
			yield* tuning.score(current, true);
			saved = { ...criteriaDraft, version: 2 };
			const sql = yield* SqlClient.SqlClient;
			yield* sql`UPDATE message_parts SET surfacing_set_version = 2`;
			expect(yield* tuning.score(saved)).toMatchObject({
				agree: 5,
				requiredCalls: 0,
				jevCalls: 0,
				complete: true,
			});
			expect(yield* tuning.score(current, true)).toMatchObject({
				requiredCalls: 55,
				complete: false,
			});
			expect(f.post).not.toHaveBeenCalled();
		}).pipe(Effect.provide(f.layer));
	},
);

it.effect(
	"reuses verdicts by their saved criteria across definition and weight-only saves",
	() => {
		let saved = current;
		const f = fixture(true, () => saved);
		return Effect.gen(function* () {
			yield* seed;
			const tuning = yield* makeCategoryTuning({
				configDir: "/tmp/category-tuning-test",
				cwd: process.cwd(),
			});
			yield* tuning.score(current, true);
			saved = { ...criteriaDraft, version: 2 };
			const sql = yield* SqlClient.SqlClient;
			// Only this message has been judged since the definition was saved.
			yield* sql`UPDATE message_parts SET surfacing_set_version = 2 WHERE id = 'p1'`;
			const latest = yield* tuning.score(saved, true);
			expect(latest).toMatchObject({
				complete: false,
				agree: 1,
				requiredCalls: 0,
				jevCalls: 0,
			});
			expect(latest.levels.filter(({ level }) => level !== null)).toEqual([
				{ partId: "p1", sessionId: "s", level: "key", category: "finding" },
			]);
			expect(yield* tuning.score(saved)).toMatchObject({
				agree: 1,
				jevCalls: 0,
			});
			// A later weight-only save keeps version-2 verdicts usable for free.
			saved = {
				version: 3,
				categories: saved.categories.map((category) => ({
					...category,
					weight: 90,
				})),
			};
			expect(yield* tuning.score(saved)).toMatchObject({
				agree: 1,
				jevCalls: 0,
			});
			yield* sql`UPDATE message_parts SET surfacing_set_version = 3`;
			expect(yield* tuning.score(saved, true)).toMatchObject({
				complete: true,
				agree: 5,
				requiredCalls: 0,
				jevCalls: 0,
			});
			expect(f.post).not.toHaveBeenCalled();
		}).pipe(Effect.provide(f.layer));
	},
);

it.effect("never caches incomplete Jev output, and allows a paid retry", () => {
	const f = fixture();
	const validPost = f.post.getMockImplementation();
	f.post.mockImplementation(() =>
		Effect.succeed(
			Response.json({
				answers: { category: { probabilities: { finding: 1 } } },
			}),
		),
	);
	return Effect.gen(function* () {
		yield* seed;
		const tuning = yield* makeCategoryTuning({
			configDir: "/tmp/category-tuning-test",
			cwd: process.cwd(),
			queryFactory: f.query,
		});
		const failed = yield* tuning.score(criteriaDraft);
		expect(failed).toMatchObject({
			complete: false,
			requiredCalls: 55,
			jevCalls: 55,
			canTest: true,
		});
		expect(failed.unavailableReason).toContain("Retry");
		if (!validPost) throw new Error("Missing fake Jev implementation");
		f.post.mockImplementation(validPost);
		expect(yield* tuning.score(criteriaDraft)).toMatchObject({
			complete: true,
			agree: 5,
			jevCalls: 55,
			requiredCalls: 0,
		});
		expect(f.post).toHaveBeenCalledTimes(110);
	}).pipe(Effect.provide(f.layer));
});

it.effect(
	"rejects malformed, stale, identity-changing and empty proposal hunks",
	() => {
		const f = fixture();
		return Effect.gen(function* () {
			yield* seed;
			const tuning = yield* makeCategoryTuning({
				configDir: "/tmp/category-tuning-test",
				cwd: process.cwd(),
				queryFactory: f.query,
			});
			for (const invalid of [
				{ ...hunk, after: hunk.before },
				{ ...hunk, before: null },
				{ ...hunk, after: { ...hunk.after, label: "Changed identity" } },
				{ ...hunk, after: { ...hunk.after, weight: 101 } },
			]) {
				f.query.mockImplementation(async function* (_input) {
					yield {
						type: "result",
						result: JSON.stringify({ hunks: [invalid], rationale: "Invalid" }),
					};
				});
				expect((yield* Effect.result(tuning.propose({})))._tag).toBe("Failure");
			}
			expect(f.replace).not.toHaveBeenCalled();
		}).pipe(Effect.provide(f.layer));
	},
);

it.effect(
	"reports unavailable scores honestly without a key or with failed persisted verdicts",
	() => {
		const f = fixture(false);
		return Effect.gen(function* () {
			yield* seed;
			const sql = yield* SqlClient.SqlClient;
			yield* sql`UPDATE message_parts SET surfacing_probabilities = NULL WHERE id = 'p1'`;
			const tuning = yield* makeCategoryTuning({
				configDir: "/tmp/category-tuning-test",
				cwd: process.cwd(),
				queryFactory: f.query,
			});
			expect(yield* tuning.score(current)).toMatchObject({
				total: 5,
				complete: false,
				jevCalls: 0,
			});
			const candidate = yield* tuning.score(criteriaDraft);
			expect(candidate).toMatchObject({
				complete: false,
				jevCalls: 0,
				requiredCalls: 55,
			});
			expect(candidate.unavailableReason).toBeTruthy();
			expect(f.post).not.toHaveBeenCalled();
		}).pipe(Effect.provide(f.layer));
	},
);

it.effect(
	"proposes explicit retirement dependencies so each addition can be scored at the active-category cap",
	() => {
		const custom: Category = {
			id: "custom-0",
			origin: "custom",
			label: "Custom 0",
			glyph: "*",
			colour: "#123456",
			weight: 50,
			retired: false,
			criteria: { what: "A custom category" },
		};
		const capped = {
			...current,
			categories: [
				...current.categories,
				...Array.from({ length: 20 - current.categories.length }, (_, n) => ({
					...custom,
					id: `custom-${n}`,
					label: `Custom ${n}`,
				})),
			],
		};
		const additions = ["First", "Second"].map((label) => ({
			id: `add-${label.toLowerCase()}`,
			categoryId: label.toLowerCase(),
			before: null,
			after: { ...custom, id: label.toLowerCase(), label },
			rationale: `Add ${label}`,
		}));
		const retirements = current.categories
			.filter(({ id }) => id === "ask" || id === "risk")
			.map((category) => ({
				id: `retire-${category.id}`,
				categoryId: category.id,
				before: category,
				after: { ...category, retired: true },
				rationale: `Retire ${category.label}`,
			}));
		const f = fixture(true, () => capped);
		f.query.mockImplementation(async function* () {
			yield {
				type: "result",
				result: JSON.stringify({
					hunks: [...additions, ...retirements, hunk],
					rationale: "Replace two categories and adjust findings.",
				}),
			};
		});
		return Effect.gen(function* () {
			yield* seed;
			const tuning = yield* makeCategoryTuning({
				configDir: "/tmp/category-tuning-test",
				cwd: process.cwd(),
				queryFactory: f.query,
			});
			const proposal = yield* tuning.propose({});
			expect(proposal.hunks).toMatchObject([
				{ id: "add-first", dependsOn: ["retire-ask"] },
				{ id: "add-second", dependsOn: ["retire-risk"] },
				{ id: "retire-ask", dependsOn: [] },
				{ id: "retire-risk", dependsOn: [] },
				{ id: "finding-weight", dependsOn: [] },
			]);
			for (const [index, addition] of proposal.hunks.slice(0, 2).entries()) {
				const dependencies = hunkDependencies(proposal.hunks, addition);
				expect(dependencies.map(({ id }) => id)).toEqual([
					index === 0 ? "retire-ask" : "retire-risk",
				]);
				const individual = withTuningHunks(capped, [...dependencies, addition]);
				expect(
					individual.categories.filter(({ retired }) => !retired),
				).toHaveLength(20);
				expect(yield* tuning.score(individual, true)).toMatchObject({
					requiredCalls: 55,
					jevCalls: 0,
				});
			}
			expect(f.post).not.toHaveBeenCalled();
		}).pipe(Effect.provide(f.layer));
	},
);

it.effect(
	"proposes validated edits through one-shot Opus with avoid and never stores them",
	() => {
		const f = fixture();
		return Effect.gen(function* () {
			yield* seed;
			const tuning = yield* makeCategoryTuning({
				configDir: "/tmp/category-tuning-test",
				cwd: process.cwd(),
				queryFactory: f.query,
			});
			const result = yield* tuning.propose({});
			expect(result).toMatchObject({
				hunks: [hunk],
				rationale: "Raise findings.",
				baseVersion: 1,
			});
			yield* tuning.propose({ avoid: result.hunks });
			const input = f.query.mock.calls.at(-1)?.[0];
			expect(input?.options).toMatchObject({
				model: "opus",
				persistSession: false,
				tools: [],
				maxTurns: 1,
			});
			expect(input?.prompt).toContain("finding-weight");
			expect(input?.prompt).toContain("Find the latency regression");
			expect(f.replace).not.toHaveBeenCalled();
			const sql = yield* SqlClient.SqlClient;
			yield* sql`DELETE FROM surfacing_marks WHERE part_id = 'p1'`;
			expect((yield* Effect.result(tuning.propose({})))._tag).toBe("Failure");
			expect(f.query).toHaveBeenCalledTimes(2);
		}).pipe(Effect.provide(f.layer));
	},
);
