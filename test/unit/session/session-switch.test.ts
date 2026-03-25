import { describe, expect, it } from "vitest";
import { classifyHistorySource } from "../../../src/lib/session/session-switch.js";
import type { RelayMessage } from "../../../src/lib/types.js";

describe("classifyHistorySource", () => {
	it('returns "needs-rest" when events is null', () => {
		expect(classifyHistorySource(null)).toBe("needs-rest");
	});

	it('returns "needs-rest" when events is undefined', () => {
		expect(classifyHistorySource(undefined)).toBe("needs-rest");
	});

	it('returns "needs-rest" when events is empty array', () => {
		expect(classifyHistorySource([])).toBe("needs-rest");
	});

	it('returns "needs-rest" when events have no chat content (only status/done)', () => {
		const events: RelayMessage[] = [
			{ type: "status", status: "processing" },
			{ type: "done", code: 0 },
		];
		expect(classifyHistorySource(events)).toBe("needs-rest");
	});

	it('returns "cached-events" when events contain user_message', () => {
		const events: RelayMessage[] = [{ type: "user_message", text: "hello" }];
		expect(classifyHistorySource(events)).toBe("cached-events");
	});

	it('returns "cached-events" when events contain delta', () => {
		const events: RelayMessage[] = [{ type: "delta", text: "response" }];
		expect(classifyHistorySource(events)).toBe("cached-events");
	});

	it('returns "cached-events" when events have mixed content with at least one user_message', () => {
		const events: RelayMessage[] = [
			{ type: "status", status: "processing" },
			{ type: "user_message", text: "hello" },
			{ type: "done", code: 0 },
		];
		expect(classifyHistorySource(events)).toBe("cached-events");
	});
});
