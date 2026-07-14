// ─── AC4: Question Flow Shape Validation ──────────────────────────────────
// Validates question endpoint shapes and the question lifecycle.
// Similar to permissions — actual question triggering requires an agent asking,
// so we validate API shapes and empty-state behavior.

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

	// NOTE: Starting with OpenCode v1.14.x the live /doc endpoint only
	// exposes global-level schemas. Question schemas are validated
	// against the committed snapshot which captures the full contract.
	describe("Question reply schema shape", () => {
		it("snapshot spec defines QuestionRequest schema", async () => {
			if (skipIfNoServer()) return;
			const doc = loadSnapshotSpec();
			const schemas = doc.components?.schemas ?? {};
			expect(schemas).toHaveProperty("QuestionRequest");
		});

		it("question reply schema defines QuestionAnswer", async () => {
			if (skipIfNoServer()) return;
			const doc = loadSnapshotSpec();
			const schemas = doc.components?.schemas ?? {};
			expect(schemas).toHaveProperty("QuestionAnswer");
		});
	});

	describe("Question reject schema shape", () => {
		it("question event schemas include asked, replied, and rejected", async () => {
			if (skipIfNoServer()) return;
			const doc = loadSnapshotSpec();
			const schemas = doc.components?.schemas ?? {};
			expect(schemas).toHaveProperty("EventQuestionAsked");
			expect(schemas).toHaveProperty("EventQuestionReplied");
			expect(schemas).toHaveProperty("EventQuestionRejected");
		});
	});

	describe("Question SSE event shape (from snapshot spec)", () => {
		it("snapshot spec defines question-related schemas", async () => {
			if (skipIfNoServer()) return;
			const doc = loadSnapshotSpec();

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

	describe("Question structure from snapshot spec", () => {
		it("question schema defines expected fields", async () => {
			if (skipIfNoServer()) return;
			const doc = loadSnapshotSpec();

			const schemas = doc.components?.schemas ?? {};
			// Find question-related schemas
			const questionSchemas = Object.entries(schemas).filter(([name]) =>
				name.toLowerCase().includes("question"),
			);
			expect(questionSchemas.length).toBeGreaterThan(0);
		});
	});
});
