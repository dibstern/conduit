import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { RelayMessageSchema } from "../../../src/lib/shared-types.js";

describe("history backfill wire decoding", () => {
	const message = { id: "msg-rest", role: "assistant", isBackfilled: true };

	it.each([
		{
			type: "session_switched",
			id: "ses-rest",
			sessionId: "ses-rest",
			history: { messages: [message], hasMore: false },
		},
		{
			type: "history_page",
			sessionId: "ses-rest",
			messages: [message],
			hasMore: false,
		},
	])("preserves the marker in $type", (wire) => {
		const decoded = Schema.decodeUnknownSync(RelayMessageSchema)(wire);
		if (decoded.type === "session_switched") {
			expect(decoded.history?.messages[0]?.isBackfilled).toBe(true);
		} else if (decoded.type === "history_page") {
			expect(decoded.messages[0]?.isBackfilled).toBe(true);
		}
	});
});
