// ─── Tests: Prompt Error Diagnostics ──────────────────────────────────────────
// Verifies that 400 errors from OpenCode's prompt_async endpoint surface
// actionable details (Zod validation errors) to both console and browser.

import { describe, expect, it } from "vitest";
import { OpenCodeApiError } from "../../src/lib/errors.js";

describe("OpenCodeApiError response body enrichment", () => {
	it("includes response body in message for 400 errors", () => {
		const zodError = {
			success: false,
			error: { issues: [{ code: "invalid_type", path: ["parts"] }] },
		};
		const err = new OpenCodeApiError(
			"POST /session/s1/prompt_async failed with 400",
			{
				endpoint: "/session/s1/prompt_async",
				responseStatus: 400,
				responseBody: zodError,
			},
		);

		expect(err.message).toContain(
			"POST /session/s1/prompt_async failed with 400",
		);
		expect(err.message).toContain("invalid_type");
		expect(err.message).toContain("parts");
	});

	it("includes string response body in message for 400 errors", () => {
		const err = new OpenCodeApiError("POST failed with 400", {
			endpoint: "/session/s1/prompt_async",
			responseStatus: 400,
			responseBody: "Bad Request: parts is required",
		});

		expect(err.message).toContain("POST failed with 400");
		expect(err.message).toContain("Bad Request: parts is required");
	});

	it("includes response body for other 4xx errors (401, 403, 404, 422)", () => {
		for (const status of [401, 403, 404, 422]) {
			const err = new OpenCodeApiError(`Failed with ${status}`, {
				endpoint: "/test",
				responseStatus: status,
				responseBody: { error: "unauthorized" },
			});

			expect(err.message).toContain(`Failed with ${status}`);
			expect(err.message).toContain("unauthorized");
		}
	});

	it("does NOT mutate message for 5xx server errors", () => {
		const err = new OpenCodeApiError("POST failed with 500", {
			endpoint: "/session/s1/prompt_async",
			responseStatus: 500,
			responseBody: { error: "Internal server error" },
		});

		expect(err.message).toBe("POST failed with 500");
		expect(err.message).not.toContain("Internal server error");
	});

	it("does NOT mutate message when responseBody is undefined", () => {
		const err = new OpenCodeApiError("POST failed with 400", {
			endpoint: "/session/s1/prompt_async",
			responseStatus: 400,
			responseBody: undefined,
		});

		expect(err.message).toBe("POST failed with 400");
	});

	it("does NOT mutate message when responseBody is null", () => {
		const err = new OpenCodeApiError("POST failed with 400", {
			endpoint: "/session/s1/prompt_async",
			responseStatus: 400,
			responseBody: null,
		});

		expect(err.message).toBe("POST failed with 400");
	});

	it("truncates very long response bodies (> 500 chars)", () => {
		const longBody = "x".repeat(600);
		const err = new OpenCodeApiError("POST failed with 400", {
			endpoint: "/test",
			responseStatus: 400,
			responseBody: longBody,
		});

		// Should NOT include the body since it exceeds 500 chars
		expect(err.message).toBe("POST failed with 400");
	});

	it("preserves all OpenCodeApiError properties", () => {
		const body = { issues: [{ code: "invalid_type" }] };
		const err = new OpenCodeApiError("POST failed with 400", {
			endpoint: "/session/s1/prompt_async",
			responseStatus: 400,
			responseBody: body,
		});

		expect(err.endpoint).toBe("/session/s1/prompt_async");
		expect(err.responseStatus).toBe(400);
		expect(err.responseBody).toEqual(body);
		expect(err.code).toBe("OPENCODE_API_ERROR");
		expect(err.name).toBe("OpenCodeApiError");
		expect(err).toBeInstanceOf(Error);
	});

	it("toWebSocket includes enriched message", () => {
		const err = new OpenCodeApiError("POST failed with 400", {
			endpoint: "/test",
			responseStatus: 400,
			responseBody: "validation failed",
		});

		const ws = err.toWebSocket();
		expect(ws.type).toBe("error");
		expect(ws.code).toBe("OPENCODE_API_ERROR");
		expect(ws.message).toContain("validation failed");
	});

	it("toJSON includes enriched message", () => {
		const err = new OpenCodeApiError("POST failed with 400", {
			endpoint: "/test",
			responseStatus: 400,
			responseBody: "validation failed",
		});

		const json = err.toJSON();
		expect(json.error.code).toBe("OPENCODE_API_ERROR");
		expect(json.error.message).toContain("validation failed");
	});
});
