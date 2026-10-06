import {
	seedFamilySessions,
	seedRootSessions,
	seedSessions,
} from "./session-fixtures.js";
// Verifies that interleaved per-session events for sessions A/B/C are routed
// independently. Covers: live event buffering during replay, prod
// missing-sessionId drop, and unknown-session drop.

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
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { featureFlags } from "../../../src/lib/frontend/stores/feature-flags.svelte.js";
import { clearAllPermissions } from "../../../src/lib/frontend/stores/permissions.svelte.js";
import {
	clearSessionState,
	getAttentionSessions,
	getSessionIndicator,
	isSessionBusy,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	handleMessage,
	isPerSessionEvent,
} from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

beforeEach(() => {
	clearMessages();
	clearAllPermissions();
	clearSessionState();
	seedRootSessions(
		["session-a", "session-b", "session-c"].map((id) => ({ id, title: "" })),
	);
	seedFamilySessions("root-a", []);
	sessionState.currentId = "session-a";
	seedSessions([
		...sessionState.sessions.values(),
		...["session-a", "session-b", "session-c"].map((id) => ({
			id,
			title: "",
			status: "idle" as const,
		})),
	]);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	clearMessages();
	sessionActivity.clear();
	sessionMessages.clear();
	clearSessionState();
});

describe("Missing sessionId — dev throws, prod drops", () => {
	it("throws in dev mode when sessionId is missing", () => {
		// Events with per-session types but no sessionId should throw in dev
		expect(() => {
			handleMessage({
				type: "thinking_stop",
			} as RelayMessage);
		}).toThrow(/routePerSession: missing sessionId/);
	});

	it("throws in dev mode when sessionId is empty string", () => {
		expect(() => {
			handleMessage({
				type: "thinking_stop",
				sessionId: "",
			} as RelayMessage);
		}).toThrow(/routePerSession: missing sessionId/);
	});
});

describe("Unknown-session guard — drops events silently", () => {
	it("logs and drops an unknown event without replaying it after the snapshot", () => {
		clearSessionState();
		sessionState.currentId = "viewed";
		featureFlags.debug = true;
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
		try {
			handleMessage({
				type: "thinking_stop",
				sessionId: "background",
			});
			expect(debug).toHaveBeenCalledWith(
				"[ws]",
				"routePerSession: unknown sessionId %s for event %s",
				"background",
				"thinking_stop",
			);
			expect(sessionMessages.has("background")).toBe(false);

			seedSessions([{ id: "background", title: "Background", status: "busy" }]);
			expect(isSessionBusy("background")).toBe(true);
			expect(sessionMessages.has("background")).toBe(false);
		} finally {
			featureFlags.debug = false;
			debug.mockRestore();
		}
	});

	it("drops events for unknown sessionId without throwing", () => {
		// "unknown-session" is not in sessionState.sessions
		expect(() => {
			handleMessage({
				type: "thinking_stop",
				sessionId: "unknown-session",
			} as RelayMessage);
		}).not.toThrow();

		// No messages should have been created
		expect(chatState.messages).toHaveLength(0);
	});

	it("processes events after session is registered", () => {
		// Register the session
		seedSessions([
			...sessionState.sessions.values(),
			{
				id: "new-session",
				title: "",
				status: "idle",
			},
		]);

		handleMessage({
			type: "thinking_stop",
			sessionId: "new-session",
		} as RelayMessage);

		expect(sessionActivity.has("new-session")).toBe(true);
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
			"user_message",
			"part_removed",
			"message_removed",
			"session_forked",
			"provider_session_reloaded",
			"session_deleted",
		];
		for (const type of perSessionTypes) {
			const msg = { type, sessionId: "s1" } as RelayMessage;
			expect(isPerSessionEvent(msg)).toBe(true);
		}
	});

	it("returns false for global event types", () => {
		const globalTypes = ["session_list", "model_info"];
		for (const type of globalTypes) {
			const msg = { type } as RelayMessage;
			expect(isPerSessionEvent(msg)).toBe(false);
		}
	});
});

describe("family attention before membership", () => {
	it("roots-only reconciliation preserves child indicators and uses rolled root counts", () => {
		seedFamilySessions("root", [
			{ id: "root", title: "Root" },
			{
				id: "new-child",
				title: "Child",
				parentID: "root",
				pendingQuestionCount: 1,
			},
		]);
		seedSessions([
			{
				id: "root",
				title: "Root",
				status: "idle",
				pendingPermissionCount: 2,
				pendingQuestionCount: 1,
			},
		]);
		expect(getSessionIndicator("new-child", null)).toBe("attention");
		expect(getAttentionSessions(null, () => new Set()).get("root")).toEqual({
			questions: 1,
			permissions: 2,
		});
	});
});
