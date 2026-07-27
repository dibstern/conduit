// ─── Read-Model Subscription (Effect) ────────────────────────────────────────
// Generic snapshot+live orchestration for read-model subscriptions.
//
// stream – merges a SubscriptionSource's snapshot (or resume replay) with its
//          live delta stream into one ordered Stream<Envelope<T>>. Owns only
//          the orchestration invariants: subscribe-to-live-first, sequence
//          high-water-mark dedup, a single `synchronized` boundary marker,
//          cold-start vs resume, and Scope-based teardown. It never inspects
//          the payload `T` or the `remove` id, and contains no coalescing —
//          burst-smoothing is a delta-source concern.

import { Effect, Ref, type Scope, Stream } from "effect";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single read-model change, tagged with its store-global sequence. */
export type Delta<T> =
	| { readonly _tag: "upsert"; readonly item: T; readonly sequence: number }
	| { readonly _tag: "remove"; readonly id: string; readonly sequence: number };

/**
 * What a subscriber receives: a snapshot base (cold start only), a
 * `synchronized` boundary once the base or catch-up is complete, then deltas.
 * The snapshot's `sequence` is the high-water mark its rows reflect.
 */
export type Envelope<T> =
	| {
			readonly _tag: "snapshot";
			readonly rows: readonly T[];
			readonly sequence: number;
	  }
	| { readonly _tag: "synchronized" }
	| Delta<T>;

/**
 * The one adapter a concrete delta source implements (detail, shell, …).
 * The orchestrator depends on nothing else — no bus, no database.
 */
export interface SubscriptionSource<T, E = never> {
	/**
	 * Cold start: full current rows + the sequence HWM they reflect. Must read
	 * rows and sequence coherently (atomically with respect to appends).
	 */
	readonly snapshot: () => Effect.Effect<
		{ readonly rows: readonly T[]; readonly sequence: number },
		E
	>;
	/**
	 * Resume catch-up: ALL deltas strictly after `afterSequence`, ascending
	 * (adapters page internally). Extension point (not yet implemented): a
	 * source may later fail with a cursor-too-old signal here — e.g. after
	 * eviction hollows out old history — at which point the orchestrator would
	 * fall back to a fresh snapshot.
	 */
	readonly replay: (afterSequence: number) => Stream.Stream<Delta<T>, E>;
	/**
	 * Live deltas from now on. Scoped: running this Effect subscribes, and the
	 * subscription buffers from that instant; the enclosing Scope releases it.
	 */
	readonly live: () => Effect.Effect<
		Stream.Stream<Delta<T>, E>,
		never,
		Scope.Scope
	>;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Produce one ordered subscription stream from a {@link SubscriptionSource}.
 *
 * - Cold start (`resumeFromSequence` undefined):
 *   `snapshot` → `synchronized` → live deltas with `sequence > snapshot HWM`.
 * - Resume: replay deltas strictly after the cursor → `synchronized` → live
 *   deltas with `sequence > max(resumeFromSequence, last replayed sequence)`.
 *   No snapshot envelope — the client already holds a base.
 *
 * The live subscription is acquired BEFORE the snapshot/replay read, so a
 * delta committed during that read is buffered rather than lost; the HWM
 * filter then drops the copies the base already covers. Lifecycle is the
 * ambient Scope of the running stream: closing it releases the live
 * subscription and runs finalizers.
 */
export const stream = <T, E = never>(options: {
	readonly source: SubscriptionSource<T, E>;
	readonly resumeFromSequence?: number;
}): Stream.Stream<Envelope<T>, E> =>
	Stream.unwrapScoped(
		Effect.gen(function* () {
			// Subscribe to live FIRST — it buffers from this instant.
			const live = yield* options.source.live();

			if (options.resumeFromSequence === undefined) {
				const snapshot = yield* options.source.snapshot();
				return Stream.concat(
					Stream.fromIterable<Envelope<T>>([
						{
							_tag: "snapshot",
							rows: snapshot.rows,
							sequence: snapshot.sequence,
						},
						{ _tag: "synchronized" },
					]),
					Stream.filter(live, (delta) => delta.sequence > snapshot.sequence),
				);
			}

			// Resume: advance the HWM to the last replayed sequence as we drain
			// replay, so a delta in the (cursor, lastReplayed] window — delivered
			// by BOTH replay and live — is emitted once by replay, then dropped
			// from live. `concat` drains replay fully before pulling live, so the
			// Ref holds the final HWM by the time live is filtered.
			const hwm = yield* Ref.make(options.resumeFromSequence);
			return options.source.replay(options.resumeFromSequence).pipe(
				Stream.tap((delta) =>
					Ref.update(hwm, (current) => Math.max(current, delta.sequence)),
				),
				Stream.concat(
					Stream.fromIterable<Envelope<T>>([{ _tag: "synchronized" }]),
				),
				Stream.concat(
					Stream.filterEffect(live, (delta) =>
						Ref.get(hwm).pipe(Effect.map((mark) => delta.sequence > mark)),
					),
				),
			);
		}),
	);
