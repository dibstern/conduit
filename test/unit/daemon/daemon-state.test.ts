import { describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { expect } from "vitest";
import {
	DaemonStateTag,
	makeDaemonStateLive,
} from "../../../src/lib/effect/daemon-state.js";

describe("DaemonState", () => {
	it.effect("initializes with empty defaults", () =>
		Effect.gen(function* () {
			const ref = yield* DaemonStateTag;
			const state = yield* Ref.get(ref);

			expect(state.pinHash).toBeNull();
			expect(state.keepAwake).toBe(false);
			expect(state.clientCount).toBe(0);
			expect(state.shuttingDown).toBe(false);
			expect(state.dismissedPaths.size).toBe(0);
			expect(state.projects).toEqual([]);
			expect(state.instances).toEqual([]);
			expect(state.tls).toBe(false);
			expect(state.dangerouslySkipPermissions).toBe(false);
		}).pipe(Effect.provide(makeDaemonStateLive())),
	);

	it.effect("initializes with provided config", () =>
		Effect.gen(function* () {
			const ref = yield* DaemonStateTag;
			const result = yield* Ref.get(ref);

			expect(result.pinHash).toBe("abc123");
			expect(result.keepAwake).toBe(true);
			expect(result.dismissedPaths.has("/tmp/foo")).toBe(true);
		}).pipe(
			Effect.provide(
				makeDaemonStateLive({
					pinHash: "abc123",
					keepAwake: true,
					dismissedPaths: new Set(["/tmp/foo"]),
				}),
			),
		),
	);

	it.effect("supports atomic updates across fields", () =>
		Effect.gen(function* () {
			const ref = yield* DaemonStateTag;
			yield* Ref.update(ref, (s) => ({
				...s,
				clientCount: s.clientCount + 1,
				keepAwake: true,
			}));
			const result = yield* Ref.get(ref);

			expect(result.clientCount).toBe(1);
			expect(result.keepAwake).toBe(true);
		}).pipe(Effect.provide(makeDaemonStateLive())),
	);
});
