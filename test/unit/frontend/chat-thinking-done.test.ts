// Terminal reduction is safe when there are no thinking blocks.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock DOMPurify (browser-only) before importing the store
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	applyTerminalTurn,
	chatState,
	clearMessages,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

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

describe("terminal thinking block finalization", () => {
	it("is a no-op when there are no thinking blocks", () => {
		applyTerminalTurn(ta, tm);
		expect(chatState.messages.length).toBe(0);
	});
});
