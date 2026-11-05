// 82tn.51: a head move lands at once. Rows leaving the Head are kept off it with their parts,
// rows joining come back whole at a new version, and replaying the move changes nothing.
// Failure modes P1-P8 are listed in the lane audit before this test was written.
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const S = "moves";

const created = (messageId: string, role: "user" | "assistant", at: number) =>
	canonicalEvent(
		"message.created",
		S,
		{ messageId, sessionId: S, role },
		{ createdAt: at },
	);
const text = (messageId: string) =>
	canonicalEvent("text.delta", S, {
		messageId,
		partId: `${messageId}-p`,
		text: `text of ${messageId}`,
	});
const moved = (moveId: string, to: string | null) =>
	canonicalEvent("head.moved", S, { moveId, to });

it("moves rows off and back onto the Head, once", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const reads = yield* ReadQueryEffectTag;
			const sql = yield* SqlClient.SqlClient;
			const seal = (node: string, parent: string | null, rows: string[]) =>
				Effect.gen(function* () {
					yield* sql`INSERT INTO history_nodes (session_id, id, parent_id, run_id, available, created_at)
						VALUES (${S}, ${node}, ${parent}, ${node}, 1, 0)`;
					yield* sql`UPDATE messages SET history_node_id = ${node} WHERE id IN ${sql.in(rows)}`;
					yield* sql`INSERT INTO history_heads (session_id, node_id) VALUES (${S}, ${node})
						ON CONFLICT (session_id) DO UPDATE SET node_id = excluded.node_id`;
				});
			const ids = Effect.map(reads.getSessionMessagesWithParts(S), (rows) =>
				rows.map(({ id }) => id),
			);
			const head = Effect.map(
				sql<{
					node_id: string | null;
				}>`SELECT node_id FROM history_heads WHERE session_id = ${S}`,
				([row]) => row?.node_id,
			);
			const kept = Effect.map(
				sql<{ row_key: string }>`SELECT row_key FROM history_off_head
					WHERE session_id = ${S} ORDER BY row_key`,
				(rows) => rows.map(({ row_key }) => row_key),
			);

			yield* commit([
				canonicalEvent("session.created", S, {
					sessionId: S,
					title: "Moves",
					provider: "claude",
				}),
				created("m1", "user", 10),
				text("m1"),
				created("m2", "assistant", 20),
				text("m2"),
				created("m3", "user", 30),
				text("m3"),
				created("m4", "assistant", 40),
				text("m4"),
			]);
			yield* seal("n1", null, ["m1", "m2"]);
			yield* seal("n2", "n1", ["m3", "m4"]);

			// P1, P2, P3, P5: rewind before m3.
			const beforeRewind = (yield* reads.readSessionTranscript(S)).version;
			yield* commit([moved("rewind", "n1")]);
			expect(yield* ids).toEqual(["m1", "m2"]);
			expect(yield* head).toBe("n1");
			expect(yield* kept).toEqual(["m3", "m3", "m3-p", "m4", "m4-p"]);
			const rewound = yield* reads.readSessionTranscript(S, {
				after: beforeRewind,
			});
			expect(rewound.removed?.map(({ id }) => id).sort()).toEqual(["m3", "m4"]);

			// A new branch from n1.
			yield* commit([created("m5", "user", 50), text("m5")]);
			yield* seal("n3", "n1", ["m5"]);

			// P4, P5: switch to the first branch.
			const beforeSwitch = (yield* reads.readSessionTranscript(S)).version;
			yield* commit([moved("switch", "n2")]);
			expect(yield* ids).toEqual(["m1", "m2", "m3", "m4"]);
			expect(yield* head).toBe("n2");
			expect(yield* kept).toEqual(["m5", "m5", "m5-p"]);
			const switched = yield* reads.readSessionTranscript(S, {
				after: beforeSwitch,
			});
			expect(switched.messages.map(({ id }) => id)).toEqual(["m3", "m4"]);
			expect(
				switched.messages.map(({ parts }) => parts.map(({ id }) => id)),
			).toEqual([["m3-p"], ["m4-p"]]);
			expect(switched.removed?.map(({ id }) => id)).toEqual(["m5"]);

			// P6: a replayed move is a no-op.
			const afterSwitch = (yield* reads.readSessionTranscript(S)).version;
			yield* commit([moved("switch", "n2")]);
			const replay = yield* reads.readSessionTranscript(S, {
				after: afterSwitch,
			});
			expect(replay.messages).toEqual([]);
			expect(replay.removed ?? []).toEqual([]);

			// P7, P8: an old log's move and a confirmation leave the Head alone.
			yield* commit([
				canonicalEvent("head.moved", S, { moveId: "old" }),
				canonicalEvent("session.rewind_committed", S, {
					messageId: "m3",
					moveId: "switch",
				}),
			]);
			expect(yield* ids).toEqual(["m1", "m2", "m3", "m4"]);

			// To the root: everything leaves.
			yield* commit([moved("root", null)]);
			expect(yield* ids).toEqual([]);
			expect(yield* head).toBeNull();
		}).pipe(Effect.provide(makePersistenceEffectLayer(":memory:", "moves"))),
	);
});
