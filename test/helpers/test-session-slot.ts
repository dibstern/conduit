/**
 * Test helper: provides per-session (activity, messages) slot for handler calls.
 *
 * Task 2 (F2): all handlers now take (activity, messages, event) as leading args.
 * Tests that call handlers directly use this helper to create a test slot.
 *
 * Usage:
 *   import { testActivity, testMessages } from "../../helpers/test-session-slot.js";
 *   handleDelta(testActivity(), testMessages(), { type: "delta", ... });
 */

import { SvelteSet } from "svelte/reactivity";
import type {
	SessionActivity,
	SessionMessages,
} from "../../src/lib/frontend/stores/chat.svelte.js";
import { createToolRegistry } from "../../src/lib/frontend/stores/tool-registry.js";

/** Create a minimal SessionActivity for test handler calls. */
export function testActivity(): SessionActivity {
	return {
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
}

/** Create a minimal SessionMessages for test handler calls. */
export function testMessages(): SessionMessages {
	return {
		messages: [],
		currentAssistantText: "",
		loadLifecycle: "empty",
		contextPercent: 0,
		historyHasMore: false,
		historyMessageCount: 0,
		historyLoading: false,
		toolRegistry: createToolRegistry(),
	};
}

/** Create both tiers as a convenience tuple. */
export function testSlot(): {
	activity: SessionActivity;
	messages: SessionMessages;
} {
	return { activity: testActivity(), messages: testMessages() };
}
