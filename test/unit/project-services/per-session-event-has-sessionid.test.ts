import { describe, expect, it } from "vitest";
import type {
	BrowserMessage,
	UntaggedBrowserMessage,
} from "../../../src/lib/shared-types.js";
import { tagWithSessionId } from "../../../src/lib/shared-types.js";

describe("message-poller synthesized events have sessionId", () => {
	it("tagWithSessionId applies sessionId to untagged events", () => {
		const untagged: UntaggedBrowserMessage = {
			type: "user_message",
			text: "hi",
		};
		const tagged = tagWithSessionId(untagged, "ses_poll");
		expect(tagged).toHaveProperty("sessionId", "ses_poll");
	});

	it("tagWithSessionId preserves existing sessionId", () => {
		const msg: BrowserMessage = {
			type: "done",
			sessionId: "ses_existing",
			code: 0,
		};
		const tagged = tagWithSessionId(msg, "ses_other");
		expect((tagged as { sessionId: string }).sessionId).toBe("ses_existing");
	});

	it("synthesized done event via tagWithSessionId has sessionId", () => {
		const raw: UntaggedBrowserMessage = { type: "done", code: 0 };
		const tagged = tagWithSessionId(raw, "ses_poller");
		expect(tagged.type).toBe("done");
		expect((tagged as { sessionId: string }).sessionId).toBe("ses_poller");
	});
});
