// test/unit/instance/instance-manager-effect.test.ts
import { describe, it } from "@effect/vitest";
import { Effect, Exit, HashMap, Layer, Ref } from "effect";
import { expect } from "vitest";
import { ConfigPersistenceNoopLive } from "../../../src/lib/effect/config-persistence-layer.js";
import {
	addInstance,
	InstanceManagerStateTag,
	makeInstanceManagerStateLive,
	removeInstance,
} from "../../../src/lib/effect/instance-manager-service.js";

const testLayer = makeInstanceManagerStateLive().pipe(
	Layer.provideMerge(ConfigPersistenceNoopLive),
);

describe("InstanceManager Effect", () => {
	it.scoped("addInstance registers instance in state", () =>
		Effect.gen(function* () {
			yield* addInstance({
				id: "inst-1",
				name: "Test Instance",
				port: 4096,
				managed: false,
			});
			const ref = yield* InstanceManagerStateTag;
			const state = yield* Ref.get(ref);
			expect(HashMap.has(state.instances, "inst-1")).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("removeInstance clears instance from state", () =>
		Effect.gen(function* () {
			yield* addInstance({
				id: "inst-1",
				name: "Test Instance",
				port: 4096,
				managed: false,
			});
			yield* removeInstance("inst-1");
			const ref = yield* InstanceManagerStateTag;
			const state = yield* Ref.get(ref);
			expect(HashMap.has(state.instances, "inst-1")).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("enforces max instance limit", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				Effect.gen(function* () {
					for (let i = 0; i < 6; i++) {
						yield* addInstance({
							id: `inst-${i}`,
							name: `Inst ${i}`,
							port: 4096 + i,
							managed: false,
						});
					}
				}),
			);
			expect(Exit.isFailure(exit)).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("add-remove-add at max instances succeeds", () =>
		Effect.gen(function* () {
			for (let i = 0; i < 5; i++) {
				yield* addInstance({
					id: `inst-${i}`,
					name: `Inst ${i}`,
					port: 4096 + i,
					managed: false,
				});
			}
			yield* removeInstance("inst-0");
			yield* addInstance({
				id: "inst-new",
				name: "New",
				port: 5000,
				managed: false,
			});
			const ref = yield* InstanceManagerStateTag;
			const state = yield* Ref.get(ref);
			expect(HashMap.size(state.instances)).toBe(5);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.scoped("max instance error has correct tag for catchTag", () =>
		Effect.gen(function* () {
			const result = yield* Effect.gen(function* () {
				for (let i = 0; i < 6; i++) {
					yield* addInstance({
						id: `inst-${i}`,
						name: `Inst ${i}`,
						port: 4096 + i,
						managed: false,
					});
				}
			}).pipe(
				Effect.catchTag("InstanceLimitExceeded", (e) =>
					Effect.succeed(`caught: max=${e.max}`),
				),
			);
			expect(result).toBe("caught: max=5");
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});
