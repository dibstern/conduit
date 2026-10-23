import {
	Deferred,
	Effect,
	Exit,
	HashMap,
	Layer,
	Option,
	Ref,
	Scope,
	Semaphore,
} from "effect";
import {
	type OwnerCloseReason,
	type OwnerScope,
	OwnerScopeClosedError,
	OwnerScopeCloseError,
	OwnerScopeProjectNotRegisteredError,
	OwnerScopeProvenanceError,
	OwnerScopes,
	type OwnerTarget,
} from "../Services/owner-scopes.js";
import { ProjectRegistryTag } from "../Services/project-registry-service.js";
import { SessionDirectory } from "../Services/session-directory.js";

export const OwnerScopesLive = Layer.effect(
	OwnerScopes,
	Effect.gen(function* () {
		const directory = yield* SessionDirectory;
		const projectRegistry = yield* ProjectRegistryTag;
		const registry = yield* Semaphore.make(1);
		type Entry = {
			readonly target: OwnerTarget | { readonly kind: "daemon" };
			readonly parent?: Entry;
			readonly scope: Scope.Closeable;
			readonly gate: Semaphore.Semaphore;
			readonly closed: Deferred.Deferred<Exit.Exit<void>>;
			readonly children: Set<Entry>;
			readonly handle: OwnerScope;
			reason?: OwnerCloseReason;
			started: boolean;
		};
		const projects = new Map<string, Entry>();
		const sessions = new Map<string, Entry>();
		const sessionTombstones = new Map<string, OwnerCloseReason>();
		const check = (entry: Entry) =>
			entry.reason
				? Effect.fail(
						new OwnerScopeClosedError({
							target: entry.target,
							reason: entry.reason,
						}),
					)
				: Effect.succeed(entry);
		const fence = (entry: Entry, reason: OwnerCloseReason): void => {
			entry.reason ??= reason;
			for (const child of entry.children) fence(child, entry.reason);
		};
		const closeEntry = (
			entry: Entry,
			reason: OwnerCloseReason,
		): Effect.Effect<void> =>
			Effect.suspend(() => {
				fence(entry, reason);
				if (entry.started)
					return Deferred.await(entry.closed).pipe(Effect.flatten);
				entry.started = true;
				// 82tn.32.12: settle runs with projectInactive here, before scope closure.
				return entry.gate
					.withPermits(1)(Scope.close(entry.scope, Exit.succeed(entry.reason)))
					.pipe(
						Effect.exit,
						Effect.tap((exit) => Deferred.succeed(entry.closed, exit)),
						Effect.flatten,
					);
			}).pipe(Effect.uninterruptible);
		// A previously reported explicit-close failure must not be raised again at daemon teardown.
		const releaseEntry = (entry: Entry, reason: OwnerCloseReason) =>
			Deferred.isDone(entry.closed).pipe(
				Effect.flatMap((done) =>
					done ? Effect.void : closeEntry(entry, reason),
				),
			);
		const makeEntry = (target: Entry["target"], parent?: Entry): Entry => {
			const entry: Entry = {
				target,
				...(parent ? { parent } : {}),
				scope: Scope.makeUnsafe("sequential"),
				gate: Semaphore.makeUnsafe(1),
				closed: Deferred.makeUnsafe<Exit.Exit<void>>(),
				children: new Set(),
				started: false,
				handle: {
					acquire: (resource) =>
						Effect.gen(function* () {
							yield* check(entry);
							return yield* entry.gate.withPermits(1)(
								Effect.gen(function* () {
									yield* check(entry);
									return yield* resource.pipe(Scope.provide(entry.scope));
								}),
							);
						}),
				},
			};
			return entry;
		};
		const daemon = yield* Effect.acquireRelease(
			Effect.sync(() => makeEntry({ kind: "daemon" })),
			(entry) => releaseEntry(entry, "detach"),
		);
		const open = (parent: Entry, target: OwnerTarget) =>
			Effect.gen(function* () {
				yield* check(parent);
				const child = makeEntry(target, parent);
				parent.children.add(child);
				yield* Effect.acquireRelease(Effect.succeed(child), (entry, exit) =>
					releaseEntry(
						entry,
						Exit.isSuccess(exit) && exit.value === "remove"
							? "remove"
							: "detach",
					),
				).pipe(Scope.provide(parent.scope));
				return yield* check(child);
			});
		const projectEntry = (projectId: string) =>
			Effect.gen(function* () {
				yield* check(daemon);
				if (!HashMap.has(yield* Ref.get(projectRegistry), projectId))
					return yield* Effect.fail(
						new OwnerScopeProjectNotRegisteredError({ projectId }),
					);
				const current = projects.get(projectId);
				if (current && !(yield* Deferred.isDone(current.closed)))
					return yield* check(current);
				const created = yield* open(daemon, { kind: "project", projectId });
				projects.set(projectId, created);
				return created;
			});
		return {
			projectScope: (projectId) =>
				registry.withPermits(1)(
					projectEntry(projectId).pipe(
						Effect.map((entry) => entry.handle),
						Effect.uninterruptible,
					),
				),
			sessionScope: (sessionId) =>
				Effect.gen(function* () {
					yield* check(daemon);
					const projectId = yield* directory.projectOf(sessionId);
					return yield* registry.withPermits(1)(
						Effect.gen(function* () {
							yield* check(daemon);
							const reason = sessionTombstones.get(sessionId);
							if (reason)
								return yield* Effect.fail(
									new OwnerScopeClosedError({
										target: { kind: "session", sessionId },
										reason,
									}),
								);
							const current = sessions.get(sessionId);
							if (
								Option.isNone(projectId) ||
								(current &&
									(current.parent?.target.kind !== "project" ||
										current.parent.target.projectId !== projectId.value))
							)
								return yield* Effect.fail(
									new OwnerScopeProvenanceError({ sessionId }),
								);
							const parent = yield* projectEntry(projectId.value);
							if (current?.parent === parent)
								return (yield* check(current)).handle;
							const created = yield* open(parent, {
								kind: "session",
								sessionId,
							});
							sessions.set(sessionId, created);
							return created.handle;
						}).pipe(Effect.uninterruptible),
					);
				}),
			close: (target, reason) =>
				Effect.gen(function* () {
					const entry = yield* registry.withPermits(1)(
						Effect.sync(() => {
							const current =
								target.kind === "project"
									? projects.get(target.projectId)
									: sessions.get(target.sessionId);
							if (current) fence(current, reason);
							if (
								target.kind === "session" &&
								!sessionTombstones.has(target.sessionId)
							)
								sessionTombstones.set(
									target.sessionId,
									current?.reason ?? reason,
								);
							return current;
						}),
					);
					if (entry)
						yield* closeEntry(entry, reason).pipe(
							Effect.catchCause((cause) =>
								Effect.fail(new OwnerScopeCloseError({ target, cause })),
							),
						);
				}).pipe(Effect.uninterruptible),
		};
	}),
);
