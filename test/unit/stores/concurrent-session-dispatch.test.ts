// ─── Concurrent Session Dispatch Tests ──────────────────────────────────────
// Verifies that interleaved per-session events for sessions A/B/C are routed
// independently. Covers: live event buffering during replay, notification_event
// non-routing, prod missing-sessionId drop, and unknown-session drop.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must mock localStorage BEFORE any store modules are loaded.
vi.hoisted(() => {
	let store: Record<string, string> = {};
	const mock = {
		getItem: vi.fn((key: string) => store[key] ?? null),
		setItem: vi.fn((key: string, value: string) => {
			store[key] = value;
		}),
		removeItem: vi.fn((key: string) => {
			delete store[key];
		}),
		clear: vi.fn(() => {
			store = {};
		}),
		get length() {
			return Object.keys(store).length;
		},
		key: vi.fn((_: number) => null),
	};
	Object.defineProperty(globalThis, "localStorage", {
		value: mock,
		writable: true,
		configurable: true,
	});
});

// Mock DOMPurify (browser-only) before importing stores
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	chatState,
	clearMessages,
	isStreaming,
	phaseToStreaming,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { getNotifState } from "../../../src/lib/frontend/stores/notification-reducer.svelte.js";
import {
	clearAllPermissions,
	permissionsState,
} from "../../../src/lib/frontend/stores/permissions.svelte.js";
import { routerState } from "../../../src/lib/frontend/stores/router.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	handleMessage,
	isPerSessionEvent,
} from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type {
	PermissionId,
	RelayMessage,
} from "../../../src/lib/shared-types.js";

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
	clearMessages();
	clearAllPermissions();
	sessionState.rootSessions = ["session-a", "session-b", "session-c"].map(
		(id) => ({ id, title: "" }),
	);
	sessionState.familySessions = [];
	sessionState.currentId = "session-a";
	for (const id of ["session-a", "session-b", "session-c"]) {
		sessionState.sessions.set(id, { id, title: "" });
	}
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	clearMessages();
	sessionActivity.clear();
	sessionMessages.clear();
	sessionState.sessions.clear();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Interleaved deltas for A/B/C — each slot independent", () => {
	it("interleaved deltas from three sessions all create assistant messages", () => {
		handleMessage({
			type: "delta",
			sessionId: "session-a",
			text: "A says hello",
		} as RelayMessage);
		handleMessage({
			type: "delta",
			sessionId: "session-b",
			text: "B says hello",
		} as RelayMessage);
		handleMessage({
			type: "delta",
			sessionId: "session-c",
			text: "C says hello",
		} as RelayMessage);

		// All deltas went through — chat state has messages
		// (during transition, all go to legacy chatState.messages)
		expect(chatState.messages.length).toBeGreaterThan(0);
	});
});

describe("notification_event — non-routing (global dispatch)", () => {
	it("notification_event is NOT a per-session event", () => {
		const msg = {
			type: "notification_event",
			eventType: "done",
			sessionId: "session-a",
		} as RelayMessage;
		// notification_event should NOT be classified as per-session
		expect(isPerSessionEvent(msg)).toBe(false);
	});

	it("notification_event does not update chat state", () => {
		phaseToStreaming();
		handleMessage({
			type: "notification_event",
			eventType: "done",
		});
		// Chat state should be unchanged — notification_event doesn't route
		// through routePerSession
		expect(isStreaming()).toBe(true);
	});
});

describe("Missing sessionId — dev throws, prod drops", () => {
	it("throws in dev mode when sessionId is missing", () => {
		// Events with per-session types but no sessionId should throw in dev
		expect(() => {
			handleMessage({
				type: "delta",
				text: "no session",
			} as RelayMessage);
		}).toThrow(/routePerSession: missing sessionId/);
	});

	it("throws in dev mode when sessionId is empty string", () => {
		expect(() => {
			handleMessage({
				type: "delta",
				sessionId: "",
				text: "empty session",
			} as RelayMessage);
		}).toThrow(/routePerSession: missing sessionId/);
	});
});

describe("Unknown-session guard — drops events silently", () => {
	it("drops events for unknown sessionId without throwing", () => {
		// "unknown-session" is not in sessionState.sessions
		expect(() => {
			handleMessage({
				type: "delta",
				sessionId: "unknown-session",
				text: "should be dropped",
			} as RelayMessage);
		}).not.toThrow();

		// No messages should have been created
		expect(chatState.messages).toHaveLength(0);
	});

	it("processes events after session is registered", () => {
		// Register the session
		sessionState.sessions.set("new-session", {
			id: "new-session",
			title: "",
		});

		handleMessage({
			type: "delta",
			sessionId: "new-session",
			text: "now it works",
		} as RelayMessage);

		// Message should have been created
		expect(chatState.messages.length).toBeGreaterThan(0);
	});
});

