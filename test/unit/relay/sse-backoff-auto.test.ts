// ─── Unit Tests: parseSSEDataAuto ─────────────────────────────────────────────
// Regression tests for the auto-detecting SSE parser that handles both
// OpenCode's global event format ({ payload: { type, properties } })
// and the direct format ({ type, properties }).

import { describe, expect, it } from "vitest";
import { parseSSEDataAuto } from "../../../src/lib/relay/sse-backoff.js";

// ─── Global format (OpenCode /event endpoint) ───────────────────────────────

describe("parseSSEDataAuto — global format", () => {
	it("parses payload-wrapped event with directory", () => {
		const raw = JSON.stringify({
			directory: "/home/user/project",
			payload: {
				type: "message.part.delta",
				properties: {
					sessionID: "s1",
					partID: "p1",
					delta: "Hello",
				},
			},
		});
		const result = parseSSEDataAuto(raw);
		expect(result.ok).toBe(true);
		expect(result.event).toEqual({
			type: "message.part.delta",
			properties: {
				sessionID: "s1",
				partID: "p1",
				delta: "Hello",
			},
		});
	});

	it("parses server.connected without directory", () => {
		const raw = JSON.stringify({
			payload: {
				type: "server.connected",
				properties: {},
			},
		});
		const result = parseSSEDataAuto(raw);
		expect(result.ok).toBe(true);
		expect(result.event).toEqual({
			type: "server.connected",
			properties: {},
		});
	});

	it("parses server.heartbeat without directory", () => {
		const raw = JSON.stringify({
			payload: {
				type: "server.heartbeat",
				properties: {},
			},
		});
		const result = parseSSEDataAuto(raw);
		expect(result.ok).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result.event!.type).toBe("server.heartbeat");
	});

	it("parses session.status event", () => {
		const raw = JSON.stringify({
			directory: "/project",
			payload: {
				type: "session.status",
				properties: { status: { type: "idle" } },
			},
		});
		const result = parseSSEDataAuto(raw);
		expect(result.ok).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result.event!.type).toBe("session.status");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result.event!.properties).toEqual({
			status: { type: "idle" },
		});
	});

	it("parses permission.asked event", () => {
		const raw = JSON.stringify({
			directory: "/project",
			payload: {
				type: "permission.asked",
				properties: {
					id: "perm-1",
					permission: "Bash",
					patterns: ["rm -rf"],
				},
			},
		});
		const result = parseSSEDataAuto(raw);
		expect(result.ok).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result.event!.type).toBe("permission.asked");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect((result.event!.properties as Record<string, unknown>)["id"]).toBe(
			"perm-1",
		);
	});

	it("normalizes missing properties in payload to empty object", () => {
		const raw = JSON.stringify({
			payload: {
				type: "server.connected",
			},
		});
		const result = parseSSEDataAuto(raw);
		expect(result.ok).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result.event!.properties).toEqual({});
	});
});

// ─── Direct format (backward compat / testing) ─────────────────────────────

describe("parseSSEDataAuto — direct format", () => {
	it("parses direct { type, properties } event", () => {
		const raw = JSON.stringify({
			type: "message.part.delta",
			properties: {
				sessionID: "s1",
				partID: "p1",
				delta: "Hi",
			},
		});
		const result = parseSSEDataAuto(raw);
		expect(result.ok).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result.event!.type).toBe("message.part.delta");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect((result.event!.properties as Record<string, unknown>)["delta"]).toBe(
			"Hi",
		);
	});

	it("normalizes missing properties to empty object", () => {
		const raw = JSON.stringify({
			type: "server.heartbeat",
		});
		const result = parseSSEDataAuto(raw);
		expect(result.ok).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result.event!.properties).toEqual({});
	});
});

// ─── Format priority ────────────────────────────────────────────────────────

describe("parseSSEDataAuto — format priority", () => {
	it("prefers global format when both type and payload exist", () => {
		// If both payload.type and type exist, global format wins
		const raw = JSON.stringify({
			type: "should-not-use-this",
			payload: {
				type: "message.part.delta",
				properties: { delta: "real" },
			},
		});
		const result = parseSSEDataAuto(raw);
		expect(result.ok).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result.event!.type).toBe("message.part.delta");
	});
});

// ─── Error cases ────────────────────────────────────────────────────────────

describe("parseSSEDataAuto — error cases", () => {
	it("returns error for empty string", () => {
		const result = parseSSEDataAuto("");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("empty");
	});

	it("returns error for whitespace-only string", () => {
		const result = parseSSEDataAuto("   ");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("empty");
	});

	it("returns error for invalid JSON", () => {
		const result = parseSSEDataAuto("{not json}");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("JSON parse error");
	});

	it("returns error for array", () => {
		const result = parseSSEDataAuto("[1, 2]");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not an object");
	});

	it("returns error for null", () => {
		const result = parseSSEDataAuto("null");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not an object");
	});

	it("returns error for primitive", () => {
		const result = parseSSEDataAuto('"hello"');
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not an object");
	});

	it("returns error when neither payload.type nor type exist", () => {
		const result = parseSSEDataAuto(JSON.stringify({ directory: "/foo" }));
		expect(result.ok).toBe(false);
		expect(result.error).toContain("unrecognized");
	});

	it("returns error for object with non-string payload.type", () => {
		const result = parseSSEDataAuto(JSON.stringify({ payload: { type: 42 } }));
		expect(result.ok).toBe(false);
		expect(result.error).toContain("unrecognized");
	});

	it("returns error for payload that is not an object", () => {
		const result = parseSSEDataAuto(JSON.stringify({ payload: "not-object" }));
		expect(result.ok).toBe(false);
		expect(result.error).toContain("unrecognized");
	});

	it("never throws on arbitrary input", () => {
		const inputs = [
			undefined as unknown as string,
			"",
			"{}",
			'{"type": 123}',
			"true",
			"42",
			"💥",
			'{"payload": null}',
			'{"payload": {"type": null}}',
		];
		for (const input of inputs) {
			expect(() => parseSSEDataAuto(input)).not.toThrow();
		}
	});
});
