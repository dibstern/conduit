import { Deferred, Effect, Exit, Fiber, Option, Scope } from "effect";

export type SendAssignment =
	| { readonly _tag: "Queued" }
	| { readonly _tag: "Dispatched"; readonly runnerId: string }
	| { readonly _tag: "Closed" };

export interface SendScope {
	readonly scope: Scope.Closeable;
	readonly sinkId: string;
	readonly sessionId: string;
	readonly assignment: SendAssignment;
	readonly close: Effect.Effect<void>;
	readonly closed: Effect.Effect<void>;
}

/** Daemon resources end independently of the runner's permission to write. */
export const makeSendScopes = (
	onClose?: (
		sinkId: string,
		sessionId: string,
	) => Effect.Effect<unknown, unknown>,
) =>
	Effect.gen(function* () {
		const parent = yield* Effect.scope;
		const sends = new Set<SendScope>();
		const assignments = new WeakMap<SendScope, SendAssignment>();
		const bounded = <A, E, R>(
			sinkId: string,
			resource: string,
			release: Effect.Effect<A, E, R>,
		) =>
			Effect.gen(function* () {
				// Scope.close is uninterruptible. Bound each detached finalizer's join
				// so a wedged resource cannot block the remaining finalizers.
				const fiber = yield* release.pipe(
					Effect.interruptible,
					Effect.exit,
					Effect.forkDetach({ startImmediately: true }),
				);
				const result = yield* Fiber.join(fiber).pipe(
					Effect.interruptible,
					Effect.timeoutOption("1 second"),
				);
				if (Option.isNone(result)) {
					yield* Effect.logWarning("Send resource finalizer timed out", {
						sinkId,
						resource,
					});
					yield* Fiber.interrupt(fiber).pipe(Effect.forkDetach);
				} else if (Exit.isFailure(result.value))
					yield* Effect.logWarning("Send resource finalizer failed", {
						sinkId,
						resource,
						cause: result.value.cause,
					});
			});
		const open = (sinkId: string, sessionId: string) =>
			Effect.uninterruptible(
				Effect.gen(function* () {
					if (parent.state._tag === "Closed") return yield* Effect.interrupt;
					const scope = yield* Scope.fork(parent, "sequential");
					const completed = yield* Deferred.make<void>();
					const closed = Deferred.await(completed);
					const send: SendScope = {
						scope,
						sinkId,
						sessionId,
						get assignment(): SendAssignment {
							return scope.state._tag === "Closed"
								? { _tag: "Closed" }
								: (assignments.get(send) ?? { _tag: "Queued" });
						},
						closed,
						close: Scope.close(scope, Exit.void).pipe(
							Effect.ensuring(closed),
							Effect.uninterruptible,
						),
					};
					assignments.set(send, { _tag: "Queued" });
					// First registered is last run, including parent-driven closure.
					yield* Scope.addFinalizer(
						scope,
						Deferred.succeed(completed, undefined),
					);
					yield* Scope.addFinalizer(
						scope,
						Effect.sync(() => sends.delete(send)).pipe(
							Effect.andThen(
								bounded(
									sinkId,
									"close notification",
									Effect.suspend(
										() => onClose?.(sinkId, sessionId) ?? Effect.void,
									),
								),
							),
						),
					);
					sends.add(send);
					return send;
				}),
			);
		return {
			open,
			dispatch: (send: SendScope, runnerId: string): void => {
				if (send.assignment._tag === "Queued")
					assignments.set(send, { _tag: "Dispatched", runnerId });
			},
			requeue: (send: SendScope, runnerId: string): void => {
				const assignment = send.assignment;
				if (
					assignment._tag === "Dispatched" &&
					assignment.runnerId === runnerId
				)
					assignments.set(send, { _tag: "Queued" });
			},
			/** The last dispatch survives close, so native cleanup still knows its runner. */
			dispatchedTo: (send: SendScope): string | undefined => {
				const assignment = assignments.get(send);
				return assignment?._tag === "Dispatched"
					? assignment.runnerId
					: undefined;
			},
			acquire: <A, E, R, R2>(
				send: SendScope,
				sinkId: string,
				resource: string,
				acquire: Effect.Effect<A, E, R>,
				release: (value: A) => Effect.Effect<unknown, unknown, R2>,
			) =>
				Effect.acquireRelease(acquire, (value) =>
					bounded(sinkId, resource, release(value)),
				).pipe(Scope.provide(send.scope)),
			fork: <A, E, R>(
				send: SendScope,
				resource: string,
				operation: Effect.Effect<A, E, R>,
				startImmediately = false,
			) =>
				Effect.gen(function* () {
					const fiber = yield* Effect.acquireRelease(
						Effect.forkDetach(operation),
						(fiber) =>
							Effect.flatMap(Effect.fiber, (closer) =>
								closer.id === fiber.id
									? Effect.void
									: bounded(send.sinkId, resource, Fiber.interrupt(fiber)),
							),
					).pipe(Scope.provide(send.scope));
					// Register ownership before the operation can synchronously close its send.
					if (startImmediately) yield* Effect.yieldNow;
					return fiber;
				}),

			close: (send: SendScope) => send.close,
			closeRunner: (runnerId: string) =>
				Effect.suspend(() =>
					Effect.forEach(
						[...sends].filter(
							(send) =>
								send.assignment._tag === "Dispatched" &&
								send.assignment.runnerId === runnerId,
						),
						(send) => send.close,
						{ concurrency: 4, discard: true },
					),
				),
			closeSession: (sessionId: string) =>
				Effect.suspend(() =>
					Effect.forEach(
						[...sends].filter((send) => send.sessionId === sessionId),
						(send) => send.close,
						{ concurrency: 4, discard: true },
					),
				),
			closeAll: Effect.suspend(() =>
				Effect.forEach([...sends], (send) => send.close, {
					concurrency: 4,
					discard: true,
				}),
			),
		};
	});

export type SendScopes = Effect.Success<ReturnType<typeof makeSendScopes>>;
