// Test clients assert on whole messages; the detail wire sends a message's
// header and each of its parts as rows of their own.

import type {
	HistoryMessageSchema,
	SessionDetailEnvelope,
	SessionDetailItemSchema,
} from "../../src/lib/contracts/ws-rpc.js";

type DetailItem = typeof SessionDetailItemSchema.Type;
type PartRow = Extract<DetailItem, { _tag: "part" }>;

/** A whole message as the wire sends it: its header, then each part. */
export const detailRowsOf = ({
	parts = [],
	...message
}: typeof HistoryMessageSchema.Type): DetailItem[] => [
	{ _tag: "message", message },
	...parts.map((part, sortOrder) => ({
		_tag: "part" as const,
		messageId: message.id,
		sortOrder,
		part,
	})),
];

/** A whole message's upserts, all at one sequence. */
export const detailUpserts = (
	message: typeof HistoryMessageSchema.Type,
	sequence: number,
): SessionDetailEnvelope[] =>
	detailRowsOf(message).map((item) => ({ _tag: "upsert", item, sequence }));

/**
 * Fold one subscription's rows into whole messages. Each row yields the message
 * it touched as it now stands, once that message's header has arrived.
 */
export const assembleDetailRows = () => {
	const headers = new Map<string, typeof HistoryMessageSchema.Type>();
	const parts = new Map<string, PartRow[]>();
	return (item: DetailItem): typeof HistoryMessageSchema.Type | undefined => {
		// Pending inputs and the inbox state are not transcript messages.
		if (item._tag === "pendingInput" || item._tag === "inbox") return undefined;
		const messageId =
			item._tag === "message" ? item.message.id : item.messageId;
		if (item._tag === "message") headers.set(messageId, item.message);
		else
			parts.set(
				messageId,
				[
					...(parts.get(messageId) ?? []).filter(
						(row) => row.part.id !== item.part.id,
					),
					item,
				].sort((a, b) => a.sortOrder - b.sortOrder),
			);
		const header = headers.get(messageId);
		return (
			header && {
				...header,
				parts: (parts.get(messageId) ?? []).map((row) => row.part),
			}
		);
	};
};
