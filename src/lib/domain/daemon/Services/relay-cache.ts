// ─── Relay Cache (ScopedRef + HashMap) ──────────────────────────────────────
// Manages WebSocket relay instances per project slug. Each slug gets at most
// one active relay. Uses ScopedRef for lifecycle (relay.stop() on invalidate
// or layer shutdown) and HashMap for structural sharing inside the Ref.
//
// Replaces the old ProjectRegistry bridge with Effect-native primitives:
//   - Ref<HashMap<string, CacheEntry>> for ready/in-flight relays
//   - Semaphore(1) to prevent duplicate creation on concurrent gets
//   - Layer.scoped ties all ScopedRefs to the layer scope

import type http from "node:http";
import type { Duplex } from "node:stream";
import {
	Context,
	Data,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Layer,
	Option,
	Ref,
	Scope,
	ScopedRef,
} from "effect";

// ─── Relay interface ────────────────────────────────────────────────────────

/** A running relay instance for a project slug. */
export interface RelayStatusSnapshot {
	readonly sessionCount: number;
	readonly clients: number;
	readonly isProcessing: boolean;
}

export interface Relay {
	slug: string;
	wsHandler: {
		handleUpgrade: (
			req: http.IncomingMessage,
			socket: Duplex,
			head: Buffer,
		) => void;
	};
	rpcWsHandler: {
		handleUpgrade: (
			req: http.IncomingMessage,
			socket: Duplex,
			head: Buffer,
		) => void;
	};
	getStatusSnapshot?: () => RelayStatusSnapshot;
	setDefaultAgent?: (agent: string) => Promise<void>;
	setDefaultModel?: (model: {
		readonly providerID: string;
		readonly modelID: string;
	}) => Promise<void>;
	stop: () => void | Promise<void>;
}

export class RelayStopError extends Data.TaggedError("RelayStopError")<{
	slug: string;
	cause: unknown;
}> {
	get message(): string {
		const inner = this.cause instanceof Error ? this.cause.message : this.cause;
		return `Failed to stop relay "${this.slug}": ${String(inner)}`;
	}
}

export class RelayCreationInvalidatedError extends Data.TaggedError(
	"RelayCreationInvalidatedError",
)<{
	slug: string;
}> {
	get message(): string {
		return `Relay creation invalidated for "${this.slug}"`;
	}
}

// ─── RelayFactory ───────────────────────────────────────────────────────────

/** Factory function that creates a Relay for the given slug. */
export type RelayFactory = (slug: string) => Effect.Effect<Relay, unknown>;

// ─── RelayCache interface ───────────────────────────────────────────────────

/** Cache that stores and manages relay instances per slug. */
export interface RelayCache {
	/** Get or create a relay for the given slug. */
	get: (slug: string) => Effect.Effect<Relay, unknown>;
	/** Get a cached relay if one exists. Must not create or start a relay. */
	peek: (slug: string) => Effect.Effect<Option.Option<Relay>>;
	/** Invalidate (stop and remove) the relay for the given slug. */
	invalidate: (slug: string) => Effect.Effect<void>;
}

// ─── Context Tag ────────────────────────────────────────────────────────────

export class RelayCacheTag extends Context.Tag("RelayCache")<
	RelayCacheTag,
	RelayCache
>() {}

// ─── Layer factory ──────────────────────────────────────────────────────────

interface CacheEntry {
	readonly scopedRef: ScopedRef.ScopedRef<Relay | null>;
	readonly ready: Deferred.Deferred<Relay, unknown>;
	readonly creationFiber: Deferred.Deferred<Fiber.RuntimeFiber<void, never>>;
}

type CacheMap = HashMap.HashMap<string, CacheEntry>;

const stopRelayFinalizer = (relay: Relay) =>
	Effect.tryPromise({
		try: async () => {
			await relay.stop();
		},
		catch: (cause) => new RelayStopError({ slug: relay.slug, cause }),
	}).pipe(
		Effect.catchAll((error) =>
			Effect.logError("relay stop failed during cache finalization", error),
		),
	);

/**
 * Create a Layer providing RelayCacheTag backed by ScopedRef + HashMap.
 *
 * - Each slug maps to a CacheEntry for either a ready or in-flight relay
 * - Relay creation runs in a cancellable fiber, then ScopedRef.set installs
 *   relay.stop() as a finalizer so it runs on invalidation or shutdown
 * - A Semaphore(1) serializes get operations to prevent duplicate creation
 * - Layer.scoped ties all ScopedRefs to the layer scope
 */
