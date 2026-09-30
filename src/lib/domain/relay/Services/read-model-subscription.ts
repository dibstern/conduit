// ─── Read-Model Subscription (Effect) ────────────────────────────────────────
// Generic base+live orchestration for read-model subscriptions.
//
// stream – turns a SubscriptionSource plus the read-model advance signal into
//          one ordered Stream<Envelope<T>>. It owns every invariant that is not
//          about rows: subscribe-before-read, cold start vs resume, the single
//          `synchronized` boundary per base, dedup, and Scope-based teardown. It never
//          inspects the payload `T`.
//
// The version column (ni8.5 §7) is why this is small. Change notification,
// resume point and high-water mark are one number, so the orchestrator holds
// one query window, and the source is asked the
// same question — "what moved in this version window?" — for the cold-start
// base, for a resume catch-up, and for every live advance. There is no second
// notification path to keep in step with it, which is the whole point: a source
// carrying its own would be a second producer.
//
// The commit seam publishes advances in commit order. Bounded reads cannot
// retire queued removals; each upsert retains its row version for resume dedup.
// A dropped bus publication forces a fresh snapshot for sources whose live
// removal signal may have been lost.

import { Effect, Ref, type Schema, Stream } from "effect";
import type { ReadModelAdvance } from "../../../contracts/read-model-advance.js";
import type { EnvelopeSchema } from "../../../contracts/ws-rpc.js";
import type { SessionEventBus } from "./session-event-bus.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * What a subscriber receives: a base (cold start, and any resume a source
 * cannot serve incrementally), a `synchronized` boundary once that base is
 * complete, then upserts and removes. Every `sequence` is a read-model version.
 */
export type Envelope<T> = Schema.Schema.Type<
	ReturnType<typeof EnvelopeSchema<T, T, never>>
>;

/** A row and the read-model version it last moved at. */
export interface VersionedRow<T> {
	readonly item: T;
	readonly version: number;
}

/**
 * Half-open window of read-model versions: `after < version <= through`.
 * Omitting `after` means from before the first version; omitting `through`
 * means up to whatever the read-model currently holds.
 */
export interface VersionRange {
	readonly after?: number;
	readonly through?: number;
}

/** What an advance means to one subscription. */
export interface AdvanceRoute {
	/** Whether a row this subscription serves may have moved — so, re-query. */
	readonly moved: boolean;
	/**
	 * Rows that are gone, named in the SUBSCRIPTION's own id space because a
	 * `remove` id is what the client keys its collection by. A deleted row
	 * leaves no version behind to find (§8), so this is the one thing a query
	 * cannot answer and the advance has to carry.
	 */
	readonly removed: readonly string[];
}

/**
 * The one adapter a concrete source implements (detail, shell, …).
 *
 * Two questions and a policy. The orchestrator builds every envelope from the
 * answers; the source owns only its SQL and its id space.
 */
