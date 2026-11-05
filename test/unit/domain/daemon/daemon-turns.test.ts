// Failure modes for the per-session permit: a finished, failed, interrupted or
// deleted session leaves its permit behind; two holders of one session run at
// once; a permit dropped while a waiter still needs it lets a third caller in
// beside that waiter; one session's work blocks another's.
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import {
	DaemonTurns,
	DaemonTurnsLive,
} from "../../../../src/lib/domain/daemon/Services/daemon-turns.js";

const hold = Effect.gen(function* () {
	const entered = yield* Deferred.make<void>();
	const resume = yield* Deferred.make<void>();
	const work = Deferred.succeed(entered, undefined).pipe(
		Effect.andThen(Deferred.await(resume)),
	);
	return { entered, resume, work };
});

describe("DaemonTurns session permits", () => {
	it.effect("DT01 a session leaves no permit once its work ends", () =>
		Effect.gen(function* () {
			const { serialised, heldPermits } = yield* DaemonTurns;
			yield* serialised("done")(Effect.void);
			yield* Effect.exit(serialised("failed")(Effect.fail("boom")));
			const waiting = yield* hold;
			const holder = yield* Effect.forkChild(
				serialised("interrupted")(waiting.work),
			);
			yield* Deferred.await(waiting.entered);
			const waiter = yield* Effect.forkChild(
				serialised("interrupted")(Effect.void),
			);
			yield* Effect.yieldNow;
			yield* Fiber.interrupt(waiter);
			yield* Fiber.interrupt(holder);
			expect(heldPermits()).toBe(0);
		}).pipe(Effect.provide(DaemonTurnsLive)),
	);

	it.effect(
		"DT02 one session runs one holder at a time and others run beside it",
		() =>
			Effect.gen(function* () {
				const { serialised, heldPermits } = yield* DaemonTurns;
				const first = yield* hold;
				const second = yield* hold;
				const ran: string[] = [];
				const a = yield* Effect.forkChild(
					serialised("s")(
						Effect.andThen(
							first.work,
							Effect.sync(() => ran.push("a")),
						),
					),
				);
				yield* Deferred.await(first.entered);
				const b = yield* Effect.forkChild(
					serialised("s")(
						Effect.andThen(
							Effect.sync(() => ran.push("b-start")),
							second.work,
						),
					),
				);
				yield* serialised("other")(Effect.sync(() => ran.push("other")));
				yield* Effect.yieldNow;
				expect(ran).toEqual(["other"]);
				yield* Deferred.succeed(first.resume, undefined);
				yield* Deferred.await(second.entered);
				yield* Fiber.join(a);
				// b holds the permit; a later caller waits behind it, not beside it.
				const c = yield* Effect.forkChild(
					serialised("s")(Effect.sync(() => ran.push("c"))),
				);
				yield* Effect.yieldNow;
				expect(ran).toEqual(["other", "a", "b-start"]);
				yield* Deferred.succeed(second.resume, undefined);
				yield* Fiber.join(b);
				yield* Fiber.join(c);
				expect(ran).toEqual(["other", "a", "b-start", "c"]);
				expect(heldPermits()).toBe(0);
			}).pipe(Effect.provide(DaemonTurnsLive)),
	);
});
