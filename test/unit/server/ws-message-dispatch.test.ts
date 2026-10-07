import { seedSessions } from "../stores/session-fixtures.js";
// Full tool content and input drafts arrive through RPC replies.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks (run before imports)

const { showBannerMock, removeBannerMock, showToastMock } = vi.hoisted(() => ({
	showBannerMock: vi.fn(),
	removeBannerMock: vi.fn(),
	showToastMock: vi.fn(),
}));

// Mock DOMPurify (required by chat.svelte.ts → markdown.ts)
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

// Mock ui.svelte.js to capture showBanner/removeBanner calls
vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	uiState: { opencodeConnections: {} },
	showToast: showToastMock,
	showBanner: showBannerMock,
	removeBanner: removeBannerMock,
	setClientCount: vi.fn(),
}));

import {
	applyToolContentResponse,
	chatState,
	clearMessages,
	inputSyncState,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { getBrowserClientId } from "../../../src/lib/frontend/stores/client-identity.js";
import { applyInputDraft } from "../../../src/lib/frontend/stores/input-draft.js";
import { clearInstanceState } from "../../../src/lib/frontend/stores/instance.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import type { ToolMessage } from "../../../src/lib/frontend/types.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

let _ta: SessionActivity;
let tm: SessionMessages;

beforeEach(() => {
	clearMessages();
	// Set currentId and register session BEFORE creating test slots,
	// so testActivity()/testMessages() register under the correct key ("s1").
	seedSessions([
		...sessionState.sessions.values(),
		{ id: "s1", title: "", status: "idle" },
	]);
	sessionState.currentId = "s1";
	_ta = testActivity();
	tm = testMessages();
	clearInstanceState();
	inputSyncState.text = "";
	inputSyncState.lastFrom = "";
	inputSyncState.lastUpdated = 0;
	showBannerMock.mockClear();
	removeBannerMock.mockClear();
	showToastMock.mockClear();
	uiState.opencodeConnections = {};
});

afterEach(() => {
	clearMessages();
	_ta = testActivity();
	tm = testMessages();
	clearInstanceState();
	inputSyncState.text = "";
	inputSyncState.lastFrom = "";
	inputSyncState.lastUpdated = 0;
});

describe("applyToolContentResponse", () => {
	/** Helper: set up a tool message with truncated result */
	function seedTruncatedTool(
		toolId: string,
		toolName: string,
		opts?: { messageId?: string },
	): void {
		tm.messages = [
			...tm.messages,
			{
				type: "tool",
				uuid: `s1/${toolId}`,
				id: toolId,
				name: toolName,
				status: "completed",
				result: "truncated output…",
				isTruncated: true,
				fullContentLength: 50_000,
				...(opts?.messageId != null && { messageId: opts.messageId }),
			},
		];
	}

	it("replaces truncated tool result with full content", () => {
		seedTruncatedTool("tool-1", "bash");

		applyToolContentResponse({
			sessionId: "s1",
			toolId: "tool-1",
			content: "full output here — all 50,000 chars",
		});

		const toolMsg = chatState.messages.find(
			(m) => m.type === "tool" && (m as ToolMessage).id === "tool-1",
		) as ToolMessage;

		expect(toolMsg).toBeDefined();
		expect(toolMsg.result).toBe("full output here — all 50,000 chars");
		expect(toolMsg.isTruncated).toBe(false);
		expect(toolMsg.fullContentLength).toBeUndefined();
	});

	it("applies RPC tool content to the current session", () => {
		seedTruncatedTool("tool-rpc", "bash");
		sessionState.currentId = "s1";

		applyToolContentResponse({
			projectSlug: "demo",
			toolId: "tool-rpc",
			content: "full rpc output",
		});

		const toolMsg = chatState.messages.find(
			(m) => m.type === "tool" && (m as ToolMessage).id === "tool-rpc",
		) as ToolMessage;

		expect(toolMsg.result).toBe("full rpc output");
		expect(toolMsg.isTruncated).toBe(false);
		expect(toolMsg.fullContentLength).toBeUndefined();
	});

	it("is a no-op for unknown toolId", () => {
		seedTruncatedTool("tool-1", "bash");
		const messagesBefore = chatState.messages.map((m) => ({ ...m }));

		applyToolContentResponse({
			sessionId: "s1",
			toolId: "nonexistent-tool",
			content: "should be ignored",
		});

		// Tool-1 should be unchanged
		const toolMsg = chatState.messages.find(
			(m) => m.type === "tool" && (m as ToolMessage).id === "tool-1",
		) as ToolMessage;
		expect(toolMsg.result).toBe("truncated output…");
		expect(toolMsg.isTruncated).toBe(true);
		expect(toolMsg.fullContentLength).toBe(50_000);
		expect(chatState.messages).toHaveLength(messagesBefore.length);
	});

	it("preserves other tool message fields when updating", () => {
		seedTruncatedTool("tool-2", "file_read", { messageId: "msg-123" });

		applyToolContentResponse({
			sessionId: "s1",
			toolId: "tool-2",
			content: "full file contents",
		});

		const updated = chatState.messages.find(
			(m) => m.type === "tool" && (m as ToolMessage).id === "tool-2",
		) as ToolMessage;

		expect(updated.name).toBe("file_read");
		expect(updated.status).toBe("completed");
		expect(updated.messageId).toBe("msg-123");
		expect(updated.result).toBe("full file contents");
		expect(updated.isTruncated).toBe(false);
		expect(updated.fullContentLength).toBeUndefined();
	});

	it("does not affect other messages in the array", () => {
		// Seed two tool messages
		seedTruncatedTool("tool-a", "bash");
		seedTruncatedTool("tool-b", "grep");

		// Only update tool-a
		applyToolContentResponse({
			sessionId: "s1",
			toolId: "tool-a",
			content: "full-a",
		});

		const toolA = chatState.messages.find(
			(m) => m.type === "tool" && (m as ToolMessage).id === "tool-a",
		) as ToolMessage;
		const toolB = chatState.messages.find(
			(m) => m.type === "tool" && (m as ToolMessage).id === "tool-b",
		) as ToolMessage;

		expect(toolA.result).toBe("full-a");
		expect(toolA.isTruncated).toBe(false);
		// tool-b should still be truncated
		expect(toolB.result).toBe("truncated output…");
		expect(toolB.isTruncated).toBe(true);
	});
});

describe("input draft follower", () => {
	it("ignores draft echoes from this browser tab", () => {
		inputSyncState.text = "before";
		inputSyncState.lastUpdated = 10;

		applyInputDraft({
			_tag: "draft",
			text: "self echo",
			from: getBrowserClientId(),
		});

		expect(inputSyncState.text).toBe("before");
		expect(inputSyncState.lastUpdated).toBe(10);
	});

	it("applies drafts from another browser tab", () => {
		applyInputDraft({
			_tag: "draft",
			text: "other tab draft",
			from: "browser-tab-b",
		});

		expect(inputSyncState.text).toBe("other tab draft");
		expect(inputSyncState.lastFrom).toBe("browser-tab-b");
		expect(inputSyncState.lastUpdated).toBeGreaterThan(0);
	});
});
