import { describe, it } from "@effect/vitest";
import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Result,
	Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { makeAccountResourceScopesLive } from "../../../src/lib/domain/daemon/Layers/account-resource-scopes-layer.js";
import { AccountResourceScopesTag } from "../../../src/lib/domain/daemon/Services/account-resource-scopes.js";

// Failure cases: duplicate first opens, a cached failed open, late opens surviving
// removal, stale releases changing a replacement's demand, cross-account
// cancellation, and idle cleanup interrupting turns, prompts or background work.
describe("daemon account resource scopes", () => {
	for (const operation of ["invalidation", "shutdown"] as const) {
		it.effect(`${operation} cancels a use before its opener starts`, () =>
			Effect.gen(function* () {
				const scope = yield* Scope.fork(yield* Effect.scope);
				const context = yield* Layer.buildWithScope(
					makeAccountResourceScopesLive({ idleTimeoutMs: 100 }),
					scope,
				);
				const scopes = Context.get(context, AccountResourceScopesTag);
				let opens = 0;
				const owner = yield* scopes.make(() => Effect.sync(() => ++opens));
				const use = yield* owner
					.use("a", Effect.succeed)
					.pipe(Effect.forkScoped({ startImmediately: true }));
				yield* operation === "invalidation"
					? scopes.invalidate("a")
					: Scope.close(scope, Exit.void);
				yield* Effect.yieldNow;
				const cancelled = use.pollUnsafe();
				// Reap a stranded waiter so a regression reports an assertion, not a timeout.
				yield* Fiber.interrupt(use);
				expect(opens).toBe(0);
				expect(cancelled && Exit.hasInterrupts(cancelled)).toBe(true);
				if (operation === "invalidation") {
					expect(yield* owner.use("a", Effect.succeed)).toBe(1);
				} else {
					const stopped = yield* owner
						.use("a", Effect.succeed)
						.pipe(Effect.exit);
					expect(Exit.hasInterrupts(stopped)).toBe(true);
					expect(opens).toBe(0);
				}
			}),
		);
	}

	for (const operation of ["invalidation", "shutdown", "idle"] as const) {
		it.effect(
			`${operation} stops initialization before releasing its resource`,
			() =>
				Effect.gen(function* () {
					const scope = yield* Scope.fork(yield* Effect.scope);
					const context = yield* Layer.buildWithScope(
						makeAccountResourceScopesLive({ idleTimeoutMs: 100 }),
						scope,
					);
					const scopes = Context.get(context, AccountResourceScopesTag);
					const opening = yield* Deferred.make<void>();
					const stopped = yield* Deferred.make<void>();
					const releasing = yield* Deferred.make<void>();
					const order: string[] = [];
					const owner = yield* scopes.make(() =>
						Effect.gen(function* () {
							yield* Effect.acquireRelease(Effect.void, () =>
								Effect.gen(function* () {
									order.push("resource closing");
									yield* Deferred.succeed(releasing, undefined);
									yield* Deferred.await(stopped);
									order.push("resource closed");
								}),
							);
							yield* Deferred.succeed(opening, undefined);
							return yield* Effect.never;
						}).pipe(
							Effect.ensuring(
								Effect.sync(() => order.push("open stopped")).pipe(
									Effect.andThen(Deferred.succeed(stopped, undefined)),
								),
							),
						),
					);
					const use = yield* owner
						.use("a", Effect.succeed)
						.pipe(Effect.forkScoped);
					yield* Deferred.await(opening);
					if (operation === "idle") yield* Fiber.interrupt(use);
					const closing = yield* (
						operation === "invalidation"
							? scopes.invalidate("a")
							: operation === "shutdown"
								? Scope.close(scope, Exit.void)
								: TestClock.adjust(100)
					).pipe(Effect.forkScoped);
					yield* Deferred.await(releasing);
					const stoppedBeforeRelease = yield* Deferred.isDone(stopped);
					// Unblock the broken ordering so the test can report the deadlock.
					yield* Deferred.succeed(stopped, undefined);
					yield* Fiber.join(closing);
					yield* Fiber.await(use);
					expect(stoppedBeforeRelease).toBe(true);
					expect(order).toEqual([
						"open stopped",
						"resource closing",
						"resource closed",
					]);
				}),
		);
	}

	it.effect("shares one lazy open between concurrent first uses", () =>
		Effect.gen(function* () {
			const scopes = yield* AccountResourceScopesTag;
			const opening = yield* Deferred.make<void>();
			const finishOpen = yield* Deferred.make<void>();
			let opens = 0;
			let closes = 0;
			const owner = yield* scopes.make((accountId) =>
				Effect.gen(function* () {
					const resource = yield* Effect.acquireRelease(
						Effect.sync(() => ({ accountId, generation: ++opens })),
						() => Effect.sync(() => closes++),
					);
					yield* Deferred.succeed(opening, undefined);
					yield* Deferred.await(finishOpen);
					return resource;
				}),
			);
			expect(opens).toBe(0);
			const first = yield* owner
				.use("account-a", Effect.succeed)
				.pipe(Effect.forkScoped);
			yield* Deferred.await(opening);
			const second = yield* owner
				.use("account-a", Effect.succeed)
				.pipe(Effect.forkScoped);
			yield* Deferred.succeed(finishOpen, undefined);
			const a = yield* Fiber.join(first);
			const b = yield* Fiber.join(second);
			expect(a).toBe(b);
			expect(opens).toBe(1);
			expect(closes).toBe(0);
			yield* scopes.invalidate("account-a");
			expect(closes).toBe(1);
		}).pipe(
			Effect.provide(makeAccountResourceScopesLive({ idleTimeoutMs: 100 })),
		),
	);

	it.effect("cleans a failed open and retries on the next use", () =>
		Effect.gen(function* () {
			const scopes = yield* AccountResourceScopesTag;
			let opens = 0;
			let live = 0;
			const owner = yield* scopes.make(() =>
				Effect.gen(function* () {
					yield* Effect.acquireRelease(
						Effect.sync(() => live++),
						() => Effect.sync(() => live--),
					);
					if (++opens === 1) return yield* Effect.fail("open failed");
					return "ready";
				}),
			);
			const failed = yield* owner.use("a", Effect.succeed).pipe(Effect.result);
			expect(Result.isFailure(failed) && failed.failure).toBe("open failed");
			expect(live).toBe(0);
			expect(yield* owner.use("a", Effect.succeed)).toBe("ready");
			expect(opens).toBe(2);
			expect(live).toBe(1);
		}).pipe(
			Effect.provide(makeAccountResourceScopesLive({ idleTimeoutMs: 100 })),
		),
	);

	it.effect(
		"a failed open still retries after its only waiter was cancelled",
		() =>
			Effect.gen(function* () {
				const scopes = yield* AccountResourceScopesTag;
				const opening = yield* Deferred.make<void>();
				const finishOpen = yield* Deferred.make<void>();
				const failed = yield* Deferred.make<void>();
				let opens = 0;
				const owner = yield* scopes.make(() =>
					Effect.gen(function* () {
						if (++opens > 1) return "ready";
						yield* Deferred.succeed(opening, undefined);
						yield* Deferred.await(finishOpen);
						return yield* Effect.fail("open failed");
					}).pipe(Effect.onExit(() => Deferred.succeed(failed, undefined))),
				);
				const first = yield* owner
					.use("a", Effect.succeed)
					.pipe(Effect.forkScoped);
				yield* Deferred.await(opening);
				yield* Fiber.interrupt(first);
				yield* Deferred.succeed(finishOpen, undefined);
				yield* Deferred.await(failed);
				yield* Effect.yieldNow;
				expect(yield* owner.use("a", Effect.succeed)).toBe("ready");
				expect(opens).toBe(2);
			}).pipe(
				Effect.provide(makeAccountResourceScopesLive({ idleTimeoutMs: 100 })),
			),
	);

	it.effect(
		"cancelling a first-use waiter leaves the shared open for another waiter",
		() =>
			Effect.gen(function* () {
				const scopes = yield* AccountResourceScopesTag;
				const opening = yield* Deferred.make<void>();
				const finishOpen = yield* Deferred.make<void>();
				let opens = 0;
				const owner = yield* scopes.make(() =>
					Effect.gen(function* () {
						opens++;
						yield* Deferred.succeed(opening, undefined);
						yield* Deferred.await(finishOpen);
						return "ready";
					}),
				);
				const first = yield* owner
					.use("a", Effect.succeed)
					.pipe(Effect.forkScoped);
				yield* Deferred.await(opening);
				const second = yield* owner
					.use("a", Effect.succeed)
					.pipe(Effect.forkScoped);
				yield* Fiber.interrupt(first);
				yield* Deferred.succeed(finishOpen, undefined);
				expect(yield* Fiber.join(second)).toBe("ready");
				expect(opens).toBe(1);
			}).pipe(
				Effect.provide(makeAccountResourceScopesLive({ idleTimeoutMs: 100 })),
			),
	);

	it.effect(
		"a replacement waits for old finalizers and retains its own demand",
		() =>
			Effect.gen(function* () {
				const scopes = yield* AccountResourceScopesTag;
				const closing = yield* Deferred.make<void>();
				const finishClose = yield* Deferred.make<void>();
				const running = yield* Deferred.make<void>();
				let opens = 0;
				const live = new Set<number>();
				const owner = yield* scopes.make(() =>
					Effect.acquireRelease(
						Effect.sync(() => {
							const generation = ++opens;
							live.add(generation);
							return generation;
						}),
						(generation) =>
							Effect.gen(function* () {
								if (generation === 1) {
									yield* Deferred.succeed(closing, undefined);
									yield* Deferred.await(finishClose);
								}
								live.delete(generation);
							}),
					),
				);
				yield* owner.use("a", Effect.succeed);
				yield* TestClock.adjust(90);
				const removal = yield* scopes.invalidate("a").pipe(Effect.forkScoped);
				yield* Deferred.await(closing);
				const replacement = yield* owner
					.use("a", (generation) =>
						Effect.gen(function* () {
							expect(generation).toBe(3);
							yield* Deferred.succeed(running, undefined);
							yield* Effect.never;
						}),
					)
					.pipe(Effect.forkScoped);
				yield* Effect.yieldNow;
				expect(opens).toBe(1);
				// Closing account a cannot hold the transition gate across cleanup I/O.
				expect(yield* owner.use("b", Effect.succeed)).toBe(2);
				yield* Deferred.succeed(finishClose, undefined);
				yield* Fiber.join(removal);
				yield* Deferred.await(running);
				// Account b took generation 2; account a's replacement is generation 3.
				yield* TestClock.adjust(200);
				expect(live).toEqual(new Set([3]));
				expect(replacement.pollUnsafe()).toBeUndefined();
				yield* Fiber.interrupt(replacement);
				yield* TestClock.adjust(100);
				expect(live.size).toBe(0);
			}).pipe(
				Effect.provide(makeAccountResourceScopesLive({ idleTimeoutMs: 100 })),
			),
	);

	it.effect(
		"cancels a replacement waiting on an old generation's cleanup",
		() =>
			Effect.gen(function* () {
				const scopes = yield* AccountResourceScopesTag;
				const closing = yield* Deferred.make<void>();
				const finishClose = yield* Deferred.make<void>();
				let opens = 0;
				const owner = yield* scopes.make(() =>
					Effect.acquireRelease(
						Effect.sync(() => ++opens),
						() =>
							Deferred.succeed(closing, undefined).pipe(
								Effect.andThen(Deferred.await(finishClose)),
							),
					),
				);
				yield* owner.use("a", Effect.succeed);
				const removal = yield* scopes.invalidate("a").pipe(Effect.forkScoped);
				yield* Deferred.await(closing);
				const replacement = yield* owner
					.use("a", Effect.succeed)
					.pipe(Effect.forkScoped);
				yield* Effect.yieldNow;
				replacement.interruptUnsafe();
				yield* Effect.yieldNow;
				const cancelledWhileClosing = replacement.pollUnsafe();
				yield* Deferred.succeed(finishClose, undefined);
				yield* Fiber.join(removal);
				yield* Fiber.await(replacement);
				expect(
					cancelledWhileClosing && Exit.hasInterrupts(cancelledWhileClosing),
				).toBe(true);
				expect(opens).toBe(1);
			}).pipe(
				Effect.provide(makeAccountResourceScopesLive({ idleTimeoutMs: 100 })),
			),
	);

	it.effect("interrupted invalidation finishes cleanup across all owners", () =>
		Effect.gen(function* () {
			const scopes = yield* AccountResourceScopesTag;
			const closing = yield* Deferred.make<void>();
			const finishClose = yield* Deferred.make<void>();
			const started = yield* Deferred.make<void>();
			const closed: string[] = [];
			yield* scopes.invalidate("absent");
			const makeOwner = (kind: string) =>
				scopes.make((id) =>
					Effect.acquireRelease(Effect.succeed(id), () =>
						Effect.gen(function* () {
							if (kind === "first" && id === "a") {
								yield* Deferred.succeed(closing, undefined);
								yield* Deferred.await(finishClose);
							}
							closed.push(`${kind}/${id}`);
						}),
					),
				);
			const first = yield* makeOwner("first");
			const second = yield* makeOwner("second");
			let starts = 0;
			const work = () =>
				Effect.gen(function* () {
					if (++starts === 3) yield* Deferred.succeed(started, undefined);
					yield* Effect.never;
				});
			const firstWork = yield* first.use("a", work).pipe(Effect.forkScoped);
			const secondWork = yield* second.use("a", work).pipe(Effect.forkScoped);
			const otherAccount = yield* second.use("b", work).pipe(Effect.forkScoped);
			yield* Deferred.await(started);
			const removal = yield* scopes.invalidate("a").pipe(Effect.forkScoped);
			yield* Deferred.await(closing);
			removal.interruptUnsafe();
			yield* Deferred.succeed(finishClose, undefined);
			const exit = yield* Fiber.await(removal);
			const closedBeforeRetry = [...closed];
			const firstExit = firstWork.pollUnsafe();
			const secondExit = secondWork.pollUnsafe();
			// Reap any work left by an interrupted traversal before reporting failure.
			yield* scopes.invalidate("a");
			expect(Exit.hasInterrupts(exit)).toBe(true);
			expect(closedBeforeRetry).toEqual(["first/a", "second/a"]);
			expect(firstExit && Exit.hasInterrupts(firstExit)).toBe(true);
			expect(secondExit && Exit.hasInterrupts(secondExit)).toBe(true);
			expect(otherAccount.pollUnsafe()).toBeUndefined();
			yield* scopes.invalidate("absent");
			for (const owner of [first, second]) {
				expect(yield* owner.use("a", Effect.succeed)).toBe("a");
			}
		}).pipe(
			Effect.provide(makeAccountResourceScopesLive({ idleTimeoutMs: 100 })),
		),
	);

	for (const operation of ["invalidation", "shutdown"] as const) {
		it.effect(
			`${operation} finishes all cleanup and preserves finalizer defects`,
			() =>
				Effect.gen(function* () {
					const scope = yield* Scope.fork(yield* Effect.scope);
					const context = yield* Layer.buildWithScope(
						makeAccountResourceScopesLive({ idleTimeoutMs: 100 }),
						scope,
					);
					const scopes = Context.get(context, AccountResourceScopesTag);
					const closed: string[] = [];
					for (const kind of ["first", "second"]) {
						const owner = yield* scopes.make((id) =>
							Effect.acquireRelease(Effect.succeed(id), () =>
								Effect.sync(() => {
									closed.push(`${kind}/${id}`);
								}).pipe(
									Effect.andThen(
										id === "a"
											? Effect.die(new Error(`${kind} cleanup failed`))
											: Effect.void,
									),
								),
							),
						);
						yield* owner.use("a", Effect.succeed);
						yield* owner.use("b", Effect.succeed);
					}
					const result = yield* (
						operation === "invalidation"
							? scopes.invalidate("a")
							: Scope.close(scope, Exit.void)
					).pipe(Effect.exit);
					const closedBeforeDisposal = [...closed];
					yield* Scope.close(scope, Exit.void).pipe(Effect.exit);
					expect(closedBeforeDisposal).toEqual(
						operation === "invalidation"
							? ["first/a", "second/a"]
							: ["first/a", "first/b", "second/a", "second/b"],
					);
					expect([...closed].sort()).toEqual([
						"first/a",
						"first/b",
						"second/a",
						"second/b",
					]);
					expect(Exit.isFailure(result)).toBe(true);
					if (Exit.isFailure(result)) {
						expect(Cause.pretty(result.cause)).toContain(
							"first cleanup failed",
						);
						expect(Cause.pretty(result.cause)).toContain(
							"second cleanup failed",
						);
					}
				}),
		);
	}

	it.effect(
		"removal during an uninterruptible open cleans even a late resource",
		() =>
			Effect.gen(function* () {
				const scopes = yield* AccountResourceScopesTag;
				const opening = yield* Deferred.make<void>();
				const finishOpen = yield* Deferred.make<void>();
				let live = 0;
				let used = false;
				const owner = yield* scopes.make(() =>
					Effect.gen(function* () {
						yield* Deferred.succeed(opening, undefined);
						yield* Deferred.await(finishOpen).pipe(Effect.uninterruptible);
						return yield* Effect.acquireRelease(
							Effect.sync(() => ++live),
							() => Effect.sync(() => live--),
						);
					}),
				);
				const use = yield* owner
					.use("a", () =>
						Effect.sync(() => {
							used = true;
						}),
					)
					.pipe(Effect.forkScoped);
				yield* Deferred.await(opening);
				const removal = yield* scopes.invalidate("a").pipe(Effect.forkScoped);
				yield* Effect.yieldNow;
				yield* Deferred.succeed(finishOpen, undefined);
				yield* Fiber.join(removal);
				expect(Exit.isFailure(yield* Fiber.await(use))).toBe(true);
				expect(used).toBe(false);
				expect(live).toBe(0);
			}).pipe(
				Effect.provide(makeAccountResourceScopesLive({ idleTimeoutMs: 100 })),
			),
	);

	it.effect(
		"removes only the exact account and cancels only its work across owners",
		() =>
			Effect.gen(function* () {
				const scopes = yield* AccountResourceScopesTag;
				const closed: string[] = [];
				const cancelled: string[] = [];
				const started = yield* Deferred.make<void>();
				let starts = 0;
				const open = (id: string) =>
					Effect.acquireRelease(Effect.succeed(id), () =>
						Effect.sync(() => {
							closed.push(id);
						}),
					);
				const first = yield* scopes.make(open);
				const second = yield* scopes.make(open);
				const work = (id: string) =>
					Effect.gen(function* () {
						if (++starts === 3) yield* Deferred.succeed(started, undefined);
						yield* Effect.never;
					}).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								cancelled.push(id);
							}),
						),
					);
				const a = yield* first.use("account", work).pipe(Effect.forkScoped);
				const similar = yield* first
					.use("account-other", work)
					.pipe(Effect.forkScoped);
				const otherOwner = yield* second
					.use("account", work)
					.pipe(Effect.forkScoped);
				yield* Deferred.await(started);
				yield* scopes.invalidate("account");
				expect(Exit.isFailure(yield* Fiber.await(a))).toBe(true);
				expect(Exit.isFailure(yield* Fiber.await(otherOwner))).toBe(true);
				expect(closed).toEqual(["account", "account"]);
				expect(cancelled).toEqual(["account", "account"]);
				expect(similar.pollUnsafe()).toBeUndefined();
			}).pipe(
				Effect.provide(makeAccountResourceScopesLive({ idleTimeoutMs: 100 })),
			),
	);

	it.effect(
		"an idle generation closes and demand opens a fresh generation",
		() =>
			Effect.gen(function* () {
				const scopes = yield* AccountResourceScopesTag;
				let opens = 0;
				const closed: number[] = [];
				const owner = yield* scopes.make(() =>
					Effect.acquireRelease(
						Effect.sync(() => ++opens),
						(generation) =>
							Effect.sync(() => {
								closed.push(generation);
							}),
					),
				);
				expect(yield* owner.use("a", Effect.succeed)).toBe(1);
				yield* TestClock.adjust(99);
				expect(closed).toEqual([]);
				yield* TestClock.adjust(1);
				expect(closed).toEqual([1]);
				expect(yield* owner.use("a", Effect.succeed)).toBe(2);
			}).pipe(
				Effect.provide(makeAccountResourceScopesLive({ idleTimeoutMs: 100 })),
			),
	);

	for (const demand of ["turn", "pending prompt", "background work"]) {
		it.effect(
			`${demand} keeps a scope open and restarts the full idle grace`,
			() =>
				Effect.gen(function* () {
					const scopes = yield* AccountResourceScopesTag;
					let closes = 0;
					const owner = yield* scopes.make(() =>
						Effect.acquireRelease(Effect.succeed("resource"), () =>
							Effect.sync(() => closes++),
						),
					);
					yield* owner.use("a", Effect.succeed);
					yield* TestClock.adjust(90);
					const started = yield* Deferred.make<void>();
					const done = yield* Deferred.make<void>();
					const work = yield* owner
						.use("a", () =>
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Deferred.await(done)),
							),
						)
						.pipe(Effect.forkScoped);
					yield* Deferred.await(started);
					yield* TestClock.adjust(1_000);
					expect(closes).toBe(0);
					yield* Deferred.succeed(done, undefined);
					yield* Fiber.join(work);
					yield* TestClock.adjust(99);
					expect(closes).toBe(0);
					yield* TestClock.adjust(1);
					expect(closes).toBe(1);
				}).pipe(
					Effect.provide(makeAccountResourceScopesLive({ idleTimeoutMs: 100 })),
				),
		);
	}

	it.effect(
		"daemon layer disposal closes all generations and cancels work",
		() =>
			Effect.gen(function* () {
				let closes = 0;
				const started = yield* Deferred.make<void>();
				const layerScope = yield* Scope.make();
				const context = yield* Layer.buildWithScope(
					makeAccountResourceScopesLive({ idleTimeoutMs: 100 }),
					layerScope,
				);
				const service = Context.get(context, AccountResourceScopesTag);
				const owner = yield* service.make(() =>
					Effect.acquireRelease(Effect.succeed("resource"), () =>
						Effect.sync(() => closes++),
					),
				);
				const work = yield* owner
					.use("a", () =>
						Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Effect.never),
						),
					)
					.pipe(Effect.forkIn(layerScope));
				yield* Deferred.await(started);
				yield* Scope.close(layerScope, Exit.void);
				expect(closes).toBe(1);
				expect(Exit.isFailure(yield* Fiber.await(work))).toBe(true);
				const restartedScope = yield* Scope.fork(yield* Effect.scope);
				const restartedContext = yield* Layer.buildWithScope(
					makeAccountResourceScopesLive({ idleTimeoutMs: 100 }),
					restartedScope,
				);
				const restarted = Context.get(
					restartedContext,
					AccountResourceScopesTag,
				);
				const restartedOwner = yield* restarted.make(() =>
					Effect.acquireRelease(Effect.succeed("fresh resource"), () =>
						Effect.sync(() => closes++),
					),
				);
				expect(yield* restartedOwner.use("a", Effect.succeed)).toBe(
					"fresh resource",
				);
				yield* Scope.close(restartedScope, Exit.void);
				expect(closes).toBe(2);
			}),
	);
});
