import { describe, it } from "@effect/vitest";
import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Layer,
	Option,
	Ref,
	Scope,
} from "effect";
import { expect } from "vitest";
import { OwnerScopesLive } from "../../../src/lib/domain/daemon/Layers/owner-scopes-layer.js";
import {
	type OwnerScope,
	OwnerScopes,
} from "../../../src/lib/domain/daemon/Services/owner-scopes.js";
import {
	makeProjectRegistryLive,
	ProjectRegistryTag,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	SessionDirectory,
	SessionDirectoryReadError,
} from "../../../src/lib/domain/daemon/Services/session-directory.js";

const project = (projectId: string) =>
	({ kind: "project", projectId }) as const;
const session = (sessionId: string) =>
	({ kind: "session", sessionId }) as const;
const ownerCloseReason = (exit: Exit.Exit<unknown, unknown>) => {
	expect(Exit.isSuccess(exit)).toBe(true);
	return Exit.isSuccess(exit) ? String(exit.value) : "unexpected failure";
};

const fixture = (
	projectOf: Context.Service.Shape<typeof SessionDirectory>["projectOf"] = (
		id,
	) =>
		Effect.succeed(
			id === "unknown" ? Option.none() : Option.some(id[0] ?? "a"),
		),
) =>
	Effect.gen(function* () {
		const daemon = yield* Scope.fork(yield* Effect.scope, "sequential");
		const context = yield* Layer.buildWithScope(
			OwnerScopesLive.pipe(
				Layer.provideMerge(
					Layer.merge(
						Layer.succeed(SessionDirectory, { projectOf }),
						makeProjectRegistryLive(
							["a", "b"].map((slug) => ({
								slug,
								title: slug,
								folders: [`/test/${slug}`],
							})),
						),
					),
				),
			),
			daemon,
		);
		return {
			daemon,
			owners: Context.get(context, OwnerScopes),
			projects: Context.get(context, ProjectRegistryTag),
		};
	});

const resource = (owner: OwnerScope, name: string, events: string[]) =>
	owner.acquire(
		Effect.acquireRelease(Effect.succeed(name), (_, exit) =>
			Effect.sync(() => {
				events.push(`${name}:${ownerCloseReason(exit)}`);
			}),
		),
	);

