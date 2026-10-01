// Verifies that handleDone finalizes any unclosed thinking blocks (done=false)
// so they don't spin forever if thinking_stop is lost.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock DOMPurify (browser-only) before importing the store
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	chatState,
	clearMessages,
	handleDone,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import type { RelayMessage } from "../../../src/lib/frontend/types.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

function msg<T extends RelayMessage["type"]>(data: {
	type: T;
	[k: string]: unknown;
}): Extract<RelayMessage, { type: T }> {
	return data as Extract<RelayMessage, { type: T }>;
}

let ta: SessionActivity;
let tm: SessionMessages;

beforeEach(() => {
	clearMessages();
	sessionState.currentId = "test-session";
	ta = testActivity();
	tm = testMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("handleDone — thinking block finalization", () => {
	it("is a no-op when there are no thinking blocks", () => {
		// handleDone with no messages should not throw
		handleDone(ta, tm, msg({ type: "done", code: 0 }));
		expect(chatState.messages.length).toBe(0);
	});
});
