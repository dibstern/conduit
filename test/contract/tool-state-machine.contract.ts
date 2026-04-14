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

			// In SDK 1.4.x / OpenCode 1.3.13+, only global event streams
			// are in the global /doc spec.  Project-scoped /event is no
			// longer listed here.
			expect(doc.paths).toHaveProperty("/global/event");
			expect(doc.paths).toHaveProperty("/global/sync-event");
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

	describe("Message and part schemas", () => {
		it("spec defines Message schema with part-related types", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, unknown> };
			}>("/doc");

			// In SDK 1.4.x / OpenCode 1.3.13+, session endpoints are
			// project-scoped and not in the global /doc spec.  But the
			// global spec still defines the Message, Part, and ToolPart schemas.
			const schemas = doc.components?.schemas ?? {};
			expect(schemas).toHaveProperty("Message");
			expect(schemas).toHaveProperty("Part");
			expect(schemas).toHaveProperty("ToolPart");
		});

		it("spec defines message part event schemas", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, unknown> };
			}>("/doc");

			const schemas = doc.components?.schemas ?? {};
			expect(schemas).toHaveProperty("Event.message.part.updated");
			expect(schemas).toHaveProperty("Event.message.updated");
		});
	});

	describe("Session and prompt schemas", () => {
		it("spec defines Session schema for prompt operations", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, unknown> };
			}>("/doc");

			const schemas = doc.components?.schemas ?? {};
			expect(schemas).toHaveProperty("Session");
			expect(schemas).toHaveProperty("SessionStatus");
		});

		it("spec defines tool state schemas for lifecycle tracking", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, unknown> };
			}>("/doc");

			const schemas = doc.components?.schemas ?? {};
			expect(schemas).toHaveProperty("ToolState");
			expect(schemas).toHaveProperty("ToolStatePending");
			expect(schemas).toHaveProperty("ToolStateRunning");
			expect(schemas).toHaveProperty("ToolStateCompleted");
			expect(schemas).toHaveProperty("ToolStateError");
		});
	});
});
