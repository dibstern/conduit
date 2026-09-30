import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedSessions } from "./session-fixtures.js";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import {
	clearMessages,
	getOrCreateSessionSlot,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";

beforeEach(() => {
	vi.useFakeTimers();
	sessionState.currentId = "history-test";
	clearMessages();
	seedSessions([{ id: "history-test", title: "History", status: "idle" }]);
	getOrCreateSessionSlot("history-test");
});
afterEach(() => vi.useRealTimers());

const page = (id: string, hasMore: boolean) =>
	handleMessage({
		type: "history_page",
		sessionId: "history-test",
		messages: [
			{
				id,
				role: "user",
				parts: [{ id: `${id}-text`, type: "text", text: id }],
			},
		],
		hasMore,
	});

describe("history_page until R12", () => {
	it("prepends older rows and updates the paging flag", async () => {
		page("newer", true);
		await vi.runAllTimersAsync();
		page("older", false);
		await vi.runAllTimersAsync();
		const messages = sessionMessages.get("history-test");
		expect(
			messages?.messages
				.filter((item) => item.type === "user")
				.map((item) => item.type === "user" && item.text),
		).toEqual(["older", "newer"]);
		expect(messages?.historyHasMore).toBe(false);
		expect(messages?.historyLoading).toBe(false);
	});
});
