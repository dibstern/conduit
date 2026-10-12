// Reconciliation can move the cut past an unchanged row. Snapshots, pages and
// live deltas must agree on the current ordering, and undo must restore it all.
import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

it("derives pending rewind visibility after REST timestamps move the cut", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const reads = yield* ReadQueryEffectTag;
			yield* commit([
				canonicalEvent("session.created", "rewind", {
					sessionId: "rewind",
					title: "Reconciliation",
					provider: "opencode",
				}),
				...([10, 20, 30, 40] as const).map((createdAt, index) =>
					canonicalEvent(
						"message.created",
						"rewind",
						{
							messageId: `m${index + 1}`,
							sessionId: "rewind",
							role: index % 2 === 0 ? "user" : "assistant",
						},
						{ createdAt },
					),
				),
			]);
			yield* commit([
				canonicalEvent("session.rewound", "rewind", {
					messageId: "m2",
				}),
			]);
			const snapshot = (messageId: string, createdAt: number) =>
				canonicalEvent("message.snapshot", "rewind", {
					messageId,
					digest: `${messageId}-${createdAt}`,
					message: {
						id: messageId,
						sessionID: "rewind",
						role:
							messageId === "m1" || messageId === "m3" ? "user" : "assistant",
						time: { created: createdAt },
						parts: [],
					},
				});
			// REST arrives one row at a time: the kept row is temporarily after
			// the streamed cut, then the cut and later rows get their real clocks.
			yield* commit([snapshot("m1", 110)]);
			const beforeCutMoves = (yield* reads.readSessionTranscript("rewind"))
				.version;
			yield* commit([
				snapshot("m2", 120),
				snapshot("m3", 130),
				snapshot("m4", 140),
			]);
			expect(
				(yield* reads.getSessionMessagesWithParts("rewind")).map(
					({ id }) => id,
				),
			).toEqual(["m1"]);
			expect(
				(yield* reads.getSessionHistoryMetadata("rewind")).messageCount,
			).toBe(1);
			expect(
				(yield* reads.readSessionTranscriptPage("rewind", {
					limit: 10,
				})).messages.map(({ id }) => id),
			).toEqual(["m1"]);
			const delta = yield* reads.readSessionTranscript("rewind", {
				after: beforeCutMoves,
			});
			expect(delta.messages.map(({ id }) => id)).toEqual(["m1"]);
			expect(delta.removed?.map(({ id }) => id)).toEqual(["m2", "m3", "m4"]);
			expect(
				(yield* reads.getSession("rewind"))?.pending_rewind_message_id,
			).toBe("m2");
			yield* commit([canonicalEvent("session.rewind_undone", "rewind", {})]);
			expect(
				(yield* reads.readSessionTranscript("rewind", {
					after: delta.version,
				})).messages.map(({ id }) => id),
			).toEqual(["m1", "m2", "m3", "m4"]);
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(":memory:", "rewind-project")),
		),
	);
});
