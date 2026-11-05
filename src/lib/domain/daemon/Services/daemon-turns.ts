import {
	Context,
	Effect,
	FiberMap,
	Layer,
	Option,
	Queue,
	Schedule,
	type Scope,
	Semaphore,
} from "effect";
import * as Failure from "../../../effect/failure-classification.js";
import { ENV } from "../../../env.js";
import { OwnerScopes } from "./owner-scopes.js";

type DispatchFibers = FiberMap.FiberMap<string, void, unknown>;

/** What a started relay lends the daemon so continuations run with its parts. */
export interface ProjectContinuation {
	readonly sweep: Effect.Effect<unknown, unknown>;
	readonly applyLimitPolicy: (sessionId: string) => Effect.Effect<void>;
}

/** Running turns and their queues, held by the daemon so relay rebuilds keep them. */
export class DaemonTurns extends Context.Service<
	DaemonTurns,
	{
		/** The session's dispatch fibers live in its owner scope, never a relay's. */
		readonly dispatchFibers: (
			sessionId: string,
		) => Effect.Effect<DispatchFibers>;
		/** One permit per session across every relay, so a session drains once. */
		readonly serialised: (
			sessionId: string,
		) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
		/** Sessions holding or awaiting a permit; none once their work ends. */
		readonly heldPermits: () => number;
		/** Lend a relay's continuation for its project until the relay's scope closes. */
		readonly attach: (
			projectId: string,
			parts: ProjectContinuation,
		) => Effect.Effect<void, never, Scope.Scope>;
		readonly queueLimitPolicy: (
			projectId: string,
			sessionId: string,
		) => Effect.Effect<void>;
	}
>()("DaemonTurns") {}

/**
 * Built once in the daemon scope (a standalone relay builds its own as its
 * daemon). Runs the one continuation sweep and the one limit-policy consumer.
 */
export const DaemonTurnsLive = Layer.effect(
	DaemonTurns,
	Effect.gen(function* () {
		const owners = yield* Effect.serviceOption(OwnerScopes);
		// Sessions without an owner scope (no row, or no daemon) still dispatch.
		const unowned = yield* FiberMap.make<string, void, unknown>();
		const held = new Map<string, DispatchFibers>();
		const lock = yield* Semaphore.make(1);
		// A permit lives while its session's work holds or awaits it, so a
		// finished or deleted session leaves nothing behind.
		const permits = new Map<
			string,
			{ readonly permit: Semaphore.Semaphore; users: number }
		>();
		const attached = new Map<string, ProjectContinuation[]>();
		const waiting = new Map<string, string[]>();
		// An entry without a session marks a newly lent relay for its project.
		const limits = yield* Queue.unbounded<{
			readonly projectId: string;
			readonly sessionId?: string;
		}>();
		const newest = (projectId: string) => attached.get(projectId)?.at(-1);

		const sweepAll = Effect.suspend(() =>
			Effect.forEach(
				[...attached.keys()],
				(projectId) =>
					(newest(projectId)?.sweep ?? Effect.void).pipe(
						Effect.catchCause((cause) =>
							Failure.isInterruptedOnly(cause)
								? Effect.interrupt
								: Effect.logError(
										"Continuation sweep failed",
										projectId,
										cause,
									),
						),
					),
				{ discard: true },
			),
		);
		yield* Effect.forkScoped(
			Effect.andThen(
				Effect.logInfo("Continuation sweep started"),
				sweepAll.pipe(
					Effect.repeat(Schedule.fixed(ENV.continuationSweepIntervalMs)),
				),
			),
		);
		// A policy for a project with no relay waits, in order, for the next one lent.
		yield* Effect.forkScoped(
			Queue.take(limits).pipe(
				Effect.flatMap(({ projectId, sessionId }) => {
					const parts = newest(projectId);
					const parked = waiting.get(projectId) ?? [];
					if (sessionId !== undefined && (!parts || parked.length > 0)) {
						waiting.set(projectId, [...parked, sessionId]);
						return Effect.void;
					}
					if (!parts) return Effect.void;
					if (sessionId !== undefined) return parts.applyLimitPolicy(sessionId);
					waiting.delete(projectId);
					return Effect.forEach(parked, parts.applyLimitPolicy, {
						discard: true,
					});
				}),
				Effect.forever,
			),
		);

		return {
			dispatchFibers: (sessionId) =>
				lock.withPermits(1)(
					Effect.suspend(() => {
						const existing = held.get(sessionId);
						if (existing) return Effect.succeed(existing);
						if (Option.isNone(owners)) return Effect.succeed(unowned);
						return owners.value.sessionScope(sessionId).pipe(
							Effect.flatMap((scope) =>
								scope.acquire<DispatchFibers, never, never>(
									Effect.acquireRelease(
										FiberMap.make<string, void, unknown>().pipe(
											Effect.tap((fibers) =>
												Effect.sync(() => held.set(sessionId, fibers)),
											),
										),
										() => Effect.sync(() => held.delete(sessionId)),
									),
								),
							),
							Effect.catch(() => Effect.succeed(unowned)),
						);
					}),
				),
			serialised: (sessionId) => (effect) =>
				Effect.acquireUseRelease(
					Effect.sync(() => {
						const entry = permits.get(sessionId) ?? {
							permit: Semaphore.makeUnsafe(1),
							users: 0,
						};
						entry.users += 1;
						permits.set(sessionId, entry);
						return entry;
					}),
					({ permit }) => permit.withPermits(1)(effect),
					(entry) =>
						Effect.sync(() => {
							entry.users -= 1;
							if (entry.users === 0) permits.delete(sessionId);
						}),
				),
			heldPermits: () => permits.size,
			attach: (projectId, parts) =>
				Effect.acquireRelease(
					Effect.andThen(
						Effect.sync(() =>
							attached.set(projectId, [
								...(attached.get(projectId) ?? []),
								parts,
							]),
						),
						Queue.offer(limits, { projectId }),
					),
					() =>
						Effect.sync(() => {
							const rest = (attached.get(projectId) ?? []).filter(
								(entry) => entry !== parts,
							);
							if (rest.length > 0) attached.set(projectId, rest);
							else attached.delete(projectId);
						}),
				),
			queueLimitPolicy: (projectId, sessionId) =>
				Effect.asVoid(Queue.offer(limits, { projectId, sessionId })),
		};
	}),
);

/** The daemon's DaemonTurns when the context has one; otherwise the caller is its own daemon. */
export const DaemonTurnsOrOwn = Layer.unwrap(
	Effect.map(Effect.serviceOption(DaemonTurns), (shared) =>
		Option.isSome(shared)
			? Layer.succeed(DaemonTurns, shared.value)
			: DaemonTurnsLive,
	),
);
