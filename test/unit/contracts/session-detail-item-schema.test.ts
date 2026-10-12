import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SessionDetailItemSchema } from "../../../src/lib/contracts/ws-rpc.js";
import type { SessionDetailItem } from "../../../src/lib/domain/relay/Services/session-detail-subscription.js";

describe("session detail item contract", () => {
	it("round-trips message and part rows through JSON", async () => {
		const samples: readonly SessionDetailItem[] = [
			{
				_tag: "message",
				message: {
					id: "message-1",
					role: "assistant",
					time: { created: 100, completed: 200 },
				},
			},
			{
				_tag: "part",
				messageId: "message-1",
				sortOrder: 0,
				part: { id: "part-1", type: "text", text: "Hello" },
			},
		];
		for (const sample of samples) {
			const encoded = await Effect.runPromise(
				Schema.encode(SessionDetailItemSchema)(sample),
			);
			const decoded = await Effect.runPromise(
				Schema.decodeUnknown(SessionDetailItemSchema)(
					JSON.parse(JSON.stringify(encoded)),
				),
			);
			expect(decoded).toEqual(sample);
		}
	});
});
