// ─── The applier ─────────────────────────────────────────────────────────────
// `reduce` is the one place a subscription's map changes. It is a pure function
// over the envelope union, so these tests are just values in and values out —
// no store, no Svelte, no socket. That purity is what lets ni8.5 T-14 drive
// both delivery paths through it and compare final states.
//
// The load-bearing claims:
//   • a change already covered by what we hold is dropped, and dropped HERE;
//   • coverage above the floor stays per row until synchronized;
//   • an unversioned change — the legacy delta arm, which has no sequences —
//     always applies, and never moves a version.

import { describe, expect, it } from "vitest";
import {
	type Change,
	emptySubscription,
	reduce,
	type SubscriptionState,
} from "../../../../src/lib/frontend/transport/subscription-state.js";

interface Row {
	readonly id: string;
	readonly title: string;
}

const identify = (row: Row): string => row.id;

const row = (id: string, title = id): Row => ({ id, title });

const empty = emptySubscription<Row>();

/** Fold a run of changes, the way the dispatch layer does. */
const apply = (
	state: SubscriptionState<Row>,
	...changes: readonly Change<Row>[]
): SubscriptionState<Row> =>
	changes.reduce((acc, change) => reduce(acc, change, identify), state);

const titles = (state: SubscriptionState<Row>): Record<string, string> =>
	Object.fromEntries([...state.rows].map(([id, r]) => [id, r.title]));

