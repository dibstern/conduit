// ─── Tests: TranslateResult discriminated union ─────────────────────────────
// Verifies that createTranslator().translate() returns TranslateResult
// (ok: true with messages array, or ok: false with reason string)
// instead of the old RelayMessage | RelayMessage[] | null.

import { describe, expect, it } from "vitest";
import type { TranslateResult } from "../../../src/lib/relay/event-translator.js";
import { createTranslator } from "../../../src/lib/relay/event-translator.js";

describe("translator returns TranslateResult", () => {
	const translator = createTranslator();

	it("returns ok: true with messages for known events", () => {
		const result = translator.translate({
			type: "session.status",
			properties: {
				sessionID: "s1",
				status: { type: "retry", attempt: 1, message: "Rate limited" },
			},
		});
		expect(result).toHaveProperty("ok", true);
		if (result.ok) {
			expect(result.messages.length).toBeGreaterThan(0);
		}
	});

	it("returns ok: false with reason for unknown events", () => {
		const result = translator.translate({
			type: "some.unknown.event",
			properties: {},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("unhandled event type");
		}
	});

	it("returns ok: false for events that produce no messages", () => {
		// permission.replied is handled by the bridge, not the translator
		const result = translator.translate({
			type: "permission.replied",
			properties: { id: "perm1" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBeTruthy();
		}
	});

	it("messages array is always an array (never single message)", () => {
		// Use a part delta event which produces a single message wrapped in array
		const result = translator.translate({
			type: "message.part.delta",
			properties: { partID: "p1", field: "text", delta: "hi" },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(Array.isArray(result.messages)).toBe(true);
		}
	});

	it("returns single error message for retry status", () => {
		const result = translator.translate({
			type: "session.status",
			properties: {
				sessionID: "s1",
				status: { type: "retry", attempt: 1, message: "Rate limited" },
			},
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages.length).toBe(1);
			expect(result.messages[0]?.type).toBe("error");
		}
	});

	it("returns ok: false for session.status busy (handled by status poller)", () => {
		const result = translator.translate({
			type: "session.status",
			properties: { sessionID: "s1", status: { type: "busy" } },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("session status");
		}
	});

	it("provides reason for unhandled session status types", () => {
		const result = translator.translate({
			type: "session.status",
			properties: {
				sessionID: "s1",
				status: { type: "unknown_status_type" },
			},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("session status");
		}
	});

	it("provides reason for message.created with non-user role", () => {
		const result = translator.translate({
			type: "message.created",
			properties: {
				message: { role: "assistant", parts: [{ type: "text", text: "hi" }] },
			},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("message created");
		}
	});

	it("provides reason for message.updated with non-assistant role", () => {
		const result = translator.translate({
			type: "message.updated",
			properties: {
				message: { role: "user" },
			},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("message updated");
		}
	});

	it("type narrows correctly after ok check", () => {
		const result: TranslateResult = translator.translate({
			type: "session.status",
			properties: {
				sessionID: "s1",
				status: { type: "retry", attempt: 1, message: "Rate limited" },
			},
		});

		if (result.ok) {
			// TypeScript should narrow to { ok: true; messages: RelayMessage[] }
			const msgs = result.messages;
			expect(msgs.length).toBeGreaterThan(0);
		} else {
			// TypeScript should narrow to { ok: false; reason: string }
			const reason = result.reason;
			expect(typeof reason).toBe("string");
		}
	});

	it("returns ok: false with reason for session.updated (handled by bridge)", () => {
		const result = translator.translate({
			type: "session.updated",
			properties: { info: { id: "s1" } },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("handled by bridge");
		}
	});

	it("returns ok: true for part delta with text field", () => {
		const result = translator.translate({
			type: "message.part.delta",
			properties: { partID: "p1", field: "text", delta: "hello" },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]?.type).toBe("delta");
		}
	});
});
