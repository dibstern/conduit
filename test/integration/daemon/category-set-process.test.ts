// Real-daemon failure modes: RPCs routed through a project, different clients
// seeing different sets, stale writes succeeding, a save lost on restart, or
// corrupt startup data preventing the daemon from serving defaults.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Either } from "effect";
import { expect, it } from "vitest";
import {
	DEFAULT_CATEGORY_SET,
	surfacingLevel,
} from "../../../src/lib/contracts/category-set.js";
import {
	GetCategorySet,
	ReplaceCategorySet,
} from "../../../src/lib/contracts/ws-rpc.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

it(
	"shares versioned categories across browser and local RPC, restart and corrupt recovery",
	{ timeout: 90_000 },
	async () => {
		const harness = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
		});
		const observations: Record<string, unknown> = {};
		let passed = false;
		try {
			await harness.restart();
			const browser = await harness.connect();
			const initial = await Effect.runPromise(browser.rpc.GetCategorySet({}));
			expect(initial).toEqual(DEFAULT_CATEGORY_SET);
			const verdict = { probabilities: { finding: 0.9, routine: 0.1 } };
			const changed = await Effect.runPromise(
				browser.rpc.ReplaceCategorySet({
					expectedVersion: initial.version,
					nextSet: {
						categories: initial.categories.map((category) =>
							category.id === "finding"
								? { ...category, weight: 90 }
								: category,
						),
					},
				}),
			);
			expect(surfacingLevel(verdict, initial).level).toBe("all");
			expect(surfacingLevel(verdict, changed).level).toBe("key");
			expect(await harness.requestRpc(new GetCategorySet({}))).toEqual(changed);
			const stale = await Effect.runPromise(
				browser.rpc
					.ReplaceCategorySet({
						expectedVersion: initial.version,
						nextSet: initial,
					})
					.pipe(Effect.either),
			);
			expect(Either.isLeft(stale) && stale.left).toMatchObject({
				reason: "stale_version",
				currentVersion: changed.version,
			});
			const invalid = [
				[...changed.categories, ...changed.categories.slice(0, 1)],
				changed.categories.filter(({ id }) => id !== "ask"),
				[
					...changed.categories,
					...Array.from({ length: 12 }, (_, i) => ({
						id: `custom-${i}`,
						origin: "custom" as const,
						label: `Custom ${i}`,
						glyph: "!",
						colour: "#123abc",
						weight: 50,
						retired: false,
						criteria: { what: "Custom finding" },
					})),
				],
				changed.categories.map((category) =>
					category.id === "ask" ? { ...category, glyph: "two" } : category,
				),
			];
			for (const categories of invalid) {
				await expect(
					harness.requestRpc(
						new ReplaceCategorySet(
							{ expectedVersion: changed.version, nextSet: { categories } },
							{ disableValidation: true },
						),
					),
				).rejects.toBeDefined();
			}
			expect(await harness.requestRpc(new GetCategorySet({}))).toEqual(changed);
			await harness.terminate();
			await harness.restart();
			expect(await harness.requestRpc(new GetCategorySet({}))).toEqual(changed);
			const filename = join(harness.configDir, "surfacing/categories.json");
			const corrupt = "{ damaged categories";
			writeFileSync(filename, corrupt);
			await harness.terminate();
			await harness.restart();
			expect(await harness.requestRpc(new GetCategorySet({}))).toEqual(
				DEFAULT_CATEGORY_SET,
			);
			const quarantines = readdirSync(
				join(harness.configDir, "surfacing"),
			).filter((name) => name.startsWith("categories.json.corrupt-"));
			expect(quarantines).toHaveLength(1);
			expect(
				readFileSync(
					join(harness.configDir, "surfacing", quarantines[0] ?? ""),
					"utf8",
				),
			).toBe(corrupt);
			expect(harness.logTail).toContain("Quarantined unreadable category set");
			Object.assign(observations, {
				before: surfacingLevel(verdict, initial),
				after: surfacingLevel(verdict, changed),
				initialVersion: initial.version,
				savedVersion: changed.version,
				invalidSetsRejected: invalid.length,
				quarantines,
			});
			passed = true;
		} finally {
			const logs = harness.logTail;
			await harness.dispose();
			harness.assertNoRunners();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/ahu8-9-category-set-process.json",
				`${JSON.stringify({ passed, observations, logs }, null, 2)}\n`,
			);
		}
	},
);