describe("Owner Scopes", () => {
	it.effect("OS01 shares concurrent lazy project and session owners", () =>
		Effect.gen(function* () {
			const { owners } = yield* fixture();
			for (const open of [
				owners.projectScope("a"),
				owners.sessionScope("a1"),
			]) {
				const handles = yield* Effect.all([open, open], { concurrency: 2 });
				expect(handles[0]).toBe(handles[1]);
			}
		}),
	);

	it.effect("OS02 parents cold sessions using Project Provenance", () =>
		Effect.gen(function* () {
			const { owners } = yield* fixture(() => Effect.succeed(Option.some("b")));
			const events: string[] = [];
			yield* resource(yield* owners.sessionScope("cold"), "cold", events);
			yield* owners.close(project("a"), "remove");
			expect(events).toEqual([]);
			yield* owners.close(project("b"), "remove");
			expect(events).toEqual(["cold:remove"]);
		}),
	);

	it.effect("OS03 fails typed for unknown or unreadable provenance", () =>
		Effect.gen(function* () {
			const { owners } = yield* fixture();
			expect(
				yield* Effect.result(owners.sessionScope("unknown")),
			).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "OwnerScopeProvenanceError", sessionId: "unknown" },
			});
			const error = new SessionDirectoryReadError({
				sessionId: "a1",
				cause: "offline",
			});
			const broken = yield* fixture(() => Effect.fail(error));
			expect(
				yield* Effect.result(broken.owners.sessionScope("a1")),
			).toMatchObject({
				_tag: "Failure",
				failure: error,
			});
		}),
	);

	it.effect(
		"OS04 rejects retained-handle acquisition before side effects",
		() =>
			Effect.gen(function* () {
				const { owners } = yield* fixture();
				const owner = yield* owners.projectScope("a");
				yield* owners.close(project("a"), "remove");
				let acquired = false;
				expect(
					yield* Effect.result(
						owner.acquire(
							Effect.sync(() => {
								acquired = true;
							}),
						),
					),
				).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "OwnerScopeClosedError", reason: "remove" },
				});
				expect(acquired).toBe(false);
			}),
	);

	it.effect(
		"OS05 rejects reconnect lookups while closing or unregistered",
		() =>
			Effect.gen(function* () {
				const { owners, projects } = yield* fixture();
				const entered = yield* Deferred.make<void>();
				const resume = yield* Deferred.make<void>();
				yield* (yield* owners.sessionScope("a1")).acquire(
					Effect.acquireRelease(Effect.void, () =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(resume)),
						),
					),
				);
				const closing = yield* owners
					.close(project("a"), "remove")
					.pipe(Effect.forkScoped);
				yield* Deferred.await(entered);
				yield* Effect.gen(function* () {
					for (const open of [
						owners.projectScope("a"),
						owners.sessionScope("a1"),
					])
						expect(yield* Effect.result(open)).toMatchObject({
							_tag: "Failure",
							failure: { _tag: "OwnerScopeClosedError", reason: "remove" },
						});
				}).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
				yield* Fiber.join(closing);
				yield* Ref.update(projects, HashMap.remove("a"));
				expect(yield* Effect.result(owners.projectScope("a"))).toMatchObject({
					_tag: "Failure",
					failure: {
						_tag: "OwnerScopeProjectNotRegisteredError",
						projectId: "a",
					},
				});
			}),
	);

	it.effect("OS06 fences and drains acquisition racing close", () =>
		Effect.gen(function* () {
			const { owners } = yield* fixture();
			const owner = yield* owners.projectScope("a");
			const entered = yield* Deferred.make<void>();
			const resume = yield* Deferred.make<void>();
			const events: string[] = [];
			const acquiring = yield* owner
				.acquire(
					Effect.acquireRelease(
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(resume)),
						),
						(_, exit) =>
							Effect.sync(() => {
								events.push(ownerCloseReason(exit));
							}),
					),
				)
				.pipe(Effect.forkScoped);
			yield* Deferred.await(entered);
			const closing = yield* owners
				.close(project("a"), "remove")
				.pipe(Effect.forkScoped);
			yield* Effect.yieldNow;
			expect(yield* Effect.result(owner.acquire(Effect.void))).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "OwnerScopeClosedError" },
			});
			expect(closing.pollUnsafe()).toBeUndefined();
			yield* Deferred.succeed(resume, undefined);
			yield* Fiber.join(acquiring);
			yield* Fiber.join(closing);
			expect(events).toEqual(["remove"]);
		}),
	);

	it.effect("OS07 fences session opening while provenance is pending", () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>();
			const resume = yield* Deferred.make<void>();
			const { owners, projects } = yield* fixture(() =>
				Deferred.succeed(entered, undefined).pipe(
					Effect.andThen(Deferred.await(resume)),
					Effect.as(Option.some("a")),
				),
			);
			const opening = yield* owners
				.sessionScope("a1")
				.pipe(Effect.result, Effect.forkScoped);
			yield* Deferred.await(entered);
			yield* Ref.update(projects, HashMap.remove("a"));
			yield* owners.close(project("a"), "remove");
			yield* Deferred.succeed(resume, undefined);
			expect(yield* Fiber.join(opening)).toMatchObject({
				_tag: "Failure",
				failure: {
					_tag: "OwnerScopeProjectNotRegisteredError",
					projectId: "a",
				},
			});
		}),
	);

	it.effect(
		"OS08 retains partial acquisitions after an acquisition failure",
		() =>
			Effect.gen(function* () {
				const { owners } = yield* fixture();
				const owner = yield* owners.projectScope("a");
				const events: string[] = [];
				yield* owner
					.acquire(
						Effect.acquireRelease(Effect.void, () =>
							Effect.sync(() => {
								events.push("partial");
							}),
						).pipe(Effect.andThen(Effect.fail("acquire failed"))),
					)
					.pipe(Effect.result);
				yield* resource(owner, "next", events);
				yield* owners.close(project("a"), "remove");
				expect(events).toEqual(["next:remove", "partial"]);
			}),
	);

	it.effect("OS09 rejects unregistered projects before first opening", () =>
		Effect.gen(function* () {
			const { owners, projects } = yield* fixture();
			const registered = yield* Ref.get(projects);
			yield* Ref.update(projects, HashMap.remove("a"));
			yield* owners.close(project("a"), "remove");
			for (const projectId of ["a", "unknown"])
				expect(
					yield* Effect.result(owners.projectScope(projectId)),
				).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "OwnerScopeProjectNotRegisteredError", projectId },
				});
			yield* Ref.set(projects, registered);
			yield* resource(yield* owners.projectScope("a"), "re-added", []);
			yield* owners.close(session("b1"), "remove");
			expect(yield* Effect.result(owners.sessionScope("b1"))).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "OwnerScopeClosedError" },
			});
		}),
	);

	for (const first of ["project", "session"] as const) {
		it.effect(
			`OS26 re-adding a project opens fresh owners through ${first} lookup`,
			() =>
				Effect.gen(function* () {
					const { owners, projects, daemon } = yield* fixture();
					const registered = yield* Ref.get(projects);
					const events: string[] = [];
					const previous = yield* owners.projectScope("a");
					const previousSession = yield* owners.sessionScope("a1");
					yield* resource(previous, "old-project", events);
					yield* resource(previousSession, "old-session", events);
					yield* Ref.update(projects, HashMap.remove("a"));
					yield* owners.close(project("a"), "remove");
					expect(events).toEqual(["old-project:remove", "old-session:remove"]);
					yield* Ref.set(projects, registered);
					yield* first === "project"
						? owners.projectScope("a")
						: owners.sessionScope("a1");
					const current = yield* owners.projectScope("a");
					const currentSession = yield* owners.sessionScope("a1");
					expect(current).not.toBe(previous);
					expect(currentSession).not.toBe(previousSession);
					let acquired = false;
					for (const old of [previous, previousSession])
						expect(
							yield* Effect.result(
								old.acquire(
									Effect.sync(() => {
										acquired = true;
									}),
								),
							),
						).toMatchObject({
							_tag: "Failure",
							failure: { _tag: "OwnerScopeClosedError", reason: "remove" },
						});
					expect(acquired).toBe(false);
					yield* resource(current, "new-project", events);
					yield* resource(currentSession, "new-session", events);
					expect(yield* owners.projectScope("a")).toBe(current);
					expect(yield* owners.sessionScope("a1")).toBe(currentSession);
					yield* owners.close(project("a"), "remove");
					yield* Scope.close(daemon, Exit.void);
					expect(events).toEqual([
						"old-project:remove",
						"old-session:remove",
						"new-project:remove",
						"new-session:remove",
					]);
				}),
		);
	}

	for (const openProject of [false, true]) {
		it.effect(
			`OS27 fences explicit session close ${openProject ? "after" : "before"} reopening its project`,
			() =>
				Effect.gen(function* () {
					const { owners, projects } = yield* fixture();
					const registered = yield* Ref.get(projects);
					const events: string[] = [];
					yield* resource(yield* owners.sessionScope("a1"), "old", events);
					yield* Ref.update(projects, HashMap.remove("a"));
					yield* owners.close(project("a"), "remove");
					yield* Ref.set(projects, registered);
					if (openProject) yield* owners.projectScope("a");
					yield* owners.close(session("a1"), "remove");
					yield* owners.close(session("a1"), "remove");
					expect(yield* Effect.result(owners.sessionScope("a1"))).toMatchObject(
						{
							_tag: "Failure",
							failure: { _tag: "OwnerScopeClosedError", reason: "remove" },
						},
					);
					yield* resource(yield* owners.sessionScope("a2"), "sibling", events);
					yield* owners.close(project("a"), "remove");
					expect(events).toEqual(["old:remove", "sibling:remove"]);
				}),
		);
	}

	it.effect(
		"OS10 removes a project tree in hierarchical LIFO and isolates siblings",
		() =>
			Effect.gen(function* () {
				const { owners } = yield* fixture();
				const events: string[] = [];
				const a = yield* owners.projectScope("a");
				yield* resource(a, "project-first", events);
				const a1 = yield* owners.sessionScope("a1");
				yield* resource(a1, "session-first", events);
				yield* resource(a, "project-later", events);
				yield* resource(a1, "session-later", events);
				yield* resource(
					yield* owners.sessionScope("a2"),
					"session-two",
					events,
				);
				const b = yield* owners.projectScope("b");
				yield* resource(b, "sibling", events);
				yield* owners.close(project("a"), "remove");
				expect(events).toEqual([
					"session-two:remove",
					"project-later:remove",
					"session-later:remove",
					"session-first:remove",
					"project-first:remove",
				]);
				yield* resource(b, "sibling-still-open", events);
			}),
	);

	it.effect(
		"OS11 removes a session without closing its parent or siblings",
		() =>
			Effect.gen(function* () {
				const { owners } = yield* fixture();
				const events: string[] = [];
				yield* resource(yield* owners.sessionScope("a1"), "one", events);
				const two = yield* owners.sessionScope("a2");
				yield* resource(two, "two", events);
				yield* owners.close(session("a1"), "remove");
				expect(events).toEqual(["one:remove"]);
				yield* resource(two, "two-again", events);
				yield* resource(yield* owners.projectScope("a"), "project", events);
			}),
	);

	for (const reason of ["detach", "remove"] as const) {
		it.effect(
			`${reason === "detach" ? "OS12" : "OS13"} delivers ${reason} to detached resource finalizers`,
			() =>
				Effect.gen(function* () {
					const { owners } = yield* fixture();
					const running = new Set(["runner", "pty-host", "opencode"]);
					const exits: unknown[] = [];
					const owner = yield* owners.sessionScope("a1");
					for (const name of running)
						yield* owner.acquire(
							Effect.acquireRelease(Effect.succeed(name), (name, exit) =>
								Effect.sync(() => {
									exits.push(exit);
									if (ownerCloseReason(exit) === "remove") running.delete(name);
								}),
							),
						);
					yield* owners.close(project("a"), reason);
					expect(running.size).toBe(reason === "detach" ? 3 : 0);
					expect(exits).toEqual([
						Exit.succeed(reason),
						Exit.succeed(reason),
						Exit.succeed(reason),
					]);
				}),
		);
	}

	it.effect("OS14 duplicate close waits for the same release", () =>
		Effect.gen(function* () {
			const { owners } = yield* fixture();
			const entered = yield* Deferred.make<void>();
			const resume = yield* Deferred.make<void>();
			let releases = 0;
			yield* (yield* owners.projectScope("a")).acquire(
				Effect.acquireRelease(Effect.void, () =>
					Effect.sync(() => {
						releases++;
					}).pipe(
						Effect.andThen(Deferred.succeed(entered, undefined)),
						Effect.andThen(Deferred.await(resume)),
					),
				),
			);
			const first = yield* owners
				.close(project("a"), "remove")
				.pipe(Effect.forkScoped);
			yield* Deferred.await(entered);
			const second = yield* owners
				.close(project("a"), "remove")
				.pipe(Effect.forkScoped);
			yield* Effect.yieldNow;
			expect(second.pollUnsafe()).toBeUndefined();
			yield* Deferred.succeed(resume, undefined);
			yield* Fiber.join(first);
			yield* Fiber.join(second);
			expect(releases).toBe(1);
		}),
	);

	for (const first of ["detach", "remove"] as const) {
		it.effect(
			`OS15 first ${first} close wins against the opposite reason`,
			() =>
				Effect.gen(function* () {
					const { owners } = yield* fixture();
					const entered = yield* Deferred.make<void>();
					const resume = yield* Deferred.make<void>();
					const reasons: string[] = [];
					yield* (yield* owners.sessionScope("a1")).acquire(
						Effect.acquireRelease(Effect.void, (_, exit) =>
							Effect.sync(() => {
								reasons.push(ownerCloseReason(exit));
							}).pipe(
								Effect.andThen(Deferred.succeed(entered, undefined)),
								Effect.andThen(Deferred.await(resume)),
							),
						),
					);
					const closing = yield* owners
						.close(project("a"), first)
						.pipe(Effect.forkScoped);
					yield* Deferred.await(entered);
					const other = yield* owners
						.close(project("a"), first === "detach" ? "remove" : "detach")
						.pipe(Effect.forkScoped);
					yield* Deferred.succeed(resume, undefined);
					yield* Fiber.join(closing);
					yield* Fiber.join(other);
					expect(reasons).toEqual([first]);
				}),
		);
	}

	it.effect(
		"OS16 continues after finalizer defects and replays the close error",
		() =>
			Effect.gen(function* () {
				const { owners } = yield* fixture();
				const owner = yield* owners.projectScope("a");
				const events: string[] = [];
				yield* resource(owner, "earlier", events);
				yield* owner.acquire(
					Effect.acquireRelease(Effect.void, () =>
						Effect.die("release defect"),
					),
				);
				yield* resource(yield* owners.sessionScope("a1"), "child", events);
				const first = yield* Effect.result(
					owners.close(project("a"), "remove"),
				);
				const second = yield* Effect.result(
					owners.close(project("a"), "detach"),
				);
				expect(first).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "OwnerScopeCloseError" },
				});
				expect(second).toEqual(first);
				if (first._tag === "Failure")
					expect(Cause.pretty(first.failure.cause)).toContain("release defect");
				expect(events).toEqual(["child:remove", "earlier:remove"]);
			}),
	);

	it.effect("OS17 interruption of close cannot abandon teardown", () =>
		Effect.gen(function* () {
			const { owners } = yield* fixture();
			const entered = yield* Deferred.make<void>();
			const resume = yield* Deferred.make<void>();
			const released = yield* Deferred.make<void>();
			yield* (yield* owners.projectScope("a")).acquire(
				Effect.acquireRelease(Effect.void, () =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(resume)),
						Effect.andThen(Deferred.succeed(released, undefined)),
					),
				),
			);
			const closing = yield* owners
				.close(project("a"), "remove")
				.pipe(Effect.forkScoped);
			yield* Deferred.await(entered);
			closing.interruptUnsafe();
			yield* Deferred.succeed(resume, undefined);
			yield* Deferred.await(released);
			yield* owners.close(project("a"), "remove");
		}),
	);

	it.effect("OS18 parent close joins an already-closing child", () =>
		Effect.gen(function* () {
			const { owners } = yield* fixture();
			const entered = yield* Deferred.make<void>();
			const resume = yield* Deferred.make<void>();
			const events: string[] = [];
			yield* resource(yield* owners.projectScope("a"), "parent", events);
			yield* (yield* owners.sessionScope("a1")).acquire(
				Effect.acquireRelease(Effect.void, () =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(resume)),
						Effect.andThen(
							Effect.sync(() => {
								events.push("child");
							}),
						),
					),
				),
			);
			const child = yield* owners
				.close(session("a1"), "remove")
				.pipe(Effect.forkScoped);
			yield* Deferred.await(entered);
			const parent = yield* owners
				.close(project("a"), "detach")
				.pipe(Effect.forkScoped);
			yield* Effect.yieldNow;
			expect(parent.pollUnsafe()).toBeUndefined();
			expect(events).toEqual([]);
			yield* Deferred.succeed(resume, undefined);
			yield* Fiber.join(child);
			yield* Fiber.join(parent);
			expect(events).toEqual(["child", "parent:detach"]);
		}),
	);

	it.effect("OS19 interrupts scoped server work even on detach", () =>
		Effect.gen(function* () {
			const { owners } = yield* fixture();
			const entered = yield* Deferred.make<void>();
			const ended = yield* Deferred.make<void>();
			const worker = yield* (yield* owners.sessionScope("a1")).acquire(
				Deferred.succeed(entered, undefined).pipe(
					Effect.andThen(Effect.never),
					Effect.ensuring(Deferred.succeed(ended, undefined)),
					Effect.forkScoped,
				),
			);
			yield* Deferred.await(entered);
			yield* owners.close(project("a"), "detach");
			expect(yield* Deferred.isDone(ended)).toBe(true);
			expect(Exit.isFailure(yield* Fiber.await(worker))).toBe(true);
		}),
	);

	it.effect(
		"OS20 daemon teardown detaches all owners and fences new work",
		() =>
			Effect.gen(function* () {
				const { owners, daemon } = yield* fixture();
				const events: string[] = [];
				const handle = yield* owners.sessionScope("a1");
				yield* resource(handle, "one", events);
				yield* resource(yield* owners.projectScope("b"), "two", events);
				yield* Scope.close(daemon, Exit.fail("startup failed"));
				expect(events).toEqual(["two:detach", "one:detach"]);
				for (const work of [
					handle.acquire(Effect.void),
					owners.projectScope("new"),
					owners.sessionScope("new"),
				])
					expect(yield* Effect.result(work)).toMatchObject({
						_tag: "Failure",
						failure: { _tag: "OwnerScopeClosedError", reason: "detach" },
					});
			}),
	);

	it.effect(
		"OS21 replacement daemon opens fresh owners for surviving resources",
		() =>
			Effect.gen(function* () {
				const first = yield* fixture();
				const previous = yield* first.owners.sessionScope("a1");
				let running = true;
				const open = Effect.acquireRelease(
					Effect.succeed("runner"),
					(_, exit) =>
						Effect.sync(() => {
							if (ownerCloseReason(exit) === "remove") running = false;
						}),
				);
				yield* previous.acquire(open);
				yield* Scope.close(first.daemon, Exit.void);
				const second = yield* fixture();
				const current = yield* second.owners.sessionScope("a1");
				expect(current).not.toBe(previous);
				expect(running).toBe(true);
				yield* current.acquire(open);
				yield* second.owners.close(session("a1"), "remove");
				expect(running).toBe(false);
			}),
	);

	it.effect(
		"OS22 browser request closure leaves its owner available on reconnect",
		() =>
			Effect.gen(function* () {
				const { owners } = yield* fixture();
				const events: string[] = [];
				const handle = yield* Effect.scoped(
					Effect.gen(function* () {
						const owner = yield* owners.sessionScope("a1");
						yield* resource(owner, "run", events);
						return owner;
					}),
				);
				expect(events).toEqual([]);
				expect(yield* owners.sessionScope("a1")).toBe(handle);
				yield* owners.close(project("a"), "remove");
				expect(events).toEqual(["run:remove"]);
			}),
	);

	it.effect(
		"OS25 rejects cached owners when provenance disappears or changes",
		() =>
			Effect.gen(function* () {
				let provenance: Option.Option<string> = Option.some("a");
				const { owners } = yield* fixture(() => Effect.succeed(provenance));
				yield* owners.sessionScope("a1");
				for (const next of [Option.none<string>(), Option.some("b")]) {
					provenance = next;
					expect(yield* Effect.result(owners.sessionScope("a1"))).toMatchObject(
						{
							_tag: "Failure",
							failure: { _tag: "OwnerScopeProvenanceError", sessionId: "a1" },
						},
					);
				}
			}),
	);
});
