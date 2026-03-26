import { describe, expect, it, vi } from "vitest";
import type { OpenCodeClient } from "../../../src/lib/instance/opencode-client.js";
import {
	preRenderHistoryMessages,
	renderMarkdownServer,
} from "../../../src/lib/relay/markdown-renderer.js";
import { SessionManager } from "../../../src/lib/session/session-manager.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";

describe("Server-side markdown rendering", () => {
	it("should render basic markdown to HTML", () => {
		const result = renderMarkdownServer("**bold** text");
		expect(result).toContain("<strong>bold</strong>");
		expect(result).toContain("text");
	});

	it("should sanitize dangerous HTML", () => {
		const result = renderMarkdownServer('<script>alert("xss")</script>');
		expect(result).not.toContain("<script>");
	});

	it("should handle code blocks", () => {
		const result = renderMarkdownServer("```js\nconst x = 1;\n```");
		expect(result).toContain("<code");
		expect(result).toContain("const x = 1;");
	});

	it("should handle empty string", () => {
		const result = renderMarkdownServer("");
		expect(result).toBe("");
	});
});

describe("preRenderHistoryMessages", () => {
	it("should add renderedHtml to assistant text parts", () => {
		const messages: HistoryMessage[] = [
			{
				id: "m1",
				role: "user",
				parts: [{ id: "p1", type: "text", text: "hello" }],
			},
			{
				id: "m2",
				role: "assistant",
				parts: [
					{ id: "p2", type: "text", text: "**bold**" },
					{ id: "p3", type: "tool", text: "ignored" },
				],
			},
		];

		preRenderHistoryMessages(messages);

		// User message parts: no renderedHtml
		expect(messages[0]?.parts?.[0]?.renderedHtml).toBeUndefined();
		// Assistant text part: has renderedHtml
		expect(messages[1]?.parts?.[0]?.renderedHtml).toContain(
			"<strong>bold</strong>",
		);
		// Assistant tool part: no renderedHtml
		expect(messages[1]?.parts?.[1]?.renderedHtml).toBeUndefined();
	});

	it("should skip parts with no text", () => {
		const messages: HistoryMessage[] = [
			{
				id: "m1",
				role: "assistant",
				parts: [{ id: "p1", type: "text" }],
			},
		];

		preRenderHistoryMessages(messages);
		expect(messages[0]?.parts?.[0]?.renderedHtml).toBeUndefined();
	});
});

describe("SessionManager.loadPreRenderedHistory", () => {
	it("returns messages with renderedHtml on assistant text parts", async () => {
		const mockMessages = [
			{
				id: "m1",
				role: "user",
				parts: [{ id: "p1", type: "text", text: "hello" }],
			},
			{
				id: "m2",
				role: "assistant",
				parts: [{ id: "p2", type: "text", text: "**bold**" }],
			},
		];

		const mockClient = {
			getMessagesPage: vi.fn().mockResolvedValue(mockMessages),
		};

		const mgr = new SessionManager({
			client: mockClient as unknown as OpenCodeClient,
		});

		const result = await mgr.loadPreRenderedHistory("test-session");

		// Assistant text part should have renderedHtml with <strong>
		expect(result.messages[0]?.parts?.[0]?.renderedHtml).toBeUndefined(); // user part
		expect(result.messages[1]?.parts?.[0]?.renderedHtml).toContain(
			"<strong>bold</strong>",
		);
	});

	it("passes offset through to loadHistory", async () => {
		const mockMessages = Array.from({ length: 100 }, (_, i) => ({
			id: `m${i}`,
			role: "assistant",
			parts: [{ id: `p${i}`, type: "text", text: `msg ${i}` }],
		}));

		const mockClient = {
			getMessagesPage: vi
				.fn()
				.mockImplementation(
					(_sessionId: string, opts?: { limit?: number; before?: string }) => {
						const limit = opts?.limit ?? mockMessages.length;
						if (!opts?.before) {
							// First page: return the last `limit` messages
							return Promise.resolve(mockMessages.slice(-limit));
						}
						// Subsequent page: return messages before the cursor
						const idx = mockMessages.findIndex(
							(m: { id: string }) => m.id === opts.before,
						);
						if (idx <= 0) return Promise.resolve([]);
						const start = Math.max(0, idx - limit);
						return Promise.resolve(mockMessages.slice(start, idx));
					},
				),
		};

		const mgr = new SessionManager({
			client: mockClient as unknown as OpenCodeClient,
			historyPageSize: 50,
		});

		const page1 = await mgr.loadPreRenderedHistory("test-session");
		expect(page1.hasMore).toBe(true);
		expect(page1.messages).toHaveLength(50);

		const page2 = await mgr.loadPreRenderedHistory("test-session", 50);
		// Cursor-based pagination: hasMore is true when page.length >= pageSize
		// (exact boundary returns true since we can't know without fetching more)
		expect(page2.messages).toHaveLength(50);

		// Both pages should have renderedHtml
		for (const msg of [...page1.messages, ...page2.messages]) {
			expect(msg.parts?.[0]?.renderedHtml).toBeDefined();
		}
	});
});
