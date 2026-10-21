import { Deferred, Effect, Exit, Fiber, Layer, Scope, Semaphore } from "effect";
import { instanceIdleTimeoutFromEnv } from "../../../instance/idle-policy.js";
import {
	type AccountResourceScopeOwner,
	AccountResourceScopesTag,
} from "../Services/account-resource-scopes.js";

const finalizeAll = <A>(
	items: Iterable<A>,
	finalize: (item: A) => Effect.Effect<void>,
) =>
	Effect.forEach(items, (item) => Effect.exit(finalize(item))).pipe(
		Effect.flatMap(Exit.asVoidAll),
	);

export const makeAccountResourceScopesLive = (
	options: { readonly idleTimeoutMs?: number } = {},
) =>
	Layer.effect(
		AccountResourceScopesTag,
		Effect.gen(function* () {
			const daemonScope = yield* Effect.scope;
			const idleTimeoutMs =
				options.idleTimeoutMs ?? (yield* instanceIdleTimeoutFromEnv);
			const owners = new Set<{
				invalidate: (id: string) => Effect.Effect<void>;
				close: Effect.Effect<void>;
			}>();
			let stopped = false;
			yield* Effect.addFinalizer(() =>
				Effect.suspend(() => {
					stopped = true;
					return finalizeAll(owners, (owner) => owner.close);
				}),
			);

			const make = <A, E, R>(
				open: (accountId: string) => Effect.Effect<A, E, R | Scope.Scope>,
			): Effect.Effect<AccountResourceScopeOwner<A, E>, never, R> =>
				Effect.gen(function* () {
					const context = yield* Effect.context<R>();
					const gate = yield* Semaphore.make(1);
					type Entry = {
						readonly id: string;
						readonly scope: Scope.Closeable;
						readonly ready: Deferred.Deferred<A, E>;
						readonly closed: Deferred.Deferred<void>;
						users: number;
						failed: boolean;
						closing: boolean;
						opener?: Fiber.Fiber<A, E>;
						grace?: Fiber.Fiber<void>;
					};
					// Entry identity is the generation fence, including for late releases.
					const entries = new Map<string, Entry>();
					const cancelGrace = (entry: Entry) => {
						entry.grace?.interruptUnsafe();
						delete entry.grace;
					};
					const beginClose = (entry: Entry) => {
						entry.closing = true;
						cancelGrace(entry);
					};
					// Never close under the gate: interrupted work releases its demand.
					const finishClose = (entry: Entry) =>
						Effect.gen(function* () {
							yield* Deferred.interrupt(entry.ready);
							// Later resource finalizers would otherwise run before forkIn's.
							if (entry.opener) yield* Fiber.interrupt(entry.opener);
							yield* Scope.close(entry.scope, Exit.void);
						}).pipe(
							Effect.ensuring(
								gate.withPermits(1)(
									Effect.gen(function* () {
										if (entries.get(entry.id) === entry)
											entries.delete(entry.id);
										yield* Deferred.succeed(entry.closed, undefined);
									}),
								),
							),
							Effect.uninterruptible,
						);
					const invalidate = (id: string) =>
						Effect.gen(function* () {
							const action = yield* gate.withPermits(1)(
								Effect.sync(() => {
									const entry = entries.get(id);
									if (!entry) return Effect.void;
									if (entry.closing) return Deferred.await(entry.closed);
									beginClose(entry);
									return finishClose(entry);
								}),
							);
							yield* action;
						}).pipe(Effect.uninterruptible);

					const acquire = (id: string) =>
						gate.withPermits(1)(
							Effect.gen(function* () {
								if (stopped) return yield* Effect.interrupt;
								const current = entries.get(id);
								if (current) {
									if (current.failed && !current.closing) {
										beginClose(current);
										yield* finishClose(current).pipe(
											Effect.forkIn(daemonScope),
										);
									}
									if (!current.closing) {
										current.users++;
										cancelGrace(current);
									}
									return [current, !current.closing] as const;
								}
								const created: Entry = {
									id,
									scope: yield* Scope.make(),
									ready: yield* Deferred.make<A, E>(),
									closed: yield* Deferred.make<void>(),
									users: 1,
									failed: false,
									closing: false,
								};
								entries.set(id, created);
								created.opener = yield* Effect.suspend(() => open(id)).pipe(
									Scope.provide(created.scope),
									Effect.provide(context),
									Effect.onExit((exit) =>
										Effect.gen(function* () {
											const close = yield* gate.withPermits(1)(
												Effect.sync(() => {
													created.failed = Exit.isFailure(exit);
													if (
														!created.failed ||
														created.users > 0 ||
														created.closing
													)
														return false;
													beginClose(created);
													return true;
												}),
											);
											yield* Deferred.done(created.ready, exit);
											if (close)
												yield* finishClose(created).pipe(
													Effect.forkIn(daemonScope),
												);
										}),
									),
									Effect.interruptible,
									Effect.forkIn(created.scope),
								);
								return [created, true] as const;
							}),
						);

					const release = (entry: Entry) =>
						Effect.gen(function* () {
							const close = yield* gate.withPermits(1)(
								Effect.gen(function* () {
									if (entries.get(entry.id) !== entry || entry.closing)
										return false;
									if (--entry.users > 0) return false;
									if (entry.failed) {
										beginClose(entry);
										return true;
									}
									const timer = yield* Effect.sleep(idleTimeoutMs).pipe(
										Effect.andThen(
											Effect.gen(function* () {
												const expired = yield* gate.withPermits(1)(
													Effect.sync(() => {
														if (
															entries.get(entry.id) !== entry ||
															entry.grace !== timer ||
															entry.users > 0 ||
															entry.closing
														)
															return false;
														delete entry.grace;
														beginClose(entry);
														return true;
													}),
												);
												if (expired) yield* finishClose(entry);
											}).pipe(Effect.uninterruptible),
										),
										Effect.interruptible,
										Effect.forkIn(daemonScope),
									);
									entry.grace = timer;
									return false;
								}),
							);
							if (close) yield* finishClose(entry);
						});

					owners.add({
						invalidate,
						close: Effect.suspend(() =>
							finalizeAll([...entries.keys()], invalidate),
						),
					});
					const use: AccountResourceScopeOwner<A, E>["use"] = (id, work) =>
						Effect.acquireUseRelease(
							acquire(id),
							([entry, retained]) =>
								retained
									? Effect.gen(function* () {
											const resource = yield* Deferred.await(entry.ready);
											return yield* Effect.acquireUseRelease(
												Effect.suspend(() => work(resource)).pipe(
													Scope.provide(entry.scope),
													Effect.interruptible,
													Effect.forkIn(entry.scope),
												),
												Fiber.join,
												Fiber.interrupt,
											);
										})
									: Deferred.await(entry.closed).pipe(
											Effect.andThen(Effect.suspend(() => use(id, work))),
										),
							([entry, retained]) => (retained ? release(entry) : Effect.void),
						);
					return { use };
				});
			return {
				make,
				invalidate: (id) =>
					finalizeAll(owners, (owner) => owner.invalidate(id)).pipe(
						Effect.uninterruptible,
					),
			};
		}),
	);
