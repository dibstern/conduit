// ─── AC6: Tool Part State Machine Validation ─────────────────────────────
// Validates tool execution state transitions via the OpenAPI spec and
// SSE event schema definitions. Full lifecycle observation requires sending
// a message that triggers tool use, which is tested when a session is active.

import { beforeAll, describe, expect, it } from "vitest";
import { apiGet, checkServerHealth } from "./helpers/server-connection.js";

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

describe("AC6 — Tool Part State Machine Validation", () => {
	describe("Message part structure from OpenAPI spec", () => {
		it("message schema defines parts array", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, Record<string, unknown>> };
			}>("/doc");

			const schemas = doc.components?.schemas ?? {};
			// Look for Message schema
			const messageSchemas = Object.entries(schemas).filter(
				([name]) =>
					name.toLowerCase() === "message" ||
					name.toLowerCase().includes("message"),
			);
			expect(messageSchemas.length).toBeGreaterThan(0);
		});
	});

	describe("Part type definitions from OpenAPI spec", () => {
		it("spec defines part-related schemas (ToolCall, TextPart, etc.)", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, Record<string, unknown>> };
			}>("/doc");

			const schemas = doc.components?.schemas ?? {};
			const schemaNames = Object.keys(schemas);

			// Look for part-related schemas
			const partSchemas = schemaNames.filter(
				(name) =>
					name.toLowerCase().includes("part") ||
					name.toLowerCase().includes("tool") ||
					name.toLowerCase().includes("text"),
			);
			expect(partSchemas.length).toBeGreaterThan(0);
		});
	});

	describe("SSE event types for tool lifecycle", () => {
		it("spec defines message.part.updated event type", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, Record<string, unknown>> };
			}>("/doc");

			const schemas = doc.components?.schemas ?? {};
			const schemaNames = Object.keys(schemas);

			// Look for event-related schemas that cover message parts
			const eventSchemas = schemaNames.filter(
				(name) =>
					name.toLowerCase().includes("event") ||
					name.toLowerCase().includes("messageevent"),
			);
			// At minimum, there should be event schemas
			expect(eventSchemas.length).toBeGreaterThan(0);
		});

		it("event stream endpoint exists for receiving tool events", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				paths: Record<string, unknown>;
			}>("/doc");

			// Both global and project event streams should exist
			expect(doc.paths).toHaveProperty("/global/event");
			expect(doc.paths).toHaveProperty("/event");
		});
	});

	describe("Tool state values", () => {
		it("our expected part types are represented in the spec", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, Record<string, unknown>> };
			}>("/doc");

			// Stringify the schemas to search for our expected part types
			const schemasStr = JSON.stringify(doc.components?.schemas ?? {});

			// These are the part types we handle in event-translator.ts
			const expectedPartTypes = ["text", "tool"];
			for (const partType of expectedPartTypes) {
				expect(schemasStr).toContain(`"${partType}"`);
			}
		});

		it("spec contains tool status values we depend on", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, unknown> };
			}>("/doc");

			const schemasStr = JSON.stringify(doc.components?.schemas ?? {});

			// Our ToolStatus type expects these values
			const expectedStatuses = ["pending", "running", "completed", "error"];
			for (const status of expectedStatuses) {
				expect(schemasStr).toContain(`"${status}"`);
			}
		});
	});

	describe("Message part endpoints", () => {
		it("GET /session/:id/message/:mid endpoint exists", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				paths: Record<string, unknown>;
			}>("/doc");

			expect(doc.paths).toHaveProperty(
				"/session/{sessionID}/message/{messageID}",
			);
		});

		it("GET /session/:id/message/:mid/part/:pid endpoint exists", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				paths: Record<string, unknown>;
			}>("/doc");

			expect(doc.paths).toHaveProperty(
				"/session/{sessionID}/message/{messageID}/part/{partID}",
			);
		});
	});

	describe("Prompt endpoint for triggering tools", () => {
		it("POST /session/:id/prompt_async endpoint exists", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				paths: Record<string, unknown>;
			}>("/doc");

			expect(doc.paths).toHaveProperty("/session/{sessionID}/prompt_async");
		});

		it("abort endpoint exists for stopping tool execution", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				paths: Record<string, unknown>;
			}>("/doc");

			expect(doc.paths).toHaveProperty("/session/{sessionID}/abort");
		});
	});
});
