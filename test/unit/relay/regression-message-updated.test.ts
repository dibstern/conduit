// ─── Regression: message.updated must handle properties.info (not just properties.message) ───
// Root cause: OpenCode sends message data under "info" key in message.updated events,
// but translateMessageUpdated only checked "message". This meant usage/cost data never
// reached the browser.

import { describe, expect, it } from "vitest";
import { translateMessageUpdated } from "../../../src/lib/relay/event-translator.js";

describe("translateMessageUpdated — properties.info regression", () => {
	it("extracts usage from properties.info (actual OpenCode format)", () => {
		const event = {
			type: "message.updated" as const,
			properties: {
				sessionID: "ses_abc",
				info: {
					id: "msg_123",
					role: "assistant",
					cost: 0.0042,
					tokens: {
						input: 100,
						output: 200,
						cache: { read: 50, write: 10 },
					},
					time: { created: 1000, completed: 2000 },
				},
			},
		};

		const result = translateMessageUpdated(event);
		expect(result).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result!.type).toBe("result");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		if (result!.type === "result") {
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.usage.input).toBe(100);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.usage.output).toBe(200);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.usage.cache_read).toBe(50);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.usage.cache_creation).toBe(10);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.cost).toBe(0.0042);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.duration).toBe(1000);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.sessionId).toBe("ses_abc");
		}
	});

	it("still works with properties.message (backward compat)", () => {
		const event = {
			type: "message.updated" as const,
			properties: {
				sessionID: "ses_abc",
				message: {
					role: "assistant",
					cost: 0.01,
					tokens: {
						input: 500,
						output: 1000,
						cache: { read: 0, write: 0 },
					},
					time: { created: 3000, completed: 5000 },
				},
			},
		};

		const result = translateMessageUpdated(event);
		expect(result).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result!.type).toBe("result");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		if (result!.type === "result") {
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.usage.input).toBe(500);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.usage.output).toBe(1000);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.cost).toBe(0.01);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.duration).toBe(2000);
		}
	});

	it("prefers info over message when both are present", () => {
		const event = {
			type: "message.updated" as const,
			properties: {
				sessionID: "ses_abc",
				info: {
					role: "assistant",
					cost: 0.05,
					tokens: { input: 999, output: 888, cache: { read: 0, write: 0 } },
					time: { created: 1000, completed: 2000 },
				},
				message: {
					role: "assistant",
					cost: 0.01,
					tokens: { input: 1, output: 2, cache: { read: 0, write: 0 } },
					time: { created: 1000, completed: 2000 },
				},
			},
		};

		const result = translateMessageUpdated(event);
		expect(result).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		if (result!.type === "result") {
			// Should use info, not message
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.cost).toBe(0.05);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.usage.input).toBe(999);
		}
	});

	it("returns null for user role in info", () => {
		const event = {
			type: "message.updated" as const,
			properties: {
				sessionID: "ses_abc",
				info: {
					role: "user",
					cost: 0,
					tokens: { input: 10, output: 0 },
				},
			},
		};

		const result = translateMessageUpdated(event);
		expect(result).toBeNull();
	});

	it("returns null when neither info nor message present", () => {
		const event = {
			type: "message.updated" as const,
			properties: {
				sessionID: "ses_abc",
			},
		};

		const result = translateMessageUpdated(event);
		expect(result).toBeNull();
	});

	it("handles info with missing optional fields", () => {
		const event = {
			type: "message.updated" as const,
			properties: {
				sessionID: "ses_xyz",
				info: {
					role: "assistant",
					// No cost, no tokens, no time
				},
			},
		};

		const result = translateMessageUpdated(event);
		expect(result).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		if (result!.type === "result") {
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.usage.input).toBe(0);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.usage.output).toBe(0);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.cost).toBe(0);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.duration).toBe(0);
		}
	});
});
