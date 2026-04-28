// ─── Frontend Effect Boundary Tests ─────────────────────────────────────────
// Tests for lazy Schema validation of daemon→client WebSocket messages at the
// frontend boundary. Uses RelayMessageSchema from shared-types.ts.

import { describe, expect, it } from "vitest";

describe("Frontend Effect boundary", () => {
	// ── Known message types (daemon → client) ──────────────────────────────
	it("validates a delta message", async () => {
		const { validateIncomingMessage } = await import(
			"../../../src/lib/frontend/effect-boundary.js"
		);
		const raw = { type: "delta", sessionId: "s1", text: "hello" };
		const result = await validateIncomingMessage(raw);
		expect(result).toHaveProperty("type", "delta");
		expect(result).toHaveProperty("text", "hello");
	});

	it("validates a session_list message", async () => {
		const { validateIncomingMessage } = await import(
			"../../../src/lib/frontend/effect-boundary.js"
		);
		const raw = {
			type: "session_list",
			sessions: [{ id: "s1", title: "test" }],
			roots: true,
		};
		const result = await validateIncomingMessage(raw);
		expect(result).toHaveProperty("type", "session_list");
	});

	it("validates a status message", async () => {
		const { validateIncomingMessage } = await import(
			"../../../src/lib/frontend/effect-boundary.js"
		);
		const raw = { type: "status", sessionId: "s1", status: "processing" };
		const result = await validateIncomingMessage(raw);
		expect(result).toHaveProperty("type", "status");
		expect(result).toHaveProperty("status", "processing");
	});

	it("validates a tool_result message", async () => {
		const { validateIncomingMessage } = await import(
			"../../../src/lib/frontend/effect-boundary.js"
		);
		const raw = {
			type: "tool_result",
			sessionId: "s1",
			id: "t1",
			content: "output",
			is_error: false,
		};
		const result = await validateIncomingMessage(raw);
		expect(result).toHaveProperty("type", "tool_result");
		expect(result).toHaveProperty("is_error", false);
	});

	// ── Unknown / future message types (graceful degradation) ──────────────
	it("passes through unknown message types (degraded)", async () => {
		const { validateIncomingMessage } = await import(
			"../../../src/lib/frontend/effect-boundary.js"
		);
		const raw = { type: "future_unknown_type", data: 123 };
		const result = await validateIncomingMessage(raw);
		expect(result).toEqual(raw);
	});

	it("passes through messages with extra fields", async () => {
		const { validateIncomingMessage } = await import(
			"../../../src/lib/frontend/effect-boundary.js"
		);
		const raw = { type: "some_new_feature", payload: { nested: true }, v: 2 };
		const result = await validateIncomingMessage(raw);
		expect(result).toEqual(raw);
	});

	it("passes through non-object values", async () => {
		const { validateIncomingMessage } = await import(
			"../../../src/lib/frontend/effect-boundary.js"
		);
		const raw = "not an object";
		const result = await validateIncomingMessage(raw);
		expect(result).toBe(raw);
	});

	// ── Decoder caching ────────────────────────────────────────────────────
	it("caches the decoder across calls", async () => {
		const { validateIncomingMessage } = await import(
			"../../../src/lib/frontend/effect-boundary.js"
		);
		// Two successive calls should both work (tests the caching path)
		const r1 = await validateIncomingMessage({
			type: "delta",
			sessionId: "s1",
			text: "a",
		});
		const r2 = await validateIncomingMessage({
			type: "status",
			sessionId: "s2",
			status: "idle",
		});
		expect(r1).toHaveProperty("type", "delta");
		expect(r2).toHaveProperty("type", "status");
	});

	it("preloads and decodes synchronously", async () => {
		const { decodeMessage, preloadDecoder } = await import(
			"../../../src/lib/frontend/effect-boundary.js"
		);
		await preloadDecoder();

		const result = decodeMessage({
			type: "delta",
			sessionId: "s1",
			text: "cached",
		});

		expect(result).toHaveProperty("type", "delta");
		expect(result).toHaveProperty("text", "cached");
	});

	it("sync decoder passes unknown messages through", async () => {
		const { decodeMessage, preloadDecoder } = await import(
			"../../../src/lib/frontend/effect-boundary.js"
		);
		await preloadDecoder();
		const raw = { type: "future_unknown_type", data: 123 };
		expect(decodeMessage(raw)).toEqual(raw);
	});
});
