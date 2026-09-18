import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SessionDetailItemSchema } from "../../../src/lib/contracts/ws-rpc.js";
import type { SessionDetailItem } from "../../../src/lib/domain/relay/Services/session-detail-subscription.js";

describe("session detail item contract", () => {
	it("round-trips transcript and stored event elements through JSON", async () => {
		const samples: readonly SessionDetailItem[] = [
			{
				_tag: "transcriptMessage",
				message: {
					id: "message-1",
					role: "assistant",
					parts: [{ id: "part-1", type: "text", text: "Hello" }],
					time: { created: 100, completed: 200 },
				},
			},
			{
				_tag: "event",
				event: {
					eventId: "event-1",
					sessionId: "session-1",
					type: "text.delta",
					data: { messageId: "message-1", partId: "part-1", text: "Hello" },
					metadata: {},
					provider: "claude",
					createdAt: 100,
					sequence: 7,
					streamVersion: 1,
				},
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