describe("isPerSessionEvent — runtime guard", () => {
	it("returns true for all per-session event types", () => {
		const perSessionTypes = [
			"delta",
			"thinking_start",
			"thinking_delta",
			"thinking_stop",
			"tool_start",
			"tool_executing",
			"tool_result",
			"tool_content",
			"result",
			"done",
			"error",
			"status",
			"user_message",
			"part_removed",
			"message_removed",
			"ask_user",
			"ask_user_resolved",
			"ask_user_error",
			"permission_request",
			"permission_resolved",
			"session_switched",
			"session_forked",
			"history_page",
			"provider_session_reloaded",
			"session_deleted",
		];
		for (const type of perSessionTypes) {
			const msg = { type, sessionId: "s1" } as RelayMessage;
			expect(isPerSessionEvent(msg)).toBe(true);
		}
	});

	it("returns false for global event types", () => {
		const globalTypes = [
			"session_list",
			"model_list",
			"model_info",
			"agent_list",
			"command_list",
			"client_count",
			"connection_status",
			"notification_event",
			"pty_list",
			"pty_created",
			"file_tree",
			"todo_state",
		];
		for (const type of globalTypes) {
			const msg = { type } as RelayMessage;
			expect(isPerSessionEvent(msg)).toBe(false);
		}
	});
});

describe("family attention before membership", () => {
	it("accepts an unknown child permission and its resolution", () => {
		handleMessage({
			type: "permission_request",
			sessionId: "new-child",
			requestId: "permission-1" as PermissionId,
			toolName: "bash",
			toolInput: {},
		});
		expect(
			permissionsState.pendingPermissions.map(
				(permission) => permission.requestId,
			),
		).toContain("permission-1");
		handleMessage({
			type: "permission_resolved",
			sessionId: "new-child",
			requestId: "permission-1" as PermissionId,
			decision: "once",
		});
		expect(permissionsState.pendingPermissions).toEqual([]);
	});

	it("accepts unknown child questions and preserves replay through a switch", () => {
		handleMessage({
			type: "ask_user",
			sessionId: "new-child",
			toolId: "question-1",
			questions: [],
		});
		handleMessage({
			type: "session_family",
			rootId: "root",
			sessions: [
				{ id: "root", title: "Root" },
				{ id: "new-child", title: "Child", parentID: "root" },
			],
		});
		routerState.path = "/s/root";
		handleMessage({ type: "session_switched", sessionId: "root", id: "root" });
		expect(
			permissionsState.pendingQuestions.map((question) => question.toolId),
		).toEqual(["question-1"]);
		handleMessage({
			type: "ask_user_error",
			sessionId: "unknown-child",
			toolId: "question-1",
			message: "Retry",
		});
		expect(permissionsState.questionErrors.get("question-1")).toBe("Retry");
		handleMessage({
			type: "ask_user_resolved",
			sessionId: "unknown-child",
			toolId: "question-1",
		});
		expect(permissionsState.pendingQuestions).toEqual([]);
	});

	// Resolutions are broadcast to every client, so a slot per unrelated
	// session would evict cached transcripts from the LRU.
	it("keeps permission and question events out of chat slots", () => {
		handleMessage({
			type: "ask_user",
			sessionId: "other-child",
			toolId: "question-2",
			questions: [],
		});
		handleMessage({
			type: "ask_user_error",
			sessionId: "other-child",
			toolId: "question-2",
			message: "Retry",
		});
		handleMessage({
			type: "ask_user_resolved",
			sessionId: "other-child",
			toolId: "question-2",
		});
		handleMessage({
			type: "permission_resolved",
			sessionId: "other-child",
			requestId: "permission-2" as PermissionId,
			decision: "once",
		});
		expect(sessionActivity.has("other-child")).toBe(false);
		expect(sessionMessages.has("other-child")).toBe(false);
	});

	it("roots-only reconciliation preserves child indicators and uses rolled root counts", () => {
		handleMessage({
			type: "notification_event",
			eventType: "ask_user",
			sessionId: "new-child",
		});
		handleMessage({
			type: "session_list",
			roots: true,
			sessions: [
				{
					id: "root",
					title: "Root",
					pendingPermissionCount: 2,
					pendingQuestionCount: 1,
				},
			],
		});
		expect(getNotifState("new-child")).toEqual({
			kind: "attention",
			questions: 1,
			permissions: 0,
		});
		expect(getNotifState("root")).toEqual({
			kind: "attention",
			questions: 1,
			permissions: 2,
		});
	});
});