export const makeRelayCacheLive = (
	factory: RelayFactory,
): Layer.Layer<RelayCacheTag> =>
	Layer.scoped(RelayCacheTag, makeRelayCacheService(factory));

export const makeRelayCacheService = (
	factory: RelayFactory,
): Effect.Effect<RelayCache, never, Scope.Scope> =>
	Effect.gen(function* () {
		// Capture the layer scope so ScopedRefs created at runtime
		// (inside get) are tied to the layer lifecycle.
		const layerScope = yield* Effect.scope;
		const cacheRef = yield* Ref.make<CacheMap>(HashMap.empty());
		const semaphore = yield* Effect.makeSemaphore(1);

		const removeEntryIfCurrent = (slug: string, entry: CacheEntry) =>
			Ref.update(cacheRef, (map) => {
				const current = HashMap.get(map, slug);
				return Option.isSome(current) && current.value === entry
					? HashMap.remove(map, slug)
					: map;
			});

		const runRelayCreation = (
			slug: string,
			entry: CacheEntry,
		): Effect.Effect<void> =>
			Effect.exit(
				Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						const relay = yield* restore(factory(slug));
						yield* ScopedRef.set(
							entry.scopedRef,
							Effect.gen(function* () {
								yield* Effect.addFinalizer(() => stopRelayFinalizer(relay));
								return relay;
							}),
						);
						return relay;
					}),
				),
			).pipe(
				Effect.flatMap((exit) =>
					Exit.isSuccess(exit)
						? Deferred.succeed(entry.ready, exit.value).pipe(Effect.asVoid)
						: removeEntryIfCurrent(slug, entry).pipe(
								Effect.zipRight(Deferred.failCause(entry.ready, exit.cause)),
								Effect.asVoid,
							),
				),
			);

		const get = (slug: string): Effect.Effect<Relay, unknown> =>
			Effect.gen(function* () {
				const entry = yield* semaphore.withPermits(1)(
					Effect.uninterruptible(
						Effect.gen(function* () {
							const map = yield* Ref.get(cacheRef);
							const existing = HashMap.get(map, slug);
							if (Option.isSome(existing)) {
								return existing.value;
							}

							// Create a new ScopedRef for this slug, providing the
							// layer scope so it's tied to the layer lifecycle.
							const scopedRef = yield* ScopedRef.fromAcquire(
								Effect.succeed<Relay | null>(null),
							).pipe(Effect.provideService(Scope.Scope, layerScope));
							const ready = yield* Deferred.make<Relay, unknown>();
							const creationFiber =
								yield* Deferred.make<Fiber.RuntimeFiber<void, never>>();
							const newEntry: CacheEntry = {
								scopedRef,
								ready,
								creationFiber,
							};

							yield* Ref.update(cacheRef, (m) =>
								HashMap.set(m, slug, newEntry),
							);
							const fiber = yield* Effect.fork(
								Effect.interruptible(runRelayCreation(slug, newEntry)),
							);
							yield* Deferred.succeed(creationFiber, fiber);
							return newEntry;
						}),
					),
				);
				return yield* Deferred.await(entry.ready);
			});

		const peek = (slug: string): Effect.Effect<Option.Option<Relay>> =>
			Effect.gen(function* () {
				const map = yield* Ref.get(cacheRef);
				const existing = HashMap.get(map, slug);
				if (Option.isNone(existing)) {
					return Option.none<Relay>();
				}
				const relay = yield* ScopedRef.get(existing.value.scopedRef);
				return relay === null ? Option.none<Relay>() : Option.some(relay);
			});

		const invalidate = (slug: string): Effect.Effect<void> =>
			Effect.gen(function* () {
				const existing = yield* semaphore.withPermits(1)(
					Ref.modify(cacheRef, (map) => {
						const entry = HashMap.get(map, slug);
						return [
							entry,
							Option.isSome(entry) ? HashMap.remove(map, slug) : map,
						] as const;
					}),
				);

				if (Option.isSome(existing)) {
					const entry = existing.value;
					const fiber = yield* Deferred.await(entry.creationFiber);
					yield* Fiber.interrupt(fiber);
					yield* Deferred.fail(
						entry.ready,
						new RelayCreationInvalidatedError({ slug }),
					);

					// Set ScopedRef to null — triggers previous scope close,
					// which runs relay.stop() via the registered finalizer
					yield* ScopedRef.set(entry.scopedRef, Effect.succeed(null));
				}
			});

		return { get, peek, invalidate } satisfies RelayCache;
	});
