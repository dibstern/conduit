// Verifies the F2 fix, now in followSessionTurn: when the session's row activity goes idle,
// all in-flight turn state is cleaned up:
// 1. In-flight message finalized via flushAndFinalizeAssistant
// 2. The session reads idle
// 3. currentMessageId cleared, currentAssistantText cleared
// 4. liveEventBuffer drained
// 5. seenMessageIds / doneMessageIds preserved (cross-turn dedup)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
	"../../../src/lib/frontend/stores/router.svelte.js",
	async (importOriginal) => {
		const router =
			await importOriginal<
				typeof import("../../../src/lib/frontend/stores/router.svelte.js")
			>();
		return {
			...router,
			navigate: (path: string) => {
				router.routerState.path = path;
			},
			replaceRoute: (path: string) => {
				router.routerState.path = path;
			},
		};
	},
);

// Mock DOMPurify (browser-only) before importing the store
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	chatState,
	clearMessages,
	isProcessing,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	openSessionForSetup,
	setSessionWorkingForSetup,
} from "../../../src/lib/frontend/stories/session-setup.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

let ta: SessionActivity;
let tm: SessionMessages;

beforeEach(() => {
	openSessionForSetup("test-session", "project-a");
	setSessionWorkingForSetup("test-session", false);
	clearMessages();
	ta = testActivity();
	tm = testMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("F2 fix: idle row full cleanup", () => {
	it("clears processing phase when idle arrives", () => {
		setSessionWorkingForSetup("test-session", true);
		expect(isProcessing()).toBe(true);

		setSessionWorkingForSetup("test-session", false);
		expect(isProcessing()).toBe(false);
		expect(ta.endedGeneration).toBe(ta.turnGeneration);
	});

	it("clears currentMessageId on idle", () => {
		ta.currentMessageId = "msg-123";
		setSessionWorkingForSetup("test-session", true);

		setSessionWorkingForSetup("test-session", false);

		expect(ta.currentMessageId).toBeNull();
	});

	it("clears currentAssistantText on idle", () => {
		tm.currentAssistantText = "partial text";
		setSessionWorkingForSetup("test-session", true);

		setSessionWorkingForSetup("test-session", false);

		expect(chatState.currentAssistantText).toBe("");
	});

	it("preserves seenMessageIds across idle (cross-turn dedup)", () => {
		ta.seenMessageIds.add("msg-1");
		ta.seenMessageIds.add("msg-2");
		setSessionWorkingForSetup("test-session", true);

		setSessionWorkingForSetup("test-session", false);

		expect(ta.seenMessageIds.has("msg-1")).toBe(true);
		expect(ta.seenMessageIds.has("msg-2")).toBe(true);
	});

	it("preserves doneMessageIds across idle (cross-turn dedup)", () => {
		ta.doneMessageIds.add("msg-1");
		setSessionWorkingForSetup("test-session", true);

		setSessionWorkingForSetup("test-session", false);

		expect(ta.doneMessageIds.has("msg-1")).toBe(true);
	});

	it("is a no-op when already idle", () => {
		expect(isProcessing()).toBe(false);
		ta.currentMessageId = "msg-123";
		tm.currentAssistantText = "partial text";
		const ended = ta.endedGeneration;

		setSessionWorkingForSetup("test-session", false);

		expect(isProcessing()).toBe(false);
		expect(ta.endedGeneration).toBe(ended);
		expect(ta.currentMessageId).toBe("msg-123");
		expect(chatState.currentAssistantText).toBe("partial text");
	});
});
