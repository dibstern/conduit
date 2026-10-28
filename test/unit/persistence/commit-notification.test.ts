import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import {
	flushPendingWrites,
	makeCommitAndSignal,
} from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";

it.effect(
	"arms the next store commit synchronously across writer instances, including silent writes",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const writer = yield* makeCommitAndSignal;
			const observer: typeof writer & {
				readonly committed?: () => Effect.Effect<void>;
			} = yield* makeCommitAndSignal;
			expect(typeof observer.committed).toBe("function");
			if (!observer.committed) return;
			const first = observer.committed();
			yield* writer.write(() => Effect.void, { publish: false });
			// Running the wait after the commit must observe the signal armed above.
			yield* first;
			let woke = false;
			const second = yield* observer.committed().pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						woke = true;
					}),
				),
				Effect.forkChild,
			);
			yield* Effect.yieldNow;
			expect(woke).toBe(false);
			expect(
				yield* Effect.result(writer.write(() => Effect.fail("rejected"))),
			).toMatchObject({
				_tag: "Failure",
				failure: "rejected",
			});
			yield* Effect.yieldNow;
			expect(woke).toBe(false);
			yield* writer.write(() => Effect.void, { publish: false });
			yield* Fiber.join(second);
			expect(woke).toBe(true);
			const lifecycleCommit = observer.committed();
			yield* flushPendingWrites(sql);
			yield* lifecycleCommit;
		}).pipe(Effect.provide(makePersistenceEffectLayer(":memory:", "project"))),
);
