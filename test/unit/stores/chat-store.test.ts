import {
	afterEach,
	assert,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// Mock DOMPurify (browser-only) before importing the store
vi.mock("dompurify", () => ({
	default: {
		sanitize: (html: string) => html,
	},
}));

import {
	addSystemMessage,
	addUserMessage,
	advanceTurnIfNewMessage,
	chatState,
	clearMessages,
	handleCompaction,
	handleError,
	historyState,
	isProcessing,
	isStreaming,
	phaseToProcessing,
	phaseToStreaming,
	prependMessages,
	restoreContextFromMessages,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import type {
	ResultMessage,
	UserMessage as UserMsg,
} from "../../../src/lib/frontend/types.js";
import { isQueued } from "../../../src/lib/frontend/utils/turns.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

let ta: SessionActivity;
let tm: SessionMessages;

beforeEach(() => {
	sessionState.currentId = "test-session";
	clearMessages();
	ta = testActivity();
	tm = testMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("projected context usage", () => {
	it("restores the context usage percentage from a persisted result window", () => {
		tm.messages = [
			{
				type: "result",
				uuid: "result-1",
				inputTokens: 10_000,
				outputTokens: 0,
				cacheRead: 320_000,
				cacheWrite: 0,
				context_window: 1_000_000,
			} as ResultMessage & { context_window: number },
		];

		restoreContextFromMessages(tm);

		expect(tm.contextPercent).toBe(33);
	});
});

describe("handleError", () => {
	it("adds an info system message for RETRY code", () => {
		handleError(ta, tm, {
			type: "error",
			sessionId: "s1",
			code: "RETRY",
			message: "Retrying...",
		});
		const m = chatState.messages[0];
		assert.exists(m, "expected chat message");
		expect(m.type).toBe("system");
		if (m.type === "system") {
			expect(m.variant).toBe("info");
			expect(m.text).toBe("Retrying...");
		}
	});

	it("adds an error system message for non-RETRY", () => {
		handleError(ta, tm, {
			type: "error",
			sessionId: "s1",
			code: "UNKNOWN",
			message: "Something broke",
		});
		const m = chatState.messages[0];
		assert.exists(m, "expected chat message");
		expect(m.type).toBe("system");
		if (m.type === "system") {
			expect(m.variant).toBe("error");
		}
	});

	it("stops processing on non-RETRY error", () => {
		phaseToStreaming(ta);
		handleError(ta, tm, {
			type: "error",
			sessionId: "s1",
			code: "FATAL",
			message: "fail",
		});
		expect(isProcessing()).toBe(false);
		expect(isStreaming()).toBe(false);
	});

	it("does NOT stop processing on RETRY", () => {
		phaseToProcessing(ta);
		handleError(ta, tm, {
			type: "error",
			sessionId: "s1",
			code: "RETRY",
			message: "retry",
		});
		expect(isProcessing()).toBe(true);
	});

	it("uses fallback text when message is empty", () => {
		handleError(ta, tm, {
			type: "error",
			sessionId: "s1",
			code: "",
			message: "",
		});
		const m = chatState.messages[0];
		assert.exists(m, "expected chat message");
		if (m.type === "system") {
			// Empty message is still passed through; the store uses msg.message directly
			expect(m.text).toBe("");
		}
	});
});

describe("addUserMessage", () => {
	it("adds a user message", () => {
		addUserMessage(ta, tm, "hello");
		expect(chatState.messages).toHaveLength(1);
		const firstMessage = chatState.messages[0];
		assert.exists(firstMessage, "expected user message");
		expect(firstMessage.type).toBe("user");
		if (firstMessage.type === "user") {
			expect(firstMessage.text).toBe("hello");
		}
	});

	it("includes images when provided", () => {
		addUserMessage(ta, tm, "look", ["img1.png"]);
		const firstMessage = chatState.messages[0];
		assert.exists(firstMessage, "expected user message");
		if (firstMessage.type === "user") {
			expect(firstMessage.images).toEqual(["img1.png"]);
		}
	});
});

describe("addSystemMessage", () => {
	it("adds an info system message by default", () => {
		addSystemMessage(ta, tm, "info text");
		const m = chatState.messages[0];
		assert.exists(m, "expected system message");
		if (m.type === "system") {
			expect(m.variant).toBe("info");
		}
	});

	it("adds an error system message when variant specified", () => {
		addSystemMessage(ta, tm, "error text", "error");
		const m = chatState.messages[0];
		assert.exists(m, "expected system message");
		if (m.type === "system") {
			expect(m.variant).toBe("error");
		}
	});
});

describe("handleCompaction", () => {
	const compaction = (
		state: "started" | "completed" | "failed",
		detail: string,
		tokens: { preTokens?: number; postTokens?: number } = {},
	) =>
		handleCompaction(ta, tm, {
			type: "compaction",
			sessionId: "s1",
			state,
			detail,
			...tokens,
		});

	it("shows a transient notice while compacting", () => {
		compaction("started", "Compacting conversation…");
		expect(chatState.messages).toEqual([
			expect.objectContaining({
				compaction: "started",
				text: "Compacting conversation…",
			}),
		]);
	});

	it.each([
		"completed",
		"failed",
	] as const)("a %s outcome retires the notice and leaves the outcome to the transcript", (state) => {
		tm.messages = [
			{
				type: "system",
				uuid: "compaction-1/compaction-part-1",
				text: "Context compacted",
				variant: "info",
				compaction: "completed",
			},
		];
		compaction("started", "Compacting conversation…");
		compaction(state, "outcome");
		expect(
			chatState.messages.map((m) => (m.type === "system" ? m.uuid : m.type)),
		).toEqual(["compaction-1/compaction-part-1"]);
	});
});

describe("queued user message (sentDuringEpoch)", () => {
	it("addUserMessage sets sentDuringEpoch when sent while processing", () => {
		addUserMessage(ta, tm, "hello", undefined, true);
		expect(chatState.messages).toHaveLength(1);
		const msg = chatState.messages[0];
		assert.exists(msg, "expected error message");
		expect(msg.type).toBe("user");
		expect((msg as UserMsg).sentDuringEpoch).toBe(chatState.turnEpoch);
	});

	it("addUserMessage defaults sentDuringEpoch to undefined", () => {
		addUserMessage(ta, tm, "hello");
		const msg = chatState.messages[0];
		assert.exists(msg, "expected user message");
		expect((msg as UserMsg).sentDuringEpoch).toBeUndefined();
	});

	// Claude starts a queued prompt's reply without ending the turn, and a tab
	// that joined mid-turn never saw the reply that was already running.
	it("stops being queued once its reply starts, even after joining mid-turn", () => {
		phaseToProcessing(ta);
		addUserMessage(ta, tm, "follow-up", undefined, true);
		const user = tm.messages.at(-1) as UserMsg;
		expect(isQueued(user, ta.turnEpoch, true)).toBe(true);
		advanceTurnIfNewMessage(ta, tm, "msg_reply_to_follow_up");
		expect(isQueued(user, ta.turnEpoch, true)).toBe(false);
	});

	it("clearMessages resets all state", () => {
		addUserMessage(ta, tm, "test", undefined, true);
		clearMessages();
		expect(chatState.messages).toHaveLength(0);
		expect(isProcessing()).toBe(false);
		expect(isStreaming()).toBe(false);
	});
});

describe("prependMessages", () => {
	beforeEach(() => {
		clearMessages();
	});

	it("prepends messages before existing messages", () => {
		addUserMessage(ta, tm, "live message");
		const older = [
			{ type: "user" as const, uuid: "h1", text: "older message" },
		];
		prependMessages(ta, tm, older);
		expect(chatState.messages).toHaveLength(2);
		expect((chatState.messages[0] as UserMsg).text).toBe("older message");
		expect((chatState.messages[1] as UserMsg).text).toBe("live message");
	});

	it("prepends into empty array", () => {
		prependMessages(ta, tm, [
			{ type: "user" as const, uuid: "h1", text: "from history" },
		]);
		expect(chatState.messages).toHaveLength(1);
		expect((chatState.messages[0] as UserMsg).text).toBe("from history");
	});

	it("no-ops on empty input", () => {
		addUserMessage(ta, tm, "existing");
		prependMessages(ta, tm, []);
		expect(chatState.messages).toHaveLength(1);
	});
});

describe("historyState", () => {
	beforeEach(() => {
		clearMessages();
	});

	it("defaults hasMore to false and loading to false after clearMessages", () => {
		expect(historyState.hasMore).toBe(false);
		expect(historyState.loading).toBe(false);
	});

	it("clearMessages resets historyState", () => {
		historyState.hasMore = true;
		historyState.loading = true;
		clearMessages();
		expect(historyState.hasMore).toBe(false);
		expect(historyState.loading).toBe(false);
	});
});