describe("reduce", () => {
	it("documents unbounded retention during 1,000 uninterrupted live removals", () => {
		// Shell opening: read-model-subscription.ts:156-164. Then consume each
		// live removal (211-216) before publishing the next. No overflow,
		// reconnect, replacement snapshot, or additional completion marker.
		// 1,000 is enough: the per-iteration assertion pins one retained entry per
		// removal. A larger N only buys quadratic map copying, which timed the unit
		// suite out at 10,000.
		let state = apply(
			empty,
			{
				_tag: "snapshot",
				rows: Array.from({ length: 1_000 }, (_, i) => row(`s${i + 1}`)),
				sequence: 1_000,
			},
			{ _tag: "synchronized" },
		);
		const initial = state;
		for (let i = 1; i <= 1_000; i++) {
			state = apply(state, {
				_tag: "remove",
				id: `s${i}`,
				sequence: 1_000 + i,
			});
			expect(state.versions.size).toBe(i);
		}
		// P2 remains unresolved: this records the defect, not an acceptable bound.
		expect(state.rows.size).toBe(0);
		expect(state.versions.size).toBe(1_000);
		expect(state.floor).toBe(1_000);
		expect(initial.rows.size).toBe(1_000);
		expect(initial.versions.size).toBe(0);
	});

	it("reclaims metadata on a shell reconnect snapshot", () => {
		// shell-subscription.ts:69 selects the snapshot opening on reconnect.
		const before = apply(
			empty,
			{ _tag: "snapshot", rows: [row("a"), row("b")], sequence: 5 },
			{ _tag: "synchronized" },
			{ _tag: "remove", id: "a", sequence: 6 },
			{ _tag: "remove", id: "b", sequence: 7 },
		);
		const state = apply(
			before,
			{ _tag: "snapshot", rows: [], sequence: 7 },
			{ _tag: "synchronized" },
		);
		expect(state.rows.size).toBe(0);
		expect(state.versions.size).toBe(0);
		expect(state.floor).toBe(7);
		expect(before.versions.size).toBe(2);
	});

	it("partitions 5,040 permutations by commit order and reconnect snapshot boundaries", () => {
		const history: readonly Change<Row>[] = [
			{ _tag: "upsert", item: row("a", "a1"), sequence: 1 },
			{ _tag: "upsert", item: row("b", "b2"), sequence: 2 },
			{ _tag: "snapshot", rows: [row("a", "a1"), row("b", "b2")], sequence: 2 },
			{ _tag: "upsert", item: row("a", "a3"), sequence: 3 },
			{ _tag: "remove", id: "b", sequence: 4 },
			{ _tag: "snapshot", rows: [row("a", "a3")], sequence: 4 },
			{ _tag: "upsert", item: row("c", "c5"), sequence: 5 },
		];
		let producible = 0;
		let impossible = 0;
		// This fixture starts from snapshot@0. Its two later snapshots are
		// reconnect rebases. A live change cannot follow a base at the same
		// sequence, since the base already covers it. Replay overlaps are
		// exercised separately below, with explicit connection boundaries.
		const canDeliver = (events: readonly Change<Row>[]): boolean => {
			let previous = 0;
			let base = 0;
			for (const event of events) {
				if (event._tag === "synchronized" || event.sequence === undefined)
					return false;
				if (event.sequence < previous) return false;
				if (event._tag === "snapshot") base = event.sequence;
				else if (event.sequence <= base) return false;
				previous = event.sequence;
			}
			return true;
		};
		const visit = (
			prefix: readonly Change<Row>[],
			remaining: readonly Change<Row>[],
		): void => {
			if (remaining.length === 0) {
				if (!canDeliver(prefix)) {
					impossible++;
					return;
				}
				producible++;
				// Markers close each snapshot immediately, not arbitrary partial
				// deliveries. Shell reconnects require a replacement snapshot.
				let state = apply(
					empty,
					{ _tag: "snapshot", rows: [], sequence: 0 },
					{ _tag: "synchronized" },
				);
				for (const event of prefix) {
					state = apply(state, event);
					if (event._tag === "snapshot")
						state = apply(state, { _tag: "synchronized" });
				}
				expect(titles(state)).toEqual({ a: "a3", c: "c5" });
				expect(state.floor).toBe(4);
				expect(state.settled).toBe(true);
				return;
			}
			remaining.forEach((change, index) => {
				visit(
					[...prefix, change],
					remaining.filter((_, i) => i !== index),
				);
			});
		};
		visit([], history);
		expect({ producible, impossible }).toEqual({
			producible: 1,
			impossible: 5_039,
		});
	});

	it("accepts equal-sequence live siblings without a completion marker", () => {
		// One commit removes a and changes b. The live arm sorts removals first
		// on equal versions (read-model-subscription.ts:208-229), with no marker.
		const state = apply(
			empty,
			{ _tag: "snapshot", rows: [row("a")], sequence: 5 },
			{ _tag: "synchronized" },
			{ _tag: "remove", id: "a", sequence: 7 },
			{ _tag: "upsert", item: row("b"), sequence: 7 },
		);
		expect(titles(state)).toEqual({ b: "b" });
		expect([...state.versions]).toEqual([
			["a", 7],
			["b", 7],
		]);
		expect(state.floor).toBe(5);
	});

	it("fills an interrupted shell group from a same-sequence rebase", () => {
		// Shell snapshot opening after a disconnect mid-group; the read-model
		// counter need not advance between the last live item and the rebase.
		const state = apply(
			empty,
			{ _tag: "snapshot", rows: [], sequence: 5 },
			{ _tag: "synchronized" },
			{ _tag: "upsert", item: row("a"), sequence: 7 },
			{ _tag: "snapshot", rows: [row("a"), row("b")], sequence: 7 },
			{ _tag: "synchronized" },
		);
		expect(titles(state)).toEqual({ a: "a", b: "b" });
		expect(state.floor).toBe(7);
		expect(state.versions.size).toBe(0);
	});

	it("fills a detail sibling on catch-up without a replacement snapshot", () => {
		// session-detail-subscription.ts:96 uses catchUp. After a drops mid-group,
		// read-model-subscription.ts:145-164 replays a,b@7. resume.ts:189-199
		// suppresses a; the consumer receives b followed by the server marker.
		const before = apply(
			empty,
			{ _tag: "snapshot", rows: [], sequence: 5 },
			{ _tag: "synchronized" },
			{ _tag: "upsert", item: row("a"), sequence: 7 },
		);
		const state = apply(
			before,
			{ _tag: "upsert", item: row("b"), sequence: 7 },
			{ _tag: "synchronized" },
		);
		expect(titles(state)).toEqual({ a: "a", b: "b" });
		expect(state.floor).toBe(7);
		// A second detail reconnect from closed cursor 7 has an empty catch-up.
		expect(apply(state, { _tag: "synchronized" })).toBe(state);
		expect(before.floor).toBe(5);
	});

	it("is pure: the state handed in is not touched", () => {
		const before = apply(empty, {
			_tag: "snapshot",
			rows: [row("a"), row("b")],
			sequence: 5,
		});
		const captured = {
			rows: new Map([...before.rows].map(([id, item]) => [id, { ...item }])),
			versions: new Map(before.versions),
			floor: before.floor,
			settled: before.settled,
		};

		apply(
			before,
			{ _tag: "synchronized" },
			{ _tag: "upsert", item: row("a", "renamed"), sequence: 6 },
			{ _tag: "remove", id: "b", sequence: 7 },
		);

		expect(before).toEqual(captured);
		const snapshotted = apply(before, {
			_tag: "snapshot",
			rows: [row("a", "snapshot"), row("b", "snapshot")],
			sequence: 6,
		});
		expect(snapshotted).toEqual({
			rows: new Map([
				["a", row("a", "snapshot")],
				["b", row("b", "snapshot")],
			]),
			versions: new Map(),
			floor: 6,
			settled: false,
		});
		expect(before).toEqual(captured);
	});

	it("takes the snapshot as the whole membership", () => {
		const state = apply(
			empty,
			{ _tag: "snapshot", rows: [], sequence: 0 },
			{ _tag: "synchronized" },
			{ _tag: "upsert", item: row("stale"), sequence: 1 },
			{ _tag: "snapshot", rows: [row("a"), row("b")], sequence: 5 },
			{ _tag: "synchronized" },
		);

		expect(titles(state)).toEqual({ a: "a", b: "b" });
	});

	it("applies an upsert and a remove", () => {
		const state = apply(
			empty,
			{ _tag: "snapshot", rows: [], sequence: 0 },
			{ _tag: "synchronized" },
			{ _tag: "upsert", item: row("a"), sequence: 1 },
			{ _tag: "upsert", item: row("b"), sequence: 2 },
			{ _tag: "upsert", item: row("a", "renamed"), sequence: 3 },
			{ _tag: "remove", id: "b", sequence: 4 },
		);

		expect(titles(state)).toEqual({ a: "renamed" });
	});

	it("settles on synchronized, and settling twice changes nothing", () => {
		// Empty detail catch-up from cursor 0 can produce each marker.
		const once = apply(
			empty,
			{ _tag: "snapshot", rows: [], sequence: 0 },
			{ _tag: "synchronized" },
		);
		expect(once.settled).toBe(true);
		expect(reduce(once, { _tag: "synchronized" }, identify)).toBe(once);
	});

	it("lets a later upsert bring a removed row back", () => {
		const state = apply(
			empty,
			{ _tag: "snapshot", rows: [row("a")], sequence: 19 },
			{ _tag: "synchronized" },
			{ _tag: "remove", id: "a", sequence: 20 },
			{ _tag: "upsert", item: row("a", "recreated"), sequence: 25 },
		);

		expect(titles(state)).toEqual({ a: "recreated" });
	});

	describe("the legacy delta arm, which has no sequences", () => {
		it("always applies", () => {
			const state = apply(
				empty,
				{ _tag: "upsert", item: row("a", "first") },
				{ _tag: "upsert", item: row("a", "second") },
				{ _tag: "upsert", item: row("b") },
				{ _tag: "remove", id: "b" },
			);

			expect(titles(state)).toEqual({ a: "second" });
		});

		it("does not invent coverage when an unversioned snapshot replaces membership", () => {
			// Raw WebSocket list and delta writers in session.svelte.ts:268-284.
			const state = apply(
				empty,
				{ _tag: "upsert", item: row("gone") },
				{ _tag: "snapshot", rows: [row("a")] },
				{ _tag: "upsert", item: row("b") },
			);
			expect(titles(state)).toEqual({ a: "a", b: "b" });
			expect(state.floor).toBeUndefined();
			expect(state.versions.size).toBe(0);
		});
	});
});
