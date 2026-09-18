import { Data, Effect, Stream } from "effect";
import type {
	HistoryMessageSchema,
	SessionDetailEnvelope,
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
		const received = new Map<string, typeof HistoryMessageSchema.Type>();
		return input.pipe(
			Stream.mapEffect((envelope) =>
				Effect.gen(function* () {
					if (envelope._tag === "snapshot") {
						received.clear();
						for (const row of envelope.rows) {
							if (row._tag === "transcriptMessage")
								received.set(row.message.id, row.message);
						}
						return envelope;
					}
					if (envelope._tag === "remove") {
						received.delete(envelope.id);
						return envelope;
					}
					if (
						envelope._tag !== "upsert" ||
						envelope.item._tag !== "transcriptMessage"
					)
						return envelope;
					const { textSuffixes, ...whole } = envelope;
					const message = envelope.item.message;
					if (textSuffixes === undefined) {
						received.set(message.id, message);
						return whole;
					}
					const previous = received.get(message.id);
					let decoded = message;
					for (const field of textSuffixes) {
						const before =
							field.partId === undefined
								? previous?.text
								: previous?.parts?.find((part) => part.id === field.partId)
										?.text;
						const partIndex =
							decoded.parts?.findIndex((part) => part.id === field.partId) ??
							-1;
						const part = decoded.parts?.[partIndex];
						const suffix =
							field.partId === undefined ? message.text : part?.text;
						if (
							typeof before !== "string" ||
							typeof suffix !== "string" ||
							before.length !== field.from ||
							before.length + suffix.length !== field.total
						) {
							return yield* new DetailLengthMismatch({ messageId: message.id });
						}
						const text = before + suffix;
						if (field.partId === undefined) decoded = { ...decoded, text };
						else if (decoded.parts && part)
							decoded = {
								...decoded,
								parts: decoded.parts.map((entry, index) =>
									index === partIndex ? { ...part, text } : entry,
								),
							};
					}
					// Publish only after every field agrees. No partial message reaches a store.
					received.set(message.id, decoded);
					return {
						...whole,
						item: { _tag: "transcriptMessage" as const, message: decoded },
					};
				}),
			),
		);
	});
