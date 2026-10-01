// ─── Regression: message.updated must handle properties.info (not just properties.message) ───
// Root cause: OpenCode sends message data under "info" key in message.updated events,
// but translateMessageUpdated only checked "message". This meant usage/cost data never
// reached the browser.

import { assert, describe, expect, it } from "vitest";
import {
	createTranslator,
	translateMessageUpdated,
} from "../../../src/lib/relay/event-translator.js";

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
		assert.exists(result, "expected translated result");
		expect(result.type).toBe("result");
		if (result.type === "result") {
			expect(result.usage.input).toBe(100);
			expect(result.usage.output).toBe(200);
			expect(result.usage.cache_read).toBe(50);
			expect(result.usage.cache_creation).toBe(10);
			expect(result.cost).toBe(0.0042);
			expect(result.duration).toBe(1000);
			expect(result.sessionId).toBe("ses_abc");
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
		assert.exists(result, "expected translated result");
		expect(result.type).toBe("result");
		if (result.type === "result") {
			expect(result.usage.input).toBe(500);
			expect(result.usage.output).toBe(1000);
			expect(result.cost).toBe(0.01);
			expect(result.duration).toBe(2000);
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
		assert.exists(result, "expected translated result");
		if (result.type === "result") {
			// Should use info, not message
			expect(result.cost).toBe(0.05);
			expect(result.usage.input).toBe(999);
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
					// No cost, no tokens, no start time: only a completed step
					// reports a result.
					time: { completed: 1 },
				},
			},
		};

		const result = translateMessageUpdated(event);
		expect(result).not.toBeNull();
		assert.exists(result, "expected translated result");
		if (result.type === "result") {
			expect(result.usage.input).toBe(0);
			expect(result.usage.output).toBe(0);
			expect(result.cost).toBe(0);
			expect(result.duration).toBe(0);
		}
	});
});

describe("createTranslator — OpenCode turn totals across sessions", () => {
	// OpenCode carries the session on `info`, not on `properties`. Two sessions
	// stepping at once must keep separate turn bills.
	const step = (
		sessionID: string,
		id: string,
		parentID: string,
		cost: number,
		finish: string,
		time: { created: number; completed: number },
	) => ({
		type: "message.updated" as const,
		properties: {
			info: { id, sessionID, parentID, role: "assistant", cost, finish, time },
		},
	});

	it("bills every step of a turn when another session steps in between", () => {
		const translator = createTranslator();
		translator.translate(
			step("ses_a", "a1", "ua", 1, "tool-calls", {
				created: 100,
				completed: 200,
			}),
		);
		translator.translate(
			step("ses_b", "b1", "ub", 5, "tool-calls", {
				created: 150,
				completed: 250,
			}),
		);
		const final = translator.translate(
			step("ses_a", "a2", "ua", 2, "stop", { created: 300, completed: 400 }),
		);

		expect(final.ok).toBe(true);
		const result = final.ok ? final.messages[0] : undefined;
		expect(result).toMatchObject({ type: "result", cost: 3, duration: 300 });
	});
});
