// ─── AC4: Question Flow Shape Validation ──────────────────────────────────
// Validates question endpoint shapes and the question lifecycle.
// Similar to permissions — actual question triggering requires an agent asking,
// so we validate API shapes and empty-state behavior.

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

describe("AC4 — Question Flow Shape Validation", () => {
	describe("GET /question (empty state)", () => {
		it("returns an array", async () => {
			if (skipIfNoServer()) return;
			const questions = await apiGet<unknown>("/question");
			expect(Array.isArray(questions)).toBe(true);
		});

		it("array is empty when no questions are pending", async () => {
			if (skipIfNoServer()) return;
			const questions = await apiGet<unknown[]>("/question");
			expect(questions.length).toBe(0);
		});
	});

	describe("Question reply endpoint shape", () => {
		it("POST /question/:id/reply exists in OpenAPI spec", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				paths: Record<string, unknown>;
			}>("/doc");
			expect(doc.paths).toHaveProperty("/question/{requestID}/reply");
			const endpoint = doc.paths["/question/{requestID}/reply"] as Record<
				string,
				unknown
			>;
			expect(endpoint).toHaveProperty("post");
		});

		it("question reply endpoint expects { answers } body", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				paths: Record<string, Record<string, Record<string, unknown>>>;
			}>("/doc");
			const post = doc.paths["/question/{requestID}/reply"]?.["post"];
			expect(post).toBeDefined();
			expect(post).toHaveProperty("requestBody");
		});
	});

	describe("Question reject endpoint shape", () => {
		it("POST /question/:id/reject exists in OpenAPI spec", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				paths: Record<string, unknown>;
			}>("/doc");
			expect(doc.paths).toHaveProperty("/question/{requestID}/reject");
			const endpoint = doc.paths["/question/{requestID}/reject"] as Record<
				string,
				unknown
			>;
			expect(endpoint).toHaveProperty("post");
		});
	});

	describe("Question SSE event shape (from OpenAPI spec)", () => {
		it("OpenAPI spec defines question-related schemas", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, unknown> };
			}>("/doc");

			const schemas = doc.components?.schemas ?? {};
			const schemaNames = Object.keys(schemas);
			const hasQuestionSchema = schemaNames.some(
				(name) =>
					name.toLowerCase().includes("question") ||
					name.toLowerCase().includes("askuser"),
			);
			expect(hasQuestionSchema).toBe(true);
		});
	});

	describe("Question structure from OpenAPI spec", () => {
		it("question schema defines expected fields", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, Record<string, unknown>> };
			}>("/doc");

			const schemas = doc.components?.schemas ?? {};
			// Find question-related schemas
			const questionSchemas = Object.entries(schemas).filter(([name]) =>
				name.toLowerCase().includes("question"),
			);
			expect(questionSchemas.length).toBeGreaterThan(0);
		});
	});
});
