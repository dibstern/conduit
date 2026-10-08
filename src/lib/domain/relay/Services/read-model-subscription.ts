// Read-Model Subscription (Effect)
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
//
// Because every subscriber asks the same question, devices watching the same
// thing ask it with the same window: subscribers of one shareable source share
// its latest window read, and a subscriber that finds several advances queued
// asks once, through the newest routed one. Neither waits for anything but the
// read itself.

import { channel } from "node:diagnostics_channel";
import {
	Chunk,
	Deferred,
	Effect,
	FiberId,
	Ref,
	type Schema,
	Stream,
} from "effect";
import type { ReadModelAdvance } from "../../../contracts/read-model-advance.js";
import type { EnvelopeSchema } from "../../../contracts/ws-rpc.js";
import type { SessionEventBus } from "./session-event-bus.js";

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
	 * Stable name of what `read` asks the store, parameters included
	 * (`session-detail/<id>`). Diagnostics label each read with it.
	 */
	readonly name: string;
	/**
	 * Whether `read` is a pure function of the range and the store, keeping no
	 * per-subscriber state. Subscribers of a source with this name then share
	 * its latest live window read.
	 */
	readonly shareReads?: boolean;
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

/**
 * One source read, published on `conduit:read-model-read` so a test harness can
 * count reads per change (conduit-test-y7eo.1). A shared window is published
 * once, by the subscriber that reads it. Nothing is built or published unless
 * something subscribes.
 */
export interface ReadModelRead {
	/** The source's {@link SubscriptionSource.name}. */
	readonly source: string;
	readonly kind: "base" | "resume" | "replacement" | "window";
	readonly range?: VersionRange;
}

const readModelReads = channel("conduit:read-model-read");

/**
 * The latest live window read per shareable source name, per bus (its version
 * space), kept while any subscriber of that source is. An answer stays valid
 * once read: a row that moves again moves past `through`, into the next window
 * every reader of this one will ask. So it serves everyone asking the same
 * window, or a narrower one ending there, whether they ask during the read or
 * after it, and however their streams are paced.
 */
const latestWindows = new WeakMap<
	SessionEventBus,
	Map<string, { holders: number; latest?: LatestWindow }>
>();

interface LatestWindow {
	readonly after: number;
	readonly through: number;
	readonly read: Effect.Effect<unknown, unknown>;
}

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
			const read = (kind: ReadModelRead["kind"], range?: VersionRange) =>
				Effect.suspend(() => {
					if (readModelReads.hasSubscribers)
						readModelReads.publish({
							source: options.source.name,
							kind,
							...(range === undefined ? {} : { range }),
						} satisfies ReadModelRead);
					return options.source.read(range);
				});
			type SourceRead = Effect.Effect.Success<ReturnType<typeof read>>;
			const name = options.source.name;
			const shared =
				options.source.shareReads === true
					? yield* Effect.acquireRelease(
							Effect.sync(() => {
								const sources =
									latestWindows.get(options.bus) ??
									new Map<string, { holders: number; latest?: LatestWindow }>();
								latestWindows.set(options.bus, sources);
								const entry = sources.get(name) ?? { holders: 0 };
								sources.set(name, entry);
								entry.holders += 1;
								return entry;
							}),
							(entry) =>
								Effect.sync(() => {
									entry.holders -= 1;
									if (entry.holders === 0)
										latestWindows.get(options.bus)?.delete(name);
								}),
						)
					: undefined;
			const readWindow = (
				after: number,
				through: number,
			): Effect.Effect<SourceRead, E> =>
				Effect.suspend(() => {
					if (shared === undefined) return read("window", { after, through });
					const latest = shared.latest;
					if (latest?.through === through && latest.after <= after)
						// Keyed by this source's name, so it holds this source's answer.
						return (latest.read as Effect.Effect<SourceRead, E>).pipe(
							Effect.map((window) => ({
								...window,
								rows: window.rows.filter((row) => row.version > after),
								removed: (window.removed ?? []).filter(
									(row) => row.version > after,
								),
							})),
						);
					const deferred = Deferred.unsafeMake<SourceRead, E>(FiberId.none);
					const window = { after, through, read: Deferred.await(deferred) };
					shared.latest = window;
					// Settles even if this subscriber goes, so no joiner hangs; a
					// failure is not kept for later readers.
					return read("window", { after, through }).pipe(
						Effect.exit,
						Effect.tap((exit) => {
							if (exit._tag === "Failure" && shared.latest === window)
								delete shared.latest;
							return Deferred.done(deferred, exit);
						}),
						Effect.uninterruptible,
						Effect.flatten,
					);
				});

			const catchUp =
				options.resumeFromSequence !== undefined &&
				options.source.resume === "catchUp";
			const base = yield* catchUp
				? read("resume", { after: options.resumeFromSequence })
				: read("base");
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

			// A chunk is every advance already queued, so a burst costs one read.
			const live = Stream.mapChunksEffect(
				advances,
				(chunk): Effect.Effect<Chunk.Chunk<Envelope<T>>, E> =>
					Effect.gen(function* () {
						// A publication gap can hide a deletion, which a range read
						// cannot recover. Replace the entire view; read after every
						// advance in the chunk was published, it covers them all.
						if (Chunk.some(chunk, (advance) => advance.dropped === true)) {
							const replacement = yield* read("replacement");
							yield* Ref.set(seen, replacement.version);
							yield* Ref.set(baseFloor, replacement.version);
							return Chunk.unsafeFromArray<Envelope<T>>([
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
							]);
						}
						const floor = yield* Ref.get(baseFloor);
						// The commit seam publishes in commit order. The chunk's window
						// closes at its newest routed advance. An unrouted advance moved
						// nothing served here, so the window may open past it, which keeps
						// it the same for every subscriber of the source.
						let after = yield* Ref.get(seen);
						let last = after;
						let through: number | undefined;
						const removed: { id: string; version: number }[] = [];
						for (const advance of chunk) {
							// Already accounted for in a coherent base, removals included.
							if (advance.version <= floor) continue;
							last = advance.version;
							const route = options.source.route(advance);
							if (route.moved || route.removed.length > 0) {
								through = advance.version;
								for (const id of route.removed)
									removed.push({ id, version: advance.version });
							} else if (through === undefined) after = advance.version;
						}
						yield* Ref.set(seen, last);
						if (through === undefined) return Chunk.empty();

						// A removal also closes the window, so catch up every row before
						// moving the watermark past it. Removals sort first within a
						// version: the client should drop before it adds, so a delete
						// and a re-create that land together settle on the survivor.
						const window = yield* readWindow(after, through);
						return Chunk.unsafeFromArray(
							deltaEnvelopes(window.rows, [
								...removed,
								...(window.removed ?? []),
							]),
						);
					}),
			);

			return Stream.concat(Stream.fromIterable(opening), live);
		}),
	);
