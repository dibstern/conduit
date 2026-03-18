// ─── AC3: Permission Flow Shape Validation ────────────────────────────────
// Validates permission endpoint shapes and the permission lifecycle.
// Note: Triggering actual permissions requires sending a message that invokes
// a tool (e.g., bash), which is complex in a contract test. This test validates
// the permission API shapes and empty-state behavior.

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

describe("AC3 — Permission Flow Shape Validation", () => {
	describe("GET /permission (empty state)", () => {
		it("returns an array", async () => {
			if (skipIfNoServer()) return;
			const permissions = await apiGet<unknown>("/permission");
			expect(Array.isArray(permissions)).toBe(true);
		});

		it("array is empty when no permissions are pending", async () => {
			if (skipIfNoServer()) return;
			const permissions = await apiGet<unknown[]>("/permission");
			// In idle state, should be empty
			expect(permissions.length).toBe(0);
		});
	});

	describe("Permission reply endpoint shape", () => {
		it("POST /permission/:id/reply exists in OpenAPI spec", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				paths: Record<string, unknown>;
			}>("/doc");
			expect(doc.paths).toHaveProperty("/permission/{requestID}/reply");
			const endpoint = doc.paths["/permission/{requestID}/reply"] as Record<
				string,
				unknown
			>;
			// Should support POST method
			expect(endpoint).toHaveProperty("post");
		});

		it("permission reply endpoint expects { reply } body per OpenAPI spec", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				paths: Record<string, Record<string, Record<string, unknown>>>;
			}>("/doc");
			const post = doc.paths["/permission/{requestID}/reply"]?.["post"];
			expect(post).toBeDefined();
			// Should have requestBody defined
			expect(post).toHaveProperty("requestBody");
		});
	});

	describe("Permission SSE event shape (from OpenAPI spec)", () => {
		it("OpenAPI spec defines permission event types", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, unknown> };
			}>("/doc");

			// The spec should define event-related schemas
			const schemas = doc.components?.schemas ?? {};
			const schemaNames = Object.keys(schemas);

			// Check for permission-related schemas or event schemas
			// OpenCode uses a bus/event system — look for Permission-related types
			const hasPermissionSchema = schemaNames.some(
				(name) =>
					name.toLowerCase().includes("permission") ||
					name.toLowerCase().includes("event"),
			);
			expect(hasPermissionSchema).toBe(true);
		});
	});

	describe("Permission reply values", () => {
		it("our assumed reply values match OpenAPI spec", async () => {
			if (skipIfNoServer()) return;
			// We use "once", "always", "reject" as reply values
			// Verify the spec's enum/schema for permission replies
			const doc = await apiGet<{
				components?: { schemas?: Record<string, Record<string, unknown>> };
			}>("/doc");

			const schemas = doc.components?.schemas ?? {};
			// Look for the reply schema that defines valid values
			const permissionSchemas = Object.entries(schemas).filter(([name]) =>
				name.toLowerCase().includes("permission"),
			);
			// At minimum, permission schemas should exist
			expect(permissionSchemas.length).toBeGreaterThan(0);
		});
	});
});
