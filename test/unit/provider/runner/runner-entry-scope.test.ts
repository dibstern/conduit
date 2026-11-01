import { Cause, Deferred, Effect, Exit, Scope, Semaphore } from "effect";
import { describe, expect, it } from "vitest";
import * as Entry from "../../../../src/lib/provider/runner/runner-entry-lifecycle.js";
import { runnerFailure } from "../../../../src/lib/provider/runner/runner-protocol.js";
import { makeSendScopes } from "../../../../src/lib/provider/runner/send-scope.js";

const entryIn = (
	parent: Scope.Scope,
	closeSends: (runnerId: string) => Effect.Effect<void> = () => Effect.void,
) =>
	Effect.gen(function* () {
		const entry: Entry.RunnerChild = {
			sessionId: "s1",
			runnerId: "r1",
			socketPath: "/tmp/r1",
			lifecycle: Entry.initialRunnerLifecycle(),
			upgrade: { activity: 0, inFlight: false, failures: 0, retryAt: 0 },
			outputs: yield* Semaphore.make(1),
			...(yield* Entry.open(parent)),
		};
		yield* Entry.own(entry, closeSends);
		return entry;
	});

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
	Effect.runPromise(Effect.scoped(effect));

describe("runner entry scope (CONTRACT 6.11)", () => {
	it("releases every waiter once with the close cause", () =>
		run(
			Effect.gen(function* () {
				const entry = yield* entryIn(yield* Effect.scope);
				const changed = yield* Deferred.make<void>();
				Entry.watch(entry, changed);
				const failure = runnerFailure("detach runner", "Project released it");
				yield* Entry.close(entry, Cause.fail(failure));
				yield* Entry.close(entry);
				expect(yield* Effect.exit(Deferred.await(entry.ready))).toEqual(
					Exit.fail(failure),
				);
				expect(Deferred.isDoneUnsafe(entry.drained)).toBe(true);
				expect(Deferred.isDoneUnsafe(changed)).toBe(true);
			}),
		));

	it("fails ready with the recorded failure on a plain close", () =>
		run(
			Effect.gen(function* () {
				const entry = yield* entryIn(yield* Effect.scope);
				const failure = runnerFailure("stop runner", "Runner exited");
				Entry.transition(entry, { _tag: "Fail", failure });
				yield* Entry.close(entry);
				expect(yield* Effect.exit(Deferred.await(entry.ready))).toEqual(
					Exit.fail(failure),
				);
			}),
		));

	it("closes only sends still dispatched to its runner, before releasing waiters", () =>
		run(
			Effect.gen(function* () {
				const sendScopes = yield* makeSendScopes();
				const dispatched = yield* sendScopes.open("sink-1", "s1");
				const requeued = yield* sendScopes.open("sink-2", "s1");
				const other = yield* sendScopes.open("sink-3", "s1");
				sendScopes.dispatch(dispatched, "r1");
				sendScopes.dispatch(requeued, "r1");
				sendScopes.requeue(requeued, "r1");
				sendScopes.dispatch(other, "r2");
				let drainedAtSendClose: boolean | undefined;
				const entry: Entry.RunnerChild = yield* entryIn(
					yield* Effect.scope,
					(runnerId) =>
						Effect.suspend(() => {
							drainedAtSendClose = Deferred.isDoneUnsafe(entry.drained);
							return sendScopes.closeRunner(runnerId);
						}),
				);
				yield* Entry.close(entry);
				expect(drainedAtSendClose).toBe(false);
				expect(dispatched.assignment._tag).toBe("Closed");
				expect(requeued.assignment._tag).toBe("Queued");
				expect(other.assignment._tag).toBe("Dispatched");
			}),
		));

	it("closes with its parent", () =>
		run(
			Effect.gen(function* () {
				const parent = yield* Scope.make();
				const entry = yield* entryIn(parent);
				yield* Scope.close(parent, Exit.void);
				expect(Deferred.isDoneUnsafe(entry.ready)).toBe(true);
				expect(Deferred.isDoneUnsafe(entry.drained)).toBe(true);
			}),
		));

	it("registers no watch waiter after the scope closed (B25)", () =>
		run(
			Effect.gen(function* () {
				const entry = yield* entryIn(yield* Effect.scope);
				yield* Entry.close(entry);
				const changed = yield* Deferred.make<void>();
				Entry.watch(entry, changed);
				expect(Deferred.isDoneUnsafe(changed)).toBe(true);
			}),
		));
});
