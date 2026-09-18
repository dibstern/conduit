import { Stream } from "effect";
import type {
	HistoryMessageSchema,
	SessionDetailEnvelope,
} from "../../../contracts/ws-rpc.js";
import type { Envelope } from "./read-model-subscription.js";
import type { SessionDetailItem } from "./session-detail-subscription.js";

export const encodeSessionDetail = <E, R>(
	input: Stream.Stream<Envelope<SessionDetailItem>, E, R>,
): Stream.Stream<SessionDetailEnvelope, E, R> =>
	Stream.suspend(() => {
		// Owned by this execution, not by the socket or the reusable stream value.
		const sent = new Map<string, typeof HistoryMessageSchema.Type>();
		let live = false;
		return input.pipe(
			Stream.map((envelope): SessionDetailEnvelope => {
				if (envelope._tag === "snapshot") {
					sent.clear();
					live = false;
					for (const row of envelope.rows) {
						if (row._tag === "transcriptMessage")
							sent.set(row.message.id, row.message);
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
				sent.set(message.id, message);
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
													previous.parts?.find((old) => old.id === part.id)
														?.text,
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
