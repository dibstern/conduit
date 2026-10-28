// Failure modes: cancellation after commit skips invalidation, cleanup re-enters
// the directory lock, rejected or cancelled edits invalidate live credentials,
// and overlapping edits leave a stale account generation in use.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Redacted } from "effect";
import { afterEach, expect } from "vitest";
import { makeAccountResourceScopesLive } from "../../../src/lib/domain/daemon/Layers/account-resource-scopes-layer.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { ConfigPersistenceTag } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	applyAccountChange,
	makeInstanceManagerStateLive,
} from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import {
	CursorAccountResources,
	CursorAccountResourcesLive,
} from "../../../src/lib/provider/cursor/cursor-account-resources.js";

const roots: string[] = [];
const evidence: { name: string; result: string | undefined }[] = [];
afterEach(({ task }) => {
	evidence.push({ name: task.name, result: task.result?.state });
	writeFileSync(
		"/tmp/82tn9-4-merge97-account-invalidation.json",
		JSON.stringify(evidence, null, 2),
	);
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture(requestSave: Effect.Effect<void>) {
	const root = mkdtempSync(join(tmpdir(), "account-change-invalidation-"));
	roots.push(root);
	const base = Layer.mergeAll(
		makeInstanceManagerStateLive(
			undefined,
			[
				{
					id: "cursor-a",
					name: "A",
					driver: "cursor",
					port: 0,
					managed: false,
					env: { CURSOR_API_KEY: "synthetic-old-key" },
				},
			],
			{ launchLogin: { _tag: "Configured", path: join(root, "claude") } },
		),
		DaemonEventBusLive,
		makeAccountResourceScopesLive(),
		Layer.succeed(ConfigPersistenceTag, { requestSave, flush: Effect.void }),
	);
	return CursorAccountResourcesLive(
		root,
		join(root, "unused-legacy.json"),
	).pipe(Layer.provideMerge(base));
}

for (const operation of ["Update", "Remove"] as const) {
	it.effect(`cancelled Cursor ${operation} invalidates after its commit`, () =>
		Effect.gen(function* () {
			const saving = yield* Deferred.make<void>();
			const finish = yield* Deferred.make<void>();
			return yield* Effect.gen(function* () {
				const directory = yield* AccountDirectory;
				const resources = yield* CursorAccountResources;
				const started = yield* Deferred.make<void>();
				let cleanupReadDirectory = false;
				const original = yield* resources.use("cursor-a", Effect.succeed);
				const work = yield* resources
					.use("cursor-a", () =>
						Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(
								directory.snapshot.pipe(
									Effect.andThen(
										Effect.sync(() => {
											cleanupReadDirectory = true;
										}),
									),
								),
							),
						),
					)
					.pipe(Effect.forkScoped);
				yield* Deferred.await(started);
				const mutation = yield* applyAccountChange(
					operation === "Update"
						? {
								_tag: "Update",
								id: "cursor-a",
								updates: { env: { CURSOR_API_KEY: "synthetic-new-key" } },
							}
						: { _tag: "Remove", id: "cursor-a" },
				).pipe(Effect.forkScoped);
				yield* Deferred.await(saving);
				mutation.interruptUnsafe();
				yield* Deferred.succeed(finish, undefined);
				expect(Exit.hasInterrupts(yield* Fiber.await(mutation))).toBe(true);
				const account = (yield* directory.snapshot).accounts.find(
					({ id }) => id === "cursor-a",
				);
				expect(account?.env?.["CURSOR_API_KEY"]).toBe(
					operation === "Update" ? "synthetic-new-key" : undefined,
				);
				expect(work.pollUnsafe()).toSatisfy(
					(exit: Exit.Exit<never> | undefined) =>
						exit !== undefined && Exit.hasInterrupts(exit),
				);
				expect(cleanupReadDirectory).toBe(true);
				if (operation === "Update") {
					const current = yield* resources.use("cursor-a", Effect.succeed);
					expect(current.sdk).not.toBe(original.sdk);
					const lookup = yield* current.credential;
					expect(lookup._tag).toBe("Ready");
					if (lookup._tag !== "Ready")
						throw new Error("Missing updated credential");
					expect(Redacted.value(lookup.credential.apiKey)).toBe(
						"synthetic-new-key",
					);
				} else {
					expect(
						Exit.isFailure(
							yield* resources
								.use("cursor-a", Effect.succeed)
								.pipe(Effect.exit),
						),
					).toBe(true);
				}
			}).pipe(
				Effect.provide(
					fixture(
						Deferred.succeed(saving, undefined).pipe(
							Effect.andThen(Deferred.await(finish)),
						),
					),
				),
			);
		}),
	);

	it.effect(
		`failed Cursor ${operation} leaves its resource generation intact`,
		() =>
			Effect.gen(function* () {
				const directory = yield* AccountDirectory;
				const resources = yield* CursorAccountResources;
				const original = yield* resources.use("cursor-a", Effect.succeed);
				const result = yield* applyAccountChange(
					operation === "Update"
						? {
								_tag: "Update",
								id: "cursor-a",
								updates: { env: { CURSOR_API_KEY: "rejected-key" } },
							}
						: { _tag: "Remove", id: "cursor-a" },
				).pipe(Effect.exit);
				expect(Exit.isFailure(result)).toBe(true);
				expect(
					(yield* directory.snapshot).accounts.find(
						({ id }) => id === "cursor-a",
					)?.env?.["CURSOR_API_KEY"],
				).toBe("synthetic-old-key");
				expect((yield* resources.use("cursor-a", Effect.succeed)).sdk).toBe(
					original.sdk,
				);
			}).pipe(Effect.provide(fixture(Effect.die("commit rejected")))),
	);
}

it.effect("an update cancelled before commit preserves the live resource", () =>
	Effect.gen(function* () {
		let saves = 0;
		return yield* Effect.gen(function* () {
			const directory = yield* AccountDirectory;
			const resources = yield* CursorAccountResources;
			const original = yield* resources.use("cursor-a", Effect.succeed);
			const locked = yield* Deferred.make<void>();
			const finish = yield* Deferred.make<void>();
			const blocker = yield* directory
				.apply(
					{ _tag: "Update", id: "cursor-a", updates: { name: "renamed" } },
					[],
					() =>
						Deferred.succeed(locked, undefined).pipe(
							Effect.andThen(Deferred.await(finish)),
						),
				)
				.pipe(Effect.forkScoped);
			yield* Deferred.await(locked);
			const mutation = yield* applyAccountChange({
				_tag: "Update",
				id: "cursor-a",
				updates: { env: { CURSOR_API_KEY: "cancelled-key" } },
			}).pipe(Effect.forkScoped);
			yield* Effect.yieldNow;
			mutation.interruptUnsafe();
			yield* Effect.yieldNow;
			const cancelledBeforeCommit = mutation.pollUnsafe();
			yield* Deferred.succeed(finish, undefined);
			yield* Fiber.join(blocker);
			yield* Fiber.await(mutation);
			expect(cancelledBeforeCommit).toBeDefined();
			expect(saves).toBe(0);
			expect((yield* resources.use("cursor-a", Effect.succeed)).sdk).toBe(
				original.sdk,
			);
			const lookup = yield* original.credential;
			expect(lookup._tag).toBe("Ready");
			if (lookup._tag !== "Ready")
				throw new Error("Missing original credential");
			expect(Redacted.value(lookup.credential.apiKey)).toBe(
				"synthetic-old-key",
			);
		}).pipe(
			Effect.provide(
				fixture(
					Effect.sync(() => {
						saves++;
					}),
				),
			),
		);
	}),
);

it.effect(
	"two overlapping account updates expose only the latest credentials",
	() =>
		Effect.gen(function* () {
			const firstSaving = yield* Deferred.make<void>();
			const secondSaving = yield* Deferred.make<void>();
			const finishFirst = yield* Deferred.make<void>();
			const finishSecond = yield* Deferred.make<void>();
			let saves = 0;
			return yield* Effect.gen(function* () {
				const resources = yield* CursorAccountResources;
				const original = yield* resources.use("cursor-a", Effect.succeed);
				const update = (key: string) =>
					applyAccountChange({
						_tag: "Update",
						id: "cursor-a",
						updates: { env: { CURSOR_API_KEY: key } },
					}).pipe(Effect.forkScoped);
				const first = yield* update("intermediate-key");
				yield* Deferred.await(firstSaving);
				const second = yield* update("latest-key");
				yield* Effect.yieldNow;
				yield* Deferred.succeed(finishFirst, undefined);
				yield* Deferred.await(secondSaving);
				yield* Deferred.succeed(finishSecond, undefined);
				yield* Fiber.join(first);
				yield* Fiber.join(second);
				const current = yield* resources.use("cursor-a", Effect.succeed);
				expect(saves).toBe(2);
				expect(current.sdk).not.toBe(original.sdk);
				const lookup = yield* current.credential;
				expect(lookup._tag).toBe("Ready");
				if (lookup._tag !== "Ready")
					throw new Error("Missing latest credential");
				expect(Redacted.value(lookup.credential.apiKey)).toBe("latest-key");
			}).pipe(
				Effect.provide(
					fixture(
						Effect.suspend(() => {
							const first = saves++ === 0;
							return Deferred.succeed(
								first ? firstSaving : secondSaving,
								undefined,
							).pipe(
								Effect.andThen(
									Deferred.await(first ? finishFirst : finishSecond),
								),
							);
						}),
					),
				),
			);
		}),
);
