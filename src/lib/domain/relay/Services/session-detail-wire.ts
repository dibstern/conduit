import { Option, Schema, Stream } from "effect";
import {
	PartRemovalId,
	SENT_PART_LIMIT,
	type SessionDetailEnvelope,
} from "../../../contracts/ws-rpc.js";
import type { SessionDetailItem } from "./session-detail-subscription.js";

export const encodeSessionDetail = <E, R>(
	input: Stream.Stream<SessionDetailEnvelope, E, R>,
): Stream.Stream<SessionDetailEnvelope, E, R> =>
	Stream.suspend(() => {
		// Owned by this execution, not by the socket or the reusable stream value.
		// Part id → the text last sent for it, and the message that holds it.
		const sent = new Map<string, { messageId: string; text: string }>();
		const remember = ({
			messageId,
			part,
		}: Extract<SessionDetailItem, { _tag: "part" }>) => {
			sent.delete(part.id);
			if (part.text === undefined) return;
			sent.set(part.id, { messageId, text: part.text });
			if (sent.size > SENT_PART_LIMIT) {
				const oldest = sent.keys().next();
				if (!oldest.done) sent.delete(oldest.value);
			}
		};
		let live = false;
		return input.pipe(
			Stream.map((envelope): SessionDetailEnvelope => {
				switch (envelope._tag) {
					case "snapshot":
						sent.clear();
						live = false;
						for (const row of envelope.rows)
							if (row._tag === "part") remember(row);
						return envelope;
					case "synchronized":
						live = true;
						return envelope;
					case "remove":
						Option.match(
							Schema.decodeUnknownOption(PartRemovalId)(envelope.id),
							{
								onSome: ([, partId]) => sent.delete(partId),
								onNone: () => {
									for (const [partId, { messageId }] of sent)
										if (messageId === envelope.id) sent.delete(partId);
								},
							},
						);
						return envelope;
				}
				const item = envelope.item;
				if (item._tag !== "part") return envelope;
				const before = sent.get(item.part.id)?.text;
				const text = item.part.text;
				remember(item);
				// Replay stays full, ordered and batched. A new subscription never
				// borrows another execution's sent state, including on resume.
				if (
					!live ||
					before === undefined ||
					text === undefined ||
					!text.startsWith(before)
				)
					return envelope;
				return {
					...envelope,
					item: {
						...item,
						part: { ...item.part, text: text.slice(before.length) },
					},
					textSuffix: { from: before.length, total: text.length },
				};
			}),
		);
	});
