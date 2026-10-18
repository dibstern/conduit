// Failure modes: blind concurrent overwrites, invalid identity/presentation,
// deleting built-ins, custom retirement, partial writes, corrupt startup data,
// leaked mutable snapshots, and RPCs starting a project or calling TypeSafe.
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Either, Exit } from "effect";
import { afterEach, beforeEach, expect } from "vitest";
import {
	type Category,
	DEFAULT_CATEGORY_SET,
	surfacingLevel,
} from "../../../src/lib/contracts/category-set.js";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { CategorySetLive } from "../../../src/lib/domain/daemon/Layers/category-set-layer.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { CategorySet } from "../../../src/lib/domain/daemon/Services/category-set.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";

let root: string;
const evidence: Array<{ name: string; result: string | undefined }> = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "conduit-categories-"));
});
afterEach(({ task }) => {
	evidence.push({ name: task.name, result: task.result?.state });
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/ahu8-9-category-set.json",
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	rmSync(root, { recursive: true, force: true });
});

const custom: Category = {
	id: "perf",
	origin: "custom",
	label: "Perf",
	glyph: "⚡",
	colour: "#123abc",
	weight: 50,
	retired: false,
	criteria: { what: "Reports a measured performance change" },
};
describe("CategorySet daemon RPC", () => {
	const client = () =>
		Effect.gen(function* () {
			const handlers = yield* DaemonWsRpcHandlersTag;
			return yield* RpcTest.makeClient(WsRpcGroup).pipe(
				Effect.provide(
					makeRoutedWsRpcServerLayer(
						() => Effect.die("Unexpected project routing"),
						handlers,
					),
				),
			);
		}).pipe(
			Effect.provide(
				makeDaemonRpcTestLayer([], undefined, { configDir: root }),
			),
		);

	it.scoped(
		"serves the tuning contract without a project or provider call",
		() =>
			Effect.gen(function* () {
				const handlers = yield* DaemonWsRpcHandlersTag;
				const rpc = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(
							() => Effect.die("Unexpected project routing"),
							handlers,
						),
					),
				);
				const set = yield* rpc.GetCategorySet({});
				expect(yield* rpc.GetSurfacingLedger({})).toEqual([]);
				expect(
					yield* rpc.ScoreCategorySet({ set, estimateOnly: true }),
				).toEqual({
					agree: 0,
					total: 0,
					levels: [],
					requiredCalls: 0,
					jevCalls: 0,
					complete: true,
					canTest: false,
				});
				expect(
					yield* rpc.ProposeCategoryTuning({}).pipe(Effect.either),
				).toMatchObject({
					_tag: "Left",
					left: {
						message:
							"Raise or lower at least 5 messages before proposing changes.",
					},
				});
			}).pipe(
				Effect.provide(
					makeDaemonRpcTestLayer([], undefined, { configDir: root }),
				),
			),
	);

	it.scoped(
		"re-levels an existing verdict through replace, persists, and reloads",
		() =>
			Effect.gen(function* () {
				const rpc = yield* client();
				const initial = yield* rpc.GetCategorySet({});
				expect(initial).toEqual(DEFAULT_CATEGORY_SET);
				const verdict = { probabilities: { finding: 0.9, routine: 0.1 } };
				expect(surfacingLevel(verdict, initial).level).toBe("all");
				const changed = yield* rpc.ReplaceCategorySet({
					expectedVersion: initial.version,
					nextSet: {
						categories: initial.categories.map((category) =>
							category.id === "finding"
								? { ...category, weight: 90 }
								: category,
						),
					},
				});
				expect(changed.version).toBe(initial.version + 1);
				expect(surfacingLevel(verdict, changed).level).toBe("key");
				expect(
					JSON.parse(
						readFileSync(join(root, "surfacing/categories.json"), "utf8"),
					),
				).toMatchObject(changed);
				const restarted = yield* client();
				expect(yield* restarted.GetCategorySet({})).toEqual(changed);
			}),
	);

	it.scoped("allows only one of two writes based on the same version", () =>
		Effect.gen(function* () {
			const rpc = yield* client();
			const initial = yield* rpc.GetCategorySet({});
			const results = yield* Effect.all(
				[1, 2].map(() =>
					rpc
						.ReplaceCategorySet({
							expectedVersion: initial.version,
							nextSet: initial,
						})
						.pipe(Effect.either),
				),
				{ concurrency: 2 },
			);
			expect(results.filter(Either.isRight)).toHaveLength(1);
			const failed = results.find(Either.isLeft);
			expect(failed?.left).toMatchObject({
				_tag: "CategorySetRejected",
				reason: "stale_version",
				currentVersion: initial.version + 1,
			});
		}),
	);

	it.scoped(
		"adds, edits and deletes customs while built-ins can retire and restore",
		() =>
			Effect.gen(function* () {
				const rpc = yield* client();
				const initial = yield* rpc.GetCategorySet({});
				const added = yield* rpc.ReplaceCategorySet({
					expectedVersion: initial.version,
					nextSet: { categories: [...initial.categories, custom] },
				});
				const edited = yield* rpc.ReplaceCategorySet({
					expectedVersion: added.version,
					nextSet: {
						categories: added.categories.map((category) =>
							category.id === "perf"
								? { ...category, label: "Latency", glyph: "🚀", weight: 70 }
								: { ...category, retired: category.id === "ask" },
						),
					},
				});
				expect(edited.categories.at(-1)).toMatchObject({
					id: "perf",
					label: "Latency",
				});
				const removed = yield* rpc.ReplaceCategorySet({
					expectedVersion: edited.version,
					nextSet: {
						categories: edited.categories
							.filter(({ id }) => id !== "perf")
							.map((category) => ({ ...category, retired: false })),
					},
				});
				expect(removed.categories).toEqual(DEFAULT_CATEGORY_SET.categories);
			}),
	);

	it.scoped("rejects invalid sets without changing disk or memory", () =>
		Effect.gen(function* () {
			const rpc = yield* client();
			const initial = yield* rpc.GetCategorySet({});
			const changeAsk = (patch: Partial<Category>) =>
				initial.categories.map((category) =>
					category.id === "ask" ? { ...category, ...patch } : category,
				);
			const invalid = [
				[...initial.categories, ...initial.categories.slice(0, 1)],
				initial.categories.filter(({ id }) => id !== "ask"),
				[
					...initial.categories,
					...Array.from({ length: 12 }, (_, i) => ({
						...custom,
						id: `custom-${i}`,
						label: `Custom ${i}`,
					})),
				],
				changeAsk({ glyph: "two" }),
				changeAsk({ weight: 101 }),
				changeAsk({ weight: -1 }),
				changeAsk({ label: "" }),
				changeAsk({ label: "x".repeat(25) }),
				changeAsk({ colour: "red" }),
				changeAsk({ origin: "custom" }),
				[...initial.categories, { ...custom, id: "wrong" }],
				[...initial.categories, { ...custom, retired: true }],
				[...initial.categories, { ...custom, id: "routine", label: "Routine" }],
			];
			const persisted = readFileSync(
				join(root, "surfacing/categories.json"),
				"utf8",
			);
			for (const categories of invalid) {
				const result = yield* rpc
					.ReplaceCategorySet({
						expectedVersion: initial.version,
						nextSet: { categories },
					})
					.pipe(Effect.exit);
				expect(Exit.isFailure(result)).toBe(true);
				expect(yield* rpc.GetCategorySet({})).toEqual(initial);
				expect(
					readFileSync(join(root, "surfacing/categories.json"), "utf8"),
				).toBe(persisted);
			}
		}),
	);

	it.scoped(
		"quarantines malformed and invalid persisted sets before using defaults",
		() =>
			Effect.gen(function* () {
				mkdirSync(join(root, "surfacing"));
				for (const contents of [
					"{bad json",
					JSON.stringify({ version: 4, categories: [] }),
				]) {
					writeFileSync(join(root, "surfacing/categories.json"), contents);
					const rpc = yield* client();
					expect(yield* rpc.GetCategorySet({})).toEqual(DEFAULT_CATEGORY_SET);
					const quarantines = readdirSync(join(root, "surfacing")).filter(
						(name) => name.startsWith("categories.json.corrupt-"),
					);
					expect(
						quarantines.some(
							(name) =>
								readFileSync(join(root, "surfacing", name), "utf8") ===
								contents,
						),
					).toBe(true);
				}
			}),
	);

	it.scoped("does not publish a new version when the atomic write fails", () =>
		Effect.gen(function* () {
			const rpc = yield* client();
			const initial = yield* rpc.GetCategorySet({});
			rmSync(join(root, "surfacing/categories.json"));
			mkdirSync(join(root, "surfacing/categories.json"));
			const result = yield* rpc
				.ReplaceCategorySet({
					expectedVersion: initial.version,
					nextSet: initial,
				})
				.pipe(Effect.either);
			expect(Either.isLeft(result)).toBe(true);
			expect(yield* rpc.GetCategorySet({})).toEqual(initial);
			expect(readdirSync(join(root, "surfacing"))).toEqual(["categories.json"]);
		}),
	);

	it.scoped("isolates current and replace results from caller mutations", () =>
		Effect.gen(function* () {
			const service = yield* CategorySet;
			const snapshot = yield* service.current();
			Reflect.set(snapshot.categories[0] ?? {}, "weight", 0);
			expect(yield* service.current()).toEqual(DEFAULT_CATEGORY_SET);
			const saved = yield* service.replace(
				snapshot.version,
				DEFAULT_CATEGORY_SET,
			);
			Reflect.set(saved.categories[0]?.criteria ?? {}, "what", "mutated");
			expect((yield* service.current()).categories).toEqual(
				DEFAULT_CATEGORY_SET.categories,
			);
		}).pipe(Effect.provide(CategorySetLive(root))),
	);
});
