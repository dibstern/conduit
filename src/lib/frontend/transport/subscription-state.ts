// ─── The applier ─────────────────────────────────────────────────────────────
// One subscription's authoritative map, and the pure function that moves it.
// Everything a subscription can say about the read model lands here, and the
// stores read the result. That is why envelope vocabulary — snapshot, upsert,
// remove, synchronized, sequence — stops at this module: past it there is a map
// of rows and a flag saying whether the server has told us we hold everything.
//
// Deliberately free of Svelte and of Effect. `reduce` is values in, values out,
// so ni8.5 T-14's harness can drive both delivery paths through it and compare
// final states, and so these semantics are testable without a socket or a store.
//
// **Where dedup lives.** Here, and nowhere else in the client's state path.
// The transport's resume (`resume.ts`) already promises the consumer one
// uninterrupted stream: it suppresses the members of the open group that a
// replay re-delivers. What it deliberately does NOT suppress is a change at a
// sequence BELOW the cursor — a coalesced replay re-derives current state, so a
// row we never saw can legitimately arrive there, and dropping it at the
// transport would lose it. Deciding whether a change is already covered needs
// the map, so it happens against the map.
//
// **Before synchronized, coverage above the floor is per row.** A replay
// comes back ascending from the resume point, so after reconnect row C at 11
// can follow row B at 12 held from the old connection. A global mark would drop C. What is
// true instead is narrower and sufficient: a row never goes backwards, so a
// change at or below the sequence we last applied FOR THAT ROW is already in
// it. `remove` records its sequence the same way, which is what stops a
// replayed upsert resurrecting a row the server has since deleted.
//
// **Snapshots and completed replays establish global coverage.** A snapshot
// is read in one transaction, so every change at or below its sequence is in its
// rows. Per-row records at or below that bound can be discarded, including
// tombstones. Records newer than a delayed snapshot must survive it.
// Commit-ordered delivery (ni8.5.13) makes synchronized another safe boundary:
// replay has filled any gaps through the highest version already held. Only
// then can that version become the floor and replace the retained tombstones.

/**
 * What a subscription has told us so far.
 *
 * Replaced whole on every change, never mutated: the dispatch layer reassigns
 * it, which is what makes a reactive read of `rows` fire.
 */
export interface SubscriptionState<T> {
	/** The rows, by id. This is the authoritative copy; stores are views of it. */
	readonly rows: ReadonlyMap<string, T>;
	/** The sequence each id was last changed at, removed ids included. */
	readonly versions: ReadonlyMap<string, number>;
	/** Coverage from a snapshot or completed replay; at or below it is covered. */
	readonly floor: number | undefined;
	/** True once the server has said we hold everything. Only a reset clears it:
	 *  a dropped socket resumes into the same stream, and resume ends in the
	 *  server's own "you are caught up" again. */
	readonly settled: boolean;
}

/**
 * One thing a subscription can say, or the same thing said without a sequence.
 *
 * The sequence is optional for exactly one caller: the legacy WebSocket delta
 * arm, which announces the same changes and has no sequences to announce them
 * with. Its changes are this tab's own and are never replayed, so there is
 * nothing to dedup and they always apply. **conduit-test-ni8.5.20 retires that
 * arm, and takes the optionality with it** — after which this union is the wire
 * envelope union exactly.
 */
export type Change<T> =
	| {
			readonly _tag: "snapshot";
			readonly rows: readonly T[];
			readonly sequence?: number;
	  }
	| { readonly _tag: "synchronized" }
	| { readonly _tag: "upsert"; readonly item: T; readonly sequence?: number }
	| {
			readonly _tag: "remove";
			readonly id: string;
			readonly sequence?: number;
	  };

/** A subscription that has been told nothing yet. */
export const emptySubscription = <T>(): SubscriptionState<T> => ({
	rows: new Map(),
	versions: new Map(),
	floor: undefined,
	settled: false,
});

/** Whether the map already reflects this change. Unversioned changes never do. */
const covered = <T>(
	state: SubscriptionState<T>,
	id: string,
	sequence: number | undefined,
): boolean => {
	if (sequence === undefined) return false;
	if (state.floor !== undefined && sequence <= state.floor) return true;
	const applied = state.versions.get(id);
	return applied !== undefined && sequence <= applied;
};

const versionsWith = <T>(
	state: SubscriptionState<T>,
	id: string,
	sequence: number | undefined,
): ReadonlyMap<string, number> =>
	sequence === undefined
		? state.versions
		: new Map(state.versions).set(id, sequence);

/**
 * Fold one change into a subscription's map.
 *
 * `identify` names a row, because the wire does not agree on where the name
 * lives: a session row carries `id`, a transcript item carries it on the
 * message or event it wraps.
 */
export const reduce = <T>(
	state: SubscriptionState<T>,
	change: Change<T>,
	identify: (item: T) => string,
): SubscriptionState<T> => {
	switch (change._tag) {
		case "synchronized": {
			let floor = state.floor;
			const versions = new Map<string, number>();
			for (const [id, version] of state.versions) {
				floor = floor === undefined ? version : Math.max(floor, version);
				if (state.rows.has(id)) versions.set(id, version);
			}
			if (
				state.settled &&
				floor === state.floor &&
				versions.size === state.versions.size
			)
				return state;
			return { ...state, versions, floor, settled: true };
		}

		case "snapshot": {
			const sequence = change.sequence;
			if (
				sequence !== undefined &&
				state.floor !== undefined &&
				sequence <= state.floor
			)
				return state;
			const rows = new Map(change.rows.map((item) => [identify(item), item]));
			// An unversioned snapshot is the legacy arm's full session list. It
			// replaces membership, but it says nothing about the wire's timeline, so
			// it must not start covering wire changes.
			if (sequence === undefined) return { ...state, rows };
			// A delayed snapshot covers only its own sequence. Keep newer live
			// rows and tombstones, while replacing everything the snapshot covers.
			const versions = new Map<string, number>();
			for (const [id, version] of state.versions) {
				if (version <= sequence) continue;
				versions.set(id, version);
				if (state.rows.has(id)) {
					const item = state.rows.get(id);
					if (item !== undefined) rows.set(id, item);
				} else rows.delete(id);
			}
			return { rows, versions, floor: sequence, settled: state.settled };
		}

		case "upsert": {
			const id = identify(change.item);
			if (covered(state, id, change.sequence)) return state;
			return {
				...state,
				rows: new Map(state.rows).set(id, change.item),
				versions: versionsWith(state, id, change.sequence),
			};
		}

		case "remove": {
			if (covered(state, change.id, change.sequence)) return state;
			const rows = new Map(state.rows);
			rows.delete(change.id);
			return {
				...state,
				rows,
				versions: versionsWith(state, change.id, change.sequence),
			};
		}
	}
};
