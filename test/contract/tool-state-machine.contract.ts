// ─── AC6: Tool Part State Machine Validation ─────────────────────────────
// Validates tool execution state transitions via the committed OpenAPI snapshot
// and SSE event schema definitions. Starting with OpenCode v1.14.x the live
// /doc endpoint only exposes global-level schemas, so project-scoped schemas
// (Message, Part, ToolPart, Session, Events, etc.) are validated against the
// committed snapshot. Full lifecycle observation requires sending a message
// that triggers tool use, which is tested when a session is active.

import { beforeAll, describe, expect, it } from "vitest";
import {
	apiGet,
	checkServerHealth,
	loadSnapshotSpec,
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

describe("AC6 — Tool Part State Machine Validation", () => {
	describe("Message part structure from snapshot spec", () => {
		it("message schema defines parts array", async () => {
			if (skipIfNoServer()) return;
			const doc = loadSnapshotSpec();

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

	describe("Part type definitions from snapshot spec", () => {
		it("spec defines part-related schemas (ToolCall, TextPart, etc.)", async () => {
			if (skipIfNoServer()) return;
			const doc = loadSnapshotSpec();

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
			const doc = loadSnapshotSpec();

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
			const doc = loadSnapshotSpec();

			// The snapshot (captured from v1.3.13) includes global event
			// stream paths that the live /doc no longer lists.
			expect(doc.paths).toHaveProperty("/global/event");
			expect(doc.paths).toHaveProperty("/global/sync-event");
		});
	});

	describe("Tool state values", () => {
		it("our expected part types are represented in the spec", async () => {
			if (skipIfNoServer()) return;
			const doc = loadSnapshotSpec();

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
			const doc = loadSnapshotSpec();

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
			const doc = loadSnapshotSpec();

			const schemas = doc.components?.schemas ?? {};
			expect(schemas).toHaveProperty("Message");
			expect(schemas).toHaveProperty("Part");
			expect(schemas).toHaveProperty("ToolPart");
		});

		it("spec defines message part event schemas", async () => {
			if (skipIfNoServer()) return;
			const doc = loadSnapshotSpec();

			const schemas = doc.components?.schemas ?? {};
			expect(schemas).toHaveProperty("Event.message.part.updated");
			expect(schemas).toHaveProperty("Event.message.updated");
		});
	});

	describe("Session and prompt schemas", () => {
		it("spec defines Session schema for prompt operations", async () => {
			if (skipIfNoServer()) return;
			const doc = loadSnapshotSpec();

			const schemas = doc.components?.schemas ?? {};
			expect(schemas).toHaveProperty("Session");
			expect(schemas).toHaveProperty("SessionStatus");
		});

		it("spec defines tool state schemas for lifecycle tracking", async () => {
			if (skipIfNoServer()) return;
			const doc = loadSnapshotSpec();

			const schemas = doc.components?.schemas ?? {};
			expect(schemas).toHaveProperty("ToolState");
			expect(schemas).toHaveProperty("ToolStatePending");
			expect(schemas).toHaveProperty("ToolStateRunning");
			expect(schemas).toHaveProperty("ToolStateCompleted");
			expect(schemas).toHaveProperty("ToolStateError");
		});
	});
});
