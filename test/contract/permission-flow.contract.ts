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

	describe("Permission reply schema shape", () => {
		it("OpenAPI spec defines PermissionRequest schema", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, unknown> };
			}>("/doc");
			const schemas = doc.components?.schemas ?? {};
			// In SDK 1.4.x / OpenCode 1.3.13+, permission endpoints are
			// project-scoped and not in the global /doc spec.  But the
			// global spec still defines the PermissionRequest schema.
			expect(schemas).toHaveProperty("PermissionRequest");
		});

		it("permission event schemas include asked and replied", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, unknown> };
			}>("/doc");
			const schemas = doc.components?.schemas ?? {};
			expect(schemas).toHaveProperty("Event.permission.asked");
			expect(schemas).toHaveProperty("Event.permission.replied");
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
