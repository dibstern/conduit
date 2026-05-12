// ─── Relay Cache (ScopedRef + HashMap) ──────────────────────────────────────
// Manages WebSocket relay instances per project slug. Each slug gets at most
// one active relay. Uses ScopedRef for lifecycle (relay.stop() on invalidate
// or layer shutdown) and HashMap for structural sharing inside the Ref.
//
// Replaces the old ProjectRegistry bridge with Effect-native primitives:
//   - Ref<HashMap<string, ScopedRef<Relay | null>>> for the cache store
//   - Semaphore(1) to prevent duplicate creation on concurrent gets
//   - Layer.scoped ties all ScopedRefs to the layer scope

import {
	Context,
	Data,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Scope,
	ScopedRef,
} from "effect";

// ─── Relay interface ────────────────────────────────────────────────────────

/** A running relay instance for a project slug. */
export interface Relay {
	slug: string;
	wsHandler: {
		handleUpgrade: (req: unknown, socket: unknown, head: unknown) => void;
	};
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

// ─── RelayFactory ───────────────────────────────────────────────────────────

/** Factory function that creates a Relay for the given slug. */
export type RelayFactory = (slug: string) => Effect.Effect<Relay>;

// ─── RelayCache interface ───────────────────────────────────────────────────

/** Cache that stores and manages relay instances per slug. */
export interface RelayCache {
	/** Get or create a relay for the given slug. */
	get: (slug: string) => Effect.Effect<Relay>;
	/** Invalidate (stop and remove) the relay for the given slug. */
	invalidate: (slug: string) => Effect.Effect<void>;
}

// ─── Context Tag ────────────────────────────────────────────────────────────

export class RelayCacheTag extends Context.Tag("RelayCache")<
	RelayCacheTag,
	RelayCache
>() {}

// ─── Layer factory ──────────────────────────────────────────────────────────

type CacheEntry = ScopedRef.ScopedRef<Relay | null>;
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
 * - Each slug maps to a ScopedRef<Relay | null>
 * - ScopedRef.set runs the factory in a new inner scope, registering
 *   relay.stop() as a finalizer so it runs on invalidation or shutdown
 * - A Semaphore(1) serializes get operations to prevent duplicate creation
 * - Layer.scoped ties all ScopedRefs to the layer scope
 */
export const makeRelayCacheLive = (
	factory: RelayFactory,
): Layer.Layer<RelayCacheTag> =>
	Layer.scoped(
		RelayCacheTag,
		Effect.gen(function* () {
			// Capture the layer scope so ScopedRefs created at runtime
			// (inside get) are tied to the layer lifecycle.
			const layerScope = yield* Effect.scope;
			const cacheRef = yield* Ref.make<CacheMap>(HashMap.empty());
			const semaphore = yield* Effect.makeSemaphore(1);

			const get = (slug: string): Effect.Effect<Relay> =>
				semaphore.withPermits(1)(
					Effect.gen(function* () {
						const map = yield* Ref.get(cacheRef);
						const existing = HashMap.get(map, slug);

						if (Option.isSome(existing)) {
							const value = yield* ScopedRef.get(existing.value);
							if (value !== null) {
								return value;
							}
						}

						// Create a new ScopedRef for this slug, providing the
						// layer scope so it's tied to the layer lifecycle.
						const scopedRef = yield* ScopedRef.fromAcquire(
							Effect.succeed<Relay | null>(null),
						).pipe(Effect.provideService(Scope.Scope, layerScope));

						// Set the ScopedRef with the factory + finalizer
						yield* ScopedRef.set(
							scopedRef,
							Effect.gen(function* () {
								const relay = yield* factory(slug);
								yield* Effect.addFinalizer(() => stopRelayFinalizer(relay));
								return relay;
							}),
						);

						// Store in the HashMap
						yield* Ref.update(cacheRef, (m) => HashMap.set(m, slug, scopedRef));

						// Return the relay
						return yield* ScopedRef.get(scopedRef) as Effect.Effect<Relay>;
					}),
				);

			const invalidate = (slug: string): Effect.Effect<void> =>
				semaphore.withPermits(1)(
					Effect.gen(function* () {
						const map = yield* Ref.get(cacheRef);
						const existing = HashMap.get(map, slug);

						if (Option.isSome(existing)) {
							// Remove from HashMap first
							yield* Ref.update(cacheRef, (m) => HashMap.remove(m, slug));

							// Set ScopedRef to null — triggers previous scope close,
							// which runs relay.stop() via the registered finalizer
							yield* ScopedRef.set(existing.value, Effect.succeed(null));
						}
					}),
				);

			return { get, invalidate } satisfies RelayCache;
		}),
	);