export interface SubscriptionSource<T, E = never> {
	/**
	 * The rows this subscription serves that moved inside `range`, each with the
	 * version it moved at, and the read-model version the answer is current
	 * through. Omit `range` for a base read; a source may bound that base and
	 * return page information for snapshots. Rows and version must be read
	 * coherently: the version is what the subscriber will resume from.
	 */
	readonly read: (range?: VersionRange) => Effect.Effect<
		{
			readonly rows: readonly VersionedRow<T>[];
			readonly version: number;
			readonly hasMore?: boolean;
			readonly cursor?: string;
			/** Tombstones in a ranged read; a base snapshot represents absence directly. */
			readonly removed?: readonly {
				readonly id: string;
				readonly version: number;
			}[];
		},
		E
	>;
	/** Route one advance. Called for every advance; must not touch the store. */
	readonly route: (advance: ReadModelAdvance) => AdvanceRoute;
	/**
	 * How a resume is served.
	 *
	 * `catchUp` — ranged reads return every surviving changed row and every
	 * removal past the cursor, each at its own version. Sources with deletions
	 * need durable tombstones to provide that history.
	 *
	 * `rebase` — re-read the whole set and send it as a fresh base. Absence is
	 * the removal.
	 */
	readonly resume: "catchUp" | "rebase";
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

const deltaEnvelopes = <T>(
	rows: readonly VersionedRow<T>[],
	removed: readonly { readonly id: string; readonly version: number }[],
): Envelope<T>[] =>
	[
		...removed.map(({ id, version }) => ({
			_tag: "remove" as const,
			id,
			sequence: version,
		})),
		...rows.map(({ item, version }) => ({
			_tag: "upsert" as const,
			item,
			sequence: version,
		})),
	].sort(
		(left, right) =>
			left.sequence - right.sequence ||
			Number(right._tag === "remove") - Number(left._tag === "remove"),
	);

/**
 * Produce one ordered subscription stream from a {@link SubscriptionSource}.
 *
 * - Cold start (`resumeFromSequence` undefined): `snapshot` → `synchronized` →
 *   live upserts and removes.
 * - Resume, `catchUp` source: one delta per row or tombstone past the cursor, in
 *   version order and at its own version → `synchronized` → live. No base
 *   envelope; the client already holds one.
 * - Resume, `rebase` source: a fresh `snapshot` → `synchronized` → live.
 *
 * The advance subscription is acquired BEFORE the base read, so an advance
 * published during that read is buffered rather than lost. It does not need a
 * filter afterwards: the base carries the version it was read at, and an
 * advance at or below it is by definition already accounted for in the base —
 * a row it moved is in the base, and a row it removed is absent from it.
 * A bus overflow replaces the view with another snapshot and synchronized
 * boundary. Lifecycle is the ambient Scope of the running stream.
 */
export const stream = <T, E = never>(options: {
	readonly source: SubscriptionSource<T, E>;
	readonly bus: SessionEventBus;
	readonly resumeFromSequence?: number;
}): Stream.Stream<Envelope<T>, E> =>
	Stream.unwrapScoped(
		Effect.gen(function* () {
			// Buffers from this instant.
			const advances = yield* options.bus.subscribeAdvances();

			const catchUp =
				options.resumeFromSequence !== undefined &&
				options.source.resume === "catchUp";
			const base = yield* options.source.read(
				catchUp ? { after: options.resumeFromSequence } : undefined,
			);
			// The counter the base was read at, not the newest row in it: what the
			// live arm must not re-read, and what a resuming client resumes from.
			const seen = yield* Ref.make(base.version);
			const baseFloor = yield* Ref.make(base.version);

			const opening: Envelope<T>[] = catchUp
				? deltaEnvelopes(base.rows, base.removed ?? [])
				: [
						{
							_tag: "snapshot" as const,
							rows: base.rows.map(({ item }) => item),
							sequence: base.version,
							...(base.hasMore === undefined ? {} : { hasMore: base.hasMore }),
							...(base.cursor === undefined ? {} : { cursor: base.cursor }),
						},
					];
			opening.push({ _tag: "synchronized" as const });

			const live = Stream.mapConcatEffect(
				advances,
				(advance): Effect.Effect<readonly Envelope<T>[], E> =>
					Effect.gen(function* () {
						// A publication gap can hide a deletion, which a range read
						// cannot recover. Replace the entire view before routing again.
						if (advance.dropped) {
							const replacement = yield* options.source.read();
							yield* Ref.set(seen, replacement.version);
							yield* Ref.set(baseFloor, replacement.version);
							return [
								{
									_tag: "snapshot",
									rows: replacement.rows.map(({ item }) => item),
									sequence: replacement.version,
									...(replacement.hasMore === undefined
										? {}
										: { hasMore: replacement.hasMore }),
									...(replacement.cursor === undefined
										? {}
										: { cursor: replacement.cursor }),
								},
								{ _tag: "synchronized" },
							];
						}
						// Already accounted for in a coherent base, removals included.
						if (advance.version <= (yield* Ref.get(baseFloor))) return [];

						const route = options.source.route(advance);
						if (!route.moved && route.removed.length === 0) return [];

						const lastSeen = yield* Ref.get(seen);
						// The commit seam publishes in commit order. A routed advance
						// closes only its own bounded window.
						const sequence = advance.version;
						// A removal also closes this window, so catch up every row before
						// moving the watermark past it.
						const window = yield* options.source.read({
							after: lastSeen,
							through: advance.version,
						});
						yield* Ref.set(seen, sequence);

						// Removals first: within a group the client should drop before it
						// adds, so a delete and a re-create that land together settle on
						// the row that survived.
						return deltaEnvelopes(window.rows, [
							...route.removed.map((id) => ({
								id,
								version: sequence,
							})),
							...(window.removed ?? []),
						]);
					}),
			);

			return Stream.concat(Stream.fromIterable(opening), live);
		}),
	);
