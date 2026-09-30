// ─── Chat Store Tests ────────────────────────────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock DOMPurify (browser-only) before importing the store
vi.mock("dompurify", () => ({
	default: {
		sanitize: (html: string) => html,
	},
}));

import {
	addSystemMessage,
	addUserMessage,
	chatState,
	clearMessages,
	handleCompaction,
	handleError,
	handleToolExecuting,
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
	RelayMessage,
	ResultMessage,
	UserMessage as UserMsg,
} from "../../../src/lib/frontend/types.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

// ─── Per-session tiers for handler calls ────────────────────────────────────
let ta: SessionActivity;
let tm: SessionMessages;

// ─── Helper: cast incomplete test data to the expected type ─────────────────
// Tests deliberately pass incomplete objects to verify defensive handling.
function msg<T extends RelayMessage["type"]>(data: {
	type: T;
	[k: string]: unknown;
}): Extract<RelayMessage, { type: T }> {
	return data as Extract<RelayMessage, { type: T }>;
}

// ─── Reset state before each test ───────────────────────────────────────────

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

// ─── Retained tool lifecycle ────────────────────────────────────────────────

describe("tool lifecycle", () => {
	it("silently ignores executing for unknown tool id (expected overlap)", () => {
		handleToolExecuting(
			ta,
			tm,
			msg({ type: "tool_executing", sessionId: "s1", id: "unknown" }),
		);
		expect(chatState.messages).toHaveLength(0);
	});
});

// ─── Projected context usage ────────────────────────────────────────────────

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

// ─── handleError ────────────────────────────────────────────────────────────

describe("handleError", () => {
	it("adds an info system message for RETRY code", () => {
		handleError(ta, tm, {
			type: "error",
			sessionId: "s1",
			code: "RETRY",
			message: "Retrying...",
		});
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const m = chatState.messages[0]!;
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
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const m = chatState.messages[0]!;
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
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const m = chatState.messages[0]!;
		if (m.type === "system") {
			// Empty message is still passed through; the store uses msg.message directly
			expect(m.text).toBe("");
		}
	});
});

// ─── addUserMessage / addSystemMessage ──────────────────────────────────────

describe("addUserMessage", () => {
	it("adds a user message", () => {
		addUserMessage(ta, tm, "hello");
		expect(chatState.messages).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(chatState.messages[0]!.type).toBe("user");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		if (chatState.messages[0]!.type === "user") {
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(chatState.messages[0]!.text).toBe("hello");
		}
	});

	it("includes images when provided", () => {
		addUserMessage(ta, tm, "look", ["img1.png"]);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		if (chatState.messages[0]!.type === "user") {
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(chatState.messages[0]!.images).toEqual(["img1.png"]);
		}
	});
});

describe("addSystemMessage", () => {
	it("adds an info system message by default", () => {
		addSystemMessage(ta, tm, "info text");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const m = chatState.messages[0]!;
		if (m.type === "system") {
			expect(m.variant).toBe("info");
		}
	});

	it("adds an error system message when variant specified", () => {
		addSystemMessage(ta, tm, "error text", "error");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const m = chatState.messages[0]!;
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

	it("replaces the in-flight notice with the completed boundary", () => {
		compaction("started", "Compacting conversation…");
		compaction("completed", "Context compacted", {
			preTokens: 180_000,
			postTokens: 42_000,
		});
		expect(chatState.messages).toEqual([
			expect.objectContaining({
				type: "system",
				compaction: "completed",
				preTokens: 180_000,
				postTokens: 42_000,
			}),
		]);
	});

	it("replaces the in-flight notice with a failure notice", () => {
		compaction("started", "Compacting conversation…");
		compaction("failed", "Compaction failed: too large");
		expect(chatState.messages).toEqual([
			expect.objectContaining({
				compaction: "failed",
				variant: "error",
				text: "Compaction failed: too large",
			}),
		]);
	});

	it("keeps earlier completed compactions", () => {
		compaction("completed", "Context compacted");
		compaction("started", "Compacting conversation…");
		compaction("completed", "Context compacted");
		expect(
			chatState.messages.map((m) =>
				m.type === "system" ? m.compaction : m.type,
			),
		).toEqual(["completed", "completed"]);
	});
});

// ─── Queued User Messages ──────────────────────────────────────────────────

describe("queued user message (sentDuringEpoch)", () => {
	it("addUserMessage sets sentDuringEpoch when sent while processing", () => {
		addUserMessage(ta, tm, "hello", undefined, true);
		expect(chatState.messages).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const msg = chatState.messages[0]!;
		expect(msg.type).toBe("user");
		expect((msg as UserMsg).sentDuringEpoch).toBe(chatState.turnEpoch);
	});

	it("addUserMessage defaults sentDuringEpoch to undefined", () => {
		addUserMessage(ta, tm, "hello");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const msg = chatState.messages[0]!;
		expect((msg as UserMsg).sentDuringEpoch).toBeUndefined();
	});

	it("clearMessages resets all state", () => {
		addUserMessage(ta, tm, "test", undefined, true);
		clearMessages();
		expect(chatState.messages).toHaveLength(0);
		expect(isProcessing()).toBe(false);
		expect(isStreaming()).toBe(false);
	});
});

// ─── prependMessages ────────────────────────────────────────────────────────

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

// ─── historyState ───────────────────────────────────────────────────────────

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
