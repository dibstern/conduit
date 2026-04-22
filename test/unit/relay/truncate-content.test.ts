// ─── truncateContent / truncateToolResult Unit Tests ─────────────────────────
// Tests for the content truncation utility used with large tool results.
// Verifies: threshold behavior, edge cases, tool_result message truncation.

import { describe, expect, it } from "vitest";
import {
	TRUNCATION_THRESHOLD,
	truncateContent,
	truncateToolResult,
} from "../../../src/lib/relay/truncate-content.js";
import type { RelayMessage } from "../../../src/lib/types.js";

// ─── truncateContent ────────────────────────────────────────────────────────

describe("truncateContent", () => {
	it("returns content unchanged when under threshold", () => {
		const result = truncateContent("short content");
		expect(result.content).toBe("short content");
		expect(result.isTruncated).toBe(false);
		expect(result.fullContentLength).toBeUndefined();
	});

	it("truncates content over threshold", () => {
		const longContent = "x".repeat(TRUNCATION_THRESHOLD + 100);
		const result = truncateContent(longContent);

		expect(result.isTruncated).toBe(true);
		expect(result.fullContentLength).toBe(TRUNCATION_THRESHOLD + 100);
		expect(result.content.length).toBeLessThanOrEqual(TRUNCATION_THRESHOLD);
		expect(result.content).toContain("[truncated]");
	});

	it("returns content unchanged at exact threshold", () => {
		const exactContent = "y".repeat(TRUNCATION_THRESHOLD);
		const result = truncateContent(exactContent);

		expect(result.content).toBe(exactContent);
		expect(result.isTruncated).toBe(false);
		expect(result.fullContentLength).toBeUndefined();
	});

	it("handles empty string", () => {
		const result = truncateContent("");
		expect(result.content).toBe("");
		expect(result.isTruncated).toBe(false);
		expect(result.fullContentLength).toBeUndefined();
	});

	it("accepts custom threshold", () => {
		const content = "abcdefghij"; // 10 chars
		const result = truncateContent(content, 5);

		expect(result.isTruncated).toBe(true);
		expect(result.fullContentLength).toBe(10);
		expect(result.content.length).toBeLessThanOrEqual(5);
	});

	it("preserves content exactly at custom threshold", () => {
		const content = "abcde"; // 5 chars
		const result = truncateContent(content, 5);

		expect(result.content).toBe("abcde");
		expect(result.isTruncated).toBe(false);
	});

	it("exports TRUNCATION_THRESHOLD as 50_000", () => {
		expect(TRUNCATION_THRESHOLD).toBe(50_000);
	});
});

// ─── truncateToolResult ─────────────────────────────────────────────────────

describe("truncateToolResult", () => {
	it("truncates large tool_result content and returns full content", () => {
		const largeContent = "z".repeat(TRUNCATION_THRESHOLD + 500);
		const msg: RelayMessage = {
			type: "tool_result",
			sessionId: "s1",
			id: "tool-42",
			content: largeContent,
			is_error: false,
		};

		const result = truncateToolResult(msg);

		// Truncated message should have truncated content
		expect(result.truncated.type).toBe("tool_result");
		expect(result.truncated.content.length).toBeLessThan(largeContent.length);
		expect(result.truncated.isTruncated).toBe(true);
		expect(result.truncated.fullContentLength).toBe(largeContent.length);

		// Full content should be returned
		expect(result.fullContent).toBe(largeContent);
	});

	it("passes through small tool_result unchanged", () => {
		const smallContent = "small output";
		const msg: RelayMessage = {
			type: "tool_result",
			sessionId: "s1",
			id: "tool-99",
			content: smallContent,
			is_error: false,
		};

		const result = truncateToolResult(msg);

		expect(result.truncated.content).toBe(smallContent);
		expect(result.truncated.isTruncated).toBeUndefined();
		expect(result.truncated.fullContentLength).toBeUndefined();
		expect(result.fullContent).toBeUndefined();
	});

	it("preserves all other fields on the message", () => {
		const msg: RelayMessage = {
			type: "tool_result",
			sessionId: "s1",
			id: "tool-7",
			content: "x".repeat(TRUNCATION_THRESHOLD + 1),
			is_error: true,
			messageId: "msg-123",
		};

		const result = truncateToolResult(msg);

		expect(result.truncated.id).toBe("tool-7");
		expect(result.truncated.is_error).toBe(true);
		expect(result.truncated.messageId).toBe("msg-123");
	});
});
