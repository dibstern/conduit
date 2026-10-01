// ─── AC1: SSE Event Shape Validation ──────────────────────────────────────
// Validates that OpenCode's SSE events match our expected shapes.
// Connects to both /global/event and /event streams.

import { assert, beforeAll, describe, expect, it, vi } from "vitest";
import {
	authHeaders,
	checkServerHealth,
	connectSSE,
	OPENCODE_BASE_URL,
} from "./helpers/server-connection.js";

let serverAvailable = false;

beforeAll(async () => {
	const health = await checkServerHealth();
	serverAvailable = health?.healthy === true;
	if (!serverAvailable) {
		console.warn("⚠️  OpenCode server not running — skipping contract tests");
	}
});

function skipIfNoServer() {
	if (!serverAvailable) {
		console.warn("SKIP: No OpenCode server available");
		return true;
	}
	return false;
}

describe("AC1 — SSE Event Shape Validation", () => {
	describe("Global event stream (/global/event)", () => {
		it("emits a server.connected event on connection", async () => {
			if (skipIfNoServer()) return;

			const events: Array<{ type: string; data: string }> = [];
			const { controller, ready } = connectSSE("/global/event", (evt) => {
				events.push(evt);
			});

			try {
				await ready;
				await vi.waitFor(
					() => expect(events.length).toBeGreaterThanOrEqual(1),
					{
						timeout: 1_000,
					},
				);
			} finally {
				controller.abort();
			}

			// Should have received at least one event
			expect(events.length).toBeGreaterThanOrEqual(1);

			// Parse the first data payload
			const firstEvent = events[0];
			assert.exists(firstEvent, "expected an SSE event");
			const firstData = JSON.parse(firstEvent.data);
			// Global event stream wraps in { payload: { type, properties } }
			expect(firstData).toHaveProperty("payload");
			const payload = firstData.payload;
			expect(payload.type).toBe("server.connected");
			expect(payload.properties).toBeDefined();
			expect(typeof payload.properties).toBe("object");
		});

		it("global events have { payload: { type: string, properties: object } } structure", async () => {
			if (skipIfNoServer()) return;

			const events: Array<{ type: string; data: string }> = [];
			const { controller, ready } = connectSSE("/global/event", (evt) => {
				events.push(evt);
			});

			try {
				await ready;
				await vi.waitFor(
					() => expect(events.length).toBeGreaterThanOrEqual(1),
					{
						timeout: 1_000,
					},
				);
			} finally {
				controller.abort();
			}

			for (const evt of events) {
				const parsed = JSON.parse(evt.data);
				expect(parsed).toHaveProperty("payload");
				expect(typeof parsed.payload.type).toBe("string");
				expect(typeof parsed.payload.properties).toBe("object");
			}
		});
	});

	describe("Project event stream (/event)", () => {
		it("emits a server.connected event on connection", async () => {
			if (skipIfNoServer()) return;

			const events: Array<{ type: string; data: string }> = [];
			const { controller, ready } = connectSSE("/event", (evt) => {
				events.push(evt);
			});

			try {
				await ready;
				await vi.waitFor(
					() => expect(events.length).toBeGreaterThanOrEqual(1),
					{
						timeout: 1_000,
					},
				);
			} finally {
				controller.abort();
			}

			expect(events.length).toBeGreaterThanOrEqual(1);

			// Project event stream: events are { type, properties } directly
			const firstEvent = events[0];
			assert.exists(firstEvent, "expected an SSE event");
			const firstData = JSON.parse(firstEvent.data);
			expect(typeof firstData.type).toBe("string");
			expect(firstData.type).toBe("server.connected");
			expect(typeof firstData.properties).toBe("object");
		});

		it("project events have { type: string, properties: object } structure", async () => {
			if (skipIfNoServer()) return;

			const events: Array<{ type: string; data: string }> = [];
			const { controller, ready } = connectSSE("/event", (evt) => {
				events.push(evt);
			});

			try {
				await ready;
				await vi.waitFor(
					() => expect(events.length).toBeGreaterThanOrEqual(1),
					{
						timeout: 1_000,
					},
				);
			} finally {
				controller.abort();
			}

			for (const evt of events) {
				const parsed = JSON.parse(evt.data);
				expect(typeof parsed.type).toBe("string");
				expect(typeof parsed.properties).toBe("object");
			}
		});
	});

	describe("Event type enumeration", () => {
		it("server.connected has empty properties", async () => {
			if (skipIfNoServer()) return;

			const events: Array<{ type: string; data: string }> = [];
			const { controller, ready } = connectSSE("/event", (evt) => {
				events.push(evt);
			});

			try {
				await ready;
				await vi.waitFor(
					() =>
						expect(
							events.some(
								(event) => JSON.parse(event.data).type === "server.connected",
							),
						).toBe(true),
					{ timeout: 500 },
				);
			} finally {
				controller.abort();
			}

			const connected = events
				.map((e) => JSON.parse(e.data))
				.find((e: { type: string }) => e.type === "server.connected");
			expect(connected).toBeDefined();
			expect(connected.properties).toEqual({});
		});
	});

	describe("SSE wire format", () => {
		it("events are delivered as 'data:' lines with valid JSON", async () => {
			if (skipIfNoServer()) return;

			// Raw fetch to verify wire format
			const controller = new AbortController();
			const res = await fetch(`${OPENCODE_BASE_URL}/event`, {
				signal: controller.signal,
				headers: { Accept: "text/event-stream", ...authHeaders() },
			});

			expect(res.ok).toBe(true);
			const contentType = res.headers.get("content-type") ?? "";
			expect(contentType).toContain("text/event-stream");

			// Read first chunk
			assert.exists(res.body, "expected a response body");
			const reader = res.body.getReader();
			const { value } = await reader.read();
			controller.abort();

			const text = new TextDecoder().decode(value);
			// Should contain "data: " prefix
			const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
			expect(dataLines.length).toBeGreaterThanOrEqual(1);

			// Each data line should be valid JSON
			for (const line of dataLines) {
				const json = line.slice(6);
				expect(() => JSON.parse(json)).not.toThrow();
			}
		});
	});
});
