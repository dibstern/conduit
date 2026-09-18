import { Stream } from "effect";
import type {
	HistoryMessageSchema,
	SessionDetailEnvelope,
} from "../../../contracts/ws-rpc.js";
import type { Envelope } from "./read-model-subscription.js";
import type { SessionDetailItem } from "./session-detail-subscription.js";

// Usually only the tip grows; eight slots keep it plus seven nearby interleaved
// messages warm. A cache miss safely sends the whole authoritative row, which the
// decoder accepts as a replacement, so eviction only costs compression.
const SENT_MESSAGE_LIMIT = 8;

export const encodeSessionDetail = <E, R>(
	input: Stream.Stream<Envelope<SessionDetailItem>, E, R>,
): Stream.Stream<SessionDetailEnvelope, E, R> =>
	Stream.suspend(() => {
		// Owned by this execution, not by the socket or the reusable stream value.
		const sent = new Map<
			string,
			{
				text: string | undefined;
				parts: Map<string, string | null>;
			}
		>();
		const remember = (message: typeof HistoryMessageSchema.Type) => {
			const parts = new Map<string, string | null>();
			for (const part of message.parts ?? []) {
				if (part.text !== undefined)
					// null refers to message text without retaining a second equal string.
					parts.set(part.id, part.text === message.text ? null : part.text);
			}
			sent.delete(message.id);
			sent.set(message.id, { text: message.text, parts });
			if (sent.size > SENT_MESSAGE_LIMIT) {
				const oldest = sent.keys().next();
				if (!oldest.done) sent.delete(oldest.value);
			}
		};
		let live = false;
		return input.pipe(
			Stream.map((envelope): SessionDetailEnvelope => {
				if (envelope._tag === "snapshot") {
					sent.clear();
					live = false;
					for (const row of envelope.rows) {
						if (row._tag === "transcriptMessage") remember(row.message);
					}
					return envelope;
				}
				if (envelope._tag === "synchronized") {
					live = true;
					return envelope;
				}
				if (envelope._tag === "remove") {
					sent.delete(envelope.id);
					return envelope;
				}
				if (envelope.item._tag !== "transcriptMessage") return envelope;
				const message = envelope.item.message;
				const previous = sent.get(message.id);
				remember(message);
				// Replay stays full, ordered and batched. A new subscription never borrows
				// another execution's sent state, including when it resumes from a cursor.
				if (!live || !previous) return envelope;
				const textSuffixes: { partId?: string; from: number; total: number }[] =
					[];
				let rewritten = false;
				const suffix = (
					text: string,
					before: unknown,
					partId?: string,
				): string => {
					if (typeof before !== "string") return text;
					if (!text.startsWith(before)) {
						rewritten = true;
						return text;
					}
					textSuffixes.push({
						...(partId === undefined ? {} : { partId }),
						from: before.length,
						total: text.length,
					});
					return text.slice(before.length);
				};
				const encoded = {
					...message,
					...(typeof message.text === "string"
						? { text: suffix(message.text, previous.text) }
						: {}),
					...(message.parts === undefined
						? {}
						: {
								parts: message.parts.map((part) => ({
									...part,
									...(part.text === undefined
										? {}
										: {
												text: suffix(
													part.text,
													previous.parts.get(part.id) === null
														? previous.text
														: previous.parts.get(part.id),
													part.id,
												),
											}),
								})),
							}),
				};
				if (rewritten || textSuffixes.length === 0) return envelope;
				return {
					...envelope,
					item: { _tag: "transcriptMessage", message: encoded },
					textSuffixes,
				};
			}),
		);
	});
