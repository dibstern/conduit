import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import {
	BUILTIN_CATEGORIES,
	CategorySetContentsSchema,
	CategorySetRejected,
	CategorySetSchema,
	type CategorySet as CategorySetSnapshot,
	categoryIdFromLabel,
	DEFAULT_CATEGORY_SET,
} from "../../../contracts/category-set.js";
import { WsRpcError } from "../../../contracts/ws-rpc.js";
import { CategorySet } from "../Services/category-set.js";

function validateCategories(
	next: CategorySetSnapshot["categories"],
	previous: CategorySetSnapshot,
) {
	const invalid = (message: string) =>
		new CategorySetRejected({
			reason: "invalid_set",
			message,
			currentVersion: previous.version,
		});
	const ids = new Set<string>();
	let active = 0;
	for (const category of next) {
		if (ids.has(category.id))
			throw invalid(`Duplicate category id: ${category.id}`);
		ids.add(category.id);
		if (category.id === "routine")
			throw invalid("Routine is implicit and cannot be edited");
		if (!category.retired) active++;
		const builtin = BUILTIN_CATEGORIES.find(({ id }) => id === category.id);
		if (builtin) {
			if (
				category.origin !== "builtin" ||
				category.label !== builtin.label ||
				category.glyph !== builtin.glyph ||
				category.colour !== builtin.colour
			) {
				throw invalid(
					`Built-in identity and presentation are immutable: ${category.id}`,
				);
			}
		} else {
			if (category.origin !== "custom" || category.retired)
				throw invalid(
					"Custom categories must be active and have custom origin",
				);
			const existing = previous.categories.find(({ id }) => id === category.id);
			if (!existing && category.id !== categoryIdFromLabel(category.label))
				throw invalid(
					`New category id must be derived from its label: ${category.id}`,
				);
		}
	}
	for (const builtin of BUILTIN_CATEGORIES) {
		if (!ids.has(builtin.id))
			throw invalid(`Built-in category cannot be deleted: ${builtin.id}`);
	}
	if (active > 20) throw invalid("At most 20 categories may be active");
}

export const CategorySetLive = (configDir: string) =>
	Layer.effect(
		CategorySet,
		Effect.gen(function* () {
			const directory = join(configDir, "surfacing");
			const filename = join(directory, "categories.json");
			const write = (snapshot: CategorySetSnapshot) => {
				mkdirSync(directory, { recursive: true });
				const temporary = `${filename}.tmp-${randomUUID()}`;
				try {
					writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
						encoding: "utf8",
						flag: "wx",
					});
					renameSync(temporary, filename);
				} finally {
					rmSync(temporary, { force: true });
				}
			};
			let quarantine: string | undefined;
			let loadError: unknown;
			let snapshot = yield* Effect.try({
				try: () => {
					let loaded: CategorySetSnapshot;
					try {
						loaded = Schema.decodeUnknownSync(
							Schema.parseJson(CategorySetSchema),
						)(readFileSync(filename, "utf8"));
						// Persisted custom labels may have changed since their ids were created.
						validateCategories(loaded.categories, loaded);
						return loaded;
					} catch (error) {
						if (
							!(
								error instanceof Error &&
								"code" in error &&
								error.code === "ENOENT"
							)
						) {
							let timestamp = Date.now();
							while (existsSync(`${filename}.corrupt-${timestamp}`))
								timestamp++;
							quarantine = `${filename}.corrupt-${timestamp}`;
							renameSync(filename, quarantine);
							loadError = error;
						}
					}
					loaded = structuredClone(DEFAULT_CATEGORY_SET);
					write(loaded);
					return loaded;
				},
				catch: (error) =>
					new WsRpcError({
						message: `Cannot load category set: ${String(error)}`,
					}),
			});
			if (quarantine)
				yield* Effect.logWarning(
					"Quarantined unreadable category set; using shipped defaults",
					{ filename, quarantine, error: String(loadError) },
				);
			return {
				current: () => Effect.sync(() => structuredClone(snapshot)),
				replace: (expectedVersion, nextSet) =>
					Effect.try({
						try: () => {
							if (expectedVersion !== snapshot.version)
								throw new CategorySetRejected({
									reason: "stale_version",
									message: "Categories changed elsewhere.",
									currentVersion: snapshot.version,
								});
							let categories: CategorySetSnapshot["categories"];
							try {
								categories = Schema.decodeUnknownSync(
									CategorySetContentsSchema,
								)(nextSet).categories;
								validateCategories(categories, snapshot);
								if (snapshot.version >= Number.MAX_SAFE_INTEGER)
									throw new CategorySetRejected({
										reason: "invalid_set",
										message: "Category set version is exhausted",
										currentVersion: snapshot.version,
									});
							} catch (error) {
								if (error instanceof CategorySetRejected) throw error;
								throw new CategorySetRejected({
									reason: "invalid_set",
									message: String(error),
									currentVersion: snapshot.version,
								});
							}
							const next = { version: snapshot.version + 1, categories };
							// Synchronous IO keeps check, rename, and publication in one transaction.
							write(next);
							snapshot = next;
							return structuredClone(snapshot);
						},
						catch: (error) =>
							error instanceof CategorySetRejected
								? error
								: new WsRpcError({
										message: `Cannot save category set: ${String(error)}`,
									}),
					}),
			};
		}),
	);
