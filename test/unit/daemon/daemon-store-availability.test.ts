import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { expect } from "vitest";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import {
	DaemonStoreAvailability,
	markProjectUnavailable,
	onProjectUnavailable,
} from "../../../src/lib/domain/daemon/Services/daemon-store-availability.js";
import {
	makeProjectRegistryLive,
	markError,
	markReady,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";

// Failures: publishing unavailable before cleanup finishes admits new warms;
// cleaning a different daemon's project or retaining a disposed owner leaks state.
it.effect("blocks the project before awaiting its reservation cleanup", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const unavailable = new Map<string, string>();
			const entered = yield* Deferred.make<string>();
			const released = yield* Deferred.make<void>();
			yield* onProjectUnavailable(unavailable, (projectId) =>
				Deferred.succeed(entered, projectId).pipe(
					Effect.andThen(Deferred.await(released)),
				),
			);
			const transition = yield* markProjectUnavailable(
				unavailable,
				"a",
				"Provider attachment recovery failed",
			).pipe(Effect.forkChild);
			expect(yield* Deferred.await(entered)).toBe("a");
			expect(unavailable.get("a")).toBe("Provider attachment recovery failed");
			expect(unavailable.has("b")).toBe(false);
			expect(transition.pollUnsafe()).toBeUndefined();
			yield* Deferred.succeed(released, undefined);
			yield* Fiber.join(transition);
		}),
	),
);

it.effect(
	"scopes cleanup to its daemon and releases the binding on disposal",
	() =>
		Effect.gen(function* () {
			const unavailable = new Map<string, string>();
			const other = new Map<string, string>();
			const cleaned: string[] = [];
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* onProjectUnavailable(unavailable, (projectId) =>
						Effect.sync(() => {
							cleaned.push(projectId);
						}),
					);
					yield* markProjectUnavailable(other, "other", "Import failed");
					yield* markProjectUnavailable(unavailable, "a", "Attachment failed");
					yield* markProjectUnavailable(unavailable, "a", "Recovery failed");
				}),
			);
			yield* markProjectUnavailable(unavailable, "disposed", "Import failed");
			expect(cleaned).toEqual(["a", "a"]);
			expect(unavailable.get("a")).toBe("Recovery failed");
		}),
);

it.effect("releases retryable relay failures without blocking recovery", () => {
	const unavailable = new Map<string, string>();
	return Effect.scoped(
		Effect.gen(function* () {
			const cleaned: string[] = [];
			yield* onProjectUnavailable(unavailable, (projectId) =>
				Effect.sync(() => {
					cleaned.push(projectId);
				}),
			);
			yield* markError("a", "Relay startup failed");
			expect(cleaned).toEqual(["a"]);
			expect(unavailable.has("a")).toBe(false);
			yield* markReady("a");
		}),
	).pipe(
		Effect.provide(
			Layer.mergeAll(
				makeProjectRegistryLive([
					{ slug: "a", title: "A", folders: ["/tmp/a"] },
				]),
				DaemonEventBusLive,
				Layer.succeed(DaemonStoreAvailability)(unavailable),
			),
		),
	);
});
