// ─── Tool Message Factory — Unit Tests ───────────────────────────────────────
// Tests the createToolMessage factory that centralizes ToolMessage construction.
// Used by both history-logic.ts (REST history) and tool-registry.ts (SSE lifecycle).

import { describe, expect, it } from "vitest";
import type { ToolMessage } from "../../../src/lib/frontend/types.js";
import {
	createToolMessage,
	type ToolMessageInit,
} from "../../../src/lib/frontend/utils/tool-message-factory.js";

describe("createToolMessage", () => {
	it("creates a minimal pending ToolMessage with required fields only", () => {
		const init: ToolMessageInit = {
			uuid: "uuid-1",
			id: "call-1",
			name: "Bash",
			status: "pending",
		};
		const result = createToolMessage(init);

		expect(result).toEqual({
			type: "tool",
			uuid: "uuid-1",
			id: "call-1",
			name: "Bash",
			status: "pending",
		});
	});

	it("creates a full history ToolMessage with all optional fields", () => {
		const init: ToolMessageInit = {
			uuid: "uuid-2",
			id: "call-2",
			name: "Read",
			status: "completed",
			result: "file contents here",
			isError: false,
			input: { filePath: "/foo.ts" },
			metadata: { sessionId: "ses_child001" },
			messageId: "msg-123",
		};
		const result = createToolMessage(init);

		expect(result).toEqual({
			type: "tool",
			uuid: "uuid-2",
			id: "call-2",
			name: "Read",
			status: "completed",
			result: "file contents here",
			isError: false,
			input: { filePath: "/foo.ts" },
			metadata: { sessionId: "ses_child001" },
			messageId: "msg-123",
		});
	});

	it("creates an error ToolMessage", () => {
		const init: ToolMessageInit = {
			uuid: "uuid-3",
			id: "call-3",
			name: "Bash",
			status: "error",
			result: "Command failed with exit code 1",
			isError: true,
		};
		const result = createToolMessage(init);

		expect(result).toMatchObject({
			type: "tool",
			status: "error",
			result: "Command failed with exit code 1",
			isError: true,
		});
	});

	it("creates a ToolMessage with truncation fields", () => {
		const init: ToolMessageInit = {
			uuid: "uuid-4",
			id: "call-4",
			name: "Read",
			status: "completed",
			result: "truncated...",
			isTruncated: true,
			fullContentLength: 50000,
		};
		const result = createToolMessage(init);

		expect(result).toMatchObject({
			type: "tool",
			isTruncated: true,
			fullContentLength: 50000,
		});
	});

	it("does NOT set optional fields to undefined (clean object shape)", () => {
		const init: ToolMessageInit = {
			uuid: "uuid-5",
			id: "call-5",
			name: "Write",
			status: "pending",
		};
		const result = createToolMessage(init);

		// Optional fields should not be present at all, not set to undefined
		expect(Object.keys(result)).toEqual([
			"type",
			"uuid",
			"id",
			"name",
			"status",
		]);
		expect(result).not.toHaveProperty("result");
		expect(result).not.toHaveProperty("isError");
		expect(result).not.toHaveProperty("input");
		expect(result).not.toHaveProperty("metadata");
		expect(result).not.toHaveProperty("messageId");
		expect(result).not.toHaveProperty("isTruncated");
		expect(result).not.toHaveProperty("fullContentLength");
	});

	it("omits result when not provided but includes isError when provided", () => {
		const init: ToolMessageInit = {
			uuid: "uuid-6",
			id: "call-6",
			name: "Bash",
			status: "completed",
			isError: false,
		};
		const result = createToolMessage(init);

		expect(result).not.toHaveProperty("result");
		expect(result.isError).toBe(false);
	});

	it("returns a ToolMessage that satisfies the ToolMessage type", () => {
		const init: ToolMessageInit = {
			uuid: "uuid-7",
			id: "call-7",
			name: "Read",
			status: "completed",
			result: "content",
		};
		const result: ToolMessage = createToolMessage(init);

		expect(result.type).toBe("tool");
	});
});
