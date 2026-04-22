/**
 * Test helper: provides per-session (activity, messages) slot for handler calls.
 *
 * Task 2 (F2): all handlers now take (activity, messages, event) as leading args.
 * Tests that call handlers directly use this helper to create a test slot.
 *
 * The helpers register the created objects into the sessionActivity/sessionMessages
 * maps so that `currentChat()` and derived getters (isProcessing, isStreaming, etc.)
 * reflect handler mutations. Tests must set `sessionState.currentId` to the test
 * session ID (default: "test-session") before calling these.
 *
 * Usage:
 *   import { testActivity, testMessages } from "../../helpers/test-session-slot.js";
 *   sessionState.currentId = "test-session";
 *   handleDelta(testActivity(), testMessages(), { type: "delta", ... });
 */

import { SvelteSet } from "svelte/reactivity";
import type {
	SessionActivity,
	SessionMessages,
} from "../../src/lib/frontend/stores/chat.svelte.js";
import {
	sessionActivity,
	sessionMessages,
} from "../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../src/lib/frontend/stores/session.svelte.js";
import { createToolRegistry } from "../../src/lib/frontend/stores/tool-registry.js";

/** Default test session ID. Matches the ID typically set in beforeEach blocks. */
const TEST_SESSION_ID = "test-session";

/** Create a minimal SessionActivity for test handler calls.
 *  Registered into sessionActivity map for the current session. */
export function testActivity(sessionId?: string): SessionActivity {
	const id = sessionId ?? sessionState.currentId ?? TEST_SESSION_ID;
	const a: SessionActivity = {
		phase: "idle",
		turnEpoch: 0,
		currentMessageId: null,
		replayGeneration: 0,
		doneMessageIds: new SvelteSet(),
		seenMessageIds: new SvelteSet(),
		liveEventBuffer: null,
		eventsHasMore: false,
		renderTimer: null,
		thinkingStartTime: 0,
	};
	sessionActivity.set(id, a);
	return a;
}

/** Create a minimal SessionMessages for test handler calls.
 *  Registered into sessionMessages map for the current session. */
export function testMessages(sessionId?: string): SessionMessages {
	const id = sessionId ?? sessionState.currentId ?? TEST_SESSION_ID;
	const m: SessionMessages = {
		messages: [],
		currentAssistantText: "",
		loadLifecycle: "empty",
		contextPercent: 0,
		historyHasMore: false,
		historyMessageCount: 0,
		historyLoading: false,
		toolRegistry: createToolRegistry(),
		replayBatch: null,
		replayBuffer: null,
	};
	sessionMessages.set(id, m);
	return m;
}

/** Create both tiers as a convenience tuple. */
export function testSlot(sessionId?: string): {
	activity: SessionActivity;
	messages: SessionMessages;
} {
	return {
		activity: testActivity(sessionId),
		messages: testMessages(sessionId),
	};
}
