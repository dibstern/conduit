import { Data, Effect, Option, Schema, Stream } from "effect";
import {
	PartRemovalId,
	type SessionDetailEnvelope,
} from "../../contracts/ws-rpc.js";

export class DetailLengthMismatch extends Data.TaggedError(
	"DetailLengthMismatch",
)<{
	readonly messageId: string;
}> {}

export const decodeSessionDetail = <E, R>(
	input: Stream.Stream<SessionDetailEnvelope, E, R>,
): Stream.Stream<SessionDetailEnvelope, E | DetailLengthMismatch, R> =>
	Stream.suspend(() => {
		// Part id → its whole text as last received, and the message that holds it.
		const received = new Map<string, { messageId: string; text: string }>();
		const remember = (messageId: string, partId: string, text?: string) => {
			if (text === undefined) received.delete(partId);
			else received.set(partId, { messageId, text });
		};
		return input.pipe(
			Stream.mapEffect((envelope) =>
				Effect.gen(function* () {
					switch (envelope._tag) {
						case "snapshot":
							received.clear();
							for (const row of envelope.rows)
								if (row._tag === "part")
									remember(row.messageId, row.part.id, row.part.text);
							return envelope;
						case "synchronized":
							return envelope;
						case "remove":
							Option.match(
								Schema.decodeUnknownOption(PartRemovalId)(envelope.id),
								{
									onSome: ([, partId]) => received.delete(partId),
									onNone: () => {
										for (const [partId, { messageId }] of received)
											if (messageId === envelope.id) received.delete(partId);
									},
								},
							);
							return envelope;
						case "upsert": {
							const { textSuffix, ...whole } = envelope;
							const item = envelope.item;
							if (item._tag !== "part") return whole;
							if (textSuffix === undefined) {
								remember(item.messageId, item.part.id, item.part.text);
								return whole;
							}
							const before = received.get(item.part.id)?.text;
							const suffix = item.part.text;
							if (
								before === undefined ||
								suffix === undefined ||
								before.length !== textSuffix.from ||
								before.length + suffix.length !== textSuffix.total
							)
								return yield* new DetailLengthMismatch({
									messageId: item.messageId,
								});
							const text = before + suffix;
							// Publish only once the lengths agree: no partial part reaches a store.
							remember(item.messageId, item.part.id, text);
							return {
								...whole,
								item: { ...item, part: { ...item.part, text } },
							};
						}
					}
				}),
			),
		);
	});
