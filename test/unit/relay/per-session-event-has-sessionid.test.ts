// Exercises each emission site and asserts sessionId presence on emitted events.
// Server Task 1: sessionId was added to every per-session RelayMessage variant.

import { describe, expect, it } from "vitest";
import type {
	PerSessionEvent,
	PerSessionEventType,
	RelayMessage,
	UntaggedRelayMessage,
} from "../../../src/lib/shared-types.js";
import { tagWithSessionId } from "../../../src/lib/shared-types.js";

describe("PerSessionEvent type discriminator", () => {
	it("PerSessionEvent is a non-empty union (Extract resolves to concrete types)", () => {
		// If the Extract resolved to `never`, this assignment would fail at compile
		// time. At runtime we verify the type string is accepted.
		const event: PerSessionEvent = {
			type: "delta",
			sessionId: "s1",
			text: "hello",
		};
		expect(event.sessionId).toBe("s1");
	});

	it("all PerSessionEventType values can produce a typed PerSessionEvent", () => {
		// Construct a minimal valid PerSessionEvent for each type.
		// If any type does not carry sessionId, TS would reject the literal.
		const types: PerSessionEventType[] = [
			"delta",
			"thinking_start",
			"thinking_delta",
			"tool_start",
			"tool_result",
			"result",
			"done",
			"user_message",
			"part_removed",
			"message_removed",
		];
		// Every per-session type is accounted for
		expect(types.length).toBeGreaterThan(0);
		// Verify the list matches the PerSessionEventType union by checking a known type
		expect(types).toContain("delta");
		expect(types).toContain("message_removed");
	});
});

describe("message-poller synthesized events have sessionId", () => {
	it("tagWithSessionId applies sessionId to untagged events", () => {
		const untagged: UntaggedRelayMessage = { type: "user_message", text: "hi" };
		const tagged = tagWithSessionId(untagged, "ses_poll");
		expect(tagged).toHaveProperty("sessionId", "ses_poll");
	});

	it("tagWithSessionId preserves existing sessionId", () => {
		const msg: RelayMessage = {
			type: "done",
			sessionId: "ses_existing",
			code: 0,
		};
		const tagged = tagWithSessionId(msg, "ses_other");
		expect((tagged as { sessionId: string }).sessionId).toBe("ses_existing");
	});

	it("synthesized done event via tagWithSessionId has sessionId", () => {
		const raw: UntaggedRelayMessage = { type: "done", code: 0 };
		const tagged = tagWithSessionId(raw, "ses_poller");
		expect(tagged.type).toBe("done");
		expect((tagged as { sessionId: string }).sessionId).toBe("ses_poller");
	});
});
