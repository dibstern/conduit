import { Schema } from "effect";
import { expect, it } from "vitest";
import { translateMessageCreated } from "../../../src/lib/relay/event-translator.js";
import { diffAndSynthesize } from "../../../src/lib/relay/message-poller.js";
import { RelayMessageSchema } from "../../../src/lib/shared-types.js";

it("preserves user provider ids through the event schema", () => {
	const event = {
		type: "user_message",
		sessionId: "s1",
		text: "Hello",
		messageId: "provider-1",
	};
	expect(Schema.decodeUnknownSync(RelayMessageSchema)(event)).toEqual(event);
});

it("polls user provider ids", () => {
	const { events } = diffAndSynthesize(new Map(), [
		{
			id: "provider-1",
			sessionID: "s1",
			role: "user",
			parts: [{ id: "part-1", type: "text", text: "Hello" }],
		},
	]);
	expect(events).toContainEqual({
		type: "user_message",
		text: "Hello",
		messageId: "provider-1",
	});
});

it("translates the sibling messageID from user message.created events", () => {
	expect(
		translateMessageCreated({
			type: "message.created",
			properties: {
				messageID: "provider-1",
				info: {
					role: "user",
					parts: [{ type: "text", text: "Hello" }],
				},
			},
		}),
	).toEqual({ type: "user_message", text: "Hello", messageId: "provider-1" });
});
