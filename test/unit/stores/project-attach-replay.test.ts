import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.defineProperty(globalThis, "localStorage", {
		value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
		configurable: true,
	});
});
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import {
	chatState,
	clearMessages,
	getOrCreateSessionSlot,
	historyState,
	sessionActivity,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	clearSessionState,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	handleMessage,
	replayEvents,
} from "../../../src/lib/frontend/stores/ws-dispatch.js";
import { onProjectAttached } from "../../../src/lib/frontend/stores/ws-listeners.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

let unsubscribe: () => void;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", { history: { replaceState: vi.fn() } });
	clearSessionState();
	attachedProjectState.slug = null;
	routerState.path = "/s/session-a";
	unsubscribe = onProjectAttached(() => {
		clearMessages();
		clearSessionState();
	});
});
afterEach(() => {
	unsubscribe();
	clearSessionState();
	attachedProjectState.slug = null;
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("drops old-project buffered and late events while the new project's replay is in flight", async () => {
	handleMessage({ type: "project_attached", slug: "a" });
	routerState.path = "/s/session-a";
	handleMessage({
		type: "session_switched",
		id: "session-a",
		sessionId: "session-a",
	});
	const oldSlot = getOrCreateSessionSlot("session-a");
	const oldReplay = replayEvents(
		Array.from(
			{ length: 100 },
			(_, i): RelayMessage => ({
				type: "user_message",
				sessionId: "session-a",
				text: `old-${i}`,
			}),
		),
		"session-a",
	);
	handleMessage({
		type: "delta",
		sessionId: "session-a",
		text: "buffered old response",
	});
	expect(oldSlot.activity.liveEventBuffer).toHaveLength(1);

	handleMessage({ type: "project_attached", slug: "b" });
	expect(oldSlot.activity.liveEventBuffer).toBeNull();
	routerState.path = "/s/session-b";
	handleMessage({
		type: "session_switched",
		id: "session-b",
		sessionId: "session-b",
	});
	const newReplay = replayEvents(
		Array.from(
			{ length: 100 },
			(_, i): RelayMessage => ({
				type: "user_message",
				sessionId: "session-b",
				text: `new-${i}`,
			}),
		),
		"session-b",
	);
	handleMessage({
		type: "delta",
		sessionId: "session-a",
		text: "late old response",
	});
	handleMessage({
		type: "user_message",
		sessionId: "session-a",
		text: "late old user",
	});
	handleMessage({
		type: "delta",
		sessionId: "session-b",
		text: "new response",
	});
	await vi.runAllTimersAsync();
	await Promise.all([oldReplay, newReplay]);

	expect(sessionState.currentId).toBe("session-b");
	expect(routerState.path).toBe("/s/session-b");
	expect(sessionActivity.has("session-a")).toBe(false);
	expect(JSON.stringify(chatState.messages)).not.toContain("old");
	expect(JSON.stringify(chatState.messages)).toContain("new response");
});

it("publishes the attached slug and resets synchronously before bootstrap", () => {
	const order: string[] = [];
	const stop = onProjectAttached((slug) => {
		order.push(slug);
		expect(attachedProjectState.slug).toBe("b");
		expect(routerState.path).toBe("/s/session-a");
		expect(sessionState.currentId).toBeNull();
	});
	handleMessage({ type: "project_attached", slug: "b" });
	routerState.path = "/s/session-b";
	handleMessage({
		type: "session_switched",
		id: "session-b",
		sessionId: "session-b",
	});
	expect(order).toEqual(["b"]);
	expect(sessionState.currentId).toBe("session-b");
	stop();
});

it("does not let an old history completion clear the new project's loading state", async () => {
	handleMessage({ type: "project_attached", slug: "a" });
	routerState.path = "/s/session-a";
	handleMessage({
		type: "session_switched",
		id: "session-a",
		sessionId: "session-a",
	});
	handleMessage({
		type: "history_page",
		sessionId: "session-a",
		messages: [],
		hasMore: false,
	});
	handleMessage({ type: "project_attached", slug: "b" });
	routerState.path = "/s/session-b";
	handleMessage({
		type: "session_switched",
		id: "session-b",
		sessionId: "session-b",
	});
	historyState.loading = true;
	await Promise.resolve();
	expect(historyState.loading).toBe(true);
});
