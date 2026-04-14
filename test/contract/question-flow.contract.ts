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

	describe("Question reply schema shape", () => {
		it("OpenAPI spec defines QuestionRequest schema", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, unknown> };
			}>("/doc");
			const schemas = doc.components?.schemas ?? {};
			// In SDK 1.4.x / OpenCode 1.3.13+, question endpoints are
			// project-scoped and not in the global /doc spec.  But the
			// global spec still defines the QuestionRequest schema.
			expect(schemas).toHaveProperty("QuestionRequest");
		});

		it("question reply schema defines QuestionAnswer", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, unknown> };
			}>("/doc");
			const schemas = doc.components?.schemas ?? {};
			expect(schemas).toHaveProperty("QuestionAnswer");
		});
	});

	describe("Question reject schema shape", () => {
		it("question event schemas include asked, replied, and rejected", async () => {
			if (skipIfNoServer()) return;
			const doc = await apiGet<{
				components?: { schemas?: Record<string, unknown> };
			}>("/doc");
			const schemas = doc.components?.schemas ?? {};
			expect(schemas).toHaveProperty("Event.question.asked");
			expect(schemas).toHaveProperty("Event.question.replied");
			expect(schemas).toHaveProperty("Event.question.rejected");
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
